import { formatDate } from "../lib/utils";
import { civicToday } from "../lib/council-terms";

export function CalendarProvenance({ meeting, compact = false }: { compact?: boolean; meeting: { calendar_source_id?: number | null; calendar?: any; meeting_date: string; status?: string; has_agenda?: boolean; has_minutes?: boolean; has_transcript?: boolean; summary?: string; meta?: any } }) {
  const calendar = meeting.calendar_source_id && (meeting.calendar ?? meeting.meta?.calendar);
  if (!calendar) return null;
  const checked = new Date(calendar.verified_at);
  const stale = !Number.isFinite(checked.getTime()) || Date.now() - checked.getTime() > 48 * 60 * 60 * 1000;
  const content = meeting.has_agenda || meeting.has_minutes || meeting.has_transcript || meeting.summary;
  const datePassed = meeting.meeting_date < new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date());
  const label = meeting.status === "Cancelled" ? "Cancelled" : content ? "Official calendar" : datePassed ? "Scheduled date passed; occurrence unconfirmed" : "Scheduled";
  let source: URL;
  try { source = new URL(calendar.source_url); if (source.protocol !== "https:" || !["langford.ca", "pub-langford.escribemeetings.com"].includes(source.hostname)) return null; } catch { return null; }
  const missingAgenda = !meeting.has_agenda && meeting.status !== "Cancelled";
  const missingDetails = !calendar.start_time && missingAgenda
    ? "Time and agenda not yet published"
    : !calendar.start_time ? "Time not yet published"
    : missingAgenda ? "Agenda not yet published" : null;
  return <p className="mt-2 text-xs leading-relaxed text-zinc-500">
    <a href={source.href} target="_blank" rel="noopener noreferrer" aria-label={`${label} — official source (opens in new tab)`} className="font-semibold underline underline-offset-2 hover:text-brand-700">{label}</a>
    {!compact && Number.isFinite(checked.getTime()) && <> · Schedule checked {formatDate(civicToday(checked))}</>}
    {calendar.start_time && ` · ${calendar.start_time} (Langford time)`}
    {missingDetails && ` · ${missingDetails}`}
    {stale && " · Schedule check overdue"}
  </p>;
}
