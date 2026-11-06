/**
 * Notices: short dated posts for residents (a change to when Council meets, a chance to have a say), written as
 * Markdown files in app/content/notices/ with a small header:
 *
 *   ---
 *   title: Council moves its last two meetings of 2026 earlier
 *   date: 2026-11-05
 *   summary: One sentence for the list and the banner.
 *   banner_until: 2026-12-09   (optional: a line on the home and meetings pages through this day)
 *   change: Mon, Nov 23 · 7:00 pm => Tue, Nov 24 · 5:30 pm | Regular Council | /meetings/2026-11-24-special-council
 *     (optional, one line each: a was/now card at the top; the meeting's name and page link are optional)
 *   ---
 *
 * The file name (without .md) is the page's address: /notices/<name>.
 */
export type Notice = {
  slug: string; title: string; date: string; summary: string; bannerUntil: string | null; body: string;
  /** Each change at a glance (a meeting moved, say): what it was and what it is now. */
  changes: Change[];
};
export type Change = { was: string; now: string; meeting: string | null; href: string | null };

const files = import.meta.glob("../content/notices/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function parse(path: string, raw: string): Notice | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const head: Record<string, string> = {};
  const changes: Change[] = [];
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim(), value = line.slice(at + 1).trim();
    if (key === "change" && value.includes("=>")) {
      const [times, meeting, href] = value.split("|").map((s) => s.trim());
      const [was, now] = times.split("=>").map((s) => s.trim());
      if (was && now) changes.push({ was, now, meeting: meeting || null, href: href?.startsWith("/") ? href : null });
    } else head[key] = value;
  }
  if (!head.title || !/^\d{4}-\d{2}-\d{2}$/.test(head.date || "")) return null;
  return {
    slug: path.split("/").pop()!.replace(/\.md$/, ""),
    title: head.title,
    date: head.date,
    summary: head.summary || "",
    bannerUntil: /^\d{4}-\d{2}-\d{2}$/.test(head.banner_until || "") ? head.banner_until : null,
    changes,
    body: match[2].trim(),
  };
}

/** Every notice, newest first. */
export const NOTICES: Notice[] = Object.entries(files)
  .map(([path, raw]) => parse(path, raw))
  .filter((n): n is Notice => !!n)
  .sort((a, b) => b.date.localeCompare(a.date));

export const noticeBySlug = (slug: string) => NOTICES.find((n) => n.slug === slug) ?? null;

/** The newest notice whose banner runs through `day` (YYYY-MM-DD, Langford time), if any. */
export const bannerNotice = (day: string) => NOTICES.find((n) => n.bannerUntil && n.date <= day && day <= n.bannerUntil) ?? null;
