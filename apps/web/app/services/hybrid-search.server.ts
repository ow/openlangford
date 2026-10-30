/**
 * Unified hybrid search service.
 *
 * Replaces the separate search.ts (keyword) and vectorSearch.ts (vector-only)
 * with a single service that calls per-table hybrid search RPCs in Supabase,
 * combining vector similarity + full-text search using Reciprocal Rank Fusion.
 *
 * Also handles transcript segments (FTS-only, no embeddings) and the
 * search_results_cache table for shareable AI answer URLs.
 */

import { embedQuery } from "./ai/index.server";
import { formatSpeakerName } from "~/lib/speaker-labels";
import { attachSourceSlugs } from "./source-slugs.server";
import { identifierMatches, matterRecencyBoost, matterStatusBoost } from "../lib/matter-rank";
import { getSupabaseAdminClient } from "../lib/supabase.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnifiedSearchResult {
  id: number;
  type:
    | "matter"
    | "motion"
    | "key_statement"
    | "document_section"
    | "transcript_segment";
  title: string;
  content: string; // Preview text (first 200 chars)
  meeting_id: number | null;
  meeting_date: string | null;
  speaker_name?: string;
  rank_score: number;
  // Type-specific metadata
  agenda_item_id?: number;
  document_id?: number;
  extracted_document_id?: number;
  motion_result?: string;
  motion_mover?: string;
  motion_seconder?: string;
  statement_type?: string;
  start_time?: number;
  /** Meeting title for grouping results under their meeting. */
  meeting_title?: string | null;
  meeting_slug?: string | null;
  matter_id?: number;
  matter_slug?: string | null;
  matter_status?: string;
  matter_category?: string;
}

export interface CachedResult {
  id: string;
  query: string;
  answer: string;
  sources: any[];
  suggested_followups: string[];
  source_count: number;
  created_at: string;
}

type ContentType = UnifiedSearchResult["type"];

// ---------------------------------------------------------------------------
// Hybrid search – calls per-table Supabase RPCs in parallel
// ---------------------------------------------------------------------------

async function hybridSearchMotions(
  queryText: string,
  embedding: number[],
  limit: number,
  dateFrom?: string | null,
  dateTo?: string | null,
): Promise<UnifiedSearchResult[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("hybrid_search_motions", {
    query_text: queryText,
    query_embedding: JSON.stringify(embedding),
    match_count: limit,
    full_text_weight: 1.0,
    semantic_weight: 1.0,
    rrf_k: 50,
    date_from: dateFrom || null,
    date_to: dateTo || null,
  });

  if (error) {
    console.error("Hybrid search motions error:", error);
    return [];
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    type: "motion" as const,
    title: row.plain_english_summary || (row.text_content || "").slice(0, 120),
    content: (row.text_content || "").slice(0, 200),
    meeting_id: row.meeting_id,
    meeting_date: null, // Enriched separately
    rank_score: row.rank_score,
    agenda_item_id: row.agenda_item_id || undefined,
    motion_result: row.result,
    motion_mover: row.mover,
    motion_seconder: row.seconder,
  }));
}

async function hybridSearchKeyStatements(
  queryText: string,
  embedding: number[],
  limit: number,
  dateFrom?: string | null,
  dateTo?: string | null,
): Promise<UnifiedSearchResult[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("hybrid_search_key_statements", {
    filter_municipality_id: null,
    query_text: queryText,
    query_embedding: JSON.stringify(embedding),
    match_count: limit,
    full_text_weight: 1.0,
    semantic_weight: 1.0,
    rrf_k: 50,
    date_from: dateFrom || null,
    date_to: dateTo || null,
  });

  if (error) {
    console.error("Hybrid search key_statements error:", error);
    return [];
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    type: "key_statement" as const,
    title: `[${row.statement_type}] ${(row.statement_text || "").slice(0, 100)}`,
    content: (row.statement_text || "").slice(0, 200),
    meeting_id: row.meeting_id,
    meeting_date: null,
    speaker_name: row.speaker_name,
    rank_score: row.rank_score,
    agenda_item_id: row.agenda_item_id || undefined,
    statement_type: row.statement_type,
  }));
}

