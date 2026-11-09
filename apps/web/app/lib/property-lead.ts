/** A property page's lead ends with a line the pipeline computes ("Mentioned in council meetings 12 times since 2009.").
 * Whoever rewrites the lead, a person or the fix agent, keeps that line rather than writing one. */
const CLOSING = /(?:^|\s)(Mentioned in council meetings[^.]*\.)\s*$/;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The lead split into what a reader's editor works on and its computed closing line (null when it has none). */
export function splitLead(lead: string | null | undefined): { body: string; closing: string | null } {
  const text = squash(lead || "");
  const closing = text.match(CLOSING)?.[1] ?? null;
  return { body: closing ? text.slice(0, text.length - closing.length).trim() : text, closing };
}

/** The new lead with the old one's closing count line kept, since the pipeline computes that line and nobody
 * rewriting the lead should guess it. A new text that already says it is left alone. */
export function withClosing(oldLead: string | null | undefined, text: string): string {
  const body = squash(text);
  const closing = (oldLead || "").match(CLOSING)?.[1];
  if (!closing || /Mentioned in council meetings/i.test(body)) return body;
  return `${body.replace(/\s+$/, "")} ${closing}`;
}
