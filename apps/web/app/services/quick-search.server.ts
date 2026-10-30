import { getSupabaseAdminClient } from "../lib/supabase.server";
import { matterPath, meetingPath } from "../lib/paths";
import { personPath } from "../lib/people-paths";
import { matterTitle } from "../lib/display-text";
import { matterQuickScore } from "../lib/matter-rank";

/**
 * Instant "jump to" matches for the search box and ⌘K palette: people,
 * matters (title / bylaw number / address), meetings (by date or type) and
 * bylaws. Plain indexed lookups — no AI, fast enough to run on every keystroke.
 */
export type QuickMatchType = "person" | "matter" | "meeting" | "bylaw" | "property";

export interface QuickMatch {
  type: QuickMatchType;
  id: number;
  title: string;
  subtitle?: string;
  href: string;
  score: number;
  /** Strong enough to navigate straight to on Enter. */
  exact: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function normalize(q: string) {
  return q.toLowerCase().replace(/[^\p{L}\p{N}\s.-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** "june 29", "jun 29 2026", "2026-06-29", "29 june" → { month, day, year? } */
export function parseMeetingDate(q: string): { month: number; day: number; year?: number } | null {
  const iso = q.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return { year: +iso[1], month: +iso[2], day: +iso[3] };
  const md = q.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/);
  const dm = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})(?:,?\s+(20\d{2}))?\b/);
  const pick = md
    ? { mon: md[1], day: md[2], year: md[3] }
    : dm
      ? { mon: dm[2], day: dm[1], year: dm[3] }
      : null;
  if (!pick) return null;
  const month = MONTHS[pick.mon.slice(0, 4)] ?? MONTHS[pick.mon.slice(0, 3)];
  const day = +pick.day;
  if (!month || day < 1 || day > 31) return null;
  return { month, day, year: pick.year ? +pick.year : undefined };
}

function nameScore(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n === q) return 100;
  const last = n.split(/\s+/).pop() || "";
  if (last === q) return 92;
  if (n.startsWith(q)) return 85;
  if (n.split(/\s+/).some((part) => part.startsWith(q))) return 75;
  return n.includes(q) ? 60 : 0;
}

