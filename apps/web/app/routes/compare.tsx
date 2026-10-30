import { getPublicSpeakingTimeStats, getPublicSpeakingTimeByTopic } from "../services/public-speaking.server";
import { attendanceCoverageText } from "../lib/attendance-evidence";
import { SITE_NAME } from "../lib/site-name";
import { personPath } from "../lib/people-paths";
import { getCouncilTerms } from "../services/council-terms";
import { getMunicipality } from "../services/municipality";
import type { CouncilTerm } from "../lib/types";
import { civicToday, membershipIsActiveOn, councilTermStatus } from "../lib/council-terms";
import { useState, useMemo } from "react";
import type { Route } from "./+types/compare";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getPublicCouncilComparisonPeople } from "../services/council-summary.server";
import { type PersonWithStats } from "../services/people";
import { fetchRelevantVotesForAlignment } from "../services/people";
import {
  getCouncillorStances,
  type CouncillorStance,
  type SpeakingTimeByTopic,
  type SpeakingTimeStat,
} from "../services/profiling";
import {
  calculateAlignmentForPerson,
  type AlignmentResult,
} from "../lib/alignment-utils";
import { TOPICS, TOPIC_ICONS, type TopicName } from "../lib/topic-utils";
import { StanceSpectrum } from "../components/profile/stance-spectrum";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/ui/page-header";
import { SectionHeading } from "../components/ui/section-heading";
import { NativeSelect } from "../components/ui/native-select";
import { cn } from "../lib/utils";
import { ogImageUrl, ogUrl } from "../lib/og";
import { Link, redirect, useNavigate } from "react-router";
import {
  Scale,
  Users,
  ChevronDown,
  Check,
  X as XIcon,
  Minus,
  Clock,
  BarChart3,
  ArrowRight,
  ArrowLeftRight,
} from "lucide-react";

// ── Types ──

interface SelectModeData {
  mode: "select";
  councillors: PersonWithStats[];
  personA: PersonWithStats | null;
  personB: PersonWithStats | null;
  stancesA: null;
  stancesB: null;
  speakingA: null;
  speakingB: null;
  speakingStatsAll: null;
  pairwiseAlignment: null;
}

interface CompareModeData {
  terms: CouncilTerm[];
  selectedTerm: CouncilTerm | null;
  mode: "compare";
  councillors: PersonWithStats[];
  personA: PersonWithStats;
  personB: PersonWithStats;
  stancesA: CouncillorStance[];
  stancesB: CouncillorStance[];
  speakingA: SpeakingTimeByTopic[];
  speakingB: SpeakingTimeByTopic[];
  speakingStatsAll: SpeakingTimeStat[];
  speakingUnavailable: boolean;
  pairwiseAlignment: AlignmentResult | null;
}

type LoaderData = SelectModeData | CompareModeData;

// ── Meta ──

