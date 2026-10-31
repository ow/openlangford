/**
 * Closed (in-camera) council sessions, from `meetings.meta.closed_session` (pipeline stage
 * `closed-sessions`). Browser-safe: wording for the meeting page and the /meetings/closed
 * summary. Lengths are estimates from the public minutes; unknown stays unknown.
 */

export interface ClosedSession {
  closed_at: string | null;
  reconvened_at: string | null;
  reasons: string[];
  reason_labels: string[];
  source: "minutes" | "decision" | "notice" | "agenda";
  position: "end" | "middle" | null;
}

export interface ClosedSessionMeta {
  sessions: ClosedSession[];
  called_at: string | null;
  adjourned_at: string | null;
  est_closed_minutes: number | null;
  open_minutes: number | null;
  method: "minutes" | "opening" | "video" | "transcript" | "none";
  confidence: "high" | "medium" | "low" | "none";
  version: string;
}

/** Unique plain-word reasons across a meeting's closed sessions, in the order given. */
export function closedReasons(meta: ClosedSessionMeta | null | undefined): string[] {
  const out: string[] = [];
  for (const s of meta?.sessions ?? []) for (const label of s.reason_labels ?? []) if (!out.includes(label)) out.push(label);
  return out;
}

/** "about 45 minutes", "about 1 hour 20 minutes", "about 3 hours". */
export function aboutDuration(minutes: number): string {
  if (minutes < 60) {
    const m = minutes < 10 ? Math.max(1, Math.round(minutes)) : Math.round(minutes / 5) * 5;
    return `about ${m} minute${m === 1 ? "" : "s"}`;
  }
  const rounded = Math.round(minutes / 10) * 10;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return `about ${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} minutes` : ""}`;
}

/** "land, legal advice"; past three reasons, "and more". */
export function reasonList(reasons: string[], max = 3): string {
  return reasons.slice(0, max).join(", ") + (reasons.length > max ? " and more" : "");
}

/** "Council met privately for about 45 minutes (land, legal advice)"; null when it didn't. */
export function closedSessionSentence(meta: ClosedSessionMeta | null | undefined, body = "Council"): string | null {
  if (!meta?.sessions?.length) return null;
  const minutes = meta.est_closed_minutes;
  const length = minutes != null && minutes > 0 ? ` for ${aboutDuration(minutes)}` : "";
  const reasons = closedReasons(meta);
  return `${body} met privately${length}${reasons.length ? ` (${reasonList(reasons)})` : ""}`;
}

// ── summary across meetings ──────────────────────────────────────────────

export interface ClosedRow {
  id: number;
  slug: string | null;
  title: string;
  meeting_date: string;
  closed: ClosedSessionMeta | null;
}

export interface TermLike {
  name: string;
  start_date: string;
  end_date: string | null;
}

/** A term or year counts as measurable when the minutes time at least this share of its closed sessions. */
export const MEASURABLE_SHARE = 0.8;

export interface TermSummary {
  name: string;
  start_date: string;
  end_date: string;
  /** Days in office covered by the records (up to today for a sitting council). */
  days: number;
  meetings: number;
  sessions: number;
  perYear: number | null;
  timedSessions: number;
  measurable: boolean;
  /** Estimated hours closed (measurable terms only). */
  closedHours: number | null;
  /** Estimated share of meeting time closed, 0–1 (measurable terms only). */
  closedShare: number | null;
  /** Meetings whose open and closed time are both known (the base of `closedShare`). */
  timedMeetings: number;
  topReasons: { label: string; count: number }[];
}

export interface YearSummary {
  year: number;
  sessions: number;
  measurable: boolean;
  closedHours: number | null;
  closedShare: number | null;
}

const dayNumber = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86_400_000;

function tally(rows: ClosedRow[]) {
  let sessions = 0, timedSessions = 0, closed = 0, open = 0, timedMeetings = 0;
  const reasons = new Map<string, number>();
  for (const r of rows) {
    const c = r.closed;
    if (!c) continue;
    const n = c.sessions?.length ?? 0;
    sessions += n;
    if (n && c.est_closed_minutes != null) timedSessions += n;
    if (c.est_closed_minutes != null && c.open_minutes != null) {
      closed += c.est_closed_minutes;
      open += c.open_minutes;
      timedMeetings += 1;
    }
    for (const s of c.sessions ?? []) for (const label of s.reason_labels ?? []) reasons.set(label, (reasons.get(label) ?? 0) + 1);
  }
  const measurable = sessions > 0 && timedSessions / sessions >= MEASURABLE_SHARE;
  return {
    sessions, timedSessions, timedMeetings, measurable,
    closedHours: measurable ? closed / 60 : null,
    closedShare: measurable && closed + open > 0 ? closed / (closed + open) : null,
    topReasons: [...reasons].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

/** Per-term figures, oldest first. Rows outside every term are ignored. */
export function summariseTerms(rows: ClosedRow[], terms: TermLike[], today: string): TermSummary[] {
  return [...terms]
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
    .filter((t) => t.start_date <= today)
    .map((t) => {
      const end = t.end_date && t.end_date < today ? t.end_date : today;
      const inTerm = rows.filter((r) => r.meeting_date >= t.start_date && r.meeting_date <= end);
      const days = dayNumber(end) - dayNumber(t.start_date) + 1;
      const s = tally(inTerm);
      return {
        name: t.name, start_date: t.start_date, end_date: end, days,
        meetings: inTerm.length,
        sessions: s.sessions,
        // A council a few weeks old has no fair yearly rate yet.
        perYear: days >= 90 ? s.sessions / (days / 365.25) : null,
        timedSessions: s.timedSessions,
        measurable: s.measurable,
        closedHours: s.closedHours,
        closedShare: s.closedShare,
        timedMeetings: s.timedMeetings,
        topReasons: s.topReasons.slice(0, 3),
      };
    });
}

export function summariseYears(rows: ClosedRow[]): YearSummary[] {
  const years = new Map<number, ClosedRow[]>();
  for (const r of rows) {
    const y = +r.meeting_date.slice(0, 4);
    years.set(y, [...(years.get(y) ?? []), r]);
  }
  // A first year our records only partly cover (they start December 2008) would read as a near-empty bar.
  const first = rows.length ? rows.reduce((a, b) => (a.meeting_date < b.meeting_date ? a : b)).meeting_date : null;
  if (first && first.slice(5) > "01-31") years.delete(+first.slice(0, 4));
  return [...years.keys()].sort((a, b) => a - b).map((year) => {
    const s = tally(years.get(year)!);
    return { year, sessions: s.sessions, measurable: s.measurable, closedHours: s.closedHours, closedShare: s.closedShare };
  });
}

/** Most recent meetings with a closed session, newest first. */
export function recentClosed(rows: ClosedRow[], limit = 12): ClosedRow[] {
  return rows
    .filter((r) => r.closed?.sessions?.length)
    .sort((a, b) => b.meeting_date.localeCompare(a.meeting_date))
    .slice(0, limit);
}

/** Plain explanations of the section 90 reasons, keyed by the stored label. */
export const REASON_EXPLAINERS: Record<string, string> = {
  "land": "Buying, selling or leasing land or buildings, when talking in public could hurt the City's position.",
  "legal advice": "Advice from the City's lawyers, which is confidential the same way it is for anyone else.",
  "staff and appointments": "Hiring, firing or appointing people, including to boards and committees.",
  "negotiating a possible new City service": "Early, confidential negotiations about a service the City might start providing, such as a new facility or a partnership to run one. The law lets Council keep these private while talking about them in public could harm the City's interests.",
  "labour relations": "Bargaining and other matters with City employees and their unions.",
  "lawsuits": "Lawsuits the City is part of, or might be.",
  "confidential business information": "Information a business gave the City in confidence, such as financial details.",
  "awards and honours": "Choosing people for City awards and honours.",
  "annual report goals": "Planning the goals that go in the City's annual report, before they are published.",
  "confidential talks with other governments": "Negotiations with the province or federal government that they asked to keep private.",
  "security of City property": "Keeping City property secure.",
  "law enforcement": "Policing and law enforcement, when talking in public could harm an investigation.",
};
