import { getPublicSpeakingTimeStats, getPublicSpeakingTimeByMeeting, getPublicSpeakingTimeByTopic } from "../services/public-speaking.server";
import { publicData } from "../services/public-data-cache.server";
import { RECENT_PUBLIC_TTL } from "../lib/public-content-cache";
import { timed } from "../lib/server-timing.server";
import { attendanceEvidence, attendanceState, attendanceRateText, attendanceCoverageText } from "../lib/attendance-evidence";
import { SITE_NAME } from "../lib/site-name";
import { electionPath, meetingPath } from "../lib/paths";
import { withMeetingSlugs } from "../lib/slug-params.server";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { participantPath, personPath } from "../lib/people-paths";
import { NativeSelect } from "../components/ui/native-select";
import { resolvePersonParam } from "../lib/people.server";
import { loaderFailure } from "../lib/loader-errors";
import { useMemo, useState, useEffect } from "react";
import type { Route } from "./+types/person-profile";
import { civicToday, membershipIsActiveOn, councilTermStatus } from "../lib/council-terms";
import { councilServicePeriods, councilServiceRange } from "../lib/council-service";
import { getCouncilTerms } from "../services/council-terms";
import { getPublicPersonAttendance } from "../services/council-summary.server";
import { getPersonProfile } from "../services/people";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import { getMunicipalityFromMatches } from "../lib/municipality-helpers";
import type { Person, Municipality, Membership, Attendance, Vote } from "../lib/types";
import { Link, redirect, useRouteLoaderData, useSearchParams } from "react-router";
import { SubscribeButton } from "../components/subscribe-button";
import {
  getCouncillorStances,
  getCouncillorHighlights,
  getKeyVotes,
} from "../services/profiling";
import { SpeakingTimeCard } from "../components/profile/speaking-time-card";
import { SpeakerRanking } from "../components/profile/speaker-ranking";
import { ProfileTab } from "../components/profile/profile-tab";
import { PublicParticipation } from "../components/profile/public-participation";
import { getPublicParticipationHistory } from "../services/public-participation.server";
import { PolicyTab } from "../components/profile/policy-tab";
import { KeyVotesTab } from "../components/profile/key-votes-tab";
import {
  ChevronLeft,
  ChevronRight,
  User,
  Briefcase,
  History,
  Vote as VoteIcon,
  Scale,
  Target,
  Sparkles,
  Mic,
} from "lucide-react";
import { Badge } from "../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { cn, formatDate } from "../lib/utils";
import { AskQuestion } from "../components/ask-question";
import { SectionHeading } from "../components/ui/section-heading";
import { displayTitle } from "../lib/display-text";
import { ogImageUrl, ogPortrait } from "../lib/og";
import { metaDescription, pageMeta } from "../lib/page-meta";
import { breadcrumbList, councilPerson, jsonLd } from "../lib/structured-data";