export const meta: Route.MetaFunction = ({ data }) => {
  const d = data as LoaderData | undefined;
  if (d?.mode === "compare" && d.personA && d.personB) {
    const title = `Compare ${d.personA.name} vs ${d.personB.name} | ${SITE_NAME}`;
    const description = `Side-by-side comparison of ${d.personA.name} and ${d.personB.name} on voting alignment, stances, and speaking time.`;
    return [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: `${d.personA.name} vs ${d.personB.name}` },
      { property: "og:description", content: description },
      { property: "og:type", content: "profile" },
      { property: "og:url", content: ogUrl(`/compare?a=${d.personA.slug || d.personA.id}&b=${d.personB.slug || d.personB.id}`) },
      { property: "og:image", content: ogImageUrl(`${d.personA.name} and ${d.personB.name}`, { subtitle: "Votes, positions and speaking time, side by side", type: "council" }) },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:card", content: "summary_large_image" },
    ];
  }
  return [
    { title: `Compare Councillors | ${SITE_NAME}` },
    { name: "description", content: "Compare two councillors side-by-side on voting alignment, policy stances, and speaking time." },
    { property: "og:title", content: `Compare Councillors | ${SITE_NAME}` },
    { property: "og:description", content: "Compare two councillors side-by-side on voting alignment, policy stances, and speaking time." },
    { property: "og:type", content: "website" },
    { property: "og:url", content: ogUrl("/compare") },
    { property: "og:image", content: ogImageUrl("Compare council members", { subtitle: "Votes, positions and speaking time, side by side", type: "council" }) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

// ── Loader ──

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const aParam = url.searchParams.get("a");
  const bParam = url.searchParams.get("b");
  const supabase = getSupabaseAdminClient();

  const municipality = await getMunicipality(supabase);
  const terms = (await getCouncilTerms(supabase, municipality.id)).filter((term) => councilTermStatus(term) !== "upcoming");
  const termParam = url.searchParams.get("term");
  const selectedTerm = termParam === "all" ? null : terms.find((term) => String(term.id) === termParam)
    || terms.find((term) => councilTermStatus(term) === "current") || null;

  // Always load councillor list for selectors
  const councillors = await getPublicCouncilComparisonPeople(municipality.id);

  // People are addressed by slug (?a=scott-goodmanson); legacy numeric ids 301.
  const slugOf = (id: number) => councillors.find((c) => c.id === id)?.slug;
  let legacy = false;
  for (const key of ["a", "b"]) {
    const value = url.searchParams.get(key);
    if (value && /^\d+$/.test(value)) {
      const slug = slugOf(Number(value));
      if (slug) { url.searchParams.set(key, slug); legacy = true; }
    }
  }
  if (legacy) throw redirect(`${url.pathname}?${url.searchParams.toString()}`, 301);
  const idFor = (value: string | null) => {
    if (!value) return null;
    const match = /^\d+$/.test(value)
      ? councillors.find((c) => c.id === Number(value))
      : councillors.find((c) => c.slug === value.toLowerCase());
    return match ? String(match.id) : null;
  };
  const aId = idFor(aParam);
  const bId = idFor(bParam);

  if (!aId || !bId) {
    const personA = aId ? councillors.find((c) => c.id === parseInt(aId)) ?? null : null;
    return {
      mode: "select" as const,
      councillors,
      personA,
      personB: null,
      stancesA: null,
      stancesB: null,
      speakingA: null,
      speakingB: null,
      speakingStatsAll: null,
      pairwiseAlignment: null,
    };
  }

  // Load both profiles in parallel
  // Speaking-time RPCs can time out; degrade to "unavailable" rather than
  // failing the whole page.
  const orNull = <T,>(promise: Promise<T>) => promise.catch(() => null);
  const [stancesA, stancesB, speakingARes, speakingBRes, speakingStatsRes] = await Promise.all([
    getCouncillorStances(supabase, parseInt(aId)),
    getCouncillorStances(supabase, parseInt(bId)),
    orNull(getPublicSpeakingTimeByTopic(parseInt(aId), selectedTerm?.start_date, selectedTerm?.end_date || undefined, municipality.id)),
    orNull(getPublicSpeakingTimeByTopic(parseInt(bId), selectedTerm?.start_date, selectedTerm?.end_date || undefined, municipality.id)),
    orNull(getPublicSpeakingTimeStats(selectedTerm?.start_date, selectedTerm?.end_date || undefined, municipality.id)),
  ]);
  const speakingUnavailable = !speakingARes || !speakingBRes || !speakingStatsRes;
  const speakingA = speakingARes ?? [];
  const speakingB = speakingBRes ?? [];
  const speakingStatsAll = speakingStatsRes ?? [];

  // Compute pairwise voting alignment
  const [votesA, membershipsRes] = await Promise.all([
    fetchRelevantVotesForAlignment(supabase, aId, municipality.id),
    supabase
      .from("memberships")
      .select("*, people(id, name, image_url)")
      .eq(
        "organization_id",
        (
          await supabase
            .from("organizations")
            .select("id")
            .eq("classification", "Council")
            .eq("municipality_id", municipality.id)
            .single()
        ).data?.id || 1,
      ),
  ]);

  const alignmentResults = calculateAlignmentForPerson(
    parseInt(aId),
    votesA,
    membershipsRes.data || [],
    selectedTerm ? new Date(`${selectedTerm.start_date}T00:00:00`) : new Date(0),
    selectedTerm?.end_date ? new Date(`${selectedTerm.end_date}T00:00:00`) : new Date(2100, 0, 1),
  );
  const pairwiseAlignment = alignmentResults.find((r) => r.personId === parseInt(bId)) ?? null;

  const personA = councillors.find((c) => c.id === parseInt(aId));
  const personB = councillors.find((c) => c.id === parseInt(bId));

  if (!personA || !personB) {
    return {
      mode: "select" as const,
      councillors,
      personA: personA ?? null,
      personB: personB ?? null,
      stancesA: null,
      stancesB: null,
      speakingA: null,
      speakingB: null,
      speakingStatsAll: null,
      pairwiseAlignment: null,
    };
  }

  return {
    mode: "compare" as const,
    terms,
    selectedTerm,
    councillors,
    personA,
    personB,
    stancesA,
    stancesB,
    speakingA,
    speakingB,
    speakingStatsAll,
    speakingUnavailable,
    pairwiseAlignment,
  };
}

// ── Component ──

export default function ComparePage({ loaderData }: Route.ComponentProps) {
  const data = loaderData as LoaderData;

  if (data.mode === "select") {
    return <SelectionMode councillors={data.councillors} preselectedA={data.personA} />;
  }

  return <ComparisonMode data={data} />;
}

// ── Selection Mode ──

function SelectionMode({
  councillors,
  preselectedA,
}: {
  councillors: PersonWithStats[];
  preselectedA: PersonWithStats | null;
}) {
  const navigate = useNavigate();
  const [selectedA, setSelectedA] = useState<PersonWithStats | null>(preselectedA);
  const [selectedB, setSelectedB] = useState<PersonWithStats | null>(null);
  const [openDropdown, setOpenDropdown] = useState<"a" | "b" | null>(null);

  const handleCompare = () => {
    if (selectedA && selectedB) {
      navigate(`/compare?a=${selectedA.slug || selectedA.id}&b=${selectedB.slug || selectedB.id}`);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-5xl px-4 pt-6 pb-12 md:pt-10">
        <PageHeader
          title="Compare councillors"
          description="Pick two councillors to see how often they vote together, where their policy stances differ, and how active they are."
          icon={ArrowLeftRight}
        />

        <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm sm:p-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <CouncillorSelector
              label="First councillor"
              selected={selectedA}
              councillors={councillors}
              excludeId={selectedB?.id}
              isOpen={openDropdown === "a"}
              onToggle={() => setOpenDropdown(openDropdown === "a" ? null : "a")}
              onSelect={(p) => {
                setSelectedA(p);
                setOpenDropdown(null);
              }}
            />
            <CouncillorSelector
              label="Second councillor"
              selected={selectedB}
              councillors={councillors}
              excludeId={selectedA?.id}
              isOpen={openDropdown === "b"}
              onToggle={() => setOpenDropdown(openDropdown === "b" ? null : "b")}
              onSelect={(p) => {
                setSelectedB(p);
                setOpenDropdown(null);
              }}
            />
          </div>

          <div className="mt-5 flex flex-col-reverse items-stretch gap-3 border-t border-zinc-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-zinc-500">
              {selectedA && selectedB
                ? `Ready to compare ${selectedA.name} and ${selectedB.name}.`
                : "Choose both councillors to continue."}
            </p>
            <button
              type="button"
              onClick={handleCompare}
              disabled={!selectedA || !selectedB}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-brand-700 px-5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-brand-800 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/30 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none"
            >
              Compare
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Councillor Selector ──

function CouncillorSelector({
  label,
  selected,
  councillors,
  excludeId,
  isOpen,
  onToggle,
  onSelect,
}: {
  label: string;
  selected: PersonWithStats | null;
  councillors: PersonWithStats[];
  excludeId?: number;
  isOpen: boolean;
  onToggle: () => void;
  onSelect: (p: PersonWithStats) => void;
}) {
  const filteredCouncillors = councillors.filter((c) => c.id !== excludeId);

  return (
    <div className="relative">
      <span className="mb-1.5 block text-sm font-medium text-zinc-700">{label}</span>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border bg-surface p-3 text-left transition-colors",
          isOpen
            ? "border-brand-500 ring-3 ring-brand-500/20"
            : "border-zinc-200 hover:border-zinc-300",
        )}
      >
        {selected ? (
          <>
            <PersonAvatar person={selected} className="h-10 w-10" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-zinc-900">{selected.name}</div>
              <div className="truncate text-xs text-zinc-500">{getRole(selected)}</div>
            </div>
          </>
        ) : (
          <>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100">
              <Users className="h-5 w-5 text-zinc-400" />
            </div>
            <span className="flex-1 text-sm text-zinc-500">Select a councillor…</span>
          </>
        )}
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-zinc-400 transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-2 max-h-80 overflow-y-auto rounded-xl border border-zinc-200 bg-surface shadow-lg animate-in fade-in zoom-in-95 duration-200"
        >
          <ul className="divide-y divide-zinc-100">
            {filteredCouncillors.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected?.id === c.id}
                  onClick={() => onSelect(c)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50",
                    selected?.id === c.id && "bg-brand-50",
                  )}
                >
                  <PersonAvatar person={c} className="h-8 w-8" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-800">{c.name}</div>
                    <div className="truncate text-xs text-zinc-500">{getRole(c)}</div>
                  </div>
                  {!c.is_councillor && (
                    <Badge variant="muted" className="shrink-0">
                      Former
                    </Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Comparison Mode ──

function alignmentTone(rate: number) {
  return rate >= 80 ? "success" : rate >= 60 ? "brand" : "warning";
}

function ComparisonMode({ data }: { data: CompareModeData }) {
  const {
    personA,
    personB,
    stancesA,
    stancesB,
    speakingA,
    speakingB,
    speakingStatsAll,
    speakingUnavailable,
    pairwiseAlignment,
  } = data;

  const alignmentRate = pairwiseAlignment?.alignmentRate ?? null;
  const navigate = useNavigate();

  // Build stance maps keyed by topic
  const stanceMapA = useMemo(() => {
    const map = new Map<string, CouncillorStance>();
    for (const s of stancesA) map.set(s.topic, s);
    return map;
  }, [stancesA]);

  const stanceMapB = useMemo(() => {
    const map = new Map<string, CouncillorStance>();
    for (const s of stancesB) map.set(s.topic, s);
    return map;
  }, [stancesB]);

  // Speaking time maps
  const speakingMapA = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of speakingA) map.set(s.topic, s.total_seconds);
    return map;
  }, [speakingA]);

  const speakingMapB = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of speakingB) map.set(s.topic, s.total_seconds);
    return map;
  }, [speakingB]);

  // Total speaking hours from stats
  const statsA = speakingStatsAll?.find((s) => s.person_id === personA.id);
  const statsB = speakingStatsAll?.find((s) => s.person_id === personB.id);

  const periodLabel = data.selectedTerm ? data.selectedTerm.name : "all recorded service";

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Sticky mobile comparison bar */}
      <div className="sticky top-16 z-40 border-b border-zinc-200 bg-surface/95 px-4 py-2 backdrop-blur-sm lg:hidden">
        <div className="flex items-center justify-between gap-2 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <PersonAvatar person={personA} className="h-6 w-6" />
            <span className="truncate font-semibold text-zinc-700">
              {personA.name.split(" ").pop()}
            </span>
          </div>
          {alignmentRate !== null ? (
            <Badge variant={alignmentTone(alignmentRate)} className="tabular-nums">
              {alignmentRate.toFixed(0)}% aligned
            </Badge>
          ) : (
            <Badge variant="muted">No shared votes</Badge>
          )}
          <div className="flex min-w-0 items-center justify-end gap-2">
            <span className="truncate font-semibold text-zinc-700">
              {personB.name.split(" ").pop()}
            </span>
            <PersonAvatar person={personB} className="h-6 w-6" />
          </div>
        </div>
      </div>

      <div className="container mx-auto max-w-5xl px-4 pt-6 pb-12 md:pt-10">
        <PageHeader
          title="Compare councillors"
          description={`${personA.name} and ${personB.name}, side by side.`}
          icon={ArrowLeftRight}
          actions={
            <div className="w-full md:w-60">
              <label htmlFor="comparison-term" className="mb-1 block text-xs text-zinc-500">
                Voting and speaking period
              </label>
              <NativeSelect
                id="comparison-term"
                value={data.selectedTerm?.id || "all"}
                onChange={(event) =>
                  navigate(`/compare?a=${personA.slug || personA.id}&b=${personB.slug || personB.id}&term=${event.target.value}`)
                }
              >
                <option value="all">All recorded service</option>
                {data.terms.map((term) => (
                  <option key={term.id} value={term.id}>
                    {term.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          }
        />

        {/* Head-to-head */}
        <section className="mb-10 rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm lg:p-8">
          <div className="grid grid-cols-2 items-start gap-6 sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-10">
            <PersonColumn person={personA} />

            <div className="order-last col-span-2 flex flex-col items-center gap-1 border-t border-zinc-100 pt-5 text-center sm:order-none sm:col-span-1 sm:border-t-0 sm:pt-0">
              <div className="mb-1 rounded-xl bg-brand-50 p-2.5 text-brand-700 ring-1 ring-brand-100">
                <Scale className="h-5 w-5" aria-hidden="true" />
              </div>
              {alignmentRate !== null ? (
                <>
                  <div
                    className={cn(
                      "text-4xl font-extrabold tabular-nums lg:text-5xl",
                      alignmentRate >= 80
                        ? "text-emerald-600"
                        : alignmentRate >= 60
                          ? "text-brand-700"
                          : "text-amber-600",
                    )}
                  >
                    {alignmentRate.toFixed(0)}%
                  </div>
                  <div className="text-sm font-medium text-zinc-700">Voting alignment</div>
                  <div className="text-xs tabular-nums text-zinc-500">
                    {pairwiseAlignment?.matchingVotes} of {pairwiseAlignment?.totalMotions} shared
                    votes · {periodLabel}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-sm font-medium text-zinc-700">No shared votes</div>
                  <div className="max-w-56 text-xs text-zinc-500">
                    No recorded votes where both took part in {periodLabel}.
                  </div>
                </>
              )}
            </div>

            <PersonColumn person={personB} />
          </div>
        </section>

        <div className="space-y-10">
          <StanceComparisonSection
            stanceMapA={stanceMapA}
            stanceMapB={stanceMapB}
            personA={personA}
            personB={personB}
          />

          <section>
            <SectionHeading
              title="Activity"
              icon={BarChart3}
              description={`Speaking time and meetings cover ${periodLabel}.`}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ActivityCard person={personA} stats={statsA} unavailable={speakingUnavailable} />
              <ActivityCard person={personB} stats={statsB} unavailable={speakingUnavailable} />
            </div>
          </section>

          {speakingUnavailable ? (
            <section>
              <SectionHeading title="Speaking time by topic" icon={Clock} />
              <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                Speaking time couldn't be loaded right now. Try again in a moment, or pick a
                shorter period.
              </div>
            </section>
          ) : (
            <SpeakingTimeComparison
              personA={personA}
              personB={personB}
              speakingMapA={speakingMapA}
              speakingMapB={speakingMapB}
            />
          )}
        </div>

        <div className="mt-12 text-center">
          <Link
            to="/compare"
            className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 transition-colors hover:text-brand-800"
          >
            <ArrowLeftRight className="h-4 w-4" />
            Compare different councillors
          </Link>
        </div>
      </div>
    </div>
  );
}

function PersonAvatar({
  person,
  className,
}: {
  person: { name: string; image_url?: string | null };
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-100 ring-1 ring-zinc-200",
        className,
      )}
    >
      {person.image_url ? (
        <img src={person.image_url} alt="" className="h-full w-full object-cover" />
      ) : (
        <Users className="h-1/2 w-1/2 text-zinc-400" aria-hidden="true" />
      )}
    </span>
  );
}

