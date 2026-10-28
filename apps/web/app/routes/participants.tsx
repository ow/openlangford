import { cachedCompute, HOURLY_SHARED } from "../services/computed-cache.server";
import { SITE_NAME } from "../lib/site-name";
import { meetingPath } from "../lib/paths";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { participantPath } from "../lib/people-paths";
import type { Route } from "./+types/participants";
import { Link, useRouteLoaderData } from "react-router";
import { ChevronDown, MessageSquare, Mic, PlayCircle, Search } from "lucide-react";
import { PageHeader } from "../components/ui/page-header";
import { useMemo, useState } from "react";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import {
  getPublicParticipantStats,
  getParticipantIdentificationCoverage,
  type PublicParticipantStats,
} from "../services/people";
import { getPublicParticipationHistories } from "../services/public-participation.server";
import type { Municipality } from "../lib/types";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { formatDate } from "../lib/utils";
import { ogImageUrl, ogUrl } from "../lib/og";
import { getMunicipalityFromMatches } from "../lib/municipality-helpers";

export const meta: Route.MetaFunction = ({ matches }) => {
  const municipality = getMunicipalityFromMatches(matches);
  const shortName = municipality?.short_name || DEFAULT_MUNICIPALITY.short_name;
  const title = `Public Participants | ${SITE_NAME}`;
  const description = `Identified public speakers and participation patterns in ${shortName} council meetings.`;

  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: "Public Participants" },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:url", content: ogUrl("/participants") },
    { property: "og:image", content: ogImageUrl("Public Participants", { type: "person" }) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

export async function loader() {
  try {
    const supabase = getSupabaseAdminClient();
    const municipality = await getMunicipality(supabase);
    // Both are slow full-table aggregations that only change when a meeting is ingested.
    const [participants, identificationCoverage] = await Promise.all([
      cachedCompute(`public-participants:${municipality.id}`, () =>
        getPublicParticipantStats(supabase, municipality.id, getPublicParticipationHistories(municipality.slug)),
        HOURLY_SHARED,
      ),
      cachedCompute(`participant-coverage:${municipality.id}`, () =>
        getParticipantIdentificationCoverage(supabase, municipality.id),
        HOURLY_SHARED,
      ).catch(error => {
        console.error("Speaker coverage unavailable:", error);
        return null;
      }),
    ]);
    return { participants, identificationCoverage, loadError: false };
  } catch (error) {
    console.error("Error loading public participants:", error);
    return { participants: [], identificationCoverage: null, loadError: true };
  }
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.round(seconds)}s`;
}

function plural(count: number, word: string) {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

const INITIAL_VISIBLE = 30;

function ParticipantRow({
  participant,
  rank,
  totalSeconds,
  maxSeconds,
}: {
  participant: PublicParticipantStats;
  rank: number;
  totalSeconds: number;
  maxSeconds: number;
}) {
  const percent =
    totalSeconds > 0 ? (participant.totalSeconds / totalSeconds) * 100 : 0;
  const barWidth =
    maxSeconds > 0 ? (participant.totalSeconds / maxSeconds) * 100 : 0;
  const topCategory = participant.topCategories[0]?.category;
  const topAppearances = participant.recentAppearances.slice(0, 2);
  const percentLabel = `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;

  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-3 px-4 py-3.5 sm:grid-cols-[1.75rem_minmax(0,1fr)_10rem_4rem] sm:gap-4 sm:px-5">
      <span className="pt-0.5 text-right text-sm font-semibold tabular-nums text-zinc-400">
        {rank}
      </span>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to={participantPath(participant.person)}
            className="truncate font-semibold text-zinc-900 hover:text-brand-700"
          >
            {participant.person.name}
          </Link>
          {topCategory && <Badge variant="muted">{topCategory}</Badge>}
        </div>
        <div className="mt-0.5 text-xs tabular-nums text-zinc-500">
          {plural(participant.meetingCount, "meeting")} · {participant.audioMeetingCount} audio-attributed · {participant.documentedMeetingCount} minutes-documented
        </div>
        {topAppearances.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {topAppearances.map((appearance) => (
              <Link
                key={`${appearance.meetingId}-${appearance.agendaItemId || "none"}`}
                to={meetingPath({ id: appearance.meetingId, slug: appearance.meetingSlug }, appearance.firstStartTime ? `?t=${Math.floor(appearance.firstStartTime)}` : "")}
                className="group inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 text-xs text-zinc-500"
              >
                {appearance.segmentCount > 0 && <PlayCircle className="h-3.5 w-3.5 shrink-0 text-zinc-400 group-hover:text-brand-600" aria-hidden="true" />}
                <span className="min-w-0 font-medium text-zinc-700 group-hover:text-brand-700 sm:truncate">
                  {appearance.agendaTitle || appearance.meetingTitle}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatDate(appearance.meetingDate)} · {appearance.segmentCount > 0 ? formatDuration(appearance.seconds) : "Official minutes"}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="text-right sm:contents">
        <div className="flex items-center gap-3 sm:h-6">
          <div className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 sm:block">
            <div
              className="h-full rounded-full bg-brand-600"
              style={{ width: `${participant.totalSeconds > 0 ? Math.max(barWidth, 1.5) : 0}%` }}
            />
          </div>
          <span className="w-full text-sm font-semibold tabular-nums text-zinc-900 sm:w-11 sm:text-right">
            <span title="Share of audio-attributed public speaking time">{participant.totalSeconds > 0 ? percentLabel : "—"}</span>
          </span>
        </div>
        <span className="block text-xs tabular-nums text-zinc-500 sm:flex sm:h-6 sm:items-center sm:justify-end sm:text-sm">
          {participant.totalSeconds > 0 ? formatDuration(participant.totalSeconds) : "No attributed audio"}
        </span>
      </div>
    </li>
  );
}

export default function Participants({ loaderData }: Route.ComponentProps) {
  const { participants, identificationCoverage, loadError } = loaderData;
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const shortName = rootData?.municipality?.short_name || DEFAULT_MUNICIPALITY.short_name;
  const [query, setQuery] = useState("");

  const totals = useMemo(() => {
    const totalSeconds = participants.reduce(
      (sum, participant) => sum + participant.totalSeconds,
      0,
    );

    return {
      people: participants.length,
      totalSeconds,
      minutes: Math.round(totalSeconds / 60),
      appearances: participants.reduce(
        (sum, participant) => sum + participant.meetingCount,
        0,
      ),
    };
  }, [participants]);

  const filteredParticipants = useMemo(() => {
    const lower = query.trim().toLowerCase();
    if (!lower) return participants;
    return participants.filter((participant) => {
      return (
        participant.person.name.toLowerCase().includes(lower) ||
        participant.topCategories.some((category) =>
          category.category.toLowerCase().includes(lower),
        ) ||
        participant.recentAppearances.some((appearance) =>
          `${appearance.meetingTitle} ${appearance.agendaTitle || ""} ${appearance.summary || ""}`
            .toLowerCase()
            .includes(lower),
        )
      );
    });
  }, [participants, query]);

  const [showAll, setShowAll] = useState(false);
  const maxSeconds = participants[0]?.totalSeconds || 0;
  const searching = query.trim().length > 0;
  const visibleParticipants =
    searching || showAll
      ? filteredParticipants
      : filteredParticipants.slice(0, INITIAL_VISIBLE);
  const hiddenCount = filteredParticipants.length - visibleParticipants.length;

  const stats = [
    { label: "People identified", value: totals.people },
    { label: "Audio-attributed minutes", value: totals.minutes },
    { label: "Person–meeting appearances", value: totals.appearances },
  ];

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-5xl px-4 py-12">
        <PageHeader
          title="Public participants"
          icon={Mic}
          description={`Public appearances in ${shortName} meetings, drawn from named audio segments and source-backed minutes records. Council and staff service, and committee members speaking in their committee role, are excluded using the role held at each meeting.`}
        />

        <div className="mb-6 space-y-2 text-sm text-zinc-600">
          <p>Speaking totals and percentages cover audio-attributed public speech only. Minutes-documented appearances add meetings, not speaking time; a meeting found in both sources counts once.</p>
          {identificationCoverage && identificationCoverage.totalSegments > 0 ? (
            <p>Speaker identification: {identificationCoverage.linkedSegments.toLocaleString()} of {identificationCoverage.totalSegments.toLocaleString()} transcript segments ({Math.round(100 * identificationCoverage.linkedSegments / identificationCoverage.totalSegments)}%) are linked to a person record, including council and staff. This measures segment identification, not the percentage of public speakers or the archive covered.</p>
          ) : <p>Speaker identification coverage {identificationCoverage ? "has no transcript segments to measure" : "is unavailable"}.</p>}
          <p>Audio attribution is machine-generated and may contain identity errors. Minutes records are included where the source and person have been established.</p>
        </div>

        <div className="mb-6 grid grid-cols-3 divide-x divide-zinc-100 rounded-2xl border border-zinc-200 bg-white shadow-sm">
          {stats.map((stat) => (
            <div key={stat.label} className="px-4 py-3 sm:px-5">
              <div className="text-xl font-bold tabular-nums text-zinc-900 sm:text-2xl">
                {stat.value.toLocaleString()}
              </div>
              <div className="text-xs text-zinc-500 sm:text-sm">{stat.label}</div>
            </div>
          ))}
        </div>

        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative sm:w-80">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, topic or meeting"
              aria-label="Search participants"
              className="h-10 rounded-xl border-zinc-200 bg-white pl-10"
            />
          </div>
          <p className="text-sm tabular-nums text-zinc-500">
            {searching
              ? `${filteredParticipants.length} of ${participants.length} match`
              : `Ordered by audio-attributed public speaking time`}
          </p>
        </div>

        {filteredParticipants.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-12 text-center">
            <MessageSquare className="mx-auto mb-3 h-10 w-10 text-zinc-300" />
            <p className="font-semibold text-zinc-600">{loadError ? "Participant records could not be loaded. Please try again." : "No matching participants found."}</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
            <div className="hidden grid-cols-[1.75rem_minmax(0,1fr)_10rem_4rem] gap-4 border-b border-zinc-100 bg-zinc-50/60 px-5 py-2 text-xs font-medium text-zinc-500 sm:grid">
              <span className="text-right">#</span>
              <span>Participant and recent appearances</span>
              <span className="text-right">Share of attributed speech</span>
              <span className="text-right">Time</span>
            </div>
            <ol className="divide-y divide-zinc-100">
              {visibleParticipants.map((participant) => (
                <ParticipantRow
                  key={participant.person.id}
                  participant={participant}
                  rank={participants.indexOf(participant) + 1}
                  totalSeconds={totals.totalSeconds}
                  maxSeconds={maxSeconds}
                />
              ))}
            </ol>
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="flex w-full items-center justify-center gap-1 border-t border-zinc-100 px-5 py-3 text-sm font-semibold text-brand-700 transition-colors hover:bg-zinc-50 hover:text-brand-800"
              >
                Show all {filteredParticipants.length} participants
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        <p className="mt-6 text-sm leading-relaxed text-zinc-500">
          Share is of all identified public speaking time; bars are scaled to the
          top speaker. Unidentified speaker labels are excluded. Identities come
          from transcript-to-person links and may improve as aliases are reviewed.
        </p>
      </div>
    </div>
  );
}
