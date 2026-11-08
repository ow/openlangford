import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/client.server";
import { glossaryIds, glossaryPromptBlock } from "./ai/glossary-prompt";
import { publisherFor, tidyQuote, waybackArchiveUrl, youtubeId, type Source, type SourceOrigin } from "../lib/sources";

/**
 * Sources outside the meeting record, added by staff from the review bar: a City news release, a public notice, a
 * news report. The pipeline links an address or topic to meetings; what happened in a closed meeting (a land
 * purchase, a settlement) often only surfaces elsewhere, so a staff member pastes the link, the draft reads the page
 * and proposes a one-line headline in the resident register, and the approved line joins the page's timeline with a
 * label saying who said it. A source is never part of the record layer: the fact check and the writers treat it as
 * evidence for its own, attributed, claim only.
 */

const MUNICIPALITY = 1;

export type SourceTarget = { matterId?: number | null; propertyId?: number | null };

const FIELDS = "id, origin, publisher, title, url, published_on, happened_on, headline, quote, note, hidden, archive_url, date_label:meta->>date_label, compact:meta->>compact, images:meta->images";

/** The sources linked to a topic or an address, oldest first. */
export async function sourcesFor(supabase: SupabaseClient, target: SourceTarget): Promise<Source[]> {
  let q = supabase.from("source_links").select(`source_id, sources!inner(${FIELDS})`).eq("hidden", false).eq("sources.hidden", false);
  if (target.matterId) q = q.eq("matter_id", target.matterId);
  else if (target.propertyId) q = q.eq("property_id", target.propertyId);
  else return [];
  const { data, error } = await q;
  if (error) { console.error("[sources] list failed:", error.message); return []; }
  const seen = new Set<number>();
  return ((data || []) as any[])
    .map((row) => (Array.isArray(row.sources) ? row.sources[0] : row.sources) as Source)
    .filter((s) => s && !seen.has(s.id) && !!seen.add(s.id))
    .sort((a, b) => a.happened_on.localeCompare(b.happened_on) || a.id - b.id);
}

/** Sources for several topics at once (a property page shows its topics' sources too), keyed by topic. */
export async function sourcesForMatters(supabase: SupabaseClient, matterIds: number[]): Promise<Map<number, Source[]>> {
  const out = new Map<number, Source[]>();
  if (!matterIds.length) return out;
  const { data, error } = await supabase.from("source_links").select(`matter_id, sources!inner(${FIELDS})`)
    .in("matter_id", matterIds).eq("hidden", false).eq("sources.hidden", false);
  if (error) { console.error("[sources] list failed:", error.message); return out; }
  for (const row of (data || []) as any[]) {
    const s = (Array.isArray(row.sources) ? row.sources[0] : row.sources) as Source;
    if (s) (out.get(row.matter_id) || out.set(row.matter_id, []).get(row.matter_id)!).push(s);
  }
  return out;
}

/** The page behind a link, as text: its title and the readable part of its body, for the draft. News sites and the
 * City's site are plain HTML; a PDF comes back as a note saying so (staff paste the quote then). */
export async function fetchPageText(url: string, signal?: AbortSignal): Promise<{ title: string; text: string; status: number }> {
  const video = youtubeId(url);
  if (video) return fetchYouTubeText(video, signal);
  const res = await fetch(url, {
    signal, redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 (compatible; OpenLangford/1.0; +https://openlangford.ca)", accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
  });
  const type = res.headers.get("content-type") || "";
  if (!res.ok) return { title: "", text: "", status: res.status };
  if (!/html|xml|text\/plain/i.test(type)) return { title: "", text: `(The link is a ${type.split(";")[0] || "file"}, not a web page; its text was not read.)`, status: res.status };
  const html = (await res.text()).slice(0, 2_000_000);
  const title = decode(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
    || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim();
  const published = html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|date|datePublished|pubdate)["'][^>]+content=["']([^"']+)/i)?.[1]
    || html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] || "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>|<!--[\s\S]*?-->/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 24_000);
  return { title, text: (published ? `Published: ${published}\n\n` : "") + text, status: res.status };
}

/** A YouTube video as text: its title and channel (the public embed endpoint), and the upload date and the uploader's
 * description from the watch page. The footage itself is not read; the draft says so. */
