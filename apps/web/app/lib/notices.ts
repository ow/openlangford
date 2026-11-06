/**
 * Notices: short dated posts for residents (a change to when Council meets, a chance to have a say), written as
 * Markdown files in app/content/notices/ with a small header:
 *
 *   ---
 *   title: A short headline
 *   date: YYYY-MM-DD
 *   summary: One sentence for the list and the banner.
 *   banner_until: YYYY-MM-DD   (optional: a line across the top of every page through this day)
 *   change: What it was => What it is now | Meeting name | /meetings/<slug>
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
