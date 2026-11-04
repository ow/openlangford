import { accountEmailFor } from "../lib/redact-email";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/admin";
import { adminRead, adminReadOnlyAction } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { DetailHeader } from "../components/ui/detail-header";
import { AreaChart, BarChart, BarList, Sparkline, type Point } from "../components/admin/charts";
import { cn, formatDate, formatRelativeTime } from "../lib/utils";
import { formatCost } from "../lib/job-usage";
import { getAdminOverview, type AdminOverview } from "../services/admin-overview.server";

export const meta = () => [
  { title: "Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = ((context as any)?.cloudflare?.env ?? {}) as Record<string, unknown>;
  const ctx = (context as any)?.cloudflare?.ctx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
  const waitUntil = ctx?.waitUntil ? (p: Promise<unknown>) => ctx.waitUntil!(p) : undefined;
  return adminRead(request, async (role) => {
    const overview = await getAdminOverview(getSupabaseAdminClient(), env, new Date(), waitUntil);
    const email = accountEmailFor(role);
    const audience = overview.audience && { ...overview.audience, recent: overview.audience.recent.map((u) => ({ ...u, email: email(u.email) })) };
    return { ...overview, audience, staffRole: role };
  });
}

export const action = adminReadOnlyAction;

const card = "rounded-2xl border border-zinc-200 bg-surface shadow-sm";
const n = (value: number) => value.toLocaleString();
const SHORT_DATE: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };

const sum = (points: Point[]) => points.reduce((total, p) => total + p.value, 0);
const weeks = (points: Point[]) => ({ current: sum(points.slice(-7)), previous: sum(points.slice(-14, -7)) });

