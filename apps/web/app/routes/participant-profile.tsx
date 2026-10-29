import { pageMeta } from "../lib/page-meta";
import { Link } from "react-router";
import { matterPath, meetingPath } from "../lib/paths";
import { withMeetingSlugs } from "../lib/slug-params.server";
import { ChevronLeft, ArrowUpRight, User } from "lucide-react";
import type { Route } from "./+types/participant-profile";
import { SITE_NAME } from "../lib/site-name";
import { participantPath, personPath } from "../lib/people-paths";
import { resolvePersonParam } from "../lib/people.server";
import { councilServicePeriods } from "../lib/council-service";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import { getPublicParticipantStats } from "../services/people";
import { getPublicParticipationHistories } from "../services/public-participation.server";
import { PublicParticipation } from "../components/profile/public-participation";
import { POSITION_LABEL, POSITION_TONE } from "../components/meeting/participation-list";
import { getParticipantStatements } from "../services/participant-statements.server";
import { cachedCompute } from "../services/computed-cache.server";
import { isGenericParticipationHeading, mergeParticipation, participationSummary } from "../lib/participant-statements";
import { cn } from "../lib/utils";
import { formatDate } from "../lib/utils";
import type { Person } from "../lib/types";

export const meta: Route.MetaFunction = ({ data }) => data
  ? pageMeta(`${data.person.name} — Public participation`, participationSummary(data.person.name, data.summary?.meetingCount ?? 0, data.summary?.agendaItemCount ?? 0, data.summary?.firstDate ?? null, data.summary?.lastDate ?? null), participantPath(data.person), "profile")
  : [{ title: `Participant | ${SITE_NAME}` }];

export async function loader({ params, request }: Route.LoaderArgs) {
  const supabase = getSupabaseAdminClient();
  const resolved = await resolvePersonParam(supabase, params.id, request, "", participantPath);
  const municipality = await getMunicipality(supabase);
  const { data: person, error } = await supabase.from("people")
    .select("id, name, slug, image_url, is_councillor, created_at, memberships(*, organization:organizations(*))")
    .eq("id", resolved.id).single();
  if (error) throw error;
  if (!person) throw new Response("Person Not Found", { status: 404 });
  const histories = getPublicParticipationHistories(municipality.slug).filter(history => history.personId === person.id);
  // Identical for every visitor; a short TTL bounds pipeline relinks and admin renames.
  const { participation, statements } = await cachedCompute(`participant-profile-v1:${municipality.id}:${person.id}`, async () => {
    const [[stats], statements] = await Promise.all([
      getPublicParticipantStats(supabase, municipality.id, histories, person.id),
      getParticipantStatements(supabase, municipality.id, person.id),
    ]);
    return { participation: stats || null, statements };
  }, { shareWithSignedIn: true });
  const merged = mergeParticipation(participation?.recentAppearances || [], statements);
  return {
    person: person as Person,
    participation,
    statements: merged.statements,
    audioOnly: merged.audioOnly,
    summary: { meetingCount: merged.meetingCount, agendaItemCount: merged.agendaItemCount, firstDate: merged.firstDate, lastDate: merged.lastDate },
    history: await withMeetingSlugs(supabase, histories[0] || null),
    hasCouncilService: councilServicePeriods(person as Person).length > 0,
  };
}

