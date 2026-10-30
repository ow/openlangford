import { useState } from "react";
import { Link, data as routeData } from "react-router";
import { FileText, History, Mic } from "lucide-react";
import type { Route } from "./+types/updates";
import { PageHeader } from "../components/ui/page-header";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import { getRecentUpdates, updateDay, type RecentUpdate } from "../services/recent-updates.server";
import { publicData } from "../services/public-data-cache.server";
import { RECENT_PUBLIC_TTL } from "../lib/public-content-cache";
import { DEGRADED_HEADERS, forwardCacheControl } from "../lib/degraded-response";
import { meetingPath } from "../lib/paths";
import { pageMeta } from "../lib/page-meta";
import { formatDate } from "../lib/utils";

export const meta: Route.MetaFunction = () =>
  pageMeta(
    "Recent updates",
    "Meetings Open Langford has finished processing most recently, including older meetings that just gained a transcript or minutes.",
    "/updates",
    "website",
  );

export const headers = forwardCacheControl;

type UpdateDay = { day: string; updates: RecentUpdate[] };

export async function loader() {
  try {
    const supabase = getSupabaseAdminClient();
    const municipality = await getMunicipality(supabase);
    const updates = await publicData(
      `recent-updates:${municipality.id}`,
      () => getRecentUpdates(supabase, municipality),
      () => true,
      RECENT_PUBLIC_TTL,
      { shareWithSignedIn: true },
    );
    const days: UpdateDay[] = [];
    for (const update of updates) {
      const day = updateDay(update.finishedAt);
      if (days.at(-1)?.day !== day) days.push({ day, updates: [] });
      days.at(-1)!.updates.push(update);
    }
    return routeData({ days, loadError: false });
  } catch (error) {
    console.error("Error loading recent updates:", error);
    return routeData({ days: [] as UpdateDay[], loadError: true }, { headers: DEGRADED_HEADERS });
  }
}

const KIND_LABEL = {
  transcript: { label: "Transcript added", icon: Mic, className: "bg-brand-50 text-brand-700 ring-brand-100" },
  documents: { label: "Agenda & minutes processed", icon: FileText, className: "bg-zinc-100 text-zinc-700 ring-zinc-200" },
} as const;

const DAY_PREVIEW = 8;

function dayHeading(day: string) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date());
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date(Date.now() - 86_400_000));
  const date = formatDate(day, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  if (day === today) return `Today · ${date}`;
  if (day === yesterday) return `Yesterday · ${date}`;
  return date;
}

function UpdateRow({ update }: { update: RecentUpdate }) {
  const kind = KIND_LABEL[update.kind];
  const Icon = kind.icon;
  return (
    <li className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <Link
          to={meetingPath({ id: update.meetingId, slug: update.slug })}
          className="font-semibold text-zinc-900 hover:text-brand-700 hover:underline"
        >
          {update.title}
        </Link>
        <div className="text-sm text-zinc-500">
          Meeting held {formatDate(update.meetingDate, { year: "numeric", month: "short", day: "numeric" })}
          {update.type && update.type !== update.title ? ` · ${update.type}` : ""}
        </div>
      </div>
      <span
        className={`inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${kind.className}`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {kind.label}
      </span>
    </li>
  );
}

function DayGroup({ group }: { group: UpdateDay }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? group.updates : group.updates.slice(0, DAY_PREVIEW);
  const hidden = group.updates.length - visible.length;
  const transcripts = group.updates.filter((u) => u.kind === "transcript").length;
  return (
    <section className="relative pl-8">
      <span className="absolute left-0 top-1.5 h-3 w-3 rounded-full bg-brand-600 ring-4 ring-brand-100" aria-hidden="true" />
      <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-900">{dayHeading(group.day)}</h2>
      <p className="mt-0.5 text-sm text-zinc-500">
        {group.updates.length} {group.updates.length === 1 ? "meeting" : "meetings"}
        {transcripts > 0 && transcripts < group.updates.length ? ` · ${transcripts} with new transcripts` : ""}
      </p>
      <ul className="mt-2 divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface px-4">
        {visible.map((update) => (
          <UpdateRow key={`${update.meetingId}:${update.finishedAt}`} update={update} />
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-sm font-medium text-brand-700 hover:underline"
        >
          Show {hidden} more
        </button>
      )}
    </section>
  );
}

export default function Updates({ loaderData }: Route.ComponentProps) {
  const { days, loadError } = loaderData;
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-12">
        <PageHeader
          title="Recent updates"
          icon={History}
          description="Meetings in the order we finished processing them. Older meetings show up here too when they gain a transcript or their agenda and minutes are reprocessed."
        />
        {loadError ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            Recent updates couldn't be loaded right now. Please try again shortly.
          </p>
        ) : days.length === 0 ? (
          <p className="text-zinc-600">Nothing has been processed yet.</p>
        ) : (
          <div className="relative space-y-10 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-0.5 before:bg-zinc-200">
            {days.map((group) => (
              <DayGroup key={group.day} group={group} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
