import { Link } from "react-router";
import type { Route } from "./+types/admin";
import { adminRead, adminReadOnlyAction } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { DetailHeader } from "../components/ui/detail-header";
import { cn, formatDate, formatRelativeTime } from "../lib/utils";
import { formatCost } from "../lib/job-usage";
import { getAdminOverview, type AdminOverview, type ActionItem } from "../services/admin-overview.server";

export const meta = () => [
  { title: "Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = ((context as any)?.cloudflare?.env ?? {}) as Record<string, unknown>;
  return adminRead(request, () => getAdminOverview(getSupabaseAdminClient(), env));
}

export const action = adminReadOnlyAction;

const card = "rounded-2xl border border-zinc-200 bg-surface shadow-sm";
const n = (value: number) => value.toLocaleString();
const SHORT_DATE: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };

const TOOLS: { heading: string; links: [string, string, string][] }[] = [
  {
    heading: "Residents",
    links: [
      ["/admin/contact", "Contact messages", "Read and answer the contact form."],
      ["/admin/users", "Accounts", "Registered accounts and their alerts."],
      ["/admin/emails", "Email activity", "Alert emails and delivery events."],
    ],
  },
  {
    heading: "Review",
    links: [
      ["/admin/names", "Speaker names", "Confirm residents' name spellings."],
      ["/admin/letters", "Letter placement", "Match letters to agenda items."],
      ["/admin/matters", "Duplicate issues", "Review proposed merges."],
      ["/admin/profiles", "Councillor profiles", "Approve generated profile drafts."],
      ["/speaker-alias", "Speaker aliases", "Correct speaker identities."],
      ["/admin/reviews", "Page reviews", "Pages you've checked, and ones that need work."],
    ],
  },
  {
    heading: "Site data",
    links: [
      ["/admin/people", "People and memberships", "Council and staff records."],
    ],
  },
];