async function hybridSearchDocumentSections(
  queryText: string,
  embedding: number[],
  limit: number,
  dateFrom?: string | null,
  dateTo?: string | null,
): Promise<UnifiedSearchResult[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc(
    "hybrid_search_document_sections",
    {
      query_text: queryText,
      query_embedding: JSON.stringify(embedding),
      match_count: limit,
      full_text_weight: 1.0,
      semantic_weight: 1.0,
      rrf_k: 50,
      date_from: dateFrom || null,
      date_to: dateTo || null,
    },
  );

  if (error) {
    // Graceful: document_sections may be empty (Phase 7.1 backfill pending)
    console.error("Hybrid search document_sections error:", error);
    return [];
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    type: "document_section" as const,
    title: row.section_title || "Document Section",
    content: (row.content || "").slice(0, 200),
    meeting_id: row.meeting_id || null,
    meeting_date: null,
    document_id: row.document_id || undefined,
    extracted_document_id: row.extracted_document_id || undefined,
    agenda_item_id: row.agenda_item_id || undefined,
    rank_score: row.rank_score,
  }));
}

async function searchMatters(
  queryText: string,
  limit: number,
  dateFrom?: string | null,
  dateTo?: string | null,
): Promise<UnifiedSearchResult[]> {
  const supabase = getSupabaseAdminClient();
  let query = supabase
    .from("matters")
    .select(
      "id, slug, title, identifier, description, plain_english_summary, category, status, first_seen, last_seen, meta",
    )
    .order("last_seen", { ascending: false, nullsFirst: false })
    .limit(1000);

  if (dateFrom) {
    query = query.gte("last_seen", dateFrom);
  }
  if (dateTo) {
    query = query.lte("first_seen", dateTo);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Matter search error:", error);
    return [];
  }

  const lower = queryText.trim().toLowerCase();
  const terms = lower.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  return (data || [])
    .map((matter: any) => {
      const meta = matter.meta && typeof matter.meta === "object" ? matter.meta : {};
      const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
      const searchable = [
        matter.title,
        matter.identifier,
        matter.description,
        matter.plain_english_summary,
        matter.category,
        matter.status,
        meta.entity_cluster,
        ...aliases,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (!terms.every((term) => searchable.includes(term))) return null;

      const title = (matter.title || "").toLowerCase();
      const identifier = (matter.identifier || "").toLowerCase();
      const aliasText = aliases.join(" ").toLowerCase();
      let rankScore = 0.04;
      if (title.includes(lower)) rankScore += 0.08;
      if (identifier.includes(lower)) rankScore += 0.08;
      if (aliasText.includes(lower)) rankScore += 0.06;
      if ((matter.plain_english_summary || matter.description || "").toLowerCase().includes(lower)) {
        rankScore += 0.03;
      }
      // An exact policy/bylaw number wins; then in-force and recent matters beat repealed or old ones.
      if (identifierMatches(matter.identifier, lower)) rankScore += 0.1;
      rankScore += (matterStatusBoost(matter.status) + matterRecencyBoost(matter.last_seen)) * 0.004;

      const aliasPreview = aliases.length > 0 ? `Aliases: ${aliases.slice(0, 5).join(", ")}` : "";
      return {
        id: matter.id,
        type: "matter" as const,
        title: matter.title,
        content:
          matter.plain_english_summary ||
          matter.description ||
          aliasPreview ||
          `${matter.category || "Council matter"} — ${matter.status || "Tracked"}`,
        meeting_id: null,
        meeting_date: matter.last_seen || matter.first_seen || null,
        rank_score: rankScore,
        matter_id: matter.id,
        matter_slug: matter.slug,
        matter_status: matter.status,
        matter_category: matter.category,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.rank_score - a.rank_score)
    .slice(0, limit) as UnifiedSearchResult[];
}

/**
 * FTS-only search for transcript segments.
 * Transcript embeddings were removed in Phase 3c (228K rows too expensive).
 * Uses tsvector full-text search with ts_rank for scoring.
 */
async function ftsSearchTranscriptSegments(
  queryText: string,
  limit: number,
  dateFrom?: string | null,
  dateTo?: string | null,
): Promise<UnifiedSearchResult[]> {
  const supabase = getSupabaseAdminClient();

  // Build a tsquery from the query text (simple AND of significant words)
  const tsQuery = queryText
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .join(" & ");

  if (!tsQuery) return [];

  let query = supabase
    .from("transcript_segments")
    .select(
      "id, meeting_id, speaker_name, text_content, start_time, meetings!inner(slug, meeting_date)",
    )
    .textSearch("text_search", tsQuery);

  // Apply date filtering via the joined meetings table
  if (dateFrom) {
    query = query.gte("meetings.meeting_date", dateFrom);
  }
  if (dateTo) {
    query = query.lte("meetings.meeting_date", dateTo);
  }

  const { data, error } = await query.limit(limit);

  if (error) {
    console.error("FTS search transcript_segments error:", error);
    return [];
  }

  if (!data || data.length === 0) return [];

  // Assign synthetic rank_score based on position (FTS results are pre-ordered by relevance)
  // Scale from 0.02 (baseline) down to 0.005 across the result set
  return data.map((row: any, index: number) => {
    const meeting = Array.isArray(row.meetings)
      ? row.meetings[0]
      : row.meetings;
    const positionScore = 0.02 - (index / data.length) * 0.015;
    return {
      id: row.id,
      type: "transcript_segment" as const,
      title: row.speaker_name
        ? `${formatSpeakerName(row.speaker_name)}: ${(row.text_content || "").slice(0, 80)}`
        : (row.text_content || "").slice(0, 100),
      content: (row.text_content || "").slice(0, 200),
      meeting_id: row.meeting_id,
      meeting_date: meeting?.meeting_date || null,
      speaker_name: row.speaker_name,
      rank_score: positionScore,
      start_time: row.start_time,
    };
  });
}

/** Find named speakers even when their spoken introduction was mistranscribed. */
async function searchTranscriptSpeakers(
  queryText: string,
  limit: number,
  dateFrom?: string | null,
  dateTo?: string | null,
): Promise<UnifiedSearchResult[]> {
  const name = queryText.trim().match(/^([A-Za-z]+)\s+([A-Za-z][A-Za-z'-]+)$/);
  if (!name) return [];

  const fullName = `${name[1]} ${name[2]}`;
  const abbreviatedName = `${name[1][0]}. ${name[2]}`;
  const aliases = [
    fullName,
    `${fullName} (public)`,
    abbreviatedName,
    `${abbreviatedName} (public)`,
  ];

  const supabase = getSupabaseAdminClient();
  let query = supabase
    .from("transcript_segments")
    .select("id, meeting_id, speaker_name, text_content, start_time, meetings!inner(slug, meeting_date)")
    .in("speaker_name", aliases);

  if (dateFrom) query = query.gte("meetings.meeting_date", dateFrom);
  if (dateTo) query = query.lte("meetings.meeting_date", dateTo);

  const { data, error } = await query.order("start_time", { ascending: true }).limit(limit);
  if (error) {
    console.error("Transcript speaker search error:", error);
    return [];
  }

  return (data || []).map((row: any) => {
    const meeting = Array.isArray(row.meetings) ? row.meetings[0] : row.meetings;
    return {
      id: row.id,
      type: "transcript_segment" as const,
      title: `${formatSpeakerName(row.speaker_name)}: ${(row.text_content || "").slice(0, 80)}`,
      content: (row.text_content || "").slice(0, 200),
      meeting_id: row.meeting_id,
      meeting_date: meeting?.meeting_date || null,
      speaker_name: row.speaker_name,
      rank_score: 0.05,
      start_time: row.start_time,
    };
  });
}

/**
 * Enrich results with meeting dates by fetching meetings in batch.
 */
async function enrichWithMeetingDates(
  results: UnifiedSearchResult[],
): Promise<void> {
  const meetingIds = [
    ...new Set(results.filter((r) => r.meeting_id).map((r) => r.meeting_id as number)),
  ];

  if (meetingIds.length === 0) return;

  const supabase = getSupabaseAdminClient();
  const { data } = await supabase
    .from("meetings")
    .select("id, slug, meeting_date, title")
    .in("id", meetingIds);

  if (!data) return;

  const byId = new Map(data.map((m: any) => [m.id, m]));
  for (const result of results) {
    const meeting = result.meeting_id ? byId.get(result.meeting_id) : null;
    if (!meeting) continue;
    if (!result.meeting_date) result.meeting_date = meeting.meeting_date || null;
    result.meeting_title = meeting.title || null;
    result.meeting_slug = meeting.slug || null;
  }
}

// ---------------------------------------------------------------------------
// Sort helper (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Sort unified search results by the given criteria.
 * - "newest": meeting_date descending, nulls last
 * - "oldest": meeting_date ascending, nulls last
 * - default/empty/"relevance": rank_score descending
 */
/**
 * Relevance with two nudges: recent records rank higher (half-weight after ~2
 * years), and an exact phrase match in the title beats a partial one.
 */
export function relevanceScore(result: UnifiedSearchResult, query?: string, now = Date.now()): number {
  let score = result.rank_score;
  if (result.meeting_date) {
    const years = Math.max(0, (now - new Date(`${result.meeting_date}T12:00:00`).getTime()) / (365.25 * 864e5));
    score *= 1 + 0.6 * Math.exp(-years / 2);
  }
  const q = query?.trim().toLowerCase();
  if (q && q.length >= 3 && result.title?.toLowerCase().includes(q)) score *= 1.3;
  return score;
}

export function sortResults(
  results: UnifiedSearchResult[],
  sort?: "relevance" | "newest" | "oldest" | string,
  query?: string,
): UnifiedSearchResult[] {
  if (results.length <= 1) return [...results];

  const sorted = [...results];

  if (sort === "newest") {
    sorted.sort((a, b) => {
      if (!a.meeting_date && !b.meeting_date) return 0;
      if (!a.meeting_date) return 1;
      if (!b.meeting_date) return -1;
      return b.meeting_date.localeCompare(a.meeting_date);
    });
  } else if (sort === "oldest") {
    sorted.sort((a, b) => {
      if (!a.meeting_date && !b.meeting_date) return 0;
      if (!a.meeting_date) return 1;
      if (!b.meeting_date) return -1;
      return a.meeting_date.localeCompare(b.meeting_date);
    });
  } else {
    // Default: relevance with recency and exact-title boosts
    const now = Date.now();
    sorted.sort((a, b) => relevanceScore(b, query, now) - relevanceScore(a, query, now));
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// Main unified search function
// ---------------------------------------------------------------------------

export async function hybridSearchAll(
  query: string,
  options?: {
    types?: ContentType[];
    limit?: number;
    dateFrom?: string | null;
    dateTo?: string | null;
    sort?: "relevance" | "newest" | "oldest";
  },
): Promise<UnifiedSearchResult[]> {
  const limit = options?.limit ?? 30;
  const types = options?.types;
  const dateFrom = options?.dateFrom ?? null;
  const dateTo = options?.dateTo ?? null;

  // Generate embedding for hybrid search (vector + FTS)
  const embedding = await embedQuery(query);

  // Build parallel search promises based on requested types
  const promises: Promise<UnifiedSearchResult[]>[] = [];

  const shouldSearch = (type: ContentType) => !types || types.includes(type);

  if (shouldSearch("matter")) {
    promises.push(searchMatters(query, 10, dateFrom, dateTo));
  }

  if (shouldSearch("motion") && embedding) {
    promises.push(hybridSearchMotions(query, embedding, 15, dateFrom, dateTo));
  }

  if (shouldSearch("key_statement") && embedding) {
    promises.push(hybridSearchKeyStatements(query, embedding, 15, dateFrom, dateTo));
  }

  if (shouldSearch("document_section") && embedding) {
    promises.push(hybridSearchDocumentSections(query, embedding, 15, dateFrom, dateTo));
  }

  if (shouldSearch("transcript_segment")) {
    promises.push(ftsSearchTranscriptSegments(query, 15, dateFrom, dateTo));
    promises.push(searchTranscriptSpeakers(query, 15, dateFrom, dateTo));
  }

  // Run all searches in parallel
  const resultSets = await Promise.all(promises);
  let allResults = resultSets.flat();

  // Enrich with meeting dates
  await enrichWithMeetingDates(allResults);

  // Sort by requested criteria (default: rank_score descending)
  allResults = sortResults(allResults, options?.sort, query);

  // Deduplicate by type+id
  const seen = new Set<string>();
  allResults = allResults.filter((r) => {
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return allResults.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Search results cache (shareable AI answer URLs)
// ---------------------------------------------------------------------------

export async function getSearchResultCache(
  id: string,
): Promise<CachedResult | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("search_results_cache")
    .select(
      "id, query, answer, sources, suggested_followups, source_count, created_at",
    )
    .eq("id", id)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (error || !data) return null;
  // Older cached answers predate slug fields on sources.
  await attachSourceSlugs(supabase, data.sources || []);
  return data as CachedResult;
}

/** Canonical form of a question for answer reuse ("What's the RCMP budget?" == "whats the rcmp budget"). */
export function normalizeQuestion(query: string): string {
  return query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let latestIngestCache: { value: string; at: number } | null = null;

/** When council records last changed; cached answers older than this are stale. */
export async function latestIngestAt(): Promise<string> {
  if (latestIngestCache && Date.now() - latestIngestCache.at < 5 * 60_000) return latestIngestCache.value;
  const supabase = getSupabaseAdminClient();
  const { data } = await supabase
    .from("meetings")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const value = data?.updated_at || new Date(0).toISOString();
  latestIngestCache = { value, at: Date.now() };
  return value;
}

/** A fresh cached answer for the same question, if one exists. */
export async function findCachedAnswer(query: string): Promise<CachedResult | null> {
  const normalized = normalizeQuestion(query);
  if (!normalized) return null;
  const supabase = getSupabaseAdminClient();
  const since = await latestIngestAt();
  const { data, error } = await supabase
    .from("search_results_cache")
    .select("id, query, answer, sources, suggested_followups, source_count, created_at")
    .eq("normalized_query", normalized)
    .gt("created_at", since)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data || !data.answer) return null;
  await attachSourceSlugs(supabase, data.sources || []);
  return data as CachedResult;
}

export async function saveSearchResultCache(data: {
  query: string;
  answer: string;
  sources: any[];
  suggested_followups: string[];
  source_count: number;
  /** False for follow-ups whose answer depends on conversation context. */
  cacheable?: boolean;
}): Promise<string | null> {
  const supabase = getSupabaseAdminClient();
  const { data: result, error } = await supabase
    .from("search_results_cache")
    .insert({
      query: data.query,
      normalized_query: data.cacheable === false ? null : normalizeQuestion(data.query),
      answer: data.answer,
      sources: data.sources,
      suggested_followups: data.suggested_followups,
      source_count: data.source_count,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to save search result cache:", error);
    return null;
  }

  return result?.id || null;
}
