import { sitemapDate } from "./sitemap";

/**
 * Dates for a topic page. matters.content_updated_at is set by database triggers whenever something a
 * reader sees changes (summary, title, status line, entries added, moved or hidden); last_seen is the
 * latest meeting that took the topic up. updated_at is a write stamp and is never used here.
 */
export interface TopicDates {
  first_seen?: string | null;
  last_seen?: string | null;
  content_updated_at?: string | null;
}

/**
 * Changes this soon after the latest meeting are that meeting being filed (items, minutes, the summary
 * rewritten to match), which the meeting date on the page already says; only later edits get a line.
 */
export const UPDATED_LINE_AFTER_DAYS = 14;

const DAY_MS = 86_400_000;
const LONG_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });

/** "November 5, 2026" for a date or timestamp, on its Langford calendar day. */
export function longCivicDate(value: string | null | undefined): string | null {
  const day = sitemapDate(value);
  return day ? LONG_DATE.format(new Date(`${day}T00:00:00Z`)) : null;
}

/** When the page last changed: the later of its last visible edit and its latest meeting. */
export function topicModified(t: TopicDates): string | null {
  const edited = sitemapDate(t.content_updated_at), met = sitemapDate(t.last_seen);
  if (edited && (!met || edited >= met)) return t.content_updated_at!;
  return t.last_seen || t.content_updated_at || null;
}

/** "Updated November 5, 2026" when the page changed well after its latest meeting; otherwise null. */
export function topicUpdatedLine(t: TopicDates): string | null {
  const edited = sitemapDate(t.content_updated_at);
  if (!edited) return null;
  const met = sitemapDate(t.last_seen || t.first_seen);
  if (met && Date.parse(edited) - Date.parse(met) <= UPDATED_LINE_AFTER_DAYS * DAY_MS) return null;
  return `Updated ${longCivicDate(edited)}`;
}
