import { pageMeta, recordDate } from "../lib/page-meta";
import { SITE_NAME } from "../lib/site-name";
import { membershipIsActiveOn } from "../lib/council-terms";
import { meetingPath } from "../lib/paths";
import { resolveSlugParam } from "../lib/slug-params.server";
import type { Route } from "./+types/meeting-explorer";
import { getMeetingById } from "../services/meetings";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { useSearchParams } from "react-router";
import { useState, useMemo, useRef } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { DetailHeader } from "../components/ui/detail-header";
import { SearchField } from "../components/ui/search-field";
import { cn, formatDate } from "../lib/utils";
import { normalizeMotionResult } from "../lib/motion-utils";
import { formatTimestamp } from "../lib/timeline-utils";
import { AgendaCard } from "../components/agenda-card";
import { MotionsList } from "../components/motions-list";
import { PeopleGrid } from "../components/people-grid";
import { MeetingTimeline } from "../components/meeting-timeline";
import { MeetingSummary } from "../components/meeting/MeetingSummary";
import { MeetingFacts } from "../components/meeting/MeetingSidebar";
import {
  MeetingPlayer,
  type MeetingPlayerHandle,
} from "../components/meeting-player";
import { getSpeakerColorIndex, SPEAKER_TEXT_COLORS } from "../lib/colors";
import type { Person, Membership } from "../lib/types";

export const meta: Route.MetaFunction = ({ data }) => {
  const m = data?.meeting;
  if (!m) return [{ title: `Meeting | ${SITE_NAME}` }];
  const date = recordDate(m.meeting_date);
  return [
    ...pageMeta(`Explorer — ${m.title} — ${date}`,
      `Explore available transcript, speakers and motions for Langford’s ${m.title} meeting on ${date}.`,
      meetingPath(m, "/explorer"), "article"),
  ];
};

export async function loader({ params, request }: Route.LoaderArgs) {
  try {
    const supabase = getSupabaseAdminClient();
    const resolved = await resolveSlugParam(supabase, "meetings", params.id, request, (m) => meetingPath(m, "/explorer"), "Meeting Not Found");
    const data = await getMeetingById(supabase, String(resolved.id));
    return data;
  } catch (error: any) {
    if (error instanceof Response) throw error;
    if (error.message === "Meeting Not Found") {
      throw new Response("Meeting Not Found", { status: 404 });
    }
    throw new Response("Error loading meeting", { status: 500 });
  }
}

