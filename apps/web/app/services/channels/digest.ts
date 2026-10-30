/**
 * Channel-agnostic meeting digest (issue #67): what a community post about one
 * meeting says, built from text the site already publishes. Adapters
 * (./discord.ts, later Slack/Mastodon/...) turn a digest into their own format.
 *
 * Content rules (docs/writing-style.md and the public-names policy):
 * - Only public, already-reviewed text: meetings.meta.highlights (else the
 *   stored summary), motions.meta.headline, and plain outcome words. Never
 *   transcripts, speaker lists, movers or participation, so the digest names
 *   no one the meeting page doesn't already show in the same words.
 * - Dissent only as a count ("passed 6–1"), never a name.
 */
import { SITE_ORIGIN } from "../../lib/og";
import { meetingPath } from "../../lib/paths";
import { recordDate } from "../../lib/page-meta";
import { meetingHighlights } from "../../lib/meeting-summary";
import { isProceduralMotion, normalizeMotionResult, OUTCOME_LABELS } from "../../lib/motion-utils";
import { voteTally } from "../../lib/vote-coverage";

export const DIGEST_FOOTER = "Open Langford";
export const MAX_DECISIONS = 6;

/** A run of bullet text; `url` makes it a link. */
export type DigestSegment = { text: string; url?: string };

export type DigestDecision = {
  /** Plain-language headline, e.g. "Off-street parking rules move forward". */
  text: string;
  /** "Passed", "Passed 6–1", "Failed 3–4", "Tabled". */
  outcome: string | null;
  /** Meeting page anchored at the agenda item. */
  url: string;
  /** Meeting page that starts the video at this decision, when there is video. */
  videoUrl: string | null;
};

export type MeetingDigest = {
  meetingId: number;
  slug: string;
  /** "Regular Council — April 20, 2026" */
  title: string;
  /** The meeting's own name: "Regular Council", "Community Advisory Committee". */
  name: string;
  date: string; // YYYY-MM-DD
  dateLabel: string; // "April 20, 2026"
  /** Council or the committee's name. */
  body: string | null;
  url: string;
  /** One-line description (highlights.description), when the pipeline wrote one. */
  description: string | null;
  /** Highlight bullets as plain/linked runs (adapters escape and render them). */
  bullets: DigestSegment[][];
  /** True when bullets came from the older stored summary, not highlights. */
  fromSummary: boolean;
  decisions: DigestDecision[];
  /** Decisions left out for space; the post links to the full list. */
  moreDecisions: number;
  decisionsUrl: string;
  /** Meeting page with the video player, when the meeting has video. */
  videoUrl: string | null;
  imageUrl: string | null;
  footer: string;
};

export type DigestMeetingRow = {
  id: number;
  slug: string | null;
  title: string;
  meeting_date: string;
  summary?: string | null;
  video_url?: string | null;
  /** v2 adds `links`, aligned with bullets: links[i] = [{text, agenda_item_id}]. */
  highlights?: { bullets?: unknown; links?: unknown; description?: unknown; version?: unknown } | null;
  /** The meeting's still image without text; preferred over the share card, which repeats the bullets. */
  poster?: { url?: unknown } | null;
  share_card?: { url?: unknown } | null;
  organization?: { name?: string | null } | null;
};

export type DigestMotionRow = {
  id: number;
  agenda_item_id: number | null;
  result: string | null;
  disposition: string | null;
  text_content?: string | null;
  time_offset_seconds?: number | null;
  meta?: { headline?: string | null; individual_vote_coverage?: string | null } | null;
  votes?: { person_id?: number | null; vote?: string | null }[] | null;
};

const absolute = (path: string) => `${SITE_ORIGIN}${path}`;

/** Only https URLs (or site paths) survive into a post. */
function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim(), SITE_ORIGIN);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A bullet split into plain and linked runs. `links` are highlights v2 phrases
 * ({text, agenda_item_id}, exact substrings in reading order); each becomes a
 * link to the meeting page at `#item-<id>`. Phrases that aren't found, overlap
 * or carry a bad id are left as plain text.
 */
