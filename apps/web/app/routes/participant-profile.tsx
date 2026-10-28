import { pageMeta } from "../lib/page-meta";
import { Link } from "react-router";
import { meetingPath } from "../lib/paths";
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
import { formatDate } from "../lib/utils";
import type { Person } from "../lib/types";

export const meta: Route.MetaFunction = ({ data }) => data
  ? pageMeta(`${data.person.name} — Public participation`, `${data.person.name}’s recorded participation as a member of the public at Langford council and committee meetings.`, participantPath(data.person), "profile")
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
  const [participation] = await getPublicParticipantStats(supabase, municipality.id, histories, person.id);
  return {
    person: person as Person,
    participation: participation || null,
    history: await withMeetingSlugs(supabase, histories[0] || null),
    hasCouncilService: councilServicePeriods(person as Person).length > 0,
  };
}

function duration(seconds: number) {
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded}s` : rounded < 3600 ? `${Math.floor(rounded / 60)}m ${rounded % 60}s` : `${Math.floor(Math.round(rounded / 60) / 60)}h ${Math.round(rounded / 60) % 60}m`;
}

export default function ParticipantProfile({ loaderData }: Route.ComponentProps) {
  const { person, participation, history, hasCouncilService } = loaderData;
  const appearances = participation?.recentAppearances.filter(appearance => appearance.segmentCount > 0) || [];
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
              <p className="mb-1 text-sm font-medium text-zinc-500">{participation ? "Public participant" : "Meeting participant"}</p>
              <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900">{person.name}</h1>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-zinc-600">Recorded appearances as a member of the public at council and committee meetings.</p>
          {hasCouncilService && <Link to={personPath(person)} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-700 hover:underline">View council service profile <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link>}
        </header>

        {participation ? <>
          <dl className="grid gap-4 sm:grid-cols-3">
            {[
              ["Meetings with recorded participation", String(participation.meetingCount)],
              ["Meetings documented in minutes", String(participation.documentedMeetingCount)],
              ["Audio-attributed speaking time", participation.totalSeconds > 0 ? duration(participation.totalSeconds) : "Not available"],
            ].map(([label, value]) => <div key={label} className="rounded-2xl border border-zinc-200 bg-surface p-5"><dt className="text-sm text-zinc-500">{label}</dt><dd className="mt-2 text-2xl font-bold tabular-nums text-zinc-900">{value}</dd></div>)}
          </dl>
          <p className="text-sm leading-relaxed text-zinc-500">These counts cover identified public appearances in the available records. Audio attribution is incomplete; minutes-documented appearances do not establish speaking time.</p>
          {history && <PublicParticipation history={history} beforeCouncil={false} />}
          <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
            <div className="p-5 sm:p-6"><h2 className="text-lg font-bold text-zinc-900">Recorded audio appearances</h2><p className="mt-1 text-sm text-zinc-500">Open a meeting to hear the attributed speech in context.</p></div>
            {appearances.length ? <ol className="divide-y divide-zinc-100 border-t border-zinc-100">
              {appearances.map(appearance => <li key={`${appearance.meetingId}-${appearance.agendaItemId || "none"}`} className="p-5 sm:px-6">
                <p className="text-xs text-zinc-500">{formatDate(appearance.meetingDate)} · {duration(appearance.seconds)} attributed</p>
                <Link to={meetingPath({ id: appearance.meetingId, slug: appearance.meetingSlug }, `?t=${Math.floor(appearance.firstStartTime)}`)} className="mt-1 inline-block font-semibold text-zinc-900 hover:text-brand-700">{appearance.agendaTitle || appearance.meetingTitle}</Link>
                {appearance.agendaTitle && <p className="mt-1 text-sm text-zinc-500">{appearance.meetingTitle}</p>}
              </li>)}
            </ol> : <p className="border-t border-zinc-100 p-5 text-sm text-zinc-500">No audio has been attributed to this participant.</p>}
          </section>
        </> : <div className="rounded-2xl border border-zinc-200 bg-surface p-6 text-sm text-zinc-600">No public participation has been identified in the available records.</div>}
      </div>
    </div>
  );
}
