/** Pure data shaping for the meetings year heatmap and the property records-per-year sparkline. */

const DAY = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type HeatMeeting = { id: number; slug?: string | null; title: string; meeting_date: string; items: number; seconds: number | null };
export type HeatDay = { date: string; col: number; row: number; meetings: HeatMeeting[]; items: number; seconds: number | null; level: number };

/** Agenda items per day → shade (0 = no meeting). Fixed cut-offs so years compare. */
export const HEAT_LEVELS = [1, 8, 16, 30];
export function heatLevel(items: number, hasMeeting: boolean) {
  if (!hasMeeting) return 0;
  let level = 1;
  HEAT_LEVELS.forEach((min, i) => {
    if (items >= min) level = i + 1;
  });
  return level;
}

/**
 * A GitHub-style year: one column per week (Monday first), one row per weekday, every day of `year`.
 * Days with meetings combine them (items and seconds summed); months label the column holding their 1st.
 */
export function yearGrid(year: number, meetings: HeatMeeting[]) {
  const byDate = new Map<string, HeatMeeting[]>();
  for (const m of meetings) {
    if (!m.meeting_date?.startsWith(`${year}-`)) continue;
    const key = m.meeting_date.slice(0, 10);
    byDate.set(key, [...(byDate.get(key) || []), m]);
  }
  const start = Date.UTC(year, 0, 1);
  const offset = (new Date(start).getUTCDay() + 6) % 7;
  const days: HeatDay[] = [];
  const months: { label: string; col: number }[] = [];
  for (let t = start; new Date(t).getUTCFullYear() === year; t += DAY) {
    const d = new Date(t);
    const date = d.toISOString().slice(0, 10);
    const index = Math.round((t - start) / DAY) + offset;
    const col = Math.floor(index / 7);
    if (d.getUTCDate() === 1) months.push({ label: MONTHS[d.getUTCMonth()], col });
    const list = byDate.get(date) || [];
    const items = list.reduce((sum, m) => sum + (m.items || 0), 0);
    const timed = list.filter((m) => m.seconds);
    days.push({
      date,
      col,
      row: index % 7,
      meetings: list,
      items,
      seconds: timed.length ? timed.reduce((sum, m) => sum + (m.seconds || 0), 0) : null,
      level: heatLevel(items, list.length > 0),
    });
  }
  return { days, months, weeks: days[days.length - 1].col + 1 };
}

/** Per-month totals for the text alternative. */
export function monthTotals(days: HeatDay[]) {
  const totals = MONTHS.map((label) => ({ label, meetings: 0, items: 0 }));
  for (const d of days) {
    const m = totals[Number(d.date.slice(5, 7)) - 1];
    m.meetings += d.meetings.length;
    m.items += d.items;
  }
  return totals;
}

export type RecordDate = { key: string; date: string | null | undefined };

/**
 * Distinct records (a matter, or an agenda item outside any matter) per calendar year, with every
 * year from first to last present (zeros included). A record counts once in each year it came up.
 */
export function recordsPerYear(rows: RecordDate[]) {
  const years = new Map<number, Set<string>>();
  for (const { key, date } of rows) {
    const year = Number(String(date || "").slice(0, 4));
    if (!year) continue;
    years.set(year, (years.get(year) || new Set<string>()).add(key));
  }
  if (!years.size) return [];
  const known = [...years.keys()];
  const first = Math.min(...known);
  const last = Math.max(...known);
  return Array.from({ length: last - first + 1 }, (_, i) => ({ year: first + i, count: years.get(first + i)?.size || 0 }));
}