function change(current: number, previous: number) {
  if (previous === 0) return current > 0 ? "None the week before" : "None in two weeks";
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct === 0 ? "Same as last week" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)}% vs last week`;
}

type ToolStatus = { text: string; tone: "waiting" | "urgent" | "neutral" | "clear" } | null;
type Tool = { to: string; title: string; status: ToolStatus };

function waiting(count: number | null | undefined, noun: string, tone: "waiting" | "urgent" = "waiting"): ToolStatus {
  if (count == null) return { text: "Couldn't check", tone: "neutral" };
  return count > 0 ? { text: `${n(count)} ${noun}`, tone } : { text: "Clear", tone: "clear" };
}

function tools(data: AdminOverview & { staffRole?: string }): { heading: string; links: Tool[] }[] {
  const q = data.queues;
  return [
    {
      heading: "Residents",
      links: [
        { to: "/admin/contact", title: "Contact messages", status: waiting(q.contact?.count, "open", "urgent") },
        {
          to: "/admin/users",
          title: "Accounts",
          status: data.audience ? { text: `${n(data.audience.total)} total`, tone: "neutral" } : null,
        },
        {
          to: "/admin/emails",
          title: "Email activity",
          status: !data.email
            ? null
            : data.email.problems7 > 0
              ? { text: `${n(data.email.problems7)} failed`, tone: "urgent" }
              : { text: `${n(data.email.sent7)} this week`, tone: "neutral" },
        },
      ],
    },
    {
      heading: "Review",
      links: [
        { to: "/admin/names", title: "Speaker names", status: waiting(q.names, "to confirm") },
        { to: "/admin/letters", title: "Letter placement", status: waiting(q.letters?.letters, "to place") },
        { to: "/admin/matters", title: "Duplicate issues", status: waiting(q.merges, "to review") },
        { to: "/admin/profiles", title: "Councillor profiles", status: waiting(q.profiles, q.profiles === 1 ? "draft" : "drafts") },
        { to: "/admin/reviews?show=needs_work", title: "Page reviews", status: waiting(q.pages, "need work") },
        { to: "/speaker-alias", title: "Speaker aliases", status: null },
      ],
    },
    // Admins only: moderators don't run the pipeline or edit council and staff records.
    ...(data.staffRole !== "admin" ? [] : [{
      heading: "Site data",
      links: [
        { to: "/admin/pipeline", title: "Pipeline", status: waiting(q.failedJobs, "failed", "urgent") },
        { to: "/admin/people", title: "People and memberships", status: null },
        { to: "/admin/audit", title: "Audit log", status: null },
      ],
    }]),
  ];
}

export default function Admin({ loaderData }: Route.ComponentProps) {
  const data = loaderData as unknown as AdminOverview & { staffRole?: string };
  const groups = tools(data);
  const busy = groups.flatMap((g) => g.links).filter((t) => t.status?.tone === "waiting" || t.status?.tone === "urgent").length;
  const traffic = data.traffic.available ? data.traffic : null;
  const trafficReason = data.traffic.available ? null : data.traffic.reason;
  const trafficShort = trafficReason === "error" ? "PostHog didn't answer" : "PostHog not connected";
  const signups = data.audience?.signups ?? [];
  const alertsAdded = data.audience?.alertsAdded ?? [];
  const questions = data.questions ?? [];

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-7xl px-4 pt-6 pb-12 md:pt-10">
        <DetailHeader
          title="Admin"
          meta={[
            <span key="busy">{busy === 0 ? "Nothing waiting on you" : `${busy} ${busy === 1 ? "tool has" : "tools have"} work waiting`}</span>,
            <span key="updated">Updated {formatRelativeTime(data.generatedAt)}</span>,
          ]}
        />

        <section aria-label="Last 7 days" className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <Stat
            label="Visitors"
            value={traffic ? n(traffic.visitors7) : "—"}
            detail={traffic ? change(traffic.visitors7, traffic.visitorsPrev7) : trafficShort}
            series={traffic?.visitors}
          />
          <Stat
            label="Page views"
            value={traffic ? n(traffic.views7) : "—"}
            detail={traffic ? change(traffic.views7, traffic.viewsPrev7) : trafficShort}
            series={traffic?.views}
          />
          <Stat
            label="New accounts"
            value={data.audience ? n(weeks(signups).current) : "—"}
            detail={data.audience ? `${n(data.audience.total)} in all · ${n(data.audience.signedIn7)} signed in` : "Couldn't read"}
            series={signups}
          />
          <Stat
            label="Alerts added"
            value={data.audience ? n(weeks(alertsAdded).current) : "—"}
            detail={data.audience ? `${n(data.audience.followers)} people follow ${n(data.audience.alerts)}` : "Couldn't read"}
            series={alertsAdded}
          />
          <Stat
            label="Questions asked"
            value={data.questions ? n(weeks(questions).current) : "—"}
            detail={
              data.questions
                ? `${change(weeks(questions).current, weeks(questions).previous)}${data.askCost7 != null ? ` · ${formatCost(data.askCost7)}` : ""}`
                : "Couldn't read"
            }
            series={questions}
          />
        </section>
        <p className="mt-2 text-xs text-zinc-500">Numbers are for the last 7 days. Trend lines show 30 days.</p>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr]">
          <ToolsPanel groups={groups} contact={data.queues.contact} />

          <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-span-2 lg:row-start-1">
            <Panel title="Visitors" subtitle={`People per day, last 30 days${traffic ? ` · as of ${formatRelativeTime(traffic.asOf)}` : ""}`}>
              {traffic ? <AreaChart data={traffic.visitors} unit="visitors" label="Visitors per day" /> : <TrafficSetup traffic={data.traffic} />}
            </Panel>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              <Panel title="New accounts" subtitle={`${n(sum(signups))} in 30 days`}>
                <BarChart data={signups} unit="accounts" label="New accounts per day" />
              </Panel>
              <Panel title="Alerts added" subtitle={`${n(sum(alertsAdded))} in 30 days`}>
                <BarChart data={alertsAdded} unit="alerts" label="Alerts added per day" />
              </Panel>
              <Panel title="Questions asked" subtitle={`${n(sum(questions))} in 30 days`}>
                <BarChart data={questions} unit="questions" label="Questions asked per day" />
              </Panel>
            </div>

            {traffic && (
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <Panel title="Most viewed pages" subtitle="Page views, last 7 days">
                  {traffic.topPages.length ? (
                    <BarList
                      items={traffic.topPages}
                      renderLabel={(path) => (
                        <Link to={path} className="hover:text-brand-700">
                          {path}
                        </Link>
                      )}
                    />
                  ) : (
                    <Empty>No page views this week.</Empty>
                  )}
                </Panel>
                <Panel title="Where visitors come from" subtitle="Other sites, last 7 days">
                  {traffic.referrers.length ? <BarList items={traffic.referrers} /> : <Empty>Everyone came directly or from search.</Empty>}
                </Panel>
              </div>
            )}
          </div>

          <aside className="min-w-0 space-y-6 lg:col-start-2 lg:row-start-2">
            {data.reviews && <ReviewProgress reviews={data.reviews} />}
            <Panel title="Council calendar" flush>
              <Calendar calendar={data.calendar} />
            </Panel>

            <Panel title="Newest accounts" flush action={{ to: "/admin/users", label: "All" }}>
              <NewestAccounts audience={data.audience} />
            </Panel>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ToolsPanel({ groups, contact }: { groups: { heading: string; links: Tool[] }[]; contact: AdminOverview["queues"]["contact"] }) {
  return (
    <div className="min-w-0 lg:col-start-2 lg:row-start-1">
      <Panel title="Tools" flush>
        {groups.map((group) => (
          <div key={group.heading} className="border-t border-zinc-100 first:border-t-0">
            <h3 className="px-5 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{group.heading}</h3>
            <ul className="pb-2">
              {group.links.map((tool) => (
                <li key={tool.to}>
                  <Link
                    to={tool.to}
                    className="flex items-baseline justify-between gap-3 px-5 py-1.5 text-sm transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                  >
                    <span className="min-w-0 truncate font-medium text-zinc-800">{tool.title}</span>
                    {tool.status && (
                      <span
                        className={cn(
                          "shrink-0 tabular-nums",
                          tool.status.tone === "urgent" && "font-semibold text-red-700",
                          tool.status.tone === "waiting" && "font-semibold text-amber-800",
                          tool.status.tone === "neutral" && "text-zinc-500",
                          tool.status.tone === "clear" && "text-zinc-400",
                        )}
                      >
                        {tool.status.text}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {contact?.oldest && (contact.count ?? 0) > 0 && (
          <p className="border-t border-zinc-100 px-5 py-2.5 text-xs text-zinc-500">
            Oldest open contact message: {formatRelativeTime(contact.oldest)}.
          </p>
        )}
      </Panel>
    </div>
  );
}

/** Pages still waiting for a person's review, and how that number has come down: a way into reviewing. */
function ReviewProgress({ reviews }: { reviews: NonNullable<AdminOverview["reviews"]> }) {
  const share = reviews.total ? Math.round(((reviews.total - reviews.left) / reviews.total) * 100) : 100;
  return (
    <Panel
      title="Pages needing review"
      subtitle={`${n(reviews.reviewedThisWeek)} reviewed this week`}
      action={{ to: "/admin/reviews", label: "All" }}
    >
      {reviews.left === 0 ? (
        <p className="text-sm text-zinc-600">Every page has been reviewed.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums tracking-tight text-zinc-950">{n(reviews.left)}</span>
            <span className="text-sm text-zinc-500">of {n(reviews.total)} left</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100" role="img" aria-label={`${share}% of pages reviewed`}>
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(share, 1)}%` }} />
          </div>
          <p className="mt-1 text-xs text-zinc-500">{share}% reviewed</p>
          <div className="mt-3">
            <AreaChart data={reviews.series} unit="pages left" label="Pages left to review, last 30 days" height={110} zoom />
          </div>
        </>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {reviews.left > 0 && (
          <Link to="/admin/reviews/next" className="rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            Review a page
          </Link>
        )}
        {reviews.awaitingConfirmation > 0 && (
          <Link to="/admin/reviews/next?status=fixed" className="text-sm font-medium text-brand-700 hover:text-brand-800">
            Confirm {n(reviews.awaitingConfirmation)} agent {reviews.awaitingConfirmation === 1 ? "fix" : "fixes"}
          </Link>
        )}
      </div>
    </Panel>
  );
}

