import { CalendarProvenance } from "../components/calendar-provenance";
import { pageMeta, recordDate, markdownAlternate, metaDescription } from "../lib/page-meta";
import { ogImageUrl } from "../lib/og";
import { breadcrumbList, jsonLd, meetingEvent, meetingVideo } from "../lib/structured-data";
import { SITE_NAME } from "../lib/site-name";
import { personPath } from "../lib/people-paths";
import { getCouncilTerms } from "../services/council-terms";
import { membershipIsActiveOn } from "../lib/council-terms";
import type { Route } from "./+types/meeting-detail";
import {
  getMeetingById,
  getDocumentSectionsForMeeting,
  getExtractedDocumentsForMeeting,
} from "../services/meetings";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { timed } from "../lib/server-timing.server";
import { getAttendanceInfo } from "../lib/attendance";
import type { AttendanceInfo } from "../lib/attendance";
import { getMunicipality } from "../services/municipality";
import type {
  Meeting,
  AgendaItem,
  TranscriptSegment,
  SpeakerAlias,
  Attendance,
  Person,
} from "../lib/types";
import {
  Link,
  useRevalidator,
  useRouteLoaderData,
  useSearchParams,
} from "react-router";
import { meetingPath } from "../lib/paths";
import { resolveSlugParam } from "../lib/slug-params.server";
import { loaderFailure } from "../lib/loader-errors";

export const meta: Route.MetaFunction = ({ data }) => {
  const m = data?.meeting;
  if (!m) return [{ title: `Meeting | ${SITE_NAME}` }];
  const date = recordDate(m.meeting_date);
  const description = `Read the meeting summary and available council records for Langford’s ${m.title} meeting on ${date}.`;
  return [
    ...pageMeta(`${m.title} — ${date}`, description, meetingPath(m, ""), "article"),
    markdownAlternate(meetingPath(m, "/summary.md")),
    jsonLd(
      meetingEvent(m, meetingPath(m), description),
      ...[meetingVideo(m, meetingPath(m), {
        description: metaDescription(m.summary?.replace(/^\s*[-*•]\s+/gm, "").replace(/\s*\n+\s*/g, " ") || `Video recording of Langford’s ${m.title} meeting on ${date}, with a searchable transcript and agenda on this page.`),
        thumbnailUrl: ogImageUrl(`${m.title}`, { subtitle: date, type: "meeting" }),
        // Many recordings have no stored length; the transcript's last timestamp is close.
        durationSeconds: m.video_duration_seconds || (data?.transcript?.length ? data.transcript[data.transcript.length - 1].end_time : null),
      })].filter((thing): thing is NonNullable<typeof thing> => thing !== null),
      breadcrumbList([["Meetings", "/meetings"], [`${m.title} — ${date}`, meetingPath(m)]]),
    ),
  ];
};
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Separator } from "../components/ui/separator";
import {
  Clock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Mic,
  MapPin,
  PlayCircle,
} from "lucide-react";
import { Badge } from "../components/ui/badge";
import { cn, formatDate, formatRelativeTime } from "../lib/utils";
import { normalizeMotionResult } from "../lib/motion-utils";
import {
  getSpeakerColorIndex,
  SPEAKER_COLORS,
  SPEAKER_BG_LIGHT_COLORS,
  SPEAKER_TEXT_COLORS,
  SPEAKER_BORDER_COLORS,
} from "../lib/colors";
import { useMeetingTranscript } from "../hooks/useMeetingTranscript";
import { useVideoPlayer } from "../hooks/useVideoPlayer";
import { useSpeakerStats } from "../hooks/useSpeakerStats";
import { getMeetingDuration } from "../lib/timeline-utils";
import { AgendaOverview } from "../components/meeting/AgendaOverview";
import { getPropertiesForItems } from "../services/properties";
import { getMatterLinks } from "../services/matters";
import { TranscriptDrawer } from "../components/meeting/TranscriptDrawer";
import { VideoWithSidebar } from "../components/meeting/VideoWithSidebar";
import { MeetingDecisions } from "../components/meeting/MeetingDecisions";
import { MeetingAttendance, MeetingDocuments, MeetingFacts } from "../components/meeting/MeetingSidebar";
import { SectionHeading } from "../components/ui/section-heading";
import { DetailHeader } from "../components/ui/detail-header";
import { MeetingSummary } from "../components/meeting/MeetingSummary";
import { ProvenanceBadges } from "../components/meeting/ProvenanceBadges";
import {
  getDocumentTypeColor,
  getDocumentTypeLabel,
} from "../lib/document-types";