async function fetchYouTubeText(id: string, signal?: AbortSignal): Promise<{ title: string; text: string; status: number }> {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const headers = { "user-agent": "Mozilla/5.0 (compatible; OpenLangford/1.0; +https://openlangford.ca)", "accept-language": "en-CA,en;q=0.8" };
  const [oembed, html] = await Promise.all([
    fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`, { signal, headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<any>,
    fetch(watch, { signal, headers }).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
  ]);
  const uploaded = html.match(/<meta itemprop="uploadDate" content="([^"]+)"/)?.[1] || html.match(/"uploadDate":"([^"]+)"/)?.[1] || "";
  let description = "";
  const raw = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1];
  if (raw) { try { description = JSON.parse(`"${raw}"`); } catch { /* leave it out */ } }
  const title = String(oembed?.title || "").trim();
  const text = [
    title && `Video: ${title}`, oembed?.author_name && `Channel: ${oembed.author_name}`, uploaded && `Uploaded: ${uploaded.slice(0, 10)}`,
    description && `Description by the uploader:\n${description.slice(0, 4000)}`,
    "(The footage itself was not watched; this is the title, channel and the uploader's own description.)",
  ].filter(Boolean).join("\n");
  return { title, text: title || description ? text : "", status: title || description ? 200 : 404 };
}

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp|#8217|#8216|#8220|#8221|#8211|#8212);/g, (m, e) => ({
    amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " ", "#8217": "’", "#8216": "‘", "#8220": "“", "#8221": "”", "#8211": "–", "#8212": "—",
  })[e as string] ?? m);
}

export const DraftSchema = z.object({
  headline: z.string().describe("One line, at most 110 characters, saying what happened, in the resident register. No attribution in it; the page labels who said it."),
  happened_on: z.string().nullable().describe("The date the thing happened, YYYY-MM-DD, as precisely as the source says; null when the source gives none."),
  published_on: z.string().nullable().describe("The date the source was published, YYYY-MM-DD, or null."),
  publisher: z.string().describe("Who published it: the outlet or body's name."),
  title: z.string().describe("The page or article's own title."),
  quote: z.string().describe("The source's own words that back the headline, at most 300 characters, verbatim."),
  origin: z.enum(["city", "press", "other"]).describe("city when the publisher is the City of Langford itself; press for news; other for another body or document."),
  date_label: z.string().nullable().describe("When the source gives only a season or a month for the event (\"spring 2019\", \"June 2019\"), those words, capitalised, to show instead of a day; otherwise null."),
  caution: z.string().nullable().describe("One sentence for staff when something should be checked (the address is misprinted, the figure is an estimate, the page is an opinion piece); else null."),
});
export type SourceDraft = z.infer<typeof DraftSchema>;

const DRAFT_SYSTEM = `You help staff of Open Langford, a site that follows Langford City council, add a source from outside the meeting record to a page's timeline: a City news release, a public notice, or a news report.
You get the page's text (and sometimes a quote and a note from staff) and write the one-line entry a resident will read.
Rules:
- The headline says what happened to the thing this page is about, in plain words: "City buys the 22-acre waterfront lot for about $2.2M", "Council told to explore selling the Finlayson Arm land". Past tense or headline present; no "according to", no publisher name (the page labels who said it).
- Keep the concrete facts the source gives: the dollar amount, the size, the date. Round money the way the source does.
- Dates: when the event's date is only approximate, give happened_on your best day inside it and put the words the source uses in date_label ("Spring 2019"); happened_on is when the event happened; a report published in November about a purchase in spring gives happened_on in spring if the text says so, else the published date.
- The quote is verbatim from the text and backs the headline; prefer the sentence with the number in it. Staff's quote, when given, wins unless it is not in the text.
- For a video the text is only its title, channel and the uploader's own description; the footage was not watched. The headline says what the video shows as the uploader describes it, never more; the publisher is the channel; origin is "other"; happened_on is the upload date unless the description says when it was filmed; quote the uploader's own words; and say in caution that the footage itself was not checked and the claims are the uploader's.
- Never invent. If the page does not say what staff's note claims, write the headline from what the page does say and put the gap in caution.
- No bylaw, file or permit numbers. Canadian spelling.

${glossaryPromptBlock("resident", glossaryIds(["land", "money", "decisions"]))}`;

/** Read the link and propose the entry. ``what`` is staff's note on what happened; ``quote`` their chosen words. */
export async function draftSource(url: string, given: { quote?: string; date?: string; what?: string; subject?: string }, signal?: AbortSignal): Promise<SourceDraft & { pageTitle: string; fetched: boolean }> {
  const guess = publisherFor(url);
  let page = { title: "", text: "", status: 0 };
  try { page = await fetchPageText(url, signal); } catch (e) { page = { title: "", text: `(The page could not be read: ${e instanceof Error ? e.message : String(e)})`, status: 0 }; }
  const fetched = page.status >= 200 && page.status < 300 && !!page.text && !page.text.startsWith("(");
  const prompt = [
    `Link: ${url}`,
    `Publisher by host: ${guess.publisher || "unknown"} (origin ${guess.origin})`,
    given.subject ? `The page this goes on is about: ${given.subject}` : "",
    given.what ? `Staff say what happened: ${given.what}` : "",
    given.date ? `Staff give the date: ${given.date}` : "",
    given.quote ? `Staff's quote: “${tidyQuote(given.quote, 600)}”` : "",
    `Page title: ${page.title || "(none)"}`,
    `Page text:\n${page.text || "(none)"}`,
  ].filter(Boolean).join("\n");
  const ai = getAiClient();
  const { data } = await ai.json({ stage: "writing", system: DRAFT_SYSTEM, prompt, schema: DraftSchema, schemaName: "source_draft", signal });
  return {
    ...data,
    publisher: data.publisher || guess.publisher,
    origin: (["city", "press", "other"].includes(data.origin) ? data.origin : guess.origin) as SourceOrigin,
    quote: tidyQuote(data.quote || given.quote || ""),
    title: data.title || page.title || url,
    published_on: data.published_on || given.date || null,
    happened_on: data.happened_on || data.published_on || given.date || null,
    pageTitle: page.title, fetched,
  };
}

export type NewSource = {
  origin: SourceOrigin; publisher: string; title: string; url: string | null; published_on: string | null; happened_on: string;
  headline: string; quote: string | null; note: string | null; date_label?: string | null; compact?: boolean;
};

const UA = { "user-agent": "Mozilla/5.0 (compatible; OpenLangford/1.0; +https://openlangford.ca)" };

/** A Wayback Machine copy that already exists for the link (the availability API answers in a second), or null. */
export async function existingWaybackCopy(url: string, timeoutMs = 6_000): Promise<string | null> {
  const already = waybackArchiveUrl(url, null, null);
  if (already) return already;
  if (youtubeId(url)) return null;
  try {
    const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(timeoutMs), headers: UA });
    const data: any = res.ok ? await res.json() : null;
    const closest = data?.archived_snapshots?.closest;
    return closest?.available && typeof closest.url === "string" ? closest.url.replace(/^http:/, "https:") : null;
  } catch { return null; }
}