export default function Admin({ loaderData }: Route.ComponentProps) {
  const data = loaderData as unknown as AdminOverview;
  const waiting = data.actions.filter((a) => (a.count ?? 0) > 0);
  const clear = data.actions.filter((a) => a.count === 0);
  const unknown = data.actions.filter((a) => a.count == null);
  const hasPageReviews = data.actions.some((a) => a.key === "pages");

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 pt-6 pb-12 md:pt-10">
        <DetailHeader
          title="Admin"
          meta={[
            <span key="waiting">
              {waiting.length === 0 ? "Nothing waiting on you" : `${waiting.length} ${waiting.length === 1 ? "thing needs" : "things need"} you`}
            </span>,
            <span key="updated">Updated {formatRelativeTime(data.generatedAt)}</span>,
          ]}
        />

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section aria-labelledby="needs-heading">
            <SectionHeading id="needs-heading">Needs you</SectionHeading>
            {waiting.length === 0 ? (
              <p className={cn(card, "px-5 py-4 text-sm text-zinc-600")}>Every queue is clear.</p>
            ) : (
              <ul className={cn(card, "divide-y divide-zinc-100")}>
                {waiting.map((item) => (
                  <ActionRow key={item.key} item={item} />
                ))}
              </ul>
            )}
            {(clear.length > 0 || unknown.length > 0) && (
              <p className="mt-3 text-sm text-zinc-500">
                {clear.length > 0 && <>Clear: {clear.map((a) => a.label.toLowerCase()).join(", ")}.</>}
                {unknown.length > 0 && (
                  <span className="text-amber-800"> Couldn't check: {unknown.map((a) => a.label.toLowerCase()).join(", ")}.</span>
                )}
              </p>
            )}
          </section>

          <section aria-labelledby="calendar-heading">
            <SectionHeading id="calendar-heading">Council calendar</SectionHeading>
            <Calendar content={data.content} />
          </section>
        </div>

        <section aria-labelledby="pulse-heading" className="mt-10">
          <SectionHeading id="pulse-heading">Last 7 days</SectionHeading>
          <div className={cn(card, "grid grid-cols-2 gap-px overflow-hidden bg-zinc-200 md:grid-cols-3 xl:grid-cols-6")}>
            <Stat
              label="Visits"
              value={data.traffic.available ? n(data.traffic.visits7) : "—"}
              detail={
                data.traffic.available
                  ? `${trend(data.traffic.visits7, data.traffic.visitsPrev7)} · ${n(data.traffic.views7)} page views`
                  : data.traffic.reason === "error"
                    ? "PostHog didn't answer"
                    : "Not connected"
              }
            />
            <Stat
              label="Accounts"
              value={data.audience ? n(data.audience.total) : "—"}
              detail={data.audience ? `${n(data.audience.new7)} new · ${n(data.audience.active7)} signed in` : "Couldn't read"}
            />
            <Stat
              label="Following something"
              value={data.audience ? n(data.audience.subscribers) : "—"}
              detail={
                data.audience
                  ? `${n(data.audience.subscriptions)} alerts · ${n(data.audience.subscriptions7)} added`
                  : "Couldn't read"
              }
            />
            <Stat
              label="Questions asked"
              value={data.ask ? n(data.ask.asked7) : "—"}
              detail={data.ask ? `${n(data.ask.asked30)} in 30 days` : "Couldn't read"}
            />
            <Stat
              label="Emails sent"
              value={data.email ? n(data.email.total) : "—"}
              tone={data.email && data.email.problems > 0 ? "danger" : "default"}
              detail={
                !data.email
                  ? "Couldn't read"
                  : data.email.problems > 0
                    ? `${n(data.email.problems)} failed or bounced`
                    : data.email.total > 0
                      ? `${n(data.email.delivered)} delivered`
                      : data.email.lastSentAt
                        ? `last ${formatRelativeTime(data.email.lastSentAt)}`
                        : "None yet"
              }
            />
            <Stat
              label="Ask cost"
              value={data.ai ? formatCost(data.ai.windows[0]?.costUsd ?? 0) : "—"}
              tone={data.ai && data.ai.recentFailures > 0 ? "danger" : "default"}
              detail={
                !data.ai
                  ? "Couldn't read"
                  : data.ai.recentFailures > 0
                    ? `${n(data.ai.recentFailures)} failed answers`
                    : `${formatCost(data.ai.windows[1]?.costUsd ?? 0)} in 30 days`
              }
            />
          </div>
        </section>

        <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-2">
          <section aria-labelledby="traffic-heading">
            <SectionHeading id="traffic-heading">Visits</SectionHeading>
            <Traffic traffic={data.traffic} />
          </section>
          <section aria-labelledby="accounts-heading">
            <SectionHeading id="accounts-heading" link={{ to: "/admin/users", label: "All accounts" }}>
              Newest accounts
            </SectionHeading>
            <NewestAccounts audience={data.audience} />
          </section>
        </div>

        <section aria-labelledby="tools-heading" className="mt-10">
          <SectionHeading id="tools-heading">Tools</SectionHeading>
          <div className="grid gap-6 md:grid-cols-3">
            {TOOLS.map((group) => (
              <div key={group.heading}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{group.heading}</h3>
                <ul className={cn(card, "divide-y divide-zinc-100")}>
                  {group.links.filter(([to]) => to !== "/admin/reviews" || hasPageReviews).map(([to, title, description]) => (
                    <li key={to}>
                      <Link
                        to={to}
                        className="block px-4 py-3 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                      >
                        <span className="block text-sm font-medium text-zinc-900">{title}</span>
                        <span className="block text-sm text-zinc-500">{description}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function SectionHeading({ id, children, link }: { id: string; children: React.ReactNode; link?: { to: string; label: string } }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 id={id} className="text-lg font-semibold text-zinc-900">
        {children}
      </h2>
      {link && (
        <Link to={link.to} className="text-sm font-medium text-brand-700 hover:text-brand-800">
          {link.label}
        </Link>
      )}
    </div>
  );
}

function ActionRow({ item }: { item: ActionItem }) {
  return (
    <li>
      <Link
        to={item.href}
        className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-3 px-5 py-3.5 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
      >
        <span
          className={cn(
            "text-2xl font-semibold tabular-nums tracking-tight",
            item.tone === "urgent" ? "text-red-700" : "text-zinc-950",
          )}
        >
          {n(item.count ?? 0)}
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-zinc-900">{item.label}</span>
          {item.detail && (
            <span className="block text-sm text-zinc-500">
              {item.key === "contact" && item.detail.startsWith("oldest from ")
                ? `Oldest ${formatRelativeTime(item.detail.slice("oldest from ".length))}`
                : item.detail[0].toUpperCase() + item.detail.slice(1)}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

function Stat({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "danger";
}) {
  return (
    <div className="min-w-0 bg-surface px-5 py-4">
      <div className="text-sm font-medium text-zinc-600">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-zinc-950">{value}</div>
      <div className={cn("mt-1 truncate text-sm", tone === "danger" ? "text-red-700" : "text-zinc-500")}>{detail}</div>
    </div>
  );
}

function trend(current: number, previous: number) {
  if (previous === 0) return current > 0 ? "new this week" : "no visits";
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return "same as last week";
  return `${change > 0 ? "up" : "down"} ${Math.abs(change)}% on last week`;
}

function Calendar({ content }: { content: AdminOverview["content"] }) {
  if (!content) return <p className={cn(card, "px-5 py-4 text-sm text-zinc-500")}>Couldn't read meetings.</p>;
  const latest = content.latestMeeting;
  return (
    <div className={cn(card, "divide-y divide-zinc-100")}>
      <div className="px-5 py-3.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Latest on the site</div>
        {latest ? (
          <>
            <Link to={`/meetings/${latest.slug ?? latest.id}`} className="mt-1 block font-medium text-zinc-900 hover:text-brand-700">
              {latest.title}
            </Link>
            <div className="text-sm text-zinc-500">
              {formatDate(latest.date)}
              {latest.hasSummary ? "" : " · no summary yet"}
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-zinc-500">No meetings yet.</p>
        )}
      </div>
      <div className="px-5 py-3.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Coming up</div>
        {content.upcoming.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500">Nothing scheduled.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {content.upcoming.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-zinc-800">{m.title}</span>
                <span className="shrink-0 tabular-nums text-zinc-500">{formatDate(m.date, SHORT_DATE)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Traffic({ traffic }: { traffic: AdminOverview["traffic"] }) {
  if (!traffic.available) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 px-5 py-4 text-sm text-zinc-600">
        {traffic.reason === "error" ? (
          "PostHog didn't answer. Visits will show again on the next load."
        ) : (
          <>
            Visits come from PostHog. Add the Worker secrets <code className="text-xs">POSTHOG_PERSONAL_API_KEY</code> (a
            personal key with query access) and <code className="text-xs">POSTHOG_PROJECT_ID</code> to show them here.
          </>
        )}
      </div>
    );
  }
  const max = Math.max(1, ...traffic.daily.map((d) => d.visits));
  const label = (day: string) => formatDate(day, SHORT_DATE);
  return (
    <div className={cn(card, "px-5 py-4")}>
      <div className="text-sm text-zinc-600">Visits per day, last 14 days</div>
      <div
        role="img"
        aria-label={`Visits per day: ${traffic.daily.map((d) => `${label(d.day)} ${d.visits}`).join(", ")}`}
        className="mt-3 flex h-24 items-end gap-[2px]"
      >
        {traffic.daily.map((d) => (
          <div key={d.day} className="group relative flex h-full flex-1 items-end">
            <div
              className="w-full rounded-t-[4px] bg-brand-600 group-hover:bg-brand-700"
              style={{ height: `${Math.max(2, (d.visits / max) * 100)}%` }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs text-white group-hover:block">
              {label(d.day)}: {n(d.visits)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-zinc-400">
        <span>{traffic.daily[0] && label(traffic.daily[0].day)}</span>
        <span>{traffic.daily.at(-1) && label(traffic.daily.at(-1)!.day)}</span>
      </div>
      {traffic.topPages.length > 0 && (
        <>
          <div className="mt-5 text-sm text-zinc-600">Most viewed pages</div>
          <ol className="mt-2 space-y-1 text-sm">
            {traffic.topPages.map((p) => (
              <li key={p.path} className="flex items-baseline justify-between gap-3">
                <Link to={p.path} className="min-w-0 truncate text-zinc-800 hover:text-brand-700">
                  {p.path}
                </Link>
                <span className="shrink-0 tabular-nums text-zinc-500">{n(p.views)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function NewestAccounts({ audience }: { audience: AdminOverview["audience"] }) {
  if (!audience) return <p className={cn(card, "px-5 py-4 text-sm text-zinc-500")}>Couldn't read accounts.</p>;
  if (audience.recent.length === 0) return <p className={cn(card, "px-5 py-4 text-sm text-zinc-500")}>No accounts yet.</p>;
  return (
    <div className={card}>
      <ul className="divide-y divide-zinc-100">
        {audience.recent.map((u) => (
          <li key={u.id}>
            <Link
              to={`/admin/users/${u.id}`}
              className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-zinc-50"
            >
              <span className="min-w-0 truncate text-zinc-800">
                {u.email ?? "No email"}
                {!u.confirmed && <span className="ml-2 text-amber-800">unconfirmed</span>}
              </span>
              <span className="shrink-0 text-zinc-500">{formatRelativeTime(u.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {audience.subscriptionTypes.length > 0 && (
        <p className="border-t border-zinc-100 px-5 py-3 text-sm text-zinc-500">
          Alerts by kind:{" "}
          {audience.subscriptionTypes.map(([type, count]) => `${ALERT_KINDS[type] ?? type} ${n(count)}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

const ALERT_KINDS: Record<string, string> = {
  digest: "meeting digest",
  topic: "topics",
  neighborhood: "near a place",
  matter: "issues",
  person: "people",
  keyword: "keywords",
};
