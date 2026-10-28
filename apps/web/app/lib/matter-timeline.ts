import { normalizeMotionResult } from "./motion-utils";

/** What happened to a matter at one meeting; ordered most to least decisive. */
export type AppearanceOutcome = "passed" | "defeated" | "deferred" | "comment" | "discussed";
export const OUTCOME_ORDER: AppearanceOutcome[] = ["passed", "defeated", "deferred", "comment", "discussed"];
export const OUTCOME_LABEL: Record<AppearanceOutcome, string> = {
  passed: "Passed",
  defeated: "Defeated",
  deferred: "Deferred or referred",
  comment: "Public comment",
  discussed: "Discussed",
};

type MotionLike = { result?: string | null; disposition?: string | null; text_content?: string | null };
export type StripEntry = {
  key: string;
  date: string | null | undefined;
  meetingId?: number | null;
  kind: "primary" | "evidence" | "mention";
  title?: string | null;
  headline?: string | null;
  motions?: MotionLike[] | null;
  hasSpeakers?: boolean;
};

const DEFER_TEXT = /\b(defer(red|ral)?|postpone[ds]?|tabled?|refer(red)?\s+(back|to\s+(staff|the|a)\b)|withdrawn?|take no action\b.*\buntil)\b/i;
const COMMENT_TITLE = /public (participation|input|hearing|comment)|question period|delegation|petition|correspondence/i;

const AMENDMENT = /^\s*amendment\b|\bmain motion be amended\b/i;

/** One motion's effect, or null when it records no result or only changes another motion's wording. */
export function motionOutcome(m: MotionLike): "passed" | "defeated" | "deferred" | null {
  if (m.disposition === "Amended" || AMENDMENT.test(m.text_content || "")) return null;
  const r = normalizeMotionResult(m.result);
  if (r === "tabled" || r === "withdrawn" || /^(referred|tabled|withdrawn)$/i.test(m.disposition || "")) return "deferred";
  if (r === "failed") return "defeated";
  if (r === "passed") return DEFER_TEXT.test(m.text_content || "") ? "deferred" : "passed";
  return null;
}

/** Classify everything recorded for one meeting into a single outcome. */
export function classifyAppearance(entries: StripEntry[]): AppearanceOutcome {
  const found = new Set<AppearanceOutcome>();
  for (const e of entries) {
    const outcomes = (e.motions || []).map(motionOutcome).filter((o) => o !== null);
    outcomes.forEach((o) => found.add(o));
    // Motions were moved but minutes gave no result: fall back to the item's plain-English headline.
    if (e.motions?.length && !outcomes.length && e.headline) {
      if (/\b(defeated|rejected|refused|denied)\b/i.test(e.headline)) found.add("defeated");
      else if (DEFER_TEXT.test(e.headline) || /\bon hold\b|\bpaused\b/i.test(e.headline)) found.add("deferred");
    }
    if (e.kind !== "evidence" && (COMMENT_TITLE.test(e.title || "") || (e.hasSpeakers && !(e.motions || []).length))) found.add("comment");
  }
  return OUTCOME_ORDER.find((o) => found.has(o)) || "discussed";
}

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const toMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const monthYear = (d: string) => `${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;

/** "3 days", "4 weeks", "5 months", "2 years" — rounded, for a glanceable span label. */
export function spanLabel(start: string, end: string): string {
  const days = Math.round((toMs(end) - toMs(start)) / DAY);
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (days < 14) return unit(Math.max(days, 1), "day");
  if (days < 70) return unit(Math.round(days / 7), "week");
  if (days < 730) return unit(Math.round(days / 30.44), "month");
  const years = days / 365.25;
  return `${years < 5 ? Math.round(years * 2) / 2 : Math.round(years)} years`;
}

export type StripMark = { date: string; x: number; outcome: AppearanceOutcome; anchor: string; count: number };
export type Strip = {
  start: string;
  end: string;
  ongoing: boolean;
  label: string;
  marks: StripMark[];
  ticks: { x: number; label: string }[];
};

/**
 * One mark per meeting on a linear date scale from first appearance to last (or today
 * when the matter is still open). x is a 0–100 percentage; year ticks appear once the
 * span is long enough for months to be noise.
 */
export function buildStrip(entries: StripEntry[], { today, ongoing = false }: { today: string; ongoing?: boolean }): Strip | null {
  const groups = new Map<string, StripEntry[]>();
  for (const e of entries) {
    if (!e.date) continue;
    const day = e.date.slice(0, 10);
    const key = `${day}|${e.meetingId ?? ""}`;
    groups.set(key, [...(groups.get(key) || []), e]);
  }
  if (!groups.size) return null;
  const days = [...groups.keys()].map((k) => k.slice(0, 10)).sort();
  const start = days[0];
  const last = days[days.length - 1];
  const end = ongoing && today > last ? today : last;
  const span = toMs(end) - toMs(start);
  const x = (d: string) => (span > 0 ? ((toMs(d) - toMs(start)) / span) * 100 : 50);
  const marks = [...groups.entries()]
    .map(([key, list]) => ({
      date: key.slice(0, 10),
      x: x(key.slice(0, 10)),
      outcome: classifyAppearance(list),
      anchor: list[0].key,
      count: list.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const ticks: Strip["ticks"] = [];
  if (span >= 540 * DAY) {
    const step = span > 12 * 365 * DAY ? 5 : span > 6 * 365 * DAY ? 2 : 1;
    for (let y = +start.slice(0, 4) + 1; y <= +end.slice(0, 4); y++) {
      if (y % step === 0) ticks.push({ x: x(`${y}-01-01`), label: String(y) });
    }
  }
  const endLabel = ongoing && end === today ? "today" : monthYear(end);
  const range = endLabel === monthYear(start) ? endLabel : `${monthYear(start)} – ${endLabel}`;
  const label = start === end ? `${monthYear(start)} · 1 meeting` : `${range} · ${spanLabel(start, end)}`;
  return { start, end, ongoing, label, marks, ticks };
}
