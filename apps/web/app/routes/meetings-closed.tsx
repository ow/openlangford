import { Link, data as routeData } from "react-router";
import type { Route } from "./+types/meetings-closed";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import { getCouncilTerms } from "../services/council-terms";
import { getClosedMeetingsData, type ClosedMeetingsData } from "../services/closed-meetings";
import { publicData } from "../services/public-data-cache.server";
import { timed } from "../lib/server-timing.server";
import { DEGRADED_HEADERS, forwardCacheControl } from "../lib/degraded-response";
import { civicToday } from "../lib/council-terms";
import { DetailHeader } from "../components/ui/detail-header";
import { ClosedSessionsChart } from "../components/closed-sessions-chart";
import { aboutDuration, closedSessionSentence, type TermSummary } from "../lib/closed-sessions";
import { meetingPath } from "../lib/paths";
import { formatDate } from "../lib/utils";
import { pageMeta } from "../lib/page-meta";
import { ogImageUrl } from "../lib/og";
import { breadcrumbList, jsonLd } from "../lib/structured-data";

export const headers = forwardCacheControl;

const DESCRIPTION = "How often Langford Council met privately, for how long, and why, council term by council term.";

export const meta: Route.MetaFunction = () => [
  ...pageMeta("Closed meetings — Langford Council", DESCRIPTION, "/meetings/closed", "website", {
    image: ogImageUrl("Closed meetings", { subtitle: "How often Council met privately, and why", type: "meeting" }),
  }),
  jsonLd(breadcrumbList([["Meetings", "/meetings"], ["Closed meetings", "/meetings/closed"]])),
];

export async function loader() {
  const today = civicToday();
  try {
    const supabase = getSupabaseAdminClient();
    const municipality = await timed("closed-municipality", getMunicipality(supabase));
    // Public tables only (meetings, council terms), so the computed page is shared with signed-in visitors.
    const result = await timed("closed-meetings", publicData(`closed-meetings:${municipality.id}:${today}`, async () => {
      const terms = await getCouncilTerms(supabase, municipality.id);
      return getClosedMeetingsData(supabase, municipality.id, terms, today);
    }, (value) => value.complete, 3600, { shareWithSignedIn: true }));
    return routeData({ data: result as ClosedMeetingsData | null, loadError: false });
  } catch (error) {
    console.error("Error loading closed meetings:", error);
    return routeData({ data: null as ClosedMeetingsData | null, loadError: true }, { headers: DEGRADED_HEADERS });
  }
}

const longDate = (date: string) => formatDate(date, { year: "numeric", month: "long", day: "numeric" });
const shortDate = (date: string) => formatDate(date, { year: "numeric", month: "short", day: "numeric" });
const percent = (share: number) => `${Math.round(share * 100)}%`;
const NotMeasurable = () => <span className="text-sm font-medium text-zinc-500">Not measurable</span>;
const hours = (h: number) => (h >= 10 ? `about ${Math.round(h)} hours` : aboutDuration(h * 60));

function lead(term: TermSummary | undefined) {
  if (!term || !term.sessions) return null;
  const rate = term.perYear != null ? `, about ${Math.round(term.perYear)} times a year` : "";
  const share = term.measurable && term.closedShare != null
    ? ` About ${percent(term.closedShare)} of its meeting time was closed to the public.`
    : "";
  return `From ${longDate(term.start_date)} to ${longDate(term.end_date)}, Council met privately ${term.sessions} times${rate}.${share}`;
}

function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-xl font-bold tabular-nums text-zinc-900">{value}</dd>
      {note && <dd className="mt-0.5 text-xs text-zinc-500">{note}</dd>}
    </div>
  );
}

