/**
 * Which borrowed entries a topic's timeline shows, and which of its own entries are repeats.
 *
 * A related topic ("Background") is linked because it shares a name or address, which says nothing about whether it
 * is the same project: the 2010 cinema sign variances at 2945 Jacklin Road are not the 2017 vehicle showroom there.
 * Its entries join the timeline only when the two are one project: they share a bylaw or application number, or an
 * editor confirmed the link. Otherwise the related topic stays in the Background list, one click away.
 */

import { writtenLetters } from "./written";

// City-wide bylaws that nearly every application cites; they never identify a project (pipeline CITY_WIDE_BYLAWS).
const CITY_WIDE = new Set(["300", "1000", "500", "1200", "2200", "1160", "1250", "33", "34", "209"]);
const BYLAW = /\bbylaws?\s+(?:nos?\.?\s*)?(\d+(?:\s*(?:,|&|and)\s*\d+)*)/gi;
const APPLICATION = /\b[A-Z]{1,5}-?\d{2}-\d{2,5}[A-Z]?\b/g;

/** The bylaw and application numbers an identifier names ("Bylaw No. 1314; File No. Z-10-12"). */
export function projectNumbers(identifier: string | null | undefined): Set<string> {
  const text = String(identifier || "");
  const out = new Set<string>();
  for (const m of text.matchAll(BYLAW)) {
    for (const n of m[1].match(/\d+/g) || []) if (!CITY_WIDE.has(n)) out.add(`bylaw ${n}`);
  }
  for (const m of text.matchAll(APPLICATION)) out.add(m[0].toUpperCase().replace(/-(?=\d{2}-)/, ""));
  return out;
}

export function sameProject(a: Iterable<string | null | undefined>, b: string | null | undefined): boolean {
  const theirs = projectNumbers(b);
  if (!theirs.size) return false;
  for (const identifier of a) for (const n of projectNumbers(identifier)) if (theirs.has(n)) return true;
  return false;
}

type Link = { source?: string | null; review?: string | null };

/** Whether a related topic's entries belong on this topic's timeline. */
export function showsInTimeline(link: Link | undefined, ownIdentifiers: (string | null | undefined)[], related: { identifier?: string | null }) {
  if (link?.source === "reviewed_official_history" || link?.review === "accepted") return true;
  return sameProject(ownIdentifiers, related.identifier);
}

const STAGES: [RegExp, string][] = [
  [/\bfirst,? second,? (?:and|&) third\b|\bthree readings\b/i, "1-2-3"],
  [/\bsecond (?:and|&) third\b/i, "2-3"],
  [/\bfirst\b/i, "1"],
  [/\bsecond\b/i, "2"],
  [/\bthird\b/i, "3"],
  [/\badopt(?:ion|ed)\b/i, "adopt"],
];

/** The reading stage an entry is about, from its headline or title: "first", "second and third", "adoption". */
export function readingStage(text: string | null | undefined): string | null {
  const t = String(text || "");
  if (!/\breading|\badopt/i.test(t)) return null;
  for (const [re, stage] of STAGES) if (re.test(t)) return stage;
  return null;
}

const bylawNumbers = (text: string | null | undefined) =>
  new Set([...String(text || "").matchAll(/\bbylaw\s+(?:no\.?\s*)?(\d{3,5})\b/gi)].map((m) => m[1]));

type Entry = { kind: string; item?: any };

/**
 * Same-meeting repeats: "Bylaw listed for first reading" next to "First reading given" for the same bylaw at the
 * same meeting is one step. The "listed" entry (an agenda line with no decision of its own) is left out; both
 * records stay on the topic.
 */
export function collapseListedReadings<T extends Entry>(entries: T[], headlines: Record<string, string> = {}): T[] {
  const primary = entries.filter((e) => e.kind === "primary" && e.item);
  const headline = (e: T) => headlines[String(e.item.id)] || "";
  const isListed = (e: T) => /\blisted\b/i.test(headline(e));
  const stageOf = (e: T) => readingStage(`${headline(e)} ${String(e.item.title || "").split("\n")[0]}`);
  const sameBylaw = (a: T, b: T) => {
    const x = bylawNumbers(a.item.title), y = bylawNumbers(b.item.title);
    return !x.size || !y.size || [...x].some((n) => y.has(n));
  };
  const drop = new Set<number>();
  for (const a of primary) {
    const stage = isListed(a) ? stageOf(a) : null;
    if (!stage) continue;
    if (primary.some((b) => b !== a && b.item.meeting_id === a.item.meeting_id && !isListed(b) && stageOf(b) === stage && sameBylaw(a, b))) {
      drop.add(a.item.id);
    }
  }
  return drop.size ? entries.filter((e) => !(e.kind === "primary" && e.item && drop.has(e.item.id))) : entries;
}

const REPORT = /^\s*(?:\d+[.)]?\s*)?(?:staff\s+)?(?:report|application|memo|memorandum|request)\b/i;
const motionText = (item: any) => (item.motions || []).map((m: any) => `${m.text_content || ""} ${m.plain_english_summary || ""}`).join(" ");
const hasSpeakers = (item: any) => Boolean(item.meta?.participation?.speakers?.length || writtenLetters(item.meta?.written_participation).length);

/**
 * One meeting's handling of a topic, filed as two agenda items, is one step: the staff report next to the bylaw
 * reading it recommended (the report has no decision of its own), or two items giving the same readings to the same
 * bylaw. The folded item's documents join the step it folds into (``folded``); both records stay on the topic.
 * A public hearing, or anything with speakers or letters, is a step of its own and never folded.
 */
export function foldSameMeetingSteps<T extends Entry & { folded?: any[] }>(entries: T[], headlines: Record<string, string> = {}): T[] {
  const primary = entries.filter((e) => e.kind === "primary" && e.item?.meeting_id != null);
  const stage = (e: T) => readingStage(`${headlines[String(e.item.id)] || ""} ${motionText(e.item)}`);
  const title = (e: T) => String(e.item.title || "").split("\n")[0];
  const sameBylaw = (a: T, b: T) => {
    const x = bylawNumbers(`${a.item.title} ${motionText(a.item)}`), y = bylawNumbers(`${b.item.title} ${motionText(b.item)}`);
    return !x.size || !y.size || [...x].some((n) => y.has(n));
  };
  const foldable = (e: T) => !hasSpeakers(e.item) && !/\bhearing\b/i.test(`${title(e)} ${headlines[String(e.item.id)] || ""}`);
  const into = new Map<T, T>();
  for (const a of primary) {
    if (!foldable(a)) continue;
    const others = primary.filter((b) => b !== a && b.item.meeting_id === a.item.meeting_id && !into.has(b) && sameBylaw(a, b));
    let target: T | undefined;
    if (!(a.item.motions || []).length && REPORT.test(title(a))) {
      target = others.find((b) => (b.item.motions || []).length > 0);
    } else if (stage(a)) {
      // The same readings twice: keep the item whose motion says more (the report's carries its other directions).
      target = others.find((b) => stage(b) === stage(a) && motionText(b.item).length >= motionText(a.item).length);
    }
    if (target && into.get(target) !== a) into.set(a, target);
  }
  if (!into.size) return entries;
  const folded = new Map<T, any[]>();
  for (const [a, b] of into) {
    let root = b;
    while (into.has(root)) root = into.get(root)!;
    folded.set(root, [...(folded.get(root) || []), a.item]);
  }
  return entries.filter((e) => !into.has(e)).map((e) => (folded.has(e) ? { ...e, folded: [...(e.folded || []), ...folded.get(e)!] } : e));
}