export async function quickSearch(rawQuery: string, limit = 8): Promise<QuickMatch[]> {
  const q = normalize(rawQuery);
  if (q.length < 2) return [];
  const supabase = getSupabaseAdminClient();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const matches: QuickMatch[] = [];

  // "bylaw 2110" / "no. 2110" / a bare 4-digit number — but not the street
  // number in "854 Latoria".
  const bylawNo =
    q.match(/\b(?:bylaw|by-law|no\.?|number|#)\s*(\d{3,4})\b/)?.[1] ?? q.match(/^(\d{4})$/)?.[1];
  const address = !bylawNo && /^\s*#?\d+[a-z]?\s*[-–]?\s*\d*\s+[a-z]/.test(q) ? q : null;
  const date = parseMeetingDate(q);

  const [people, matters, bylawMatters, addressItems, meetings, properties] = await Promise.all([
    supabase.from("people").select("id, name, slug, is_councillor").ilike("name", like).limit(10),
    supabase
      .from("matters")
      .select("id, slug, title, identifier, category, status, last_seen, meta")
      .or(`title.ilike.${like},meta->>display_title.ilike.${like},identifier.ilike.${like}`)
      .is("meta->>canonical_matter_id", null)
      .is("meta->>hidden", null)
      .order("last_seen", { ascending: false, nullsFirst: false })
      .limit(8),
    bylawNo
      ? supabase
          .from("matters")
          .select("id, slug, title, identifier, category, status, last_seen, meta")
          .or(`identifier.ilike.%${bylawNo}%,title.ilike.%no. ${bylawNo}%,title.ilike.%bylaw ${bylawNo}%`)
          .order("last_seen", { ascending: false, nullsFirst: false })
          .limit(5)
      : Promise.resolve({ data: [] as any[] }),
    address
      ? supabase
          .from("agenda_items")
          .select("matter_id, related_address, matters!inner(id, slug, title, category, last_seen, meta)")
          .ilike("related_address", like)
          .not("matter_id", "is", null)
          .limit(10)
      : Promise.resolve({ data: [] as any[] }),
    date
      ? supabase
          .from("meetings")
          .select("id, slug, title, meeting_date, type")
          .order("meeting_date", { ascending: false })
          .limit(2000)
          .then((res: any) => ({
            ...res,
            data: (res.data || [])
              .filter((m: any) => {
                const [y, mo, d] = String(m.meeting_date).split("-").map(Number);
                return mo === date.month && d === date.day && (!date.year || y === date.year);
              })
              .slice(0, 5),
          }))
      : supabase
          .from("meetings")
          .select("id, slug, title, meeting_date, type")
          .ilike("title", like)
          .order("meeting_date", { ascending: false })
          .limit(3),
    // Lots ("2750 leigh") and streets ("leigh road"); spelling of the street type varies, so match the start.
    q.length >= 4
      ? supabase.from("properties").select("id, slug, address, civic_number").eq("hidden", false).ilike("address", `${q.replace(/[%_]/g, "").replace(/\s+(rd|road|ave|avenue|dr|drive|st|street|pl|place|pkwy|parkway|cres|crescent|way|hwy|highway)\.?$/, "")}%`).limit(5)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  for (const p of people.data || []) {
    const s = nameScore(p.name, q) + (p.is_councillor ? 5 : 0);
    if (!s) continue;
    matches.push({
      type: "person",
      id: p.id,
      title: p.name,
      subtitle: p.is_councillor ? "Council member" : "Public participant",
      href: personPath(p),
      score: s,
      exact: s >= 90,
    });
  }

  for (const m of bylawMatters.data || []) {
    matches.push({
      type: "matter",
      id: m.id,
      title: matterTitle(m),
      subtitle: [m.identifier, m.category].filter(Boolean).join(" · "),
      href: matterPath(m),
      score: 95,
      exact: true,
    });
  }

  const seenMatters = new Set(matches.filter((m) => m.type === "matter").map((m) => m.id));
  for (const row of addressItems.data || []) {
    const m = (row as any).matters;
    if (!m || seenMatters.has(m.id)) continue;
    seenMatters.add(m.id);
    matches.push({
      type: "matter",
      id: m.id,
      title: matterTitle(m),
      subtitle: `${m.category || "Matter"} · at this address`,
      href: matterPath(m),
      score: 88,
      exact: false,
    });
  }

  // The address page (everything at that lot or on that street) outranks individual matters there.
  for (const p of properties.data || []) {
    const exact = p.address.toLowerCase() === q || (properties.data || []).length === 1;
    matches.push({
      type: "property",
      id: p.id,
      title: p.address,
      subtitle: p.civic_number ? "Everything council considered at this address" : "Street",
      href: `/properties/${p.slug}`,
      score: exact ? 96 : 89,
      exact,
    });
  }

  // A single matter at the searched address is an unambiguous hit.
  const addressHits = matches.filter((m) => m.subtitle?.endsWith("at this address"));
  if (addressHits.length === 1) addressHits[0].exact = true;

  for (const m of matters.data || []) {
    if (seenMatters.has(m.id)) continue;
    seenMatters.add(m.id);
    const { score, exact } = matterQuickScore(m, q);
    matches.push({
      type: "matter",
      id: m.id,
      title: matterTitle(m),
      subtitle: [m.identifier, m.category, m.status !== "Active" ? m.status : null].filter(Boolean).join(" · "),
      href: matterPath(m),
      score,
      exact,
    });
  }

  for (const mt of meetings.data || []) {
    matches.push({
      type: "meeting",
      id: mt.id,
      title: mt.title,
      subtitle: new Date(`${mt.meeting_date}T12:00:00`).toLocaleDateString("en-CA", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      href: meetingPath(mt),
      score: date ? 90 : 50,
      exact: Boolean(date) && (meetings.data || []).length === 1,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  // Only flag a single, unambiguous top hit as exact.
  if (matches.length > 1 && matches[0].score === matches[1].score) matches[0].exact = false;
  return matches.slice(0, limit);
}