function TermCard({ term }: { term: TermSummary }) {
  const unmeasured = term.sessions > 0 && !term.measurable;
  return (
    <article className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-base font-semibold text-zinc-900">{term.name}</h3>
        <p className="text-xs text-zinc-500">
          {shortDate(term.start_date)} to {shortDate(term.end_date)}
        </p>
      </header>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat label="Closed sessions" value={term.sessions} note={`in ${term.meetings} meetings`} />
        <Stat label="Per year in office" value={term.perYear != null ? Math.round(term.perYear) : "—"} />
        <Stat label="Time closed" value={term.closedHours != null ? hours(term.closedHours) : <NotMeasurable />} />
        <Stat label="Share of meeting time" value={term.closedShare != null ? percent(term.closedShare) : <NotMeasurable />} />
      </dl>
      {term.topReasons.length > 0 && (
        <p className="mt-4 text-sm text-zinc-600">
          Most often about {term.topReasons.map((r, i) => (
            <span key={r.label}>
              {i > 0 && (i === term.topReasons.length - 1 ? " and " : ", ")}
              {r.label} <span className="text-zinc-500">({r.count})</span>
            </span>
          ))}
        </p>
      )}
      {unmeasured && (
        <p className="mt-2 text-xs text-zinc-500">
          {term.timedSessions > 0
            ? `Only ${term.timedSessions} of ${term.sessions} closed sessions can be timed from the minutes, too few to measure the term.`
            : "The minutes from these years don't say when Council went private, so the length can't be measured."}
        </p>
      )}
    </article>
  );
}

export default function ClosedMeetings({ loaderData }: Route.ComponentProps) {
  const { data, loadError } = loaderData;
  const terms = data?.terms ?? [];
  const latest = terms.find((t) => t.sessions > 0);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-5xl px-4 pt-8 pb-16">
        <DetailHeader
          back={{ to: "/meetings", label: "Meetings" }}
          title="Closed meetings"
          description={lead(latest) ?? DESCRIPTION}
        />

        {loadError || !data ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface px-6 py-16 text-center">
            <h2 className="text-base font-semibold text-zinc-900">Closed meetings could not be loaded</h2>
            <p className="mt-1 text-sm text-zinc-500">Please try again shortly.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-10">
            <p className="-mt-4 max-w-3xl text-sm leading-relaxed text-zinc-600">
              Council can close part of a meeting to the public to discuss things like land deals, legal advice or staff matters.
              It has to vote in public to do that, and the vote names the reasons.
            </p>

            <section aria-labelledby="by-term">
              <h2 id="by-term" className="mb-4 text-sm font-semibold text-zinc-600">By council term</h2>
              <div className="flex flex-col gap-4">
                {data.upcoming.map((t) => (
                  <p key={t.name} className="rounded-2xl border border-dashed border-zinc-300 bg-surface px-5 py-4 text-sm text-zinc-600">
                    The council elected in {t.start_date.slice(0, 4)} takes office on {longDate(t.start_date)}. Its closed sessions will be counted here as the minutes are published.
                  </p>
                ))}
                {terms.map((t) => <TermCard key={t.name} term={t} />)}
              </div>
            </section>

            <section aria-labelledby="by-year">
              <h2 id="by-year" className="mb-4 text-sm font-semibold text-zinc-600">By year</h2>
              <ClosedSessionsChart years={data.years} terms={terms} through={data.through} />
            </section>

            {data.recent.length > 0 && (
              <section aria-labelledby="recent">
                <h2 id="recent" className="mb-4 text-sm font-semibold text-zinc-600">Recent closed sessions</h2>
                <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                  {data.recent.map((m) => (
                    <li key={m.id} className="flex flex-col gap-0.5 px-5 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                      <Link to={meetingPath(m)} className="shrink-0 text-sm font-semibold text-brand-700 hover:underline sm:w-56">
                        {m.title}, {shortDate(m.meeting_date)}
                      </Link>
                      <span className="text-sm text-zinc-600">{closedSessionSentence(m.closed)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section aria-labelledby="how" className="max-w-3xl">
              <h2 id="how" className="mb-3 text-sm font-semibold text-zinc-600">How we estimate this</h2>
              <div className="space-y-3 text-sm leading-relaxed text-zinc-600">
                <p>
                  We count every vote to close a meeting in Council's public minutes, plus the City's notices of separate private meetings.
                  This covers regular and special council meetings and Committee of the Whole.
                </p>
                <p>
                  The private part isn't filmed and its minutes aren't published, so its length is an estimate.
                  Council usually goes private near the end of a meeting and adjourns afterwards.
                  We take the time from closing to adjourning. When the minutes don't say when Council closed the meeting, we use the length of the meeting video, which stops at that point.
                </p>
                <p>
                  Share of meeting time compares private time with public time, using only meetings where both are known.
                  Before 2021 the minutes rarely recorded when Council went private and there is no video, so those years can be counted but not timed.
                  Estimates can be off by a few minutes.
                </p>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