export function linkSegments(text: string, links: unknown, meetingUrl: string): DigestSegment[] {
  const segments: DigestSegment[] = [];
  let cursor = 0;
  for (const link of Array.isArray(links) ? links : []) {
    const phrase = typeof link?.text === "string" ? link.text.trim() : "";
    const id = Number(link?.agenda_item_id);
    if (!phrase || !Number.isSafeInteger(id) || id <= 0) continue;
    const start = text.indexOf(phrase, cursor);
    if (start < 0) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    segments.push({ text: phrase, url: `${meetingUrl}#item-${id}` });
    cursor = start + phrase.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/** The bullet as plain text (links dropped). */
export function bulletText(bullet: DigestSegment[]): string {
  return bullet.map((s) => s.text).join("");
}

/** Highlight bullets with their aligned v2 links (empty bullets dropped, alignment kept). */
function highlightBullets(highlights: DigestMeetingRow["highlights"], meetingUrl: string): DigestSegment[][] | null {
  if (!meetingHighlights({ highlights })) return null;
  const bullets = highlights!.bullets as unknown[];
  const links = Array.isArray(highlights!.links) ? highlights!.links : [];
  const out: DigestSegment[][] = [];
  bullets.forEach((b, i) => {
    if (typeof b === "string" && b.trim()) out.push(linkSegments(b.trim(), links[i], meetingUrl));
  });
  return out;
}

/** Stored summaries are "- …" bullets; anything else is one paragraph. */
function summaryBullets(summary: string | null | undefined): string[] {
  const lines = (summary || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.every((l) => /^[-*•]\s+/.test(l))) return lines.map((l) => l.replace(/^[-*•]\s+/, ""));
  return lines.length ? [lines.join(" ")] : [];
}

/** "Passed", or "Passed 6–1" when someone voted the other way (style rule 11). */
export function decisionOutcome(motion: DigestMotionRow): string | null {
  const outcome = normalizeMotionResult(motion.result);
  if (!outcome) return null;
  const label = OUTCOME_LABELS[outcome];
  const tally = voteTally({ meta: motion.meta, votes: motion.votes });
  if (tally && !tally.endsWith("–0")) return `${label} ${tally}`;
  if (!tally) {
    // Partial records: minutes name only those opposed.
    const opposed = (motion.votes ?? []).filter((v) => v.vote === "No").length;
    if (opposed) return `${label}, ${opposed} opposed`;
  }
  return label;
}

function startSeconds(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function buildMeetingDigest(meeting: DigestMeetingRow, motions: DigestMotionRow[] = []): MeetingDigest {
  const ref = { id: meeting.id, slug: meeting.slug };
  const url = absolute(meetingPath(ref));
  const dateLabel = recordDate(meeting.meeting_date);
  const fromHighlights = highlightBullets(meeting.highlights, url);
  const bullets = fromHighlights ?? summaryBullets(meeting.summary).map((text) => [{ text }]);
  const description = typeof meeting.highlights?.description === "string" && meeting.highlights.description.trim()
    ? meeting.highlights.description.trim()
    : null;
  const hasVideo = !!safeUrl(meeting.video_url);

  const seen = new Set<string>();
  const decisions: DigestDecision[] = [];
  for (const m of [...motions].sort((a, b) => a.id - b.id)) {
    const headline = m.meta?.headline?.trim();
    if (!headline || isProceduralMotion(m)) continue;
    const key = headline.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const anchor = m.agenda_item_id ? `#item-${m.agenda_item_id}` : "#decisions";
    const t = startSeconds(m.time_offset_seconds);
    decisions.push({
      text: headline.replace(/[.\s]+$/, ""),
      outcome: decisionOutcome(m),
      url: absolute(meetingPath(ref, anchor)),
      videoUrl: hasVideo && t !== null ? absolute(meetingPath(ref, `?t=${t}`)) : null,
    });
  }

  const body = meeting.organization?.name?.trim() || null;
  return {
    meetingId: meeting.id,
    slug: meeting.slug || String(meeting.id),
    title: `${meeting.title} — ${dateLabel}`,
    name: meeting.title,
    date: meeting.meeting_date.slice(0, 10),
    dateLabel,
    body,
    url,
    description,
    bullets,
    fromSummary: !fromHighlights && bullets.length > 0,
    decisions: decisions.slice(0, MAX_DECISIONS),
    moreDecisions: Math.max(0, decisions.length - MAX_DECISIONS),
    decisionsUrl: absolute(meetingPath(ref, "#decisions")),
    videoUrl: hasVideo ? absolute(meetingPath(ref, "?t=0")) : null,
    imageUrl: safeUrl(meeting.poster?.url) ?? safeUrl(meeting.share_card?.url),
    footer: DIGEST_FOOTER,
  };
}

/** Something worth posting: highlights or a summary to say what happened. */
export function hasPostableContent(digest: MeetingDigest): boolean {
  return digest.bullets.length > 0;
}

// ── loading (read-only) ──────────────────────────────────────────────────

/** The subset of a Supabase client used here (admin or publishable). */
export type DigestDb = { from: (table: string) => any };

export const DIGEST_MEETING_SELECT =
  "id,slug,title,meeting_date,status,summary,video_url,has_minutes,has_transcript,highlights:meta->highlights,poster:meta->poster,share_card:meta->share_card,organization:organizations(name)";
const DIGEST_MOTION_SELECT =
  "id,agenda_item_id,result,disposition,text_content,time_offset_seconds,headline:meta->>headline,coverage:meta->>individual_vote_coverage,votes(person_id,vote)";

/** Reads one meeting (by slug or id) and its decisions. Never writes. */
export async function loadMeetingDigest(db: DigestDb, slugOrId: string | number): Promise<MeetingDigest | null> {
  const byId = typeof slugOrId === "number" || /^\d+$/.test(String(slugOrId));
  const { data: meeting, error } = await db
    .from("meetings")
    .select(DIGEST_MEETING_SELECT)
    .eq(byId ? "id" : "slug", byId ? Number(slugOrId) : String(slugOrId))
    .maybeSingle();
  if (error) throw new Error(`Meeting unavailable: ${error.message ?? "query failed"}`);
  if (!meeting) return null;
  const { data: motions, error: motionError } = await db
    .from("motions")
    .select(DIGEST_MOTION_SELECT)
    .eq("meeting_id", meeting.id)
    .not("result", "is", null)
    .order("id");
  if (motionError) throw new Error(`Decisions unavailable: ${motionError.message ?? "query failed"}`);
  const rows: DigestMotionRow[] = (motions ?? []).map((m: any) => ({
    ...m,
    meta: { headline: m.headline ?? null, individual_vote_coverage: m.coverage ?? null },
  }));
  return buildMeetingDigest(meeting, rows);
}