export function HydrateFallback() {
  return <MeetingLoadingSkeleton />;
}

function MeetingLoadingSkeleton() {
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto py-8 px-4 max-w-7xl">
        <div className="flex flex-col items-center justify-center py-32">
          <div className="relative mb-8">
            <div className="w-16 h-16 rounded-2xl bg-zinc-900 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-white"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="6 3 20 12 6 21 6 3" fill="currentColor" />
              </svg>
            </div>
            <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-brand-600 rounded-full flex items-center justify-center">
              <div className="w-2 h-2 bg-surface rounded-full animate-ping" />
            </div>
          </div>

          <div
            className="text-lg font-bold text-zinc-900 mb-2"
            style={{ animation: "fade-up 0.3s ease-out" }}
          >
            Loading meeting
          </div>

          <div className="flex items-center gap-1.5 text-sm text-zinc-400">
            <span>Fetching video stream</span>
            <span
              className="inline-block w-1 h-1 rounded-full bg-zinc-400"
              style={{ animation: "pulse-dot 1.4s ease-in-out infinite" }}
            />
            <span
              className="inline-block w-1 h-1 rounded-full bg-zinc-400"
              style={{
                animation: "pulse-dot 1.4s ease-in-out 0.2s infinite",
              }}
            />
            <span
              className="inline-block w-1 h-1 rounded-full bg-zinc-400"
              style={{
                animation: "pulse-dot 1.4s ease-in-out 0.4s infinite",
              }}
            />
          </div>

          <div className="mt-8 w-48 h-1 bg-zinc-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-600 rounded-full"
              style={{ animation: "progress 3s ease-in-out infinite" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export async function loader({ params, request }: Route.LoaderArgs) {
  try {
    const { supabase } = createSupabaseServerClient(request);
    const resolved = await timed("meeting-resolve", resolveSlugParam(supabase, "meetings", params.id, request, (m) => meetingPath(m), "Meeting Not Found"));
    const id = String(resolved.id);
    const municipalityPromise = getMunicipality(supabase).catch(() => null);
    const [data, documentSections, extractedDocuments, municipality, terms] = await Promise.all([
      timed("meeting-record", getMeetingById(supabase, id, { includeText: false })),
      timed("meeting-sections", getDocumentSectionsForMeeting(supabase, id, { includeText: false })),
      timed("meeting-documents", getExtractedDocumentsForMeeting(supabase, id)),
      municipalityPromise,
      // Council terms only need the municipality: fetched alongside, not after, the meeting.
      timed("meeting-terms", municipalityPromise.then((m) => m ? getCouncilTerms(supabase, m.id) : [])),
    ]);

    // Only show attendance info for future meetings (Vancouver timezone)
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Vancouver",
    });
    const isFutureMeeting = data.meeting?.meeting_date >= today;
    const attendanceInfo = isFutureMeeting && municipality
      ? getAttendanceInfo(municipality.meta, data.meeting?.meta, data.meeting?.type)
      : null;

    const councilTerm = terms.find((term) => membershipIsActiveOn(term, data.meeting.meeting_date)) || null;
    // Transcript and report-section text run to megabytes; ship timings/titles only and let
    // the page fetch the text from /api/meeting-text (transcript on demand, sections on expand).
    const transcript = (data.transcript || []).map(({ text_content, ...rest }: any) => rest);
    const sections = (documentSections || []).map(({ section_text, ...rest }: any) => rest);
    const [itemProperties, itemMatters] = await timed("meeting-links", Promise.all([
      getPropertiesForItems(supabase, (data.agendaItems || []).map((it: any) => it.id)),
      getMatterLinks(supabase, (data.agendaItems || []).map((it: any) => it.matter_id)),
    ]));
    return { ...data, transcript, documentSections: sections, extractedDocuments, attendanceInfo, councilTerm, itemProperties, itemMatters };
  } catch (error) {
    throw loaderFailure(error, "Meeting Not Found");
  }
}


export default function MeetingDetail(props: any) {
  // React Router reuses this route across meeting URLs. Playback, deep links and
  // text demand belong to one meeting and must not carry into the next summary.
  return <MeetingDetailContent key={props.loaderData.meeting.id} {...props} />;
}

function MeetingDetailContent({ loaderData }: any) {
  const rootData = useRouteLoaderData("root") as { user: any } | undefined;
  const user = rootData?.user;

  const {
    meeting: rawMeeting,
    agendaItems: rawAgendaItems,
    transcript: rawTranscript,
    attendance: rawAttendance,
    people,
    activeCouncilMemberIds,
    documentSections,
    extractedDocuments,
    attendanceInfo,
    councilTerm,
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
        meta: item.meta?.participation?.speakers
          ? {
              ...item.meta,
              participation: {
                ...item.meta.participation,
                speakers: item.meta.participation.speakers.map((s: any) =>
                  s?.person_id && people[s.person_id] ? { ...s, person: people[s.person_id] } : s,
                ),
              },
            }
          : item.meta,
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

  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false);
  const [transcriptRequestedFor, setTranscriptRequestedFor] = useState<number | null>(null);
  const transcriptRequested = transcriptRequestedFor === rawMeeting.id;
  const transcriptState = useMeetingTranscript(rawMeeting.id, rawTranscript.length > 0, transcriptDrawerOpen || transcriptRequested);
  const transcriptText = transcriptState.texts;

  const transcript = useMemo(
    () =>
      rawTranscript.map((s: any) => ({
        ...s,
        text_content: transcriptText?.[s.id] ?? s.text_content ?? "",
        person: s.person_id ? people[s.person_id] : undefined,
      })),
    [rawTranscript, people, transcriptText],
  );

  const attendance = useMemo(
    () =>
      rawAttendance.map((a: any) => ({
        ...a,
        person: a.person_id ? people[a.person_id] : undefined,
      })),
    [rawAttendance, people],
  );

  // Vimeo data — fetched client-side so it doesn't block page load
  const [vimeoData, setVimeoData] = useState<{
    direct_url?: string | null;
    direct_audio_url?: string | null;
  } | null>(null);

  useEffect(() => {
    if (!rawMeeting.video_url) return;
    const params = new URLSearchParams({
      video_url: rawMeeting.video_url,
      meeting_id: String(rawMeeting.id),
    });
    fetch(`/api/vimeo-url?${params}`)
      .then((res) => res.json())
      .then((data: any) => setVimeoData(data))
      .catch(() => setVimeoData(null));
  }, [rawMeeting.video_url, rawMeeting.id]);

  const directVideoUrl = vimeoData?.direct_url;
  const directAudioUrl = vimeoData?.direct_audio_url;

  // UI state
  const [expandedAgendaItemId, setExpandedAgendaItemId] = useState<
    number | null
  >(null);
  const [focusedTranscriptSegmentId, setFocusedTranscriptSegmentId] = useState<number | null>(null);
  const [transcriptSearchQuery, setTranscriptSearchQuery] = useState("");
  const [showCaption, setShowCaption] = useState(true);
  const [searchParams] = useSearchParams();

  // Links from matter timelines (#item-123) open and scroll to that agenda item.
  useEffect(() => {
    const openLinkedItem = () => {
      const match = /^#item-(\d+)$/.exec(window.location.hash);
      if (!match) return;
      const itemId = Number(match[1]);
      setExpandedAgendaItemId(itemId);
      requestAnimationFrame(() => document.getElementById(`item-${itemId}`)?.scrollIntoView({ block: "start" }));
    };
    openLinkedItem();
    window.addEventListener("hashchange", openLinkedItem);
    return () => window.removeEventListener("hashchange", openLinkedItem);
  }, []);

  useEffect(() => {
    const openLinkedTranscript = () => {
      const match = /^#transcript=(\d+)$/.exec(window.location.hash);
      if (!match) return;
      const segmentId = Number(match[1]);
      if (!transcript.some((segment: TranscriptSegment) => segment.id === segmentId)) return;
      setFocusedTranscriptSegmentId(segmentId);
      setTranscriptSearchQuery("");
      setTranscriptDrawerOpen(true);
    };

    openLinkedTranscript();
    window.addEventListener("hashchange", openLinkedTranscript);
    return () => window.removeEventListener("hashchange", openLinkedTranscript);
  }, [transcript]);

  // Track if we've already reported a video error
  const hasReportedVideoError = useRef(false);
  const hasAppliedInitialTime = useRef(false);
  const revalidator = useRevalidator();

  const handleVideoError = useCallback(() => {
    if (!hasReportedVideoError.current && meeting?.id) {
      hasReportedVideoError.current = true;
      console.error(
        "[Video] Error detected, reporting failure and revalidating...",
      );

      const formData = new FormData();
      formData.append("meetingId", meeting.id.toString());

      fetch("/api/report-video-failure", {
        method: "POST",
        body: formData,
      })
        .then(() => {
          console.log("Reported failure. Revalidating...");
          revalidator.revalidate();
          setTimeout(() => {
            hasReportedVideoError.current = false;
          }, 5000);
        })
        .catch((e) => console.error("Failed to report video error", e));
    }
  }, [meeting?.id, revalidator]);

  // Video player hook
  const videoPlayer = useVideoPlayer({
    directVideoUrl,
    directAudioUrl,
    meetingId: rawMeeting.id,
    onError: (error) => {
      console.error("[Video] HLS error:", error);
      handleVideoError();
    },
  });

  useEffect(() => {
    if (videoPlayer.isPlaying || videoPlayer.videoEnabled || videoPlayer.currentTime > 0) {
      setTranscriptRequestedFor(rawMeeting.id);
    }
  }, [videoPlayer.isPlaying, videoPlayer.videoEnabled, videoPlayer.currentTime, rawMeeting.id]);

  useEffect(() => {
    if (hasAppliedInitialTime.current) return;
    const rawTime = searchParams.get("t");
    if (!rawTime) return;

    const startTime = Number(rawTime);
    if (!Number.isFinite(startTime) || startTime < 0) return;

    hasAppliedInitialTime.current = true;
    videoPlayer.seekTo(startTime);
  }, [searchParams, videoPlayer]);

  const resolveSpeakerName = (seg: {
    person?: { name: string } | null;
    speaker_name?: string | null;
  }) => {
    if (seg.person?.name) return seg.person.name;
    const label = seg.speaker_name;
    if (!label) return "Unknown Speaker";
    // Meeting-wide aliases can belong to an older diarization run. A durable
    // segment person link is required before presenting a confirmed identity.
    return label;
  };

  // Speaker stats hook
  const speakerStatsData = useSpeakerStats({
    transcript,
    attendance,
    meetingDate: meeting.meeting_date,
    resolveSpeakerName,
    activeCouncilMemberIds,
    people,
    participantRoles: meeting.meta?.participant_roles,
  });

  const { speakerStats, attendanceGroups, participantCount, getPersonRole, formatDuration } =
    speakerStatsData;

  // Meeting duration
  const meetingDuration = useMemo(
    () => getMeetingDuration(rawTranscript),
    [rawTranscript],
  );

  // Handle video navigation from agenda
  const handleWatchVideo = (startTime: number, itemId?: number) => {
    if (itemId) {
      setExpandedAgendaItemId(itemId);
    }
    videoPlayer.seekTo(startTime);
  };

  // Handle agenda item expansion
  const handleAgendaItemClick = (itemId: number) => {
    setExpandedAgendaItemId(expandedAgendaItemId === itemId ? null : itemId);
  };


  const allMotions = useMemo(
    () => agendaItems.flatMap((item: any) => item.motions || []),
    [agendaItems],
  );
  const substantiveMotions = allMotions.filter(
    (m: any) => m.result && m.disposition !== "Procedural",
  );
  const carriedCount = allMotions.filter(
    (m: any) => normalizeMotionResult(m.result) === "passed",
  ).length;
  const defeatedCount = allMotions.filter(
    (m: any) => normalizeMotionResult(m.result) === "failed",
  ).length;

  const durationSeconds =
    meeting.video_duration_seconds ||
    (transcript.length > 0 ? transcript[transcript.length - 1].end_time : 0);
  const durationDisplay = useMemo(() => {
    if (!durationSeconds) return null;
    const h = Math.floor(durationSeconds / 3600);
    const m = Math.floor((durationSeconds % 3600) / 60);
    if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
    return `${m}m`;
  }, [durationSeconds]);

  const extractedDocs = extractedDocuments || [];
  const hasVideo = Boolean(meeting.video_url);

  // Video lives in a collapsible "Watch" panel. Timestamps anywhere on the
  // page open it, scroll to it and seek.
  const [videoOpen, setVideoOpen] = useState(true);
  const watchRef = useRef<HTMLDivElement>(null);
  const watchAt = useCallback(
    (seconds: number) => {
      setVideoOpen(true);
      requestAnimationFrame(() => {
        watchRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      videoPlayer.seekTo(seconds);
    },
    [videoPlayer],
  );

  const facts = [
    durationDisplay && { label: "Length", value: durationDisplay },
    agendaItems.length > 0 && { label: "Agenda items", value: agendaItems.length },
    allMotions.length > 0 && {
      label: "Motions",
      value: (
        <>
          {carriedCount}
          <span className="text-sm font-normal text-zinc-500"> carried</span>
          {defeatedCount > 0 && (
            <span className="text-sm font-normal text-red-700"> · {defeatedCount} defeated</span>
          )}
        </>
      ),
    },
    participantCount > 0 && { label: "Participants", value: participantCount },
  ].filter(Boolean) as { label: string; value: React.ReactNode }[];

  const meetingYear = meeting.meeting_date?.slice(0, 4);
  const isPast = meeting.meeting_date < new Date().toLocaleDateString("en-CA");
  const orgName = meeting.organization?.name;
  const showOrg = orgName && !meeting.title.toLowerCase().includes(orgName.toLowerCase());

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 pt-8 pb-16">
        <DetailHeader
          back={{ to: meetingYear ? `/meetings?year=${meetingYear}` : "/meetings", label: "Meetings" }}
          meta={[
            formatDate(meeting.meeting_date, {
              weekday: "short",
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
            durationDisplay,
            showOrg ? orgName : null,
            councilTerm?.name,
          ]}
          title={meeting.title}
          badges={isPast && !meeting.summary ? <Badge variant="muted">Summary pending</Badge> : undefined}
          actions={
            <>
              <ProvenanceBadges meeting={meeting} />
              {transcript.length > 0 && (
                <Link
                  to={meetingPath(meeting, "/explorer")}
                  className="inline-flex items-center rounded-full border border-zinc-200 bg-surface px-3 py-1 text-sm font-medium text-zinc-700 transition-colors hover:border-brand-300 hover:text-brand-700"
                >
                  Timeline explorer
                </Link>
              )}
              {user && meeting.video_url && (
                <Link
                  to={`/speaker-alias?meetingId=${meeting.id}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-surface px-3 py-1 text-sm font-medium text-zinc-600 transition-colors hover:border-brand-300 hover:text-brand-700"
                >
                  <Mic className="h-3.5 w-3.5" />
                  Aliases
                </Link>
              )}
            </>
          }
        />

        <CalendarProvenance meeting={meeting} />

        {/* How to attend (upcoming meetings) */}
        {attendanceInfo && (
          <section className="mb-8 rounded-2xl border border-brand-200 bg-brand-50/60 p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-brand-900">
              <MapPin className="h-4 w-4 text-brand-700" />
              How to attend
            </h2>
            <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <div className="font-medium text-zinc-900">{attendanceInfo.venue}</div>
                <a href={attendanceInfo.mapsUrl} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">
                  {attendanceInfo.address}
                </a>
              </div>
              {attendanceInfo.startTime && (
                <div>
                  <div className="font-medium text-zinc-900">Starts</div>
                  <span className="text-zinc-600">{attendanceInfo.startTime}</span>
                </div>
              )}
              {attendanceInfo.watchLink && (
                <div>
                  <div className="font-medium text-zinc-900">Watch online</div>
                  <a href={attendanceInfo.watchLink} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">
                    {attendanceInfo.watchLabel || "Watch live"}
                  </a>
                </div>
              )}
              {attendanceInfo.publicInputProcess && (
                <p className="leading-relaxed text-zinc-600 sm:col-span-2 lg:col-span-3">
                  <span className="font-medium text-zinc-900">Public input: </span>
                  {attendanceInfo.publicInputProcess}
                </p>
              )}
              {attendanceInfo.specialInstructions && (
                <p className="leading-relaxed text-zinc-600 sm:col-span-2 lg:col-span-3">
                  <span className="font-medium text-zinc-900">Note: </span>
                  {attendanceInfo.specialInstructions}
                </p>
              )}
            </div>
          </section>
        )}

        {/* Watch */}
        {hasVideo && (
          <div ref={watchRef} className="mb-8 scroll-mt-20">
            <button
              onClick={() => setVideoOpen((v) => !v)}
              aria-expanded={videoOpen}
              className={cn(
                "flex w-full items-center gap-3 border border-zinc-200 bg-surface px-4 py-3 text-left shadow-sm transition-colors hover:bg-zinc-50",
                videoOpen ? "rounded-t-2xl border-b-0" : "rounded-2xl",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-zinc-900">
                  {videoOpen ? "Hide video" : "Watch the meeting"}
                </span>
                <span className="block text-xs text-zinc-500">
                  {[durationDisplay, transcript.length > 0 && "synced transcript", agendaItems.length > 0 && "jump to any agenda item"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <ChevronDown className={cn("h-5 w-5 shrink-0 text-zinc-400 transition-transform", videoOpen && "rotate-180")} />
            </button>
            {/* Kept mounted so timestamps can seek before it is opened */}
            <div className={cn(!videoOpen && "hidden")}>
              <VideoWithSidebar
                videoPlayer={videoPlayer}
                directVideoUrl={directVideoUrl}
                directAudioUrl={directAudioUrl}
                meeting={meeting}
                agendaItems={agendaItems}
                transcript={transcript}
                onTranscriptOpen={() => setTranscriptRequestedFor(rawMeeting.id)}
                meetingDuration={meetingDuration}
                resolveSpeakerName={resolveSpeakerName}
                showCaption={showCaption}
                setShowCaption={setShowCaption}
                onVideoError={handleVideoError}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          {/* Main column */}
          <div className="min-w-0 space-y-10 lg:col-span-8">
            <section>
              <SectionHeading title="Summary" />
              {meeting.summary ? (
                <div className="rounded-2xl border border-zinc-200 bg-surface p-5 text-[15px] shadow-sm sm:p-6">
                  <MeetingSummary summary={meeting.summary} />
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                  {isPast
                    ? "A summary will appear here once the meeting records have been processed."
                    : "This meeting hasn't happened yet."}
                </div>
              )}
            </section>

            {allMotions.length > 0 && (
              <section id="decisions" className="scroll-mt-20">
                <SectionHeading
                  title="Decisions"
                  description={substantiveMotions.length > 0 ? "What council voted on, in agenda order." : undefined}
                />
                <MeetingDecisions agendaItems={agendaItems} onWatch={hasVideo ? watchAt : undefined} />
              </section>
            )}

            {agendaItems.length > 0 && (
              <section id="agenda" className="scroll-mt-20">
                <SectionHeading
                  title="Agenda"
                  description={`${agendaItems.length} items · select one for details, debate and documents`}
                />
                <AgendaOverview
                  items={agendaItems}
                  documentSections={documentSections}
                  extractedDocuments={extractedDocuments}
                  expandedItemId={expandedAgendaItemId}
                  onItemClick={handleAgendaItemClick}
                  onWatchVideo={(startTime, itemId) => {
                    setExpandedAgendaItemId(itemId);
                    watchAt(startTime);
                  }}
                  meetingId={meeting.id}
                  meetingSlug={meeting.slug}
                  itemProperties={(loaderData as any).itemProperties}
                  itemMatters={(loaderData as any).itemMatters}
                />
              </section>
            )}
          </div>

          {/* Sidebar */}
          <aside className="space-y-6 lg:col-span-4">
            <div className="space-y-6 lg:sticky lg:top-20">
              <MeetingFacts facts={facts} />
              <MeetingAttendance
                attendanceGroups={attendanceGroups}
                speakerStats={speakerStats}
                getPersonRole={getPersonRole}
                formatDuration={formatDuration}
              />
              <MeetingDocuments meetingId={meeting.id} meetingSlug={meeting.slug} documents={extractedDocs} />
            </div>
          </aside>
        </div>
      </div>

      {/* Transcript Drawer */}
      <TranscriptDrawer
        isOpen={transcriptDrawerOpen}
        onClose={() => {
          setTranscriptDrawerOpen(false);
          setFocusedTranscriptSegmentId(null);
        }}
        transcript={transcript}
        textStatus={transcriptState.status}
        onRetryText={transcriptState.retry}
        focusedSegmentId={focusedTranscriptSegmentId}
        currentTime={videoPlayer.currentTime}
        onSegmentClick={(time) => {
          setFocusedTranscriptSegmentId(null);
          videoPlayer.seekTo(time);
        }}
        searchQuery={transcriptSearchQuery}
        onSearchChange={setTranscriptSearchQuery}
        resolveSpeakerName={resolveSpeakerName}
      />
    </div>
  );
}
