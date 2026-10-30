import { recordDate } from "./page-meta";

type MeetingLike = { title: string; meeting_date: string; summary?: string | null; meta?: any };

/** "(Bylaw 2299)", "(TUP26-0004)", "(Zoning Bylaw 2110)": codes stay out of running text. */
const CODE_PARENS = /\s*\((?=[^)]*\d)[^)]*\)/g;

/** A summary bullet as a sentence: no list marker, no codes, ends with a full stop. */
function sentence(bullet: string): string {
  const text = bullet.replace(/^\s*[-*•]\s*/, "").replace(CODE_PARENS, "").replace(/\s+/g, " ").trim().replace(/[;,:.\s]+$/, "");
  return text ? `${text}.` : "";
}

/**
 * The meeting's own words for search results and share cards: the meeting-highlights stage's
 * description when there is one, else the first points of the summary as sentences
 * ("May 19, 2026: Council approved …"), else a plain line about what the page has.
 */
export function meetingDescription(m: MeetingLike): string {
  const date = recordDate(m.meeting_date);
  const highlight = m.meta?.highlights?.description;
  if (typeof highlight === "string" && highlight.trim()) return highlight.trim();
  const bullets = (m.summary || "").split(/\n+/).map(sentence).filter(Boolean);
  if (bullets.length) {
    // Bullets start with what happened ("Adopted …", "Recommended …"); name who did it.
    const subject = /council/i.test(m.title) ? "Council" : `The ${m.title}`;
    const [first, ...rest] = bullets;
    const lead = /^[A-Z][a-z]+ed\b/.test(first) ? `${subject} ${first[0].toLowerCase()}${first.slice(1)}` : first;
    return [`${date}: ${lead}`, ...rest].join(" ");
  }
  return `${date}: agenda, minutes, video and decisions from Langford’s ${m.title} meeting.`;
}