function duration(seconds: number) {
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded}s` : rounded < 3600 ? `${Math.floor(rounded / 60)}m ${rounded % 60}s` : `${Math.floor(Math.round(rounded / 60) / 60)}h ${Math.round(rounded / 60) % 60}m`;
}

const SOURCE_LABEL = { minutes: "From the minutes", transcript: "From the meeting recording" } as const;

export default function ParticipantProfile({ loaderData }: Route.ComponentProps) {
  const { person, participation, statements, audioOnly, summary, history, hasCouncilService } = loaderData;
  const hasParticipation = summary.meetingCount > 0;
  const totalSeconds = participation?.totalSeconds || 0;
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl space-y-6 px-4 py-8 sm:pb-16">
        <Link to="/participants" className="inline-flex items-center text-sm font-medium text-zinc-600 hover:text-brand-700">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Public participants
        </Link>
        <header className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm sm:p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-zinc-100">
              {person.image_url ? <img src={person.image_url} alt={person.name} className="h-full w-full object-cover" /> : <User className="h-8 w-8 text-zinc-400" aria-hidden="true" />}
            </div>
            <div>
              <p className="mb-1 text-sm font-medium text-zinc-500">{hasParticipation ? "Public participant" : "Meeting participant"}</p>
              <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900">{person.name}</h1>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-zinc-600">Recorded appearances as a member of the public at council and committee meetings.</p>
          {hasCouncilService && <Link to={personPath(person)} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-700 hover:underline">View council service profile <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link>}
        </header>

        {hasParticipation ? <>
          <dl className="grid gap-4 sm:grid-cols-3">
            {[
              ["Meetings with recorded participation", String(summary.meetingCount)],
              ["Agenda items addressed", String(summary.agendaItemCount)],
              ["Audio-attributed speaking time", totalSeconds > 0 ? duration(totalSeconds) : "Not available"],
            ].map(([label, value]) => <div key={label} className="rounded-2xl border border-zinc-200 bg-surface p-5"><dt className="text-sm text-zinc-500">{label}</dt><dd className="mt-2 text-2xl font-bold tabular-nums text-zinc-900">{value}</dd></div>)}
          </dl>
          <p className="text-sm leading-relaxed text-zinc-500">These counts cover identified public appearances in the available records. Audio attribution is incomplete; appearances documented only in minutes do not establish speaking time.</p>
          {history && <PublicParticipation history={history} beforeCouncil={false} />}
          {statements.length > 0 && <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
            <div className="p-5 sm:p-6">
              <h2 className="text-lg font-bold text-zinc-900">What {person.name} told council</h2>
              <p className="mt-1 text-sm text-zinc-500">Summaries of each comment, newest first. Open the meeting for the full record.</p>
            </div>
            <ol className="divide-y divide-zinc-100 border-t border-zinc-100">
              {statements.map((statement, index) => {
                const itemHref = meetingPath({ id: statement.meetingId, slug: statement.meetingSlug }, `#item-${statement.agendaItemId}`);
                const showAgendaTitle = !isGenericParticipationHeading(statement.agendaTitle) && statement.agendaTitle !== statement.topic;
                return <li key={`${statement.agendaItemId}-${index}`} className="p-5 sm:px-6">
                  <p className="text-xs text-zinc-500">
                    <time dateTime={statement.meetingDate}>{formatDate(statement.meetingDate)}</time>
                    {" · "}<Link to={itemHref} className="hover:text-brand-700 hover:underline">{statement.meetingTitle}</Link>
                  </p>
                  <h3 className="mt-1 font-semibold text-zinc-900">
                    <Link to={itemHref} className="hover:text-brand-700">{statement.topic || statement.agendaTitle || "Agenda item"}</Link>
                    {POSITION_LABEL[statement.position] && <span className={cn("ml-2 text-xs font-medium", POSITION_TONE[statement.position] || "text-zinc-500")}>{POSITION_LABEL[statement.position]}</span>}
                  </h3>
                  {statement.point && <p className="mt-1 text-sm leading-relaxed text-zinc-700">{statement.point}</p>}
                  {(showAgendaTitle || statement.matter || statement.audio || statement.source) && <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
                    {showAgendaTitle && <span>Agenda item: {statement.agendaTitle}</span>}
                    {statement.matter && <Link to={matterPath(statement.matter)} className="font-medium text-brand-700 hover:underline">Matter: {statement.matter.title}</Link>}
                    {statement.audio && <Link to={meetingPath({ id: statement.meetingId, slug: statement.meetingSlug }, `?t=${Math.floor(statement.audio.firstStartTime)}`)} className="font-medium text-brand-700 hover:underline">Listen · {duration(statement.audio.seconds)}</Link>}
                    {statement.source && <span>{SOURCE_LABEL[statement.source]}</span>}
                  </p>}
                </li>;
              })}
            </ol>
          </section>}
          {(audioOnly.length > 0 || statements.length === 0) && <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
            <div className="p-5 sm:p-6"><h2 className="text-lg font-bold text-zinc-900">{statements.length ? "Other recorded audio appearances" : "Recorded audio appearances"}</h2><p className="mt-1 text-sm text-zinc-500">Open a meeting to hear the attributed speech in context.</p></div>
            {audioOnly.length ? <ol className="divide-y divide-zinc-100 border-t border-zinc-100">
              {audioOnly.map(appearance => <li key={`${appearance.meetingId}-${appearance.agendaItemId || "none"}`} className="p-5 sm:px-6">
                <p className="text-xs text-zinc-500">{formatDate(appearance.meetingDate)} · {duration(appearance.seconds)} attributed</p>
                <Link to={meetingPath({ id: appearance.meetingId, slug: appearance.meetingSlug }, `?t=${Math.floor(appearance.firstStartTime)}`)} className="mt-1 inline-block font-semibold text-zinc-900 hover:text-brand-700">{appearance.agendaTitle || appearance.meetingTitle}</Link>
                {appearance.agendaTitle && <p className="mt-1 text-sm text-zinc-500">{appearance.meetingTitle}</p>}
              </li>)}
            </ol> : <p className="border-t border-zinc-100 p-5 text-sm text-zinc-500">No audio has been attributed to this participant.</p>}
          </section>}
        </> : <div className="rounded-2xl border border-zinc-200 bg-surface p-6 text-sm leading-relaxed text-zinc-600">No public comments or appearances have been linked to {person.name} yet. Comments are linked when a speaker’s full name in the minutes or meeting recording matches this profile exactly.</div>}
      </div>
    </div>
  );
}
