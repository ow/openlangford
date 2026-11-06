import { highlightPoints } from "./meeting-summary";

/** The meeting list shows this many highlight points per row (MeetingCard's MeetingSummary limit). */
export const LIST_HIGHLIGHT_LIMIT = 3;

/**
 * Trim a meeting row to what the /meetings list renders, so the loader payload carries no unseen text.
 * The rendered HTML is unchanged: a row shows at most three points, and `summary` is only read for
 * "does this meeting have one" (and the fallback text when there are no highlights).
 * - highlights: first three bullets and their links (what the card renders), nothing else;
 * - summary: when highlights exist, the first bullet stands in for the long summary text.
 */
export function shapeListMeeting<M extends { summary?: string | null; highlights?: any }>(meeting: M): M {
  const points = highlightPoints(meeting);
  if (!points) return meeting;
  const shown = points.slice(0, LIST_HIGHLIGHT_LIMIT);
  return {
    ...meeting,
    summary: meeting.summary ? shown[0].text : meeting.summary,
    highlights: { bullets: shown.map((p) => p.text), links: shown.map((p) => p.links) },
  };
}
