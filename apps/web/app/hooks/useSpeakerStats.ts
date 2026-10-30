import { membershipIsActiveOn } from "../lib/council-terms";
import { UNKNOWN_SPEAKER } from "~/lib/speaker-labels";
import { useMemo } from "react";
import { isNamedParticipant } from "../lib/participant-identity";
import { documentedParticipantRole } from "../lib/participant-roles";
import type { TranscriptSegment, Attendance, Person, Membership } from "../lib/types";

interface SpeakerStats {
  stats: Record<string, number>;
  totalTime: number;
}
interface AttendanceGroups {
  council: ExtendedAttendance[];
  staff: ExtendedAttendance[];
  others: ExtendedAttendance[];
}
interface ExtendedAttendance {
  id: number | string;
  meeting_id?: number;
  person_id: number | null;
  attendance_mode?: string;
  notes?: string;
  created_at?: string;
  person?: Person;
  isVirtual?: boolean;
  resolvedName?: string;
  isParticipant: boolean;
  hasTranscriptEvidence: boolean;
  speakingSeconds: number;
  participationEvidence: "recorded_attendance" | "recorded_absence" | "transcript_only" | "unknown";
}
interface UseSpeakerStatsOptions {
  transcript: TranscriptSegment[];
  attendance: Attendance[];
  meetingDate: string;
  resolveSpeakerName: (seg: { person?: { name: string } | null; speaker_name?: string | null }) => string;
  activeCouncilMemberIds?: number[];
  people?: Record<number, Person>;
  participantRoles?: unknown;
}
interface UseSpeakerStatsReturn {
  speakerStats: SpeakerStats;
  attendanceGroups: AttendanceGroups;
  participantCount: number;
  getPersonRole: (person?: Person) => string | null;
  formatDuration: (seconds: number) => string;
}

const nameKey = (name: string) => name.trim().toLocaleLowerCase();
const modeKey = (mode?: string) => (mode || "").toLowerCase().replace(/[\s_-]/g, "");
const isAway = (mode?: string) => ["absent", "regrets"].includes(modeKey(mode));
const isRecordedPresent = (mode?: string) => ["inperson", "present", "remote", "online", "electronic", "virtual"].includes(modeKey(mode));

const isCouncilOffice = (m: Membership) => m.organization?.classification?.trim().toLowerCase() === "council" || /mayor|councillor|councilor/i.test(m.role || "");
const isStaffOffice = (m: Membership) => m.organization?.classification?.trim().toLowerCase() === "staff" || /director|clerk|\bcao\b|manager|chief|officer|planner|police|rcmp|engineer|administrator|superintendent|\bsupt\b|assistant|deputy|coordinator/i.test(m.role || "");