function Panel({
  title,
  subtitle,
  action,
  flush,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: { to: string; label: string };
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={card}>
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-zinc-900">{title}</h2>
          {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {action && (
          <Link to={action.to} className="shrink-0 text-sm font-medium text-brand-700 hover:text-brand-800">
            {action.label}
          </Link>
        )}
      </div>
      <div className={flush ? "" : "px-5 pb-5"}>{children}</div>
    </section>
  );
}

function Stat({ label, value, detail, series }: { label: string; value: string; detail: string; series?: Point[] }) {
  return (
    <div className={cn(card, "flex min-w-0 flex-col px-4 pt-4 pb-3")}>
      <div className="text-sm font-medium text-zinc-600">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-zinc-950">{value}</div>
      <div className="mt-0.5 truncate text-xs text-zinc-500" title={detail}>
        {detail}
      </div>
      <div className="mt-auto pt-3">{series ? <Sparkline data={series} /> : <div className="h-8 border-b border-dashed border-zinc-200" />}</div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-500">{children}</p>;
}

function postHogProblem(status: number | null) {
  if (status === 401) return "PostHog didn't accept the key. Set POSTHOG_PERSONAL_API_KEY again; it may be empty or mistyped.";
  if (status === 403) return "The key can't run queries on this project. Give it Query: read on the Open Langford project.";
  if (status === 404) return "PostHog can't find the project. Check POSTHOG_PROJECT_ID in wrangler.toml.";
  if (status) return `PostHog returned an error (${status}). Visitors will show again once it answers.`;
  return "PostHog didn't answer in time. Visitors will show again on the next load.";
}

function TrafficSetup({ traffic }: { traffic: AdminOverview["traffic"] }) {
  const reason = traffic.available ? "not_configured" : traffic.reason;
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-8 border-zinc-300 bg-zinc-50 px-6 text-center text-sm text-zinc-600">
      {reason === "error" ? (
        <p className="max-w-md">{postHogProblem(!traffic.available && traffic.reason === "error" ? traffic.status : null)}</p>
      ) : (
        <p className="max-w-md">
          Visitor numbers come from PostHog. Set the Worker secret <code className="text-xs">POSTHOG_PERSONAL_API_KEY</code> (a
          personal key with query access) and <code className="text-xs">POSTHOG_PROJECT_ID</code> in wrangler.toml to show them here.
        </p>
      )}
    </div>
  );
}

function Calendar({ calendar }: { calendar: AdminOverview["calendar"] }) {
  if (!calendar) return <p className="px-5 pb-4 text-sm text-zinc-500">Couldn't read meetings.</p>;
  return (
    <div className="pb-3">
      <div className="px-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Latest on the site</div>
        {calendar.latest ? (
          <Link to={`/meetings/${calendar.latest.slug ?? calendar.latest.id}`} className="mt-0.5 block text-sm hover:text-brand-700">
            <span className="font-medium text-zinc-900">{calendar.latest.title}</span>
            <span className="block text-zinc-500">
              {formatDate(calendar.latest.date, SHORT_DATE)}
              {calendar.latest.hasSummary ? "" : " · no summary yet"}
            </span>
          </Link>
        ) : (
          <p className="mt-0.5 text-sm text-zinc-500">No meetings yet.</p>
        )}
      </div>
      <div className="mt-3 border-t border-zinc-100 px-5 pt-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Coming up</div>
        {calendar.upcoming.length === 0 ? (
          <p className="mt-0.5 text-sm text-zinc-500">Nothing scheduled.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {calendar.upcoming.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-zinc-800">{m.title}</span>
                <span className="shrink-0 tabular-nums text-zinc-500">{formatDate(m.date, { month: "short", day: "numeric" })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const ALERT_KINDS: Record<string, string> = {
  digest: "digest",
  topic: "topics",
  neighborhood: "near a place",
  matter: "issues",
  person: "people",
  keyword: "keywords",
};

function NewestAccounts({ audience }: { audience: AdminOverview["audience"] }) {
  if (!audience) return <p className="px-5 pb-4 text-sm text-zinc-500">Couldn't read accounts.</p>;
  if (audience.recent.length === 0) return <p className="px-5 pb-4 text-sm text-zinc-500">No accounts yet.</p>;
  return (
    <>
      <ul className="pb-2">
        {audience.recent.map((u) => (
          <li key={u.id}>
            <Link to={`/admin/users/${u.id}`} className="flex items-baseline justify-between gap-3 px-5 py-1.5 text-sm transition-colors hover:bg-zinc-50">
              <span className="min-w-0 truncate text-zinc-800">
                {u.email ?? "No email"}
                {!u.confirmed && <span className="ml-1.5 text-xs text-amber-800">unconfirmed</span>}
              </span>
              <span className="shrink-0 text-xs text-zinc-500">{formatRelativeTime(u.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {audience.alertTypes.length > 0 && (
        <p className="border-t border-zinc-100 px-5 py-2.5 text-xs text-zinc-500">
          Alerts: {audience.alertTypes.map(([type, count]) => `${ALERT_KINDS[type] ?? type} ${n(count)}`).join(" · ")}
        </p>
      )}
    </>
  );
}