export const meta: Route.MetaFunction = ({ data, matches }) => {
  if (!data?.person) return [{ title: `Person | ${SITE_NAME}` }];
  const p = data.person as Person;
  const municipality = getMunicipalityFromMatches(matches);
  const municipalityName = municipality?.name || DEFAULT_MUNICIPALITY.name;
  const activeMembership = (p as any).memberships?.find(
    (m: Membership) => membershipIsActiveOn(m, civicToday()),
  );
  const upcomingMembership = p.memberships?.find((m) => m.start_date && m.start_date > civicToday());
  const role = activeMembership?.role || (upcomingMembership ? `${upcomingMembership.role}-elect` : p.is_councillor ? ((p as any).in_memoriam ? "Councillor (in memoriam)" : "Former Council Member") : "Public participant");
  // "Councillor, 2018–present; Mayor, 2014–2018" from council service periods (lib/council-service).
  const service = councilServicePeriods(p as Person)
    .filter((period) => period.startYear)
    .map((period) => `${period.role}, ${councilServiceRange(period)}`)
    .join("; ");
  const lead = `${p.name}: ${role} for the ${municipalityName}${service ? ` (${service})` : ""}.`;
  const description = p.bio ? `${lead} ${p.bio}` : `${lead} Voting record, attendance, motions and speaking time on Langford Council.`;
  const path = personPath(p);
  // Share card with the portrait (when there is one) and their council service.
  const image = ogImageUrl(p.name, { subtitle: service || role, type: p.is_councillor ? "person" : "default", image: ogPortrait(p.image_url) });
  return [
    ...pageMeta(`${p.name} — ${role}`, description, path, "profile", { image }),
    jsonLd(
      councilPerson(p, role, path, metaDescription(description)),
      breadcrumbList([["People", "/people"], [p.name, path]]),
    ),
  ];
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const { id } = params;
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "0", 10);
  const timeRange = url.searchParams.get("timeRange") || "all";

  // Compute date range for speaking time queries
  let startDate: string | undefined;
  let endDate: string | undefined;
  if (timeRange === "12m") {
    // Civic (Pacific) dates, so the cache key changes once a day, at local midnight.
    endDate = civicToday();
    startDate = `${Number(endDate.slice(0, 4)) - 1}${endDate.slice(4)}`.replace(/-02-29$/, "-02-28");
  } else if (timeRange === "term") {
    endDate = civicToday();
  }
  // "all" -> startDate/endDate remain undefined

  try {
    const supabase = getSupabaseAdminClient();
    const [municipality, resolved] = await timed("person-resolve", Promise.all([
      getMunicipality(supabase),
      resolvePersonParam(supabase, id, request),
    ]));
    const personId = resolved.id;
    const [{ data: identity, error: identityError }, terms] = await timed("person-identity", Promise.all([
      supabase.from("people").select("*, memberships(*, organization:organizations(*))").eq("id", personId).single(),
      getCouncilTerms(supabase, municipality.id),
    ]));
    if (identityError) throw identityError;
    if (!identity) throw new Response("Person Not Found", { status: 404 });
    if (councilServicePeriods(identity as Person).length === 0) {
      throw redirect(participantPath(identity) + url.search, 302);
    }
    const selectedTermId = url.searchParams.get("term");
    const selectedTerm = selectedTermId ? terms.find((term) => String(term.id) === selectedTermId) : null;
    if (selectedTermId && !selectedTerm) throw new Response("Unknown council term", { status: 400 });
    const selectedPeriod = selectedTerm ? { start: selectedTerm.start_date, end: selectedTerm.end_date && selectedTerm.end_date < civicToday() ? selectedTerm.end_date : civicToday() } : undefined;
    const currentTerm = terms.find((term) => councilTermStatus(term, civicToday()) === "current");
    // Without verified term dates, show no term statistics rather than silently using all history.
    const termUnavailable = timeRange === "term" && !currentTerm && !selectedTerm;
    if (timeRange === "term") startDate = currentTerm?.start_date || "9999-12-31";
    if (selectedPeriod) { startDate = selectedPeriod.start; endDate = selectedPeriod.end; }
    // Profile data is critical; profiling data is optional (graceful degradation). Everything here
    // is public and session-free, so the whole bundle is shared at the edge (keyed by every input,
    // including today's civic date for the 12-month and term windows); a bundle with a degraded
    // part is never stored.
    const { data, speakingTimeRanking, speakingTimeTrend, speakingTimeByTopic, stances, highlights, keyVotes, publicParticipation } =
      await timed("person-profile", publicData(
        JSON.stringify(["person-profile-v1", municipality.id, personId, page, timeRange, selectedTerm?.id ?? null, startDate ?? null, endDate ?? null, civicToday()]),
        async () => {
          let degraded = false;
          const optional = <T,>(label: string, fallback: T) => (e: unknown) => { degraded = true; console.error(`${label} failed:`, e); return fallback; };
          const [data, speakingTimeRanking, speakingTimeTrend, speakingTimeByTopic, stances, highlights, keyVotes, publicParticipation] = await Promise.all([
            getPublicPersonAttendance(municipality.id, personId, selectedTerm?.id).then(summary =>
              getPersonProfile(supabase, String(personId), page, municipality.id, selectedPeriod, summary)),
            getPublicSpeakingTimeStats(startDate, endDate, municipality.id).catch(optional("Speaking time stats", [] as Awaited<ReturnType<typeof getPublicSpeakingTimeStats>>)),
            getPublicSpeakingTimeByMeeting(personId, startDate, endDate, municipality.id).catch(optional("Speaking time by meeting", [] as Awaited<ReturnType<typeof getPublicSpeakingTimeByMeeting>>)),
            getPublicSpeakingTimeByTopic(personId, startDate, endDate, municipality.id).catch(optional("Speaking time by topic", [] as Awaited<ReturnType<typeof getPublicSpeakingTimeByTopic>>)),
            getCouncillorStances(supabase, personId).catch(optional("Councillor stances", [] as Awaited<ReturnType<typeof getCouncillorStances>>)),
            getCouncillorHighlights(supabase, personId).catch(optional("Councillor highlights", null as Awaited<ReturnType<typeof getCouncillorHighlights>>)),
            getKeyVotes(supabase, personId).catch(optional("Key votes", [] as Awaited<ReturnType<typeof getKeyVotes>>)),
            withMeetingSlugs(supabase, getPublicParticipationHistory(personId, municipality.slug)),
          ]);
          return { data, speakingTimeRanking, speakingTimeTrend, speakingTimeByTopic, stances, highlights, keyVotes, publicParticipation, degraded };
        },
        (bundle) => !bundle.degraded, RECENT_PUBLIC_TTL, { shareWithSignedIn: true },
      ));

    // Find current person's speaking time from the ranking
    const currentPersonSpeaking = speakingTimeRanking.find(
      (r) => r.person_id === personId,
    );
    const rank = currentPersonSpeaking
      ? speakingTimeRanking
          .filter((r) => r.total_seconds > 0)
          .sort((a, b) => b.total_seconds - a.total_seconds)
          .findIndex((r) => r.person_id === personId) + 1
      : undefined;
    const totalCouncillorsWithData = speakingTimeRanking.filter(
      (r) => r.total_seconds > 0,
    ).length;

    return {
      ...data,
      publicParticipation,
      page,
      speakingTimeRanking,
      speakingTimeTrend,
      speakingTimeByTopic,
      stances,
      highlights,
      keyVotes,
      timeRange,
      termUnavailable,
      terms,
      selectedTerm,
      currentPersonSpeaking,
      speakingRank: rank,
      totalCouncillorsWithData,
    };
  } catch (error) {
    throw loaderFailure(error, "Person Not Found");
  }
}

