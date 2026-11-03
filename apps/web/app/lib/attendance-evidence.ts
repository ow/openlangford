import { civicToday, membershipIsActiveOn } from "./council-terms";
import type { Attendance, Meeting, Membership } from "./types";

export type AttendanceState = "present" | "absent" | "unknown";
export interface AttendanceSummary {
  rate: number | null;
  total: number;
  attended: number;
  absent: number;
  unknown: number;
  verified: number;
  recorded: number;
}

/** A member saying their own name on the meeting video (the oath of office at an inaugural meeting with no minutes):
 * presence only, pinned to the transcript line. */
function videoSelfIdentification(evidence: any) {
  return evidence.method === "video_self_identification" && evidence.state === "present" &&
    Number.isInteger(evidence.transcript_segment_id) && evidence.transcript_segment_id >= 1 &&
    Number.isInteger(evidence.source_seconds) && evidence.source_seconds >= 0;
}

/** Legacy AI attendee lists and default modes do not establish attendance. */
export function attendanceEvidence(record: Pick<Attendance, "notes" | "meeting_id" | "person_id">) {
  try {
    const evidence = JSON.parse(record.notes || "null");
    const document = ["original_roster", "original_minutes_attendance"].includes(evidence?.method) &&
      /^[a-f0-9]{64}$/.test(evidence.source_sha256) &&
      Number.isInteger(evidence.source_page) && evidence.source_page >= 1;
    if (
      evidence?.schema !== "council-attendance/v1" ||
      !(document || videoSelfIdentification(evidence)) ||
      !["present", "absent"].includes(evidence.state) ||
      evidence.person_id !== record.person_id || evidence.meeting_id !== record.meeting_id ||
      !/^https:\/\//.test(evidence.source_url) ||
      typeof evidence.source_quote !== "string" || !evidence.source_quote.trim()
    ) return null;
    return evidence as { state: "present" | "absent"; source_url: string; local_date: string };
  } catch {
    return null;
  }
}

/** Compatibility for the existing 2022–2026 import, without claiming source verification.
 * Never extend this to historical imports, unknown modes, or rejected source evidence.
 */
export function attendanceState(record: Pick<Attendance, "notes" | "meeting_id" | "person_id" | "attendance_mode">, meetingDate: string): AttendanceState {
  const evidence = attendanceEvidence(record);
  if (evidence) return evidence.local_date === meetingDate ? evidence.state : "unknown";
  if (record.notes?.trim() || meetingDate < "2022-11-07" || meetingDate > "2026-11-01") return "unknown";
  if (record.attendance_mode === "In Person") return "present";
  if (["Absent", "Regrets"].includes(record.attendance_mode)) return "absent";
  return "unknown";
}

export function calculateAttendance(
  person: { id: number; memberships?: Membership[] },
  meetings: Meeting[],
  attendance: Attendance[],
  councilId: number,
  period?: { start: string; end: string },
): AttendanceSummary {
  const today = civicToday();
  const expected = new Map(meetings.filter((meeting) =>
    meeting.organization_id === councilId &&
    !/^(cancelled|canceled)$/i.test(meeting.status || "") &&
    meeting.meeting_date <= today &&
    (!period || (meeting.meeting_date >= period.start && meeting.meeting_date <= period.end)) &&
    (person.memberships || []).some((m) => m.organization_id === councilId && membershipIsActiveOn(m, meeting.meeting_date))
  ).map((meeting) => [meeting.id, meeting]));
  const states = new Map<number, Set<AttendanceState>>();
  const sourceVerified = new Set<number>();
  for (const record of attendance) {
    const meeting = expected.get(record.meeting_id);
    if (!meeting || record.person_id !== person.id) continue;
    const evidence = attendanceEvidence(record);
    const state = attendanceState(record, meeting.meeting_date);
    if (evidence && evidence.local_date === meeting.meeting_date) sourceVerified.add(record.meeting_id);
    const values = states.get(record.meeting_id) || new Set<AttendanceState>();
    values.add(state);
    states.set(record.meeting_id, values);
  }
  let attended = 0, absent = 0, verified = 0;
  for (const [meetingId, values] of states) {
    if (values.size !== 1) continue; // Conflicting records remain unresolved.
    if (values.has("present")) attended++;
    if (values.has("absent")) absent++;
    if (!values.has("unknown") && sourceVerified.has(meetingId)) verified++;
  }
  const total = expected.size;
  const recorded = attended + absent;
  const unknown = total - recorded;
  return { total, attended, absent, unknown, verified, recorded,
    // Legacy coverage is explicitly labelled recorded presence, not a verified attendance grade.
    rate: total > 0 && (unknown === 0 || recorded > verified) ? Math.round(attended / total * 100) : null };
}

export function attendanceCoverageText(stats: AttendanceSummary) {
  return `${stats.attended} present · ${stats.absent} absent · ${stats.unknown} unknown. Source evidence verified for ${stats.verified} of ${stats.total} meetings.`;
}

export function attendanceRateText(stats: AttendanceSummary) {
  if (stats.rate === null) return "Incomplete evidence";
  return stats.recorded > stats.verified ? `${stats.rate}% recorded present` : `${stats.rate}% attendance`;
}
