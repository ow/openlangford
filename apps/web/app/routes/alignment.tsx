import { SITE_NAME } from "../lib/site-name";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { civicToday, councilTermStatus, membershipIsActiveOn, membershipOverlapsRange } from "../lib/council-terms";
import { getCouncilTerms } from "../services/council-terms";
import type { Route } from "./+types/alignment";
import { getContestedMotions, getVotingAlignment } from "../services/analytics";
import { cachedCompute, HOURLY_SHARED } from "../services/computed-cache.server";
import { VoteMatrix } from "../components/alignment/vote-matrix";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import { Users, Info, Scale, Grid3X3, Rows3 } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { cn } from "../lib/utils";
import { useCallback, useMemo, useState } from "react";
import { PageHeader } from "../components/ui/page-header";
import { SectionHeading } from "../components/ui/section-heading";
import { NativeSelect } from "../components/ui/native-select";
import { personPath } from "../lib/people-paths";
import { ogImageUrl, ogUrl } from "../lib/og";

export const meta: Route.MetaFunction = () => {
  return [
    { title: `Voting Alignment | ${SITE_NAME}` },
    { name: "description", content: `See how ${DEFAULT_MUNICIPALITY.short_name} council members vote together — alignment matrix and trends` },
    { property: "og:title", content: `Voting Alignment | ${SITE_NAME}` },
    { property: "og:description", content: `See how ${DEFAULT_MUNICIPALITY.short_name} council members vote together — alignment matrix and trends` },
    { property: "og:type", content: "website" },
    { property: "og:url", content: ogUrl("/alignment") },
    { property: "og:image", content: ogImageUrl("Voting Alignment", { type: "person" }) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

export async function loader() {
  try {
    const supabase = getSupabaseAdminClient();
    const municipality = await getMunicipality(supabase);
    const [data, councilTerms] = await Promise.all([
      getVotingAlignment(supabase, municipality.id),
      getCouncilTerms(supabase, municipality.id),
    ]);
    const contestedMotions = await cachedCompute(
      `alignment-contested-motions:${municipality.id}`,
      () => getContestedMotions(supabase, data.votes),
      HOURLY_SHARED,
    );
    return { ...data, councilTerms, contestedMotions };
  } catch (error) {
    console.error("Error loading alignment data:", error);
    throw new Response("Error loading alignment", { status: 500 });
  }
}

// Helper to parse dates without timezone shifts
const parseDate = (dateStr: string | null | undefined) => {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split(/[- : T]/).map(Number);
  return new Date(y, m - 1, d || 1);
};

export default function VotingAlignment({ loaderData }: Route.ComponentProps) {
  const { people, votes, motions, memberships, councilTerms, contestedMotions } = loaderData;
  const [searchParams] = useSearchParams();
  const requestedPersonId = Number(searchParams.get("person"));
  const focusedPersonId = Number.isSafeInteger(requestedPersonId) && requestedPersonId > 0
    ? requestedPersonId : null;

  const today = civicToday();
  const terms = useMemo(() => councilTerms
    .filter((term) => councilTermStatus(term, today) !== "upcoming")
    .map((term) => {
      const termMemberships = memberships.filter((m: any) => membershipOverlapsRange(m, term.start_date, term.end_date));
      const members = new Map<number, any>();
      termMemberships.forEach((m: any) => {
        if (m.people) members.set(m.people.id, m.people);
      });
      return { ...term, start: parseDate(term.start_date)!, end: parseDate(term.end_date || today)!, members: [...members.values()] };
    }), [councilTerms, memberships, today]);
  const personTerms = focusedPersonId
    ? terms.filter((term) => term.members.some((member: any) => member.id === focusedPersonId))
    : terms;
  const defaultTerm = personTerms.find((term) => councilTermStatus(term, today) === "current")
    || personTerms[0] || terms[0];
  const [selectedTermId, setSelectedId] = useState<number | null>(defaultTerm?.id || null);
  const selectedTerm = terms.find((term) => term.id === selectedTermId) || defaultTerm;
  const servedOnDay = useCallback(
    (personId: number, day: string) =>
      memberships.some((m: any) => (m.person_id || m.people?.id) === personId && membershipIsActiveOn(m, day)),
    [memberships],
  );
  const servedOn = (personId: number, date: Date) =>
    servedOnDay(personId, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);

  const { alignmentMatrix, consensusRate, dataQuality } = useMemo(() => {
    if (!selectedTerm) {
      return {
        alignmentMatrix: {} as Record<string, { total: number; matches: number }>,
        consensusRate: null,
        dataQuality: {
          hasExplicitDissent: false,
          contestedOutcomeCount: 0,
          recordedVoteCount: 0,
          motionsWithRecordedVotes: 0,
          resultedMotions: 0,
        },
      };
    }

    // Group votes by motion and store date
    const votesByMotion: Record<
      number,
      { date: Date; votes: Record<number, string> }
    > = {};
    votes.forEach((v: any) => {
      const d = parseDate(v.motions?.meetings?.meeting_date);
      if (d && d >= selectedTerm.start && d <= selectedTerm.end) {
        if (!votesByMotion[v.motion_id]) {
          votesByMotion[v.motion_id] = { date: d, votes: {} };
        }
        votesByMotion[v.motion_id].votes[v.person_id] = v.vote;
      }
    });

    const termMotions = (motions || []).filter((motion: any) => {
      const d = parseDate(motion.meetings?.meeting_date);
      return d && d >= selectedTerm.start && d <= selectedTerm.end;
    });
    const termVotes = votes.filter((vote: any) => {
      const date = parseDate(vote.motions?.meetings?.meeting_date);
      return date && date >= selectedTerm.start && date <= selectedTerm.end;
    });
    const explicitDissentVotes = termVotes.filter((vote: any) => ["No", "Opposed", "Abstain"].includes(vote.vote));
    const contestedOutcomeCount = termMotions.filter((motion: any) => {
      const result = String(motion.result || "").toUpperCase();
      return (
        result.includes("DEFEATED") ||
        result.includes("FAILED") ||
        result.includes("LOST")
      );
    }).length;
    const hasExplicitDissent = explicitDissentVotes.length > 0;

    const matrix: Record<string, { total: number; matches: number }> = {};
    const members = selectedTerm.members;

    members.forEach((p1: any) => {
      members.forEach((p2: any) => {
        if (p1.id === p2.id) return;
        const key = `${p1.id}-${p2.id}`;
        matrix[key] = { total: 0, matches: 0 };

        Object.values(votesByMotion).forEach((motionData) => {
          // Check if both members were active on this specific motion date
          const isActive1 = servedOn(p1.id, motionData.date);
          const isActive2 = servedOn(p2.id, motionData.date);

          if (
            isActive1 &&
            isActive2 &&
            motionData.votes[p1.id] &&
            motionData.votes[p2.id]
          ) {
            matrix[key].total++;
            if (motionData.votes[p1.id] === motionData.votes[p2.id]) {
              matrix[key].matches++;
            }
          }
        });
      });
    });

    // Calculate term consensus
    const motionVoteGroups = Object.values(votesByMotion);
    let unanimousCount = 0;
    let motionsWithQuorum = 0;

    motionVoteGroups.forEach((motionData) => {
      // Find members who were active on this date
      const activeMembersAtTime = members.filter(
        (m: any) =>
          servedOn(m.id, motionData.date),
      );

      const castVotes = activeMembersAtTime
        .map((m: any) => motionData.votes[m.id])
        .filter((v) => v !== undefined);

      if (castVotes.length > 1) {
        motionsWithQuorum++;
        const firstVote = castVotes[0];
        if (castVotes.every((v) => v === firstVote)) {
          unanimousCount++;
        }
      }
    });

    return {
      alignmentMatrix: matrix,
      consensusRate:
        motionsWithQuorum > 0 ? (unanimousCount / motionsWithQuorum) * 100 : null,
      dataQuality: {
        hasExplicitDissent,
        contestedOutcomeCount,
        recordedVoteCount: termVotes.length,
        motionsWithRecordedVotes: termMotions.filter((motion: any) => motion.votes?.length > 0).length,
        resultedMotions: termMotions.filter((motion: any) => !!motion.result).length,
      },
    };
  }, [selectedTerm, votes, motions, memberships]);

  const hasIncompleteDissentAttribution =
    dataQuality.contestedOutcomeCount > 0 && !dataQuality.hasExplicitDissent;

  const hasMatrixData = Object.values(alignmentMatrix).some((cell) => cell.total > 0);
  const lastName = (name: string) => name.split(" ").pop() || name;

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 py-12">
        <PageHeader
          title="Council alignment"
          description="How often council members vote the same way, measured across each council term."
          icon={Scale}
          actions={
            terms.length > 0 ? (
              <div className="w-full md:w-56">
                <label htmlFor="alignment-term" className="sr-only">
                  Council term
                </label>
                <NativeSelect
                  id="alignment-term"
                  value={selectedTerm?.id ?? ""}
                  onChange={(event) => setSelectedId(Number(event.target.value))}
                >
                  {terms.map((term) => (
                    <option key={term.id} value={term.id}>
                      {term.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : undefined
          }
        />

        {!selectedTerm && (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
            No verified council term dates are available yet, so alignment can't be calculated.
          </div>
        )}

        {selectedTerm && (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
            {/* Term summary */}
            <div className="space-y-6 lg:col-span-4">
              <div className="rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                <div className="border-b border-zinc-100 p-5">
                  <p className="text-sm text-zinc-500">Council term</p>
                  <h2 className="text-lg font-bold tracking-tight text-zinc-900">
                    {selectedTerm.name}
                  </h2>
                  <p className="mt-1 text-xs text-zinc-500">
                    Terms use recorded service dates. Incoming councils appear here once their
                    term begins.
                  </p>
                </div>
                <div className="p-5">
                  <div className="flex items-end justify-between gap-4">
                    <span className="text-sm font-medium text-zinc-600">Consensus rate</span>
                    <span
                      className={cn(
                        "font-bold tabular-nums",
                        consensusRate === null ? "text-sm text-zinc-400" : "text-2xl text-zinc-900",
                      )}
                    >
                      {consensusRate === null ? "Not available" : `${consensusRate.toFixed(0)}%`}
                    </span>
                  </div>
                  {consensusRate !== null && (
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                      <div
                        className="h-full rounded-full bg-brand-600 transition-all duration-1000"
                        style={{ width: `${consensusRate}%` }}
                      />
                    </div>
                  )}
                  <p className="mt-2 text-xs text-zinc-500">
                    {consensusRate === null
                      ? "Not enough per-councillor vote records to calculate."
                      : "Share of motions where every recorded vote matched."}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    <span className="tabular-nums">{dataQuality.motionsWithRecordedVotes}</span> of{" "}
                    <span className="tabular-nums">{dataQuality.resultedMotions}</span> decided motions this term have
                    individual vote records. Complete records may be reconstructed from official minutes and
                    attendance; incomplete roll calls are excluded.
                  </p>
                </div>
                <div className="border-t border-zinc-100">
                  <p className="px-5 pb-1 pt-4 text-sm font-medium text-zinc-600">
                    Members{" "}
                    <span className="tabular-nums text-zinc-400">({selectedTerm.members.length})</span>
                  </p>
                  <ul className="divide-y divide-zinc-100 pb-2">
                    {selectedTerm.members.map((m: any) => (
                      <li key={m.id}>
                        <Link
                          to={personPath(m)}
                          className="flex items-center gap-3 px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:text-brand-700"
                        >
                          <Avatar person={m} />
                          {m.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {hasMatrixData && (
              <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                  <Info className="h-4 w-4 text-brand-600" aria-hidden="true" />
                  How to read this
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                  Each cell shows how often two members cast the same vote on motions where both
                  voted. Looking across a whole term helps show "core" members who usually vote with
                  the majority and more independent members who dissent more often.
                </p>
              </div>
              )}
            </div>

            {/* Alignment matrix */}
            <div className="order-first lg:order-none lg:col-span-8">
              <SectionHeading
                title="Alignment matrix"
                icon={Grid3X3}
                description={
                  hasMatrixData
                    ? "Percentage of shared votes where both members voted the same way."
                    : undefined
                }
              />

              {hasMatrixData ? (
                <>
                  {hasIncompleteDissentAttribution && (
                    <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
                      This term has <span className="tabular-nums">{dataQuality.contestedOutcomeCount}</span>{" "}
                      defeated motion{dataQuality.contestedOutcomeCount === 1 ? "" : "s"}, but no
                      explicit No/Opposed votes have been extracted yet. Agreement percentages only
                      reflect recorded individual votes.
                    </div>
                  )}
                  <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-zinc-100">
                          <th scope="col" className="sticky left-0 z-10 bg-surface px-4 py-3 text-left font-medium text-zinc-500">
                            <span className="sr-only">Member</span>
                          </th>
                          {selectedTerm.members.map((p2: any) => (
                            <th
                              key={p2.id}
                              scope="col"
                              className="px-2 py-3 text-center text-xs font-medium text-zinc-500"
                            >
                              {lastName(p2.name)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100">
                        {selectedTerm.members.map((p1: any) => (
                          <tr
                            key={p1.id}
                            id={`person-${p1.id}`}
                            className={cn("scroll-mt-24", p1.id === focusedPersonId && "bg-brand-50/60")}
                          >
                            <th
                              scope="row"
                              className={cn(
                                "sticky left-0 z-10 whitespace-nowrap px-4 py-2 text-left font-medium text-zinc-800",
                                p1.id === focusedPersonId ? "bg-brand-50" : "bg-surface",
                              )}
                            >
                              <Link
                                to={personPath(p1)}
                                className="flex items-center gap-2 hover:text-brand-700"
                              >
                                <Avatar person={p1} size="sm" />
                                {p1.name}
                              </Link>
                            </th>
                            {selectedTerm.members.map((p2: any) => {
                              if (p1.id === p2.id) {
                                return (
                                  <td key={p2.id} className="px-1 py-1.5">
                                    <div className="h-10 min-w-14 rounded-lg bg-zinc-100" aria-hidden="true" />
                                  </td>
                                );
                              }
                              const cell = alignmentMatrix[`${p1.id}-${p2.id}`];
                              const rate = cell && cell.total > 0 ? (cell.matches / cell.total) * 100 : null;
                              return (
                                <td key={p2.id} className="px-1 py-1.5">
                                  <div
                                    title={
                                      rate === null
                                        ? `No shared votes: ${p1.name} and ${p2.name}`
                                        : `${p1.name} and ${p2.name}: ${cell.matches} of ${cell.total} votes matched`
                                    }
                                    className={cn(
                                      "flex h-10 min-w-14 items-center justify-center rounded-lg text-sm font-semibold tabular-nums",
                                      rate === null
                                        ? "text-zinc-300"
                                        : rate > 90
                                          ? "bg-emerald-50 text-emerald-700"
                                          : rate > 75
                                            ? "bg-brand-50 text-brand-700"
                                            : "bg-amber-50 text-amber-700",
                                    )}
                                  >
                                    {rate === null ? "—" : `${rate.toFixed(0)}%`}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm bg-emerald-200" /> Over 90%
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm bg-brand-200" /> 76–90%
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm bg-amber-200" /> 75% or less
                    </span>
                  </div>
                </>
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm leading-relaxed text-zinc-500">
                  <p className="font-medium text-zinc-700">
                    No per-councillor vote records for this term yet
                  </p>
                  <p className="mt-1">
                    Alignment is calculated from individual recorded votes, and none have been
                    extracted for {selectedTerm.name}
                    {dataQuality.recordedVoteCount > 0 ? " that overlap between members" : ""}.
                  </p>
                  {hasIncompleteDissentAttribution && (
                    <p className="mt-2">
                      This term has{" "}
                      <span className="tabular-nums">{dataQuality.contestedOutcomeCount}</span>{" "}
                      defeated motion{dataQuality.contestedOutcomeCount === 1 ? "" : "s"}, but no
                      explicit No/Opposed votes have been extracted yet, so we can't tell who voted
                      against them.
                    </p>
                  )}
                </div>
              )}
            </div>

            <section className="lg:col-span-12">
              <SectionHeading
                title="Split votes, member by member"
                icon={Rows3}
                description="Every motion this term where members voted on both sides, with each member's recorded vote. Unanimous and procedural motions are left out, as are motions whose minutes name only some voters."
              />
              <VoteMatrix
                motions={contestedMotions}
                members={selectedTerm.members}
                start={selectedTerm.start_date}
                end={selectedTerm.end_date || today}
                servedOn={servedOnDay}
                focusedPersonId={focusedPersonId}
              />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Avatar({ person, size = "md" }: { person: any; size?: "sm" | "md" }) {
  const dims = size === "sm" ? "h-6 w-6" : "h-8 w-8";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-100 ring-1 ring-zinc-200",
        dims,
      )}
    >
      {person.image_url ? (
        <img src={person.image_url} alt="" className="h-full w-full object-cover" />
      ) : (
        <Users className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
      )}
    </span>
  );
}
