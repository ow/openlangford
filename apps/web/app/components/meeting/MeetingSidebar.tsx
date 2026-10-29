import { useState } from "react";
import { documentPath, meetingDocumentsPath } from "../../lib/paths";
import { Link } from "react-router";
import { Check, ChevronDown, ChevronRight, FileText } from "lucide-react";
import { getDocumentTypeLabel } from "../../lib/document-types";
import { participantPath, personPath } from "../../lib/people-paths";
import { cn } from "../../lib/utils";

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-surface shadow-sm">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
        {action}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

export function MeetingFacts({ facts }: { facts: { label: string; value: React.ReactNode }[] }) {
  if (facts.length === 0) return null;
  return (
    <section className="rounded-2xl border border-zinc-200 bg-surface p-4 shadow-sm">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {facts.map((f) => (
          <div key={f.label}>
            <dt className="text-xs text-zinc-500">{f.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums tracking-tight text-zinc-900">{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface AttendanceProps {
  attendanceGroups: { council: any[]; staff: any[]; others: any[] };
  speakerStats: { stats: Record<string, number>; totalTime: number };
  getPersonRole: (person?: any) => string | null;
  formatDuration: (seconds: number) => string;
}

function isAway(record: any) {
  return /^(regrets|absent)$/i.test((record.attendance_mode || "").trim());
}

export function MeetingAttendance({ attendanceGroups, speakerStats, getPersonRole, formatDuration }: AttendanceProps) {
  const [showStaff, setShowStaff] = useState(false);
  const { council, staff, others } = attendanceGroups;
  if (council.length + staff.length + others.length === 0) return null;

  const time = (r: any) => r.speakingSeconds ?? speakerStats.stats[r.resolvedName || ""] ?? 0;
  const maxCouncil = Math.max(1, ...council.map(time));
  const sortedCouncil = [...council].sort((a, b) => Number(isAway(a)) - Number(isAway(b)) || time(b) - time(a));
  const present = council.filter((r) => r.isParticipant).length;

  return (
    <Panel
      title="Council"
      action={
        council.length > 0 && (
          <span className="text-xs text-zinc-500">
            {present} verified {present === 1 ? "attendee" : "attendees"}
          </span>
        )
      }
    >
      {council.some((r) => !isAway(r) && time(r) > 0) && (
        <div className="mb-2 flex justify-between text-xs text-zinc-400">
          <span>Member</span>
          <span>Time speaking</span>
        </div>
      )}
      {council.length > 0 && (
        <ul className="space-y-2.5">
          {sortedCouncil.map((r) => {
            const t = time(r);
            const away = isAway(r);
            const name = r.resolvedName || "Unknown";
            const role = getPersonRole(r.person ?? undefined);
            const nameEl = r.person_id ? (
              <Link
                to={personPath({ id: r.person_id, name: r.person?.name })}
                className="font-medium text-zinc-900 hover:text-brand-700"
              >
                {name}
              </Link>
            ) : (
              <span className="font-medium text-zinc-900">{name}</span>
            );
            return (
              <li key={r.id ?? name} className={cn(away && "opacity-60")}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">
                    {nameEl}
                    {role && /mayor/i.test(role) && <span className="ml-1.5 text-xs text-zinc-500">Mayor</span>}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                    {away ? r.attendance_mode : r.participationEvidence === "transcript_only" ? `Transcript only${t ? ` · ${formatDuration(t)}` : ""}` : r.participationEvidence === "unknown" ? "Attendance unknown" : r.attendance_mode === "Remote" ? `Remote${t ? ` · ${formatDuration(t)}` : ""}` : t ? formatDuration(t) : <Check className="h-4 w-4 text-emerald-600" aria-label="Recorded present" />}
                  </span>
                </div>
                {away && r.hasTranscriptEvidence && (
                  <p className="mt-0.5 text-xs text-amber-700">Transcript attribution conflicts with recorded absence</p>
                )}
                {!away && t > 0 && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-100" aria-hidden="true">
                    <div className="h-full rounded-full bg-brand-500" style={{ width: `${(t / maxCouncil) * 100}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(staff.length > 0 || others.length > 0) && (
        <div className="mt-4 border-t border-zinc-100 pt-3">
          <button
            onClick={() => setShowStaff((v) => !v)}
            aria-expanded={showStaff}
            className="flex w-full items-center justify-between text-sm text-zinc-600 hover:text-zinc-900"
          >
            <span>
              {staff.length > 0 && `${staff.length} staff records`}
              {staff.length > 0 && others.length > 0 && " · "}
              {others.length > 0 && `${others.length} public / guest records`}
            </span>
            <ChevronDown className={cn("h-4 w-4 transition-transform", showStaff && "rotate-180")} />
          </button>
          {showStaff && (
            <ul className="mt-2 space-y-1.5 text-sm">
              {[...staff, ...others].map((r) => (
                <li key={r.id ?? r.resolvedName} className="flex items-baseline justify-between gap-2">
                  {/* Rows carry a canonical person_id from attendance or identified transcript
                      segments; staff link to their profile, the public to their participant page. */}
                  {r.person_id ? (
                    <Link
                      to={(staff.includes(r) ? personPath : participantPath)({ id: r.person_id, name: r.person?.name, slug: r.person?.slug })}
                      className="min-w-0 truncate text-zinc-800 hover:text-brand-700"
                    >
                      {r.resolvedName || "Unknown"}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate text-zinc-800">{r.resolvedName || "Unknown"}</span>
                  )}
                  <span className="shrink-0 truncate text-xs text-zinc-500">
                    {isAway(r) ? r.attendance_mode : r.participationEvidence === "transcript_only" ? "Transcript only" : r.participationEvidence === "unknown" ? "Attendance unknown" : getPersonRole(r.person ?? undefined) || (staff.includes(r) ? "Staff" : "Guest")}
                    {isAway(r) && r.hasTranscriptEvidence && " · Transcript attribution conflicts"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

export function MeetingDocuments({ meetingId, meetingSlug, documents }: { meetingId: number; meetingSlug?: string | null; documents: any[] }) {
  if (!documents?.length) return null;
  // Agenda packages are often extracted twice (cover + full package)
  const seen = new Set<string>();
  const unique = documents.filter((d) => {
    const key = `${d.document_type}:${(d.title || "").toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const shown = unique.slice(0, 6);

  return (
    <Panel
      title="Documents"
      action={
        <Link to={meetingDocumentsPath({ id: meetingId, slug: meetingSlug })} className="text-xs font-semibold text-brand-700 hover:text-brand-800">
          View all{documents.length > shown.length ? ` (${documents.length})` : ""}
        </Link>
      }
    >
      <ul className="-mx-2">
        {shown.map((d) => (
          <li key={d.id}>
            <Link
              to={documentPath({ id: meetingId, slug: meetingSlug }, d.id)}
              className="group flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-zinc-50"
            >
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 group-hover:text-brand-600" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-snug text-zinc-900 group-hover:text-brand-700 line-clamp-2">
                  {d.title}
                </span>
                <span className="text-xs text-zinc-500">{getDocumentTypeLabel(d.document_type)}</span>
              </span>
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300" />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
