import schedule from "../data/langford-schedule-2026.json";
import { civicToday } from "../lib/council-terms";
import type { SupabaseClient } from "@supabase/supabase-js";

export const CALENDAR_CRON = "17 */12 * * *";
export const CALENDAR_URL = "https://pub-langford.escribemeetings.com/MeetingsCalendarView.aspx/GetCalendarMeetings";
const PORTAL = "https://pub-langford.escribemeetings.com/meetingscalendarview.aspx";
const TYPES: Record<string, [string, string, string]> = {
  "Council Meeting": ["Regular Council", "Council", "Regular Council"],
  "Special Council Meeting": ["Special Council", "Council", "Special Council"],
  "Inaugural Council Meeting": ["Inauguration", "Council", "Inauguration"],
  "Special Inaugural Council Meeting": ["Inauguration", "Council", "Inauguration"],
  "Committee of the Whole Meeting": ["Committee of the Whole", "Council", "Committee of the Whole"],
  "Public Hearing": ["Public Hearing", "Council", "Public Hearing"],
  "Community Advisory Committee": ["Advisory Committee", "Community Advisory Committee", "Community Advisory Committee"],
  "Sustainable Development Advisory Committee": ["Advisory Committee", "Sustainable Development Advisory Committee", "Sustainable Development Advisory Committee"],
  "Capital West Accessibility Advisory Committee": ["Advisory Committee", "Capital West Accessibility Advisory Committee", "Capital West Accessibility Advisory Committee"],
};
export interface CalendarEvent {
  source_type: "escribe" | "official_schedule";
  source_id: string;
  meeting_date: string;
  title: string;
  type: string;
  organization_name: string;
  source_url: string;
  start_time: string | null;
  cancelled: boolean;
}

/** Fixed endpoints, bounded response sizes/timeouts and two retries; never follows arbitrary source links. */
async function fetchSource(url: string, init: RequestInit): Promise<Uint8Array> {
  let error: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "manual" });
      // Workers do not implement redirect:"error". Manual mode plus the status
      // check rejects redirects without contacting a different destination.
      if (!response.ok) throw new Error(`Official calendar HTTP ${response.status}`);
      if (Number(response.headers.get("Content-Length")) > 2_000_000 || !response.body) throw new Error("Official calendar response too large or empty");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) { await reader.cancel(); throw new Error("Official calendar response too large"); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    } catch (e) { error = e; }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
  }
  throw error;
}

/** Public metadata only. No database mutation, downloads of meeting documents, or AI. */
export async function discoverCalendarEvents(now = new Date()) {
  const today = civicToday(now);
  const end = new Date(`${today}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 180);
  const until = end.toISOString().slice(0, 10);
  const warnings: string[] = [];
  const events: CalendarEvent[] = [];
  // A failed source is not an empty successful snapshot and must not cancel anything.
  const bytes = await fetchSource(CALENDAR_URL, {
    method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ calendarStartDate: `${today}T00:00:00`, calendarEndDate: `${until}T23:59:59` }),
  });
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  const rows = typeof payload.d === "string" ? JSON.parse(payload.d) : payload.d;
  if (!Array.isArray(rows) || rows.length > 500) throw new Error("Unexpected official calendar payload");
  const seen = new Set<string>();
  for (const row of rows) {
    const mapping = TYPES[row.MeetingType];
    const stamp = String(row.StartDate).match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2})/);
    if (!mapping || !stamp || !/^[a-f0-9-]{36}$/i.test(row.ID)) { warnings.push("Unsupported calendar event held for review"); continue; }
    const date = `${stamp[1]}-${stamp[2]}-${stamp[3]}`;
    if (date < today || date > until || seen.has(row.ID.toLowerCase())) continue;
    if (new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid official calendar date");
    seen.add(row.ID.toLowerCase());
    events.push({ source_type: "escribe", source_id: row.ID.toLowerCase(), meeting_date: date,
      type: mapping[0], organization_name: mapping[1], title: mapping[2], start_time: stamp[4],
      source_url: PORTAL, cancelled: row.IsCancelled === true || row.Cancelled === true || /\bcancell?ed\b/i.test(String(row.MeetingName))
        // Langford cancels by attaching a "Meeting Cancellation Notice" to the calendar entry.
        || (Array.isArray(row.MeetingDocumentLink) && row.MeetingDocumentLink.some((d: any) => /\bcancell?ation notice\b/i.test(String(d?.Title)))) });
  }
  // The PDF encodes meeting categories by colour. Use a human-reviewed, hash-pinned
  // manifest; a changed PDF is held for review, never interpreted by an LLM/OCR.
  try {
    const pdf = await fetchSource(schedule.sourceUrl, {});
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pdf.buffer as ArrayBuffer))].map(b => b.toString(16).padStart(2, "0")).join("");
    if (hash !== schedule.sha256) warnings.push("Annual calendar changed: reviewed schedule fallback held pending review");
    else for (const event of schedule.events) {
      if (event.meeting_date < today || event.meeting_date > until) continue;
      // A published event takes precedence over the annual schedule for its date/type/org.
      if (events.some(e => e.meeting_date === event.meeting_date && e.type === event.type && e.organization_name === event.organization_name)) continue;
      events.push({ ...event, source_type: "official_schedule", source_url: schedule.sourceUrl, cancelled: false });
    }
  } catch { warnings.push("Annual calendar unavailable: retaining previously verified schedule"); }
  if (events.length > 64) throw new Error("Calendar batch exceeds bounded import size");
  return { checked_at: now.toISOString(), events, warnings };
}

/** Uses the same already-authorized server-side database client as the web app. */
export async function syncCalendar(db: SupabaseClient, trigger: "manual" | "cron" = "manual", now = new Date()) {
  const claim = await db.rpc("claim_calendar_sync", { p_trigger: trigger });
  if (claim.error) throw claim.error;
  if (!claim.data) return { skipped: "another calendar sync is active" };
  try {
    const discovery = await discoverCalendarEvents(now);
    const result = await db.rpc("apply_calendar_sync", { p_token: claim.data, p_events: discovery.events, p_warnings: discovery.warnings });
    if (result.error) throw result.error;
    return { ...discovery, result: result.data };
  } catch (error) {
    await db.rpc("fail_calendar_sync", { p_token: claim.data, p_error: "Official calendar sync failed; last verified events retained" });
    throw error;
  }
}