function PersonColumn({ person }: { person: PersonWithStats }) {
  return (
    <Link
      to={personPath(person)}
      className="group flex min-w-0 flex-col items-center text-center"
    >
      <PersonAvatar
        person={person}
        className="h-20 w-20 shadow-sm ring-4 ring-surface transition-shadow group-hover:shadow-md lg:h-24 lg:w-24"
      />
      <span className="mt-3 text-base font-bold text-zinc-900 transition-colors group-hover:text-brand-700 lg:text-lg">
        {person.name}
      </span>
      <span className="text-sm text-zinc-500">{getRole(person)}</span>
    </Link>
  );
}

// ── Stance Comparison Section ──

function StanceComparisonSection({
  stanceMapA,
  stanceMapB,
  personA,
  personB,
}: {
  stanceMapA: Map<string, CouncillorStance>;
  stanceMapB: Map<string, CouncillorStance>;
  personA: PersonWithStats;
  personB: PersonWithStats;
}) {
  const hasAny = stanceMapA.size > 0 || stanceMapB.size > 0;
  const topics = TOPICS.filter((t) => stanceMapA.has(t) || stanceMapB.has(t));
  const missing = TOPICS.filter((t) => !stanceMapA.has(t) && !stanceMapB.has(t));

  return (
    <section>
      <SectionHeading
        title="Policy stances"
        icon={Scale}
        description="AI-summarised from what each councillor has said in meetings. Covers all recorded service."
      />
      {!hasAny ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
          No stance summaries have been generated for either councillor yet.
        </div>
      ) : (
        <div className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface shadow-sm">
          {topics.map((topic) => (
            <StanceRow
              key={topic}
              topic={topic}
              Icon={TOPIC_ICONS[topic]}
              stanceA={stanceMapA.get(topic) ?? null}
              stanceB={stanceMapB.get(topic) ?? null}
              personAName={personA.name}
              personBName={personB.name}
            />
          ))}
          {missing.length > 0 && (
            <p className="px-5 py-3 text-xs text-zinc-500">
              No stance data for either councillor on: {missing.join(", ")}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ── Stance Row ──

function StanceRow({
  topic,
  Icon,
  stanceA,
  stanceB,
  personAName,
  personBName,
}: {
  topic: TopicName;
  Icon: React.ElementType;
  stanceA: CouncillorStance | null;
  stanceB: CouncillorStance | null;
  personAName: string;
  personBName: string;
}) {
  const agreement = getAgreementLevel(stanceA, stanceB);

  return (
    <div className="p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-zinc-100 p-1.5 text-zinc-500">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <h3 className="flex-1 text-sm font-semibold text-zinc-900 sm:text-base">{topic}</h3>
        <AgreementIndicator level={agreement.level} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
        {[
          { name: personAName, stance: stanceA },
          { name: personBName, stance: stanceB },
        ].map(({ name, stance }) => (
          <div key={name} className="space-y-2">
            <div className="text-xs font-medium text-zinc-500">{name}</div>
            {stance ? (
              <>
                <StanceSpectrum score={stance.position_score ?? 0} position={stance.position} />
                <p className="line-clamp-2 text-sm text-zinc-600">{stance.summary}</p>
              </>
            ) : (
              <div className="py-2 text-sm text-zinc-400">No stance data</div>
            )}
          </div>
        ))}
      </div>

      {agreement.note && <p className="mt-3 text-xs text-zinc-500">{agreement.note}</p>}
    </div>
  );
}

// ── Agreement Indicator ──

function AgreementIndicator({ level }: { level: "agree" | "disagree" | "partial" | "no-data" }) {
  switch (level) {
    case "agree":
      return (
        <Badge variant="success">
          <Check /> Agree
        </Badge>
      );
    case "disagree":
      return (
        <Badge variant="danger">
          <XIcon /> Disagree
        </Badge>
      );
    case "partial":
      return (
        <Badge variant="warning">
          <Minus /> Mixed
        </Badge>
      );
    case "no-data":
      return <Badge variant="muted">Partial data</Badge>;
  }
}

// ── Activity Card ──

function ActivityCard({
  person,
  stats,
  unavailable,
}: {
  person: PersonWithStats;
  stats: SpeakingTimeStat | undefined;
  unavailable: boolean;
}) {
  const totalHours = stats ? (stats.total_seconds / 3600).toFixed(1) : "0";
  const meetingCount = stats?.meeting_count ?? 0;
  const attendanceRate = person.stats?.rate;

  return (
    <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <PersonAvatar person={person} className="h-8 w-8" />
        <span className="text-sm font-semibold text-zinc-900">{person.name}</span>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <StatBlock label="Speaking time" value={unavailable ? "—" : `${totalHours}h`} />
        <StatBlock label="Meetings spoken at" value={unavailable ? "—" : `${meetingCount}`} />
        <StatBlock label="Attendance" value={attendanceRate == null ? "Incomplete evidence" : `${attendanceRate}%`} />
        <p className="col-span-2 text-xs text-zinc-500">{attendanceCoverageText(person.stats)}</p>
        <StatBlock label="Total votes" value={`${person.stats?.total ?? 0}`} />
      </dl>
    </div>
  );
}

// ── Speaking Time Comparison ──

function SpeakingTimeComparison({
  personA,
  personB,
  speakingMapA,
  speakingMapB,
}: {
  personA: PersonWithStats;
  personB: PersonWithStats;
  speakingMapA: Map<string, number>;
  speakingMapB: Map<string, number>;
}) {
  const maxSeconds = useMemo(() => {
    let max = 0;
    for (const topic of TOPICS) {
      max = Math.max(max, speakingMapA.get(topic) ?? 0, speakingMapB.get(topic) ?? 0);
    }
    return max;
  }, [speakingMapA, speakingMapB]);

  if (maxSeconds === 0) return null;

  return (
    <section>
      <SectionHeading title="Speaking time by topic" icon={Clock} />
      <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm sm:p-6">
        <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-sm bg-brand-600" />
            <span className="font-medium text-zinc-600">{personA.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-sm bg-zinc-400" />
            <span className="font-medium text-zinc-600">{personB.name}</span>
          </div>
        </div>

        <div className="space-y-4">
          {TOPICS.map((topic) => {
            const secA = speakingMapA.get(topic) ?? 0;
            const secB = speakingMapB.get(topic) ?? 0;
            if (secA === 0 && secB === 0) return null;
            const pctA = (secA / maxSeconds) * 100;
            const pctB = (secB / maxSeconds) * 100;
            const Icon = TOPIC_ICONS[topic];

            return (
              <div key={topic}>
                <div className="mb-1.5 flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                  <span className="text-sm font-medium text-zinc-700">{topic}</span>
                </div>
                <div className="space-y-1">
                  {[
                    { pct: pctA, sec: secA, bar: "bg-brand-600", who: personA.name },
                    { pct: pctB, sec: secB, bar: "bg-zinc-400", who: personB.name },
                  ].map(({ pct, sec, bar, who }) => (
                    <div key={who} className="flex items-center gap-2">
                      <div className="h-3 flex-1 overflow-hidden rounded-full bg-zinc-100">
                        <div
                          className={cn("h-full rounded-full transition-all duration-500", bar)}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-12 text-right text-xs tabular-nums text-zinc-500">
                        <span className="sr-only">{who}: </span>
                        {formatSeconds(sec)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── Stat Block ──

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-zinc-50 p-3">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="text-lg font-bold tabular-nums text-zinc-900">{value}</dd>
    </div>
  );
}

// ── Helpers ──

function getRole(person: PersonWithStats): string {
  const membership = (person as any).memberships?.find(
    (m: any) => membershipIsActiveOn(m, civicToday()),
  );
  return membership?.role || "Former / incoming council member";
}

function getAgreementLevel(
  a: CouncillorStance | null,
  b: CouncillorStance | null,
): { level: "agree" | "disagree" | "partial" | "no-data"; note: string | null } {
  if (!a && !b) {
    return { level: "no-data", note: "No stance data for either councillor" };
  }
  if (!a || !b) {
    const who = a ? "Only " + a.position : "Only " + b!.position;
    return { level: "no-data", note: `${who} -- no data for the other councillor` };
  }

  const scoreA = a.position_score ?? 0;
  const scoreB = b.position_score ?? 0;
  const distance = Math.abs(scoreA - scoreB);

  const posA = a.position;
  const posB = b.position;

  if (distance <= 0.5) {
    const note =
      posA === posB
        ? `Both ${posA === "supports" ? "support" : posA === "opposes" ? "oppose" : "have a " + posA + " stance on"} this topic`
        : `Similar positions (${posA} vs ${posB})`;
    return { level: "agree", note };
  }

  if (distance > 1.0) {
    return {
      level: "disagree",
      note: `${getFirstName(posA)} vs ${getFirstName(posB)} -- significant disagreement`,
    };
  }

  return {
    level: "partial",
    note: `Moderate difference (${posA} vs ${posB})`,
  };
}

function getFirstName(position: string): string {
  return position.charAt(0).toUpperCase() + position.slice(1);
}

function formatSeconds(seconds: number): string {
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}