/** Ask the Wayback Machine to save the link and return the copy's address, or null when it declines or is slow.
 * Saving can take a minute, so this runs after the response (see addSource's ``later``). */
export async function archiveWithWayback(url: string, timeoutMs = 90_000): Promise<string | null> {
  const already = waybackArchiveUrl(url, null, null);
  if (already) return already;
  if (youtubeId(url)) return null;
  try {
    const res = await fetch(`https://web.archive.org/save/${url}`, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: UA });
    return waybackArchiveUrl(url, res.url, res.headers.get("content-location")) ?? await existingWaybackCopy(url);
  } catch (e) {
    console.warn("[sources] wayback save failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Fill in a source's archived copy once the Wayback Machine has one. Safe to call again for a row still without one. */
export async function archiveSource(supabase: SupabaseClient, sourceId: number, url: string): Promise<string | null> {
  const copy = await archiveWithWayback(url);
  if (copy) await supabase.from("sources").update({ archive_url: copy, archived_at: new Date().toISOString() }).eq("id", sourceId).is("archive_url", null);
  return copy;
}

/** Add a source and link it to the page it was added from. The same link added to a second page reuses the row.
 * The page's text is kept on the row (never shown; the checks read it) and a Wayback copy is requested. */
export async function addSource(supabase: SupabaseClient, input: NewSource, target: SourceTarget, userId: string, later: (work: Promise<unknown>) => void = (w) => { w.catch(() => {}); }): Promise<Source> {
  if (!input.headline.trim()) throw new Error("Could not add the source: it needs a headline.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.happened_on)) throw new Error("Could not add the source: the date must be YYYY-MM-DD.");
  if (!target.matterId && !target.propertyId) throw new Error("Could not add the source: no page to link it to.");
  let row: any = null;
  if (input.url) {
    const { data } = await supabase.from("sources").select(FIELDS).eq("url", input.url).eq("hidden", false).limit(1);
    row = data?.[0] ?? null;
  }
  if (!row) {
    // The text and any existing archive copy, both best effort: a page that won't read still gets its line.
    const [page, archive] = input.url
      ? await Promise.all([fetchPageText(input.url, AbortSignal.timeout(15_000)).catch(() => null), existingWaybackCopy(input.url)])
      : [null, null];
    const text = page && page.status >= 200 && page.status < 300 && !page.text.startsWith("(") ? page.text.slice(0, 60_000) : null;
    const now = new Date().toISOString();
    const { data, error } = await supabase.from("sources").insert({
      municipality_id: MUNICIPALITY, origin: input.origin, publisher: input.publisher.trim() || "Unknown", title: input.title.trim() || input.url || input.headline,
      url: input.url, published_on: input.published_on || null, happened_on: input.happened_on, headline: input.headline.trim(),
      quote: input.quote?.trim() || null, note: input.note?.trim() || null, added_by: userId,
      meta: { ...(input.date_label?.trim() ? { date_label: input.date_label.trim() } : {}), ...(input.compact ? { compact: true } : {}) },
      content_text: text, content_fetched_at: text ? now : null, archive_url: archive, archived_at: archive ? now : null,
    }).select(FIELDS).single();
    if (error) throw new Error(`Could not add the source: ${error.message}`);
    row = data;
    // No copy yet: ask the Wayback Machine to make one, after the response (it can take a minute).
    if (input.url && !archive) later(archiveSource(supabase, row.id, input.url));
  }
  const link = { source_id: row.id, matter_id: target.matterId || null, property_id: target.propertyId || null, hidden: false };
  const { data: existing } = await supabase.from("source_links").select("id").eq("source_id", row.id)
    .eq(target.matterId ? "matter_id" : "property_id", (target.matterId || target.propertyId)!).limit(1);
  if (existing?.length) await supabase.from("source_links").update({ hidden: false }).eq("id", existing[0].id);
  else {
    const { error } = await supabase.from("source_links").insert(link);
    if (error) throw new Error(`Could not link the source: ${error.message}`);
  }
  return row as Source;
}

/** Take a source off this page (its link is hidden; the source stays for any other page it is on). */
export async function removeSource(supabase: SupabaseClient, sourceId: number, target: SourceTarget): Promise<void> {
  let q = supabase.from("source_links").update({ hidden: true }).eq("source_id", sourceId);
  if (target.matterId) q = q.eq("matter_id", target.matterId);
  else if (target.propertyId) q = q.eq("property_id", target.propertyId);
  else throw new Error("Could not remove the source: no page given.");
  const { error } = await q;
  if (error) throw new Error(`Could not remove the source: ${error.message}`);
}

/** The sources as lines for the fact check and the fix agent: evidence for their own, attributed, claim only. Each
 * names its ref (source:<id>) so research can read the page's text. */
export function sourceRecordLines(sources: Source[]): string {
  if (!sources.length) return "";
  return sources.map((s) => `SOURCE source:${s.id} (${s.origin === "city" ? "City publication" : `reported by ${s.publisher}`}, ${s.happened_on}${s.published_on && s.published_on !== s.happened_on ? `, published ${s.published_on}` : ""}): ${s.headline}${s.quote ? ` — “${tidyQuote(s.quote)}”` : ""}`).join("\n");
}

export type SourceHit = Source & { preview: string };

/** Sources whose text, headline or quote mentions the query's words, for the research step's search. */
export async function searchSources(supabase: SupabaseClient, query: string): Promise<SourceHit[]> {
  const words = query.toLowerCase().split(/[^a-z0-9$.-]+/i).filter((w) => w.length > 3).slice(0, 4);
  if (!words.length) return [];
  const filters = words.flatMap((w) => [`headline.ilike.%${w}%`, `quote.ilike.%${w}%`, `content_text.ilike.%${w}%`]);
  const { data } = await supabase.from("sources").select(`${FIELDS}, content_text`).eq("hidden", false).or(filters.join(",")).limit(6);
  return ((data || []) as any[]).map((s) => {
    const text: string = s.content_text || "";
    const at = words.map((w) => text.toLowerCase().indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
    const preview = at >= 0 ? "…" + text.slice(Math.max(0, at - 120), at + 200).replace(/\s+/g, " ").trim() + "…" : tidyQuote(s.quote || s.headline);
    const { content_text: _omit, ...rest } = s;
    return { ...rest, preview };
  });
}

/** A source's page text as a record to read: who said it, when, the approved line, then the page's words. */
export async function readSource(supabase: SupabaseClient, id: number): Promise<string | null> {
  const { data } = await supabase.from("sources").select(`${FIELDS}, content_text, content_fetched_at`).eq("id", id).maybeSingle();
  if (!data) return null;
  const s = data as any;
  const who = s.origin === "city" ? "the City of Langford's own publication" : `reported by ${s.publisher}`;
  return `SOURCE source:${s.id} (${who}; happened ${s.happened_on}${s.published_on ? `, published ${s.published_on}` : ""})\n` +
    `Staff's approved line: ${s.headline}\n${s.quote ? `Quoted: “${s.quote}”\n` : ""}${s.url ? `Link: ${s.url}\n` : ""}${s.archive_url ? `Archived copy: ${s.archive_url}\n` : ""}` +
    `This is not Council's record: use it only with its attribution.\n\n` +
    (s.content_text ? `Page text as read on ${String(s.content_fetched_at || "").slice(0, 10)}:\n${s.content_text}` : "(The page's text was not kept.)");
}