export default function MeetingExplorer({ loaderData }: Route.ComponentProps) {
  const {
    meeting: rawMeeting,
    agendaItems: rawAgendaItems,
    transcript: rawTranscript,
    speakerAliases: rawSpeakerAliases,
    attendance: rawAttendance,
    people,
  } = loaderData;

  // Hydrate data from normalized people map
  const meeting = useMemo(
    () => ({
      ...rawMeeting,
      chair: rawMeeting.chair_person_id
        ? people[rawMeeting.chair_person_id]
        : rawMeeting.chair,
    }),
    [rawMeeting, people],
  );

  const agendaItems = useMemo(
    () =>
      rawAgendaItems.map((item: any) => ({
        ...item,
        motions: (item.motions || []).map((motion: any) => ({
          ...motion,
          mover_person: motion.mover_id ? people[motion.mover_id] : undefined,
          seconder_person: motion.seconder_id
            ? people[motion.seconder_id]
            : undefined,
          votes: (motion.votes || []).map((vote: any) => ({
            ...vote,
            person: vote.person_id ? people[vote.person_id] : undefined,
          })),
        })),
      })),
    [rawAgendaItems, people],
  );

  const transcript = useMemo(
    () =>
      rawTranscript.map((s: any) => ({
        ...s,
        person: s.person_id ? people[s.person_id] : undefined,
      })),
    [rawTranscript, people],
  );

  const attendance = useMemo(
    () =>
      rawAttendance.map((a: any) => ({
        ...a,
        person: a.person_id ? people[a.person_id] : undefined,
      })),
    [rawAttendance, people],
  );

  // State
  const [expandedItems, setExpandedItems] = useState<Record<number, boolean>>(
    {},
  );
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null);
  const transcriptRefs = useRef<Record<number, HTMLLIElement | null>>({});

  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get("tab") || "agenda";
  const playerRef = useRef<MeetingPlayerHandle>(null);

  const handleTabChange = (value: string) => {
    setSearchParams(
      (prev) => {
        prev.set("tab", value);
        return prev;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  const handleSegmentHover = (id: number | null) => {
    setActiveSegmentId(id);
    if (id && transcriptRefs.current[id]) {
      const element = transcriptRefs.current[id];
      const container = element?.closest(".overflow-y-auto");
      if (element && container) {
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const relativeTop =
          elementRect.top - containerRect.top + container.scrollTop;

        container.scrollTo({
          top: relativeTop - containerRect.height / 2 + elementRect.height / 2,
          behavior: "smooth",
        });
      }
    }
  };

  // Speaker helpers
  const speakerMap = useMemo(() => {
    const map: Record<string, string> = {};
    rawSpeakerAliases?.forEach((alias: any) => {
      map[alias.speaker_label] =
        people[alias.person_id]?.name || alias.speaker_label;
    });
    return map;
  }, [rawSpeakerAliases, people]);

  const resolveSpeakerName = (segment: any) => {
    if (segment.person?.name) return segment.person.name;
    const label = segment.speaker_name;
    return speakerMap[label] || label || "Unknown Speaker";
  };

  const getPersonRole = (person?: Person) => {
    if (!person) return null;
    const activeMembership = person.memberships?.find((m: Membership) => membershipIsActiveOn(m, meeting.meeting_date));
    return activeMembership?.role || null;
  };

  // Stats calculation
  const speakerStats = useMemo(() => {
    const stats: Record<string, number> = {};
    let totalTime = 0;
    transcript.forEach((segment: any) => {
      const name = resolveSpeakerName(segment);
      const duration = segment.end_time - segment.start_time;
      stats[name] = (stats[name] || 0) + duration;
      totalTime += duration;
    });
    return { stats, totalTime };
  }, [transcript, speakerMap]);

  const stats = useMemo(() => {
    const motions = agendaItems.flatMap((item: any) => item.motions || []);
    const carried = motions.filter((m: any) => normalizeMotionResult(m.result) === "passed").length;
    const defeated = motions.filter((m: any) => normalizeMotionResult(m.result) === "failed").length;
    const seconds =
      meeting.video_duration_seconds ||
      (transcript.length > 0 ? transcript[transcript.length - 1].end_time : 0);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const duration = seconds ? (h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`) : null;

    return {
      items: agendaItems.length,
      motions: motions.length,
      carried,
      defeated,
      speakers: Object.keys(speakerStats.stats).length,
      duration,
    };
  }, [agendaItems, meeting, transcript, speakerStats]);

  // Grouping for PeopleGrid
  const attendanceGroups = useMemo(() => {
    const groups = {
      council: [] as any[],
      staff: [] as any[],
      others: [] as any[],
    };
    const seenPersonIds = new Set<number>();
    const seenNames = new Set<string>();

    attendance.forEach((record: any) => {
      if (record.person_id) seenPersonIds.add(record.person_id);
      const name = record.person?.name || "Unknown";
      seenNames.add(name);
      const person = record.person;
      const role = getPersonRole(person);
      const roleLower = role?.toLowerCase() || "";
      const ext = { ...record, resolvedName: name };

      if (
        person?.is_councillor ||
        roleLower.includes("mayor") ||
        roleLower.includes("councillor")
      ) {
        groups.council.push(ext);
      } else if (
        roleLower.includes("director") ||
        roleLower.includes("clerk") ||
        roleLower.includes("cao")
      ) {
        groups.staff.push(ext);
      } else {
        groups.others.push(ext);
      }
    });

    transcript.forEach((segment: any) => {
      const name = resolveSpeakerName(segment);
      const personId = segment.person_id;
      if (personId && !seenPersonIds.has(personId)) {
        seenPersonIds.add(personId);
        seenNames.add(name);
        const virtual = {
          id: `v-${personId}`,
          person_id: personId,
          person: segment.person,
          isVirtual: true,
          resolvedName: name,
        };
        const roleLower = getPersonRole(segment.person)?.toLowerCase() || "";
        if (
          segment.person?.is_councillor ||
          roleLower.includes("mayor") ||
          roleLower.includes("councillor")
        ) {
          groups.council.push(virtual);
        } else if (
          roleLower.includes("director") ||
          roleLower.includes("clerk") ||
          roleLower.includes("cao")
        ) {
          groups.staff.push(virtual);
        } else {
          groups.others.push(virtual);
        }
      } else if (
        !personId &&
        !seenNames.has(name) &&
        name !== "Unknown Speaker"
      ) {
        seenNames.add(name);
        groups.others.push({
          id: `v-${name}`,
          person_id: null,
          isVirtual: true,
          resolvedName: name,
        });
      }
    });
    return groups;
  }, [attendance, transcript, speakerMap, meeting.meeting_date]);

  const filteredTranscript = useMemo(() => {
    if (!transcriptSearch) return transcript;
    const query = transcriptSearch.toLowerCase();
    return transcript.filter(
      (s: any) =>
        s.text_content.toLowerCase().includes(query) ||
        resolveSpeakerName(s).toLowerCase().includes(query),
    );
  }, [transcript, transcriptSearch]);

  const getVimeoTimeUrl = (seconds: number) => {
    if (!meeting.video_url) return "#";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const timeStr = `${h > 0 ? h + "h" : ""}${m}m${s}s`;
    return `${meeting.video_url.split("#")[0]}#t=${timeStr}`;
  };

  const toggleItem = (id: number) => {
    setExpandedItems((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const openInVimeo = (startTime: number) => {
    if (playerRef.current) {
      playerRef.current.seekTo(startTime);
    } else {
      window.open(getVimeoTimeUrl(startTime), "_blank");
    }
  };

  const facts = [
    stats.duration && { label: "Length", value: stats.duration },
    stats.items > 0 && { label: "Agenda items", value: stats.items },
    stats.motions > 0 && {
      label: "Motions",
      value: (
        <>
          {stats.carried}
          <span className="text-sm font-normal text-zinc-500"> carried</span>
          {stats.defeated > 0 && (
            <span className="text-sm font-normal text-red-700"> · {stats.defeated} defeated</span>
          )}
        </>
      ),
    },
    stats.speakers > 0 && { label: "Speakers", value: stats.speakers },
  ].filter(Boolean) as { label: string; value: React.ReactNode }[];

  const orgName = meeting.organization?.name;
  const showOrg = orgName && !meeting.title.toLowerCase().includes(orgName.toLowerCase());
  const hasVideo = Boolean(meeting.video_url);

  const sourceLinks = [
    meeting.agenda_url && { href: meeting.agenda_url, label: "Agenda PDF" },
    meeting.minutes_url && { href: meeting.minutes_url, label: "Minutes PDF" },
    meeting.video_url && { href: meeting.video_url.split("#")[0], label: "Vimeo" },
  ].filter(Boolean) as { href: string; label: string }[];

  const tabTrigger =
    "relative h-11 flex-none rounded-none border-0 bg-transparent px-3 text-sm font-semibold text-zinc-500 shadow-none hover:text-zinc-800 data-[state=active]:bg-transparent data-[state=active]:text-zinc-900 data-[state=active]:shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full data-[state=active]:after:bg-brand-600";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 pt-8 pb-16">
        <DetailHeader
          back={{ to: meetingPath(meeting), label: "Meeting" }}
          meta={[
            formatDate(meeting.meeting_date, {
              weekday: "short",
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
            stats.duration,
            showOrg ? orgName : null,
          ]}
          title={meeting.title}
          description="Explore the meeting minute by minute: who spoke when, every motion, everyone who took part and the full searchable transcript."
          actions={
            sourceLinks.length > 0 ? (
              <>
                {sourceLinks.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-zinc-200 bg-surface px-3 py-1 text-sm font-medium text-zinc-600 transition-colors hover:border-brand-300 hover:text-brand-700"
                  >
                    {link.label}
                  </a>
                ))}
              </>
            ) : undefined
          }
        />

        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
          {/* Left column: video, summary, facts */}
          <div className="space-y-6 lg:sticky lg:top-20 lg:col-span-5">
            {hasVideo ? (
              <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                <MeetingPlayer
                  ref={playerRef}
                  videoUrl={meeting.video_url}
                  agendaItems={agendaItems}
                />
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                No video was published for this meeting, so the timeline and transcript may be empty.
              </div>
            )}

            <section className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">Summary</h2>
              {meeting.summary ? (
                <div className="text-sm">
                  <MeetingSummary summary={meeting.summary} />
                </div>
              ) : (
                <p className="text-sm text-zinc-500">
                  A summary will appear here once the meeting records have been processed.
                </p>
              )}
            </section>

            <MeetingFacts facts={facts} />
          </div>

          {/* Right column: explorer tabs */}
          <div className="min-w-0 lg:col-span-7">
            <Tabs value={currentTab} onValueChange={handleTabChange} className="space-y-6">
              <TabsList className="flex h-auto w-full justify-start gap-0 overflow-x-auto rounded-none border-b border-zinc-200 bg-transparent p-0 [scrollbar-width:none]">
                <TabsTrigger value="agenda" className={tabTrigger}>
                  <span className="sm:hidden">Agenda</span>
                  <span className="hidden sm:inline">Timeline & agenda</span>
                </TabsTrigger>
                <TabsTrigger value="motions" className={tabTrigger}>
                  Motions
                  {stats.motions > 0 && (
                    <span className="ml-1.5 text-xs font-normal tabular-nums text-zinc-400">{stats.motions}</span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="people" className={tabTrigger}>
                  People
                </TabsTrigger>
                <TabsTrigger value="transcript" className={tabTrigger}>
                  Transcript
                </TabsTrigger>
              </TabsList>

              <TabsContent value="agenda" className="mt-0 space-y-6 outline-none">
                {transcript.length > 0 ? (
                  <MeetingTimeline
                    transcript={transcript}
                    agendaItems={agendaItems}
                    videoUrl={meeting.video_url}
                    speakerMap={speakerMap}
                    onSegmentHover={handleSegmentHover}
                    activeSegmentId={activeSegmentId}
                    onSeek={hasVideo ? openInVimeo : undefined}
                  />
                ) : (
                  <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                    The speaking timeline needs a transcript, and this meeting hasn't been transcribed yet.
                  </div>
                )}

                <section>
                  <h2 className="mb-1 text-lg font-bold tracking-tight text-zinc-900">Agenda</h2>
                  <p className="mb-4 text-sm text-zinc-500">
                    {agendaItems.length > 0
                      ? `${agendaItems.length} items · select one for its summary, discussion and motions`
                      : "No agenda items were recorded for this meeting."}
                  </p>
                  {agendaItems.length > 0 && (
                    <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                      {agendaItems.map((item: any) => (
                        <AgendaCard
                          key={item.id}
                          item={item}
                          isExpanded={!!expandedItems[item.id]}
                          onToggle={() => toggleItem(item.id)}
                          onWatchVideo={hasVideo ? openInVimeo : undefined}
                          resolveSpeakerName={resolveSpeakerName}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              </TabsContent>

              <TabsContent value="motions" className="mt-0 outline-none">
                <MotionsList
                  agendaItems={agendaItems}
                  onWatchVideo={hasVideo ? openInVimeo : undefined}
                />
              </TabsContent>

              <TabsContent value="people" className="mt-0 outline-none">
                <PeopleGrid
                  attendanceGroups={attendanceGroups}
                  speakerStats={speakerStats}
                  getPersonRole={getPersonRole}
                  agendaItems={agendaItems}
                />
              </TabsContent>

              <TabsContent value="transcript" className="mt-0 outline-none">
                {transcript.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                    No transcript is available for this meeting yet.
                  </div>
                ) : (
                  <div className="flex h-[75vh] min-h-[480px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                    <div className="flex flex-col gap-3 border-b border-zinc-100 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-zinc-500">
                        <span className="font-semibold tabular-nums text-zinc-900">{filteredTranscript.length}</span>
                        {transcriptSearch ? ` of ${transcript.length}` : ""} segments
                        {hasVideo && " · select one to jump the video there"}
                      </p>
                      <SearchField
                        value={transcriptSearch}
                        onValueChange={setTranscriptSearch}
                        placeholder="Search the transcript"
                        aria-label="Search the transcript"
                        className="w-full sm:max-w-xs"
                      />
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {filteredTranscript.length > 0 ? (
                        <ul className="divide-y divide-zinc-100">
                          {filteredTranscript.map((segment: any) => {
                            const speakerName = resolveSpeakerName(segment);
                            const colorIdx = getSpeakerColorIndex(speakerName);
                            const role = segment.person ? getPersonRole(segment.person) : null;
                            return (
                              <li
                                key={segment.id}
                                ref={(el) => {
                                  transcriptRefs.current[segment.id] = el;
                                }}
                                className={cn(
                                  "px-4 py-3 transition-colors",
                                  hasVideo && "cursor-pointer hover:bg-zinc-50",
                                  activeSegmentId === segment.id && "bg-brand-50/70",
                                )}
                                onClick={hasVideo ? () => openInVimeo(segment.start_time) : undefined}
                                onMouseEnter={() => setActiveSegmentId(segment.id)}
                                onMouseLeave={() => setActiveSegmentId(null)}
                              >
                                <div className="mb-0.5 flex items-baseline justify-between gap-3">
                                  <span className="min-w-0 truncate text-sm">
                                    <span className={cn("font-semibold", SPEAKER_TEXT_COLORS[colorIdx])}>
                                      {speakerName}
                                    </span>
                                    {role && <span className="text-xs text-zinc-500"> · {role}</span>}
                                  </span>
                                  <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                                    {formatTimestamp(segment.start_time)}
                                  </span>
                                </div>
                                <p className="text-sm leading-relaxed text-zinc-700">{segment.text_content}</p>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="px-4 py-6 text-sm text-zinc-500">
                          No transcript segments match your search.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </div>
  );
}