export function useSpeakerStats({ transcript, attendance, meetingDate, resolveSpeakerName,
  activeCouncilMemberIds = [], people = {}, participantRoles }: UseSpeakerStatsOptions): UseSpeakerStatsReturn {
  const activeMemberships = (person?: Person) => person?.memberships?.filter(m => membershipIsActiveOn(m, meetingDate)) || [];
  const getPersonRole = (person?: Person): string | null => {
    const memberships = activeMemberships(person);
    const observed = person && documentedParticipantRole(participantRoles, person.id, meetingDate);
    if (!memberships.some(isCouncilOffice) && observed) return observed.role;
    return (memberships.find(isCouncilOffice) || memberships[0])?.role || null;
  };
  const formatDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
    return m === 0 ? `${s}s` : `${m}m ${s}s`;
  };
  // A label or matching full name is an identity candidate, never a person
  // link. Only the canonical ID attached to the segment may attribute speech.
  const knownPeople = new Map<number, Person>();
  for (const person of [...Object.values(people), ...attendance.map(r => r.person), ...transcript.map(s => s.person)]) {
    if (person) knownPeople.set(person.id, person);
  }
  const segmentPerson = (segment: TranscriptSegment) => segment.person_id ? knownPeople.get(segment.person_id) : undefined;
  const segmentId = (segment: TranscriptSegment) => segment.person_id;
  const segmentName = (segment: TranscriptSegment) => {
    const person = segmentPerson(segment);
    return person ? resolveSpeakerName({ ...segment, person }) : UNKNOWN_SPEAKER;
  };
  const positiveDuration = (segment: TranscriptSegment) => Number.isFinite(segment.start_time) && Number.isFinite(segment.end_time) && Number.isFinite(segment.end_time - segment.start_time) && segment.end_time > segment.start_time;

  const speakerStats = useMemo(() => {
    const stats: Record<string, number> = {};
    let totalTime = 0;
    for (const segment of transcript) {
      if (!positiveDuration(segment)) continue;
      const name = segmentName(segment), duration = segment.end_time - segment.start_time;
      stats[name] = (stats[name] || 0) + duration;
      totalTime += duration;
    }
    return { stats, totalTime };
  }, [transcript, resolveSpeakerName, people, attendance]);

  const attendanceGroups = useMemo(() => {
    const groups: AttendanceGroups = { council: [], staff: [], others: [] };
    const seenIds = new Set<number>();
    const secondsById = new Map<number, number>();
    for (const segment of transcript) {
      const name = segmentName(segment);
      const id = segmentId(segment);
      if (!id || !positiveDuration(segment) || !isNamedParticipant(name)) continue;
      const duration = segment.end_time - segment.start_time;
      secondsById.set(id, (secondsById.get(id) || 0) + duration);
    }
    const add = (record: ExtendedAttendance) => {
      const memberships = activeMemberships(record.person);
      if (memberships.some(isCouncilOffice) || (record.person_id != null && activeCouncilMemberIds.includes(record.person_id))) groups.council.push(record);
      else if (memberships.some(isStaffOffice) || (record.person_id &&
          documentedParticipantRole(participantRoles, record.person_id, meetingDate))) groups.staff.push(record);
      else groups.others.push(record);
    };
    for (const record of attendance) {
      const person = record.person || people[record.person_id];
      const name = person?.name || "Unknown";
      if (record.person_id) seenIds.add(record.person_id);
      const speakingSeconds = isNamedParticipant(name) ? secondsById.get(record.person_id) || 0 : 0;
      const speech = speakingSeconds > 0;
      const away = isAway(record.attendance_mode), present = isRecordedPresent(record.attendance_mode);
      add({ ...record, person, resolvedName: name, hasTranscriptEvidence: speech, speakingSeconds,
        isParticipant: isNamedParticipant(name) && !away && (present || speech),
        participationEvidence: away ? "recorded_absence" : present ? "recorded_attendance" : speech ? "transcript_only" : "unknown" });
    }
    // Membership alone is no attendance evidence. Missing roster members are
    // omitted; actual recorded absences above remain authoritative and visible.
    for (const segment of transcript) {
      const name = segmentName(segment), id = segmentId(segment);
      if (!id || !positiveDuration(segment) || !isNamedParticipant(name) || seenIds.has(id)) continue;
      seenIds.add(id);
      add({ id: `virtual-p-${id}`, person_id: id,
        person: segmentPerson(segment), isVirtual: true, resolvedName: name,
        speakingSeconds: secondsById.get(id) || 0,
        hasTranscriptEvidence: true, isParticipant: true, participationEvidence: "transcript_only" });
    }
    return groups;
  }, [attendance, transcript, meetingDate, resolveSpeakerName, activeCouncilMemberIds, people, participantRoles]);

  const participantCount = new Set([...attendanceGroups.council, ...attendanceGroups.staff, ...attendanceGroups.others]
    .filter(r => r.isParticipant).map(r => r.person_id ? `person:${r.person_id}` : `name:${nameKey(r.resolvedName || "")}`)).size;
  return { speakerStats, attendanceGroups, participantCount, getPersonRole, formatDuration };
}