// ── Main Component ──

export default function PersonProfile({ loaderData }: Route.ComponentProps) {
  const {
    person,
    attendance,
    attendanceSummary: attendanceStats,
    attendanceTotal,
    candidacies,
    segments,
    stats,
    alignmentResults,
    page,
    speakingTimeRanking,
    speakingTimeTrend,
    speakingTimeByTopic,
    stances,
    highlights,
    keyVotes,
    currentPersonSpeaking,
    speakingRank,
    totalCouncillorsWithData,
    termUnavailable,
    terms,
    selectedTerm,
    timeRange,
    publicParticipation,
  } = loaderData;

  const [profileParams, setProfileParams] = useSearchParams();
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const shortName = rootData?.municipality?.short_name || DEFAULT_MUNICIPALITY.short_name;
  const [selectedAlignId, setSelectedAlignId] = useState<number | null>(null);

  useEffect(() => {
    if (alignmentResults && alignmentResults.length > 0 && !selectedAlignId) {
      setSelectedAlignId(alignmentResults[0].personId);
    }
  }, [alignmentResults]);

  const selectedAlignment = useMemo(() => {
    return alignmentResults?.find((r: any) => r.personId === selectedAlignId);
  }, [alignmentResults, selectedAlignId]);

  const topTopics = useMemo(() => {
    const counts: Record<string, number> = {};
    let total = 0;
    segments.forEach((seg) => {
      const cat = seg.agenda_items?.category;
      if (cat && cat !== "Other") {
        counts[cat] = (counts[cat] || 0) + 1;
        total++;
      }
    });
    if (total === 0) return [];
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, count]) => ({
        name,
        percent: Math.round((count / total) * 100),
      }));
  }, [segments]);

  const today = civicToday();
  const activeMemberships = person.memberships?.filter((m) => membershipIsActiveOn(m, today)) || [];
  const upcomingMemberships = person.memberships?.filter((m) => m.start_date && m.start_date > today) || [];
  const serviceMemberships = [...(person.memberships || [])].sort(
    (a, b) => (b.start_date || "").localeCompare(a.start_date || ""),
  );
  const councilService = councilServicePeriods(person, today);
  const otherService = serviceMemberships.filter((m) => m.organization?.classification !== "Council");
  const upcomingRole = (role: string) => /mayor|councillor|councilor/i.test(role) ? `${role}-elect` : `Incoming ${role}`;



  const relevantAttendance = attendance;

  const hasSpeakingData = currentPersonSpeaking && currentPersonSpeaking.total_seconds > 0;
  const speakingPeriodLabel = selectedTerm?.name || (timeRange === "12m" ? "Last 12 months" : timeRange === "term" ? "Current term" : "All recorded dates");
  const speakingCoverageLabel = hasSpeakingData ? `${currentPersonSpeaking.meeting_count} meetings · ${speakingPeriodLabel}` : "No attributed speech available";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 pt-8 pb-16">
        {/* Profile header */}
        <header className="mb-8 rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl bg-zinc-100 ring-1 ring-zinc-200 sm:h-28 sm:w-28">
              {person.image_url ? (
                <img src={person.image_url} alt={person.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <User className="h-10 w-10 text-zinc-300" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500">
                <Link to="/people" className="-ml-1 inline-flex items-center font-medium text-zinc-600 hover:text-brand-700">
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  Council
                </Link>
                {(activeMemberships.some((m) => m.organization?.classification === "Council")
                  ? activeMemberships.filter((m) => m.organization?.classification === "Council")
                  : activeMemberships
                ).map((m) => (
                  <span key={m.id} className="inline-flex items-center gap-2">
                    <span aria-hidden="true" className="text-zinc-300">·</span>
                    <span>
                      <span className="font-medium text-brand-700">{m.role}</span>
                      {m.start_date && (
                        <>
                          {" since "}
                          {m.organization?.classification === "Council"
                            ? councilService.find((period) => period.organizationId === m.organization_id && period.role === m.role && period.status === "current")?.startYear || m.start_date.slice(0, 4)
                            : m.start_date.slice(0, 4)}
                        </>
                      )}
                    </span>
                  </span>
                ))}
                {activeMemberships.length === 0 && (
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden="true" className="text-zinc-300">·</span>
                    {upcomingMemberships.length > 0
                      ? upcomingRole(upcomingMemberships[0].role)
                      : (person as any).in_memoriam && councilService[0]
                        ? `${councilService[0].role} ${councilServiceRange(councilService[0])} · In memoriam`
                        : `Former ${shortName} council member`}
                  </span>
                )}
              </p>
              <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900 md:text-4xl">
                {person.name}
              </h1>
            </div>
            {(person.is_councillor || person.email) && (
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {person.email && (
                  <a
                    href={`mailto:${person.email}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-surface px-3 py-1.5 text-sm font-semibold text-zinc-700 transition-colors hover:border-brand-300 hover:text-brand-700"
                  >
                    Email
                  </a>
                )}
                {person.is_councillor && (
                <Link
                  to={`/compare?a=${person.slug || person.id}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-surface px-3 py-1.5 text-sm font-semibold text-zinc-700 transition-colors hover:border-brand-300 hover:text-brand-700"
                >
                  Compare
                </Link>
                )}
                {person.is_councillor && <SubscribeButton type="person" targetId={person.id} label="Follow" />}
              </div>
            )}
          </div>
          {person.bio && (
            <p className="mt-5 max-w-3xl border-t border-zinc-100 pt-4 text-sm leading-relaxed text-zinc-600">
              {person.bio}
            </p>
          )}
        </header>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          {/* Main Content with Tabs */}
          <div className="min-w-0 space-y-4 lg:col-span-8">
            <Tabs defaultValue="profile" className="space-y-6">
              <div className="sticky top-16 z-10 -mx-4 bg-zinc-50/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-zinc-50/75">
                <TabsList className="flex h-auto w-full justify-start gap-0 overflow-x-auto rounded-none border-b border-zinc-200 bg-transparent p-0 [scrollbar-width:none]">
                  <TabsTrigger
                    value="profile"
                    className="relative h-11 flex-none rounded-none border-0 bg-transparent px-3 text-sm font-semibold text-zinc-500 shadow-none hover:text-zinc-800 data-[state=active]:bg-transparent data-[state=active]:text-zinc-900 data-[state=active]:shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full data-[state=active]:after:bg-brand-600"
                  >
                    Profile
                  </TabsTrigger>
                  <TabsTrigger
                    value="policy"
                    className="relative h-11 flex-none rounded-none border-0 bg-transparent px-3 text-sm font-semibold text-zinc-500 shadow-none hover:text-zinc-800 data-[state=active]:bg-transparent data-[state=active]:text-zinc-900 data-[state=active]:shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full data-[state=active]:after:bg-brand-600"
                  >
                    Policy
                  </TabsTrigger>
                  <TabsTrigger
                    value="key-votes"
                    className="relative h-11 flex-none rounded-none border-0 bg-transparent px-3 text-sm font-semibold text-zinc-500 shadow-none hover:text-zinc-800 data-[state=active]:bg-transparent data-[state=active]:text-zinc-900 data-[state=active]:shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full data-[state=active]:after:bg-brand-600"
                  >
                    Key votes
                  </TabsTrigger>
                  <TabsTrigger
                    value="votes"
                    className="relative h-11 flex-none rounded-none border-0 bg-transparent px-3 text-sm font-semibold text-zinc-500 shadow-none hover:text-zinc-800 data-[state=active]:bg-transparent data-[state=active]:text-zinc-900 data-[state=active]:shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full data-[state=active]:after:bg-brand-600"
                  >
                    Votes
                  </TabsTrigger>
                  {hasSpeakingData && (
                  <TabsTrigger
                    value="speaking"
                    className="relative h-11 flex-none rounded-none border-0 bg-transparent px-3 text-sm font-semibold text-zinc-500 shadow-none hover:text-zinc-800 data-[state=active]:bg-transparent data-[state=active]:text-zinc-900 data-[state=active]:shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full data-[state=active]:after:bg-brand-600"
                  >
                    Speaking
                  </TabsTrigger>
                  )}
                  <TabsTrigger
                    value="attendance"
                    className="relative h-11 flex-none rounded-none border-0 bg-transparent px-3 text-sm font-semibold text-zinc-500 shadow-none hover:text-zinc-800 data-[state=active]:bg-transparent data-[state=active]:text-zinc-900 data-[state=active]:shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full data-[state=active]:after:bg-brand-600"
                  >
                    Attendance
                  </TabsTrigger>
                </TabsList>
              </div>

              {/* Profile Tab */}
              <TabsContent value="profile" className="space-y-6">
                {publicParticipation && <PublicParticipation history={publicParticipation} />}
                <ProfileTab
                  highlights={highlights}
                  attendanceStats={attendanceStats}
                  totalVotes={stats.totalVotes}
                  totalMoved={stats.totalMoved}
                  totalSeconded={stats.totalSeconded}
                  hoursSpoken={hasSpeakingData ? currentPersonSpeaking!.total_seconds / 3600 : null}
                  speakingRank={speakingRank}
                  totalCouncillors={totalCouncillorsWithData}
                  speakingCoverageLabel={speakingCoverageLabel}
                  topTopics={topTopics}
                  personName={person.name}
                  showStats={Boolean(person.is_councillor || (person.memberships?.length ?? 0) > 0)}
                  hasParticipation={Boolean(publicParticipation)}
                />
              </TabsContent>

              {/* Policy Tab */}
              <TabsContent value="policy" className="space-y-6">
                <PolicyTab
                  stances={stances ?? []}
                  highlights={highlights?.highlights ?? []}
                />
              </TabsContent>

              {/* Key Votes Tab */}
              <TabsContent value="key-votes" className="space-y-6">
                <KeyVotesTab
                  keyVotes={keyVotes ?? []}
                  personName={person.name}
                />
              </TabsContent>

              {/* Votes Tab */}
              <TabsContent value="votes" className="space-y-6">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {/* Voting record */}
                  <Link
                    to={personPath(person, "/votes")}
                    className="group rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm transition-colors hover:border-brand-300"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="text-sm text-zinc-500">Recorded votes</h3>
                      <span className="text-sm font-semibold text-brand-700 group-hover:text-brand-800">View all</span>
                    </div>
                    <p className="mt-1 text-3xl font-bold tabular-nums tracking-tight text-zinc-900">
                      {stats.totalVotes > 0 ? stats.totalVotes.toLocaleString() : "—"}
                    </p>
                    {stats.totalVotes > 0 && stats.votesBreakdown ? (
                      <dl className="mt-4 space-y-2">
                        {([
                          { label: "Yes", value: stats.votesBreakdown.yes, bar: "bg-emerald-500" },
                          { label: "No", value: stats.votesBreakdown.no, bar: "bg-red-500" },
                          { label: "Abstained", value: stats.votesBreakdown.abstain, bar: "bg-zinc-400" },
                        ]).map((row) => (
                          <div key={row.label} className="flex items-center gap-3 text-sm">
                            <dt className="w-20 shrink-0 text-zinc-600">{row.label}</dt>
                            <span className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100">
                              <span className={cn("block h-full rounded-full", row.bar)} style={{ width: `${(row.value / stats.totalVotes) * 100}%` }} />
                            </span>
                            <dd className="w-10 shrink-0 text-right font-medium tabular-nums text-zinc-800">{row.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="mt-3 text-sm text-zinc-500">No individually documented votes for this period.</p>
                    )}
                  </Link>

                  {/* Motions moved / seconded */}
                  <Link
                    to={personPath(person, "/proposals")}
                    className="group rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm transition-colors hover:border-brand-300"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="text-sm text-zinc-500">Motions moved or seconded</h3>
                      <span className="text-sm font-semibold text-brand-700 group-hover:text-brand-800">View all</span>
                    </div>
                    <p className="mt-1 text-3xl font-bold tabular-nums tracking-tight text-zinc-900">
                      {(stats.totalMoved + stats.totalSeconded).toLocaleString()}
                    </p>
                    <dl className="mt-4 grid grid-cols-2 divide-x divide-zinc-100 rounded-xl border border-zinc-100 bg-zinc-50/60">
                      <div className="px-3 py-2.5">
                        <dt className="text-xs text-zinc-500">Moved</dt>
                        <dd className="text-lg font-semibold tabular-nums text-zinc-900">{stats.totalMoved.toLocaleString()}</dd>
                      </div>
                      <div className="px-3 py-2.5">
                        <dt className="text-xs text-zinc-500">Seconded</dt>
                        <dd className="text-lg font-semibold tabular-nums text-zinc-900">{stats.totalSeconded.toLocaleString()}</dd>
                      </div>
                    </dl>
                  </Link>
                </div>

                {/* Voting alignment */}
                <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                  <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
                    <div>
                      <h3 className="text-base font-semibold text-zinc-900">Voting alignment</h3>
                      <p className="mt-0.5 text-sm text-zinc-500">How often colleagues voted the same way on shared, fully recorded votes.</p>
                    </div>
                    <Link to={`/alignment?person=${person.id}#person-${person.id}`} className="shrink-0 text-sm font-semibold text-brand-700 hover:text-brand-800">
                      Full analysis
                    </Link>
                  </div>
                  {alignmentResults && alignmentResults.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="border-y border-zinc-100 bg-zinc-50/70 text-xs text-zinc-500">
                          <tr>
                            <th scope="col" className="px-5 py-2 font-medium">Member</th>
                            <th scope="col" className="px-3 py-2 text-right font-medium">Shared votes</th>
                            <th scope="col" className="px-5 py-2 text-right font-medium">Agreement</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                          {alignmentResults.map((result: any) => (
                            <tr key={result.personId} className="hover:bg-zinc-50">
                              <td className="px-5 py-2">
                                <Link to={personPath({ id: result.personId, name: result.personName })} className="flex min-w-0 items-center gap-2.5 font-medium text-zinc-800 hover:text-brand-700">
                                  <span className="h-7 w-7 shrink-0 overflow-hidden rounded-full border border-zinc-200 bg-zinc-100">
                                    {result.imageUrl ? (
                                      <img src={result.imageUrl} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                      <User className="m-1.5 h-3.5 w-3.5 text-zinc-300" aria-hidden="true" />
                                    )}
                                  </span>
                                  <span className="truncate">{result.personName}</span>
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{result.totalMotions}</td>
                              <td className="px-5 py-2">
                                <div className="flex items-center justify-end gap-2.5">
                                  <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-zinc-100 sm:block">
                                    <span className="block h-full rounded-full bg-brand-500" style={{ width: `${result.alignmentRate}%` }} />
                                  </span>
                                  <span className="w-10 text-right font-semibold tabular-nums text-zinc-900">{result.alignmentRate.toFixed(0)}%</span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="border-t border-zinc-100 px-5 py-4 text-sm text-zinc-500">
                      No fully recorded votes shared with other members in this period, so alignment can't be calculated.
                    </p>
                  )}
                </section>
              </TabsContent>

              {/* Speaking Tab */}
              {hasSpeakingData && (
                <TabsContent value="speaking" className="space-y-6">
                  <SpeakingTimeCard
                    totalSeconds={currentPersonSpeaking!.total_seconds}
                    meetingCount={currentPersonSpeaking!.meeting_count}
                    segmentCount={currentPersonSpeaking!.segment_count}
                    trendData={speakingTimeTrend}
                    topicBreakdown={speakingTimeByTopic}
                    rank={speakingRank}
                    totalCouncillors={totalCouncillorsWithData}
                    fixedPeriodLabel={selectedTerm?.name}
                  />
                  {speakingTimeRanking && speakingTimeRanking.some((r: any) => r.total_seconds > 0) && (
                    <section className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm sm:p-6">
                      <SpeakerRanking
                        rankings={speakingTimeRanking}
                        currentPersonId={person.id}
                      />
                    </section>
                  )}
                </TabsContent>
              )}

              {/* Attendance Tab */}
              <TabsContent value="attendance" className="space-y-8">
                {relevantAttendance.length > 0 ? (
                  <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pt-5 pb-3">
                      <h3 className="text-base font-semibold text-zinc-900">Meeting attendance</h3>
                      {attendanceStats.total > 0 && (
                        <p className="text-sm text-zinc-500 tabular-nums">
                          {attendanceStats.rate !== null && <span className="font-semibold text-zinc-900">{attendanceRateText(attendanceStats)}. </span>}
                          {attendanceCoverageText(attendanceStats)}
                        </p>
                      )}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="border-y border-zinc-100 bg-zinc-50/70 text-xs text-zinc-500">
                          <tr>
                            <th scope="col" className="hidden px-5 py-2 font-medium sm:table-cell">Date</th>
                            <th scope="col" className="px-5 py-2 font-medium sm:px-3">Meeting</th>
                            <th scope="col" className="px-5 py-2 text-right font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                          {relevantAttendance.map((record) => {
                            const evidence = attendanceEvidence(record);
                            const state = attendanceState(record, record.meetings?.meeting_date || "");
                            const tone = state === "unknown" ? "warning" : state === "absent" ? "danger" : "success";
                            const label = state === "unknown" ? "Unknown" : `${state === "present" ? "Present" : "Absent"}${evidence ? "" : " (recorded)"}`;
                            return (
                              <tr key={record.id} className="hover:bg-zinc-50">
                                <td className="hidden whitespace-nowrap px-5 py-2.5 tabular-nums text-zinc-500 sm:table-cell">
                                  {formatDate(record.meetings?.meeting_date)}
                                </td>
                                <td className="px-5 py-2.5 sm:px-3">
                                  <Link to={meetingPath({ id: record.meeting_id, slug: record.meetings?.slug })} className="font-medium text-zinc-900 hover:text-brand-700">
                                    {displayTitle(record.meetings?.title)}
                                  </Link>
                                  <span className="block text-xs tabular-nums text-zinc-500 sm:hidden">
                                    {formatDate(record.meetings?.meeting_date)}
                                  </span>
                                </td>
                                <td className="px-5 py-2.5 text-right">
                                  <Badge variant={tone}>{label}</Badge>
                                  {evidence && state !== "unknown" && <a href={evidence.source_url} className="ml-2 underline text-xs">Source</a>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {attendanceTotal > 20 && (
                      <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-5 py-3">
                        <p className="text-sm text-zinc-500 tabular-nums">
                          {page * 20 + 1}–{Math.min((page + 1) * 20, attendanceTotal)} of {attendanceTotal}
                        </p>
                        <div className="flex gap-2">
                          <Link
                            to={`?${new URLSearchParams({ ...Object.fromEntries(profileParams), page: String(Math.max(0, page - 1)) })}`}
                            preventScrollReset={true}
                            aria-disabled={page === 0}
                            className={cn(
                              "rounded-lg border border-zinc-200 bg-surface px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50",
                              page === 0 && "pointer-events-none opacity-50",
                            )}
                          >
                            Previous
                          </Link>
                          <Link
                            to={`?${new URLSearchParams({ ...Object.fromEntries(profileParams), page: String(page + 1) })}`}
                            preventScrollReset={true}
                            aria-disabled={(page + 1) * 20 >= attendanceTotal}
                            className={cn(
                              "rounded-lg border border-zinc-200 bg-surface px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50",
                              (page + 1) * 20 >= attendanceTotal && "pointer-events-none opacity-50",
                            )}
                          >
                            Next
                          </Link>
                        </div>
                      </div>
                    )}
                  </section>
                ) : (
                  <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                    {attendanceCoverageText(attendanceStats)} Missing or unverified records are unknown, not absences.
                  </div>
                )}

                {candidacies.length > 0 && (
                  <section>
                    <SectionHeading title="Electoral history" />
                    <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                      {candidacies.map((can: any) => {
                        const election = can.election_offices?.elections;
                        const year = election?.election_date ? election.election_date.slice(0, 4) : null;
                        const inner = (
                          <>
                            <div className="min-w-0">
                              <p className="font-semibold text-zinc-900">{election?.name || "Election"}</p>
                              <p className="text-sm text-zinc-500">
                                Candidate for {can.election_offices?.office || "office"}
                                {year && !election?.name?.includes(year) ? ` · ${year}` : ""}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                              {can.votes_received != null && (
                                <span className="text-sm tabular-nums text-zinc-600">
                                  <span className="font-semibold text-zinc-900">{can.votes_received.toLocaleString()}</span> votes
                                </span>
                              )}
                              <Badge variant={can.is_elected ? "success" : "muted"}>
                                {can.is_elected ? "Elected" : "Not elected"}
                              </Badge>
                            </div>
                          </>
                        );
                        return (
                          <li key={can.id}>
                            {election?.id ? (
                              <Link to={electionPath(election)} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3.5 hover:bg-zinc-50">
                                {inner}
                              </Link>
                            ) : (
                              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3.5">{inner}</div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </TabsContent>
            </Tabs>
          </div>

          {/* Sidebar */}
          <aside className="space-y-6 lg:col-span-4">
            <div className="rounded-2xl border border-zinc-200 bg-surface p-4 shadow-sm">
              <label htmlFor="profile-term" className="mb-2 block text-sm font-semibold text-zinc-900">
                Statistics period
              </label>
              <NativeSelect
                id="profile-term"
                value={selectedTerm?.id || ""}
                onChange={(event) => setProfileParams((prev) => {
                  const next = new URLSearchParams(prev);
                  if (event.target.value) next.set("term", event.target.value); else next.delete("term");
                  next.delete("page");
                  next.delete("timeRange");
                  return next;
                }, { preventScrollReset: true })}
              >
                <option value="">All available records</option>
                {terms.map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}
              </NativeSelect>
              {termUnavailable && <p className="mt-3 text-sm text-zinc-600">Current term dates have not been recorded. <Link to="?timeRange=all" className="underline">View all-time speaking statistics</Link>.</p>}
              <details className="group mt-3 text-sm text-zinc-500">
                <summary className="cursor-pointer list-none font-medium text-zinc-600 hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
                  <span className="inline-flex items-center gap-1">
                    About these numbers
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                  </span>
                </summary>
                <div className="mt-2 space-y-2 leading-relaxed">
                  <p>Votes, motions, attendance and alignment use the selected period. {selectedTerm ? "Speaking time uses the selected term." : "Speaking time has its own range selector."} AI highlights, policy summaries and key votes cover all recorded service.</p>
                  {stats.totalVotes === 0 && <p>Individual vote records are unavailable for this period. This does not mean no votes were cast.</p>}
                  {stats.totalVotes > 0 && <p>Totals include explicit choices and validated reconstructions from official minutes (meeting pages mark inferred choices). Incomplete roll calls are excluded from alignment.</p>}
                  <p>Recorded speech: {speakingCoverageLabel}. Totals exclude missing transcripts and unidentified speakers.</p>
                </div>
              </details>
            </div>

            {(councilService.length > 0 || otherService.length > 0) && (
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Service</CardTitle>
                  
                </CardHeader>
                <CardContent>
                  <ol className="flex flex-col gap-5">
                    {councilService.map((period) => (
                      <li key={`${period.organizationId}-${period.role}-${period.startYear}-${period.startDate || "history"}`} className="flex flex-wrap items-start justify-between gap-3 border-l-2 border-border pl-4">
                        <div>
                          <p className="font-semibold">{period.status === "upcoming" ? upcomingRole(period.role) : period.role}</p>
                          <p className="text-sm text-muted-foreground">{period.organizationName}</p>
                          <p className="text-sm text-muted-foreground">{councilServiceRange(period)}</p>
                          {period.status === "upcoming" && period.startDate && <p className="text-xs text-muted-foreground">Takes office {formatDate(period.startDate)}</p>}
                          {period.sourceUrl && <a href={period.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline underline-offset-2">Historical source</a>}
                        </div>
                        <Badge variant={period.status === "current" ? "default" : "outline"}>{period.status === "upcoming" ? "Upcoming" : period.status === "current" ? "Current" : "Past"}</Badge>
                      </li>
                    ))}
                    {otherService.map((m) => {
                      const upcoming = Boolean(m.start_date && m.start_date > today);
                      const active = membershipIsActiveOn(m, today);
                      return (
                        <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 border-l-2 border-border pl-4">
                          <div>
                            <p className="font-semibold">{upcoming ? upcomingRole(m.role) : m.role}</p>
                            <p className="text-sm text-muted-foreground">{m.organization?.name}</p>
                            <p className="text-sm text-muted-foreground">
                              {m.start_date ? formatDate(m.start_date) : "Start date unrecorded"}
                              {" – "}{m.end_date ? formatDate(m.end_date) : upcoming ? "End date unrecorded" : "Present"}
                            </p>
                          </div>
                          <Badge variant={active ? "default" : "outline"}>{upcoming ? "Upcoming" : active ? "Current" : "Past"}</Badge>
                        </li>
                      );
                    })}
                  </ol>
                </CardContent>
              </Card>
            )}


            <AskQuestion
              personId={person.id}
              personName={person.name}
              className="shadow-sm"
            />
          </aside>
        </div>
      </div>
    </div>
  );
}
