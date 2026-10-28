import { Fragment, type ReactNode } from "react";
import { Form, Link, useNavigation } from "react-router";
import { matterPath } from "../lib/paths";
import type { Route } from "./+types/admin-matters";
import { requireAdmin } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Button } from "../components/ui/button";
import { DetailHeader } from "../components/ui/detail-header";
import { displayTitle, matterTitle } from "../lib/display-text";
import { cn, formatDate } from "../lib/utils";
import {
  canonicalMatterId,
  currentMatterIds,
  openPairDecisions,
  planMerge,
  signalLabels,
  type MatterMergeRow,
  type MergeDecision,
} from "../lib/matter-merge";

export const meta: Route.MetaFunction = () => [{ title: "Matter merge review" }];

const MERGE_ROW_FIELDS = "id, first_seen, last_seen, meta";

/** Loads the given matters plus whatever they're aliased to, so proposals resolve to today's matters. */
async function loadMergeRows(supabase: ReturnType<typeof getSupabaseAdminClient>, ids: number[]) {
  const byId = new Map<number, MatterMergeRow>();
  let pending = [...new Set(ids)];
  for (let hop = 0; hop < 5 && pending.length > 0; hop++) {
    const { data, error } = await supabase.from("matters").select(MERGE_ROW_FIELDS).in("id", pending);
    if (error) throw error;
    for (const row of data || []) byId.set(row.id, row as MatterMergeRow);
    pending = [
      ...new Set(
        (data || [])
          .map((row: any) => Number(row.meta?.canonical_matter_id))
          .filter((id) => id && !byId.has(id)),
      ),
    ];
  }
  return byId;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return loadMergeQueue(getSupabaseAdminClient());
}

export async function loadMergeQueue(supabase: ReturnType<typeof getSupabaseAdminClient>) {
  const [{ data: proposals, error }, { count: decided }] = await Promise.all([
    supabase
      .from("matter_merge_proposals")
      .select("id, matter_ids, decisions, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase
      .from("matter_merge_proposals")
      .select("id", { count: "exact", head: true })
      .neq("status", "pending"),
  ]);
  if (error) throw error;

  // Only show proposals that still have two or more separate, visible matters to merge.
  const byId = await loadMergeRows(supabase, (proposals || []).flatMap((p: any) => p.matter_ids as number[]));
  const open = (proposals || [])
    .map((p: any) => ({ ...p, current_ids: currentMatterIds(p.matter_ids, byId) }))
    .filter((p) => p.current_ids.length >= 2);

  const ids = [...new Set(open.flatMap((p) => p.current_ids))];
  // History includes agenda items filed under matters already merged into these.
  const historyIds = [
    ...new Set([...ids, ...ids.flatMap((id) => (byId.get(id)?.meta?.merged_matter_ids as number[]) || [])]),
  ];
  const [{ data: matters, error: mattersError }, { data: items, error: itemsError }] = ids.length
    ? await Promise.all([
        supabase
          .from("matters")
          .select("id, slug, title, identifier, category, first_seen, last_seen, meta, plain_english_summary")
          .in("id", ids),
        supabase
          .from("agenda_items")
          .select("id, matter_id, title, related_address, meetings(meeting_date)")
          .in("matter_id", historyIds),
      ])
    : [{ data: [] as any[], error: null }, { data: [] as any[], error: null }];
  if (mattersError) throw mattersError;
  if (itemsError) throw itemsError;

  const display = new Map((matters || []).map((m: any) => [m.id, m]));
  const historyByMatter = new Map<number, any[]>();
  for (const item of items || []) {
    const owner = canonicalMatterId(item.matter_id, byId);
    const matter = display.get(owner);
    const date = (item as any).meetings?.meeting_date;
    if (!matter || !date) continue;
    const addresses = parseAddresses(item.related_address);
    historyByMatter.set(owner, [
      ...(historyByMatter.get(owner) || []),
      {
        id: item.id,
        date,
        text: matter.meta?.timeline_headlines?.[String(item.id)] || displayTitle(item.title),
        addresses,
      },
    ]);
  }

  return {
    decided: decided || 0,
    proposals: open.map((p) => {
      const pairs = openPairDecisions(p.decisions as MergeDecision[], p.current_ids, byId);
      const proposalMatters = p.current_ids
        .map((id: number) => display.get(id))
        .filter(Boolean)
        .sort(
          (x: any, y: any) =>
            String(x.first_seen || "9999").localeCompare(String(y.first_seen || "9999")) || x.id - y.id,
        )
        .map((m: any) => ({
          id: m.id,
          slug: m.slug,
          title: matterTitle(m),
          identifier: m.identifier,
          category: m.category,
          first_seen: m.first_seen,
          last_seen: m.last_seen,
          status_line: m.meta?.status_line ?? null,
          summary: m.plain_english_summary,
          history: (historyByMatter.get(m.id) || []).sort(
            (x, y) => x.date.localeCompare(y.date) || x.id - y.id,
          ),
        }));
      return {
        id: p.id,
        pairs,
        reasons: signalLabels(pairs),
        sharedAddresses: sharedAddresses(proposalMatters.map((m: any) => m.history)),
        matters: proposalMatters,
      };
    }),
  };
}

/** related_address is stored as an array, a JSON-encoded array, or a plain string. */
function parseAddresses(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((a): a is string => typeof a === "string" && a.trim() !== "");
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return parseAddresses(JSON.parse(value));
  } catch {
    return [value];
  }
}

/** Addresses every matter in the proposal mentions, as written in the first one. */
function sharedAddresses(histories: { addresses: string[] }[][]) {
  const normalize = (a: string) =>
    a.toLowerCase().replace(/\broad\b/g, "rd").replace(/\bstreet\b/g, "st").replace(/\s+/g, " ").trim();
  const sets = histories.map((h) => new Map(h.flatMap((i) => i.addresses).map((a) => [normalize(a), a])));
  if (sets.length === 0) return [];
  return [...sets[0].entries()].filter(([key]) => sets.every((s) => s.has(key))).map(([, label]) => label);
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const form = await request.formData();
  const id = Number(form.get("proposal_id"));
  const intent = String(form.get("intent"));
  if (!id) return { error: "Missing proposal." };

  const { data: proposal } = await supabase
    .from("matter_merge_proposals")
    .select("id, matter_ids, status")
    .eq("id", id)
    .maybeSingle();
  if (!proposal || proposal.status !== "pending") return { error: "That proposal was already decided." };

  if (intent === "merge") {
    const byId = await loadMergeRows(supabase, proposal.matter_ids);
    const currentIds = currentMatterIds(proposal.matter_ids, byId);
    if (currentIds.length < 2) {
      // Already combined (or the rest are hidden): close it so it leaves the queue.
      await supabase
        .from("matter_merge_proposals")
        .update({ status: "approved", decided_at: new Date().toISOString(), decided_by: user.email ?? null })
        .eq("id", id);
      return { ok: "Nothing left to merge: these matters were already combined." };
    }
    const plan = planMerge(currentIds.map((matterId) => byId.get(matterId)!));
    const { data: repointRows, error: repointError } = plan.repointIds.length
      ? await supabase.from("matters").select("id, meta").in("id", plan.repointIds)
      : { data: [] as any[], error: null };
    if (repointError) return { error: repointError.message };

    const updates = [
      supabase
        .from("matters")
        .update({
          meta: { ...(plan.canonical.meta || {}), merged_matter_ids: plan.mergedIds },
          last_seen: plan.lastSeen,
        })
        .eq("id", plan.canonical.id),
      ...plan.aliases.map((a) => {
        const { merged_matter_ids: _absorbed, ...meta } = a.meta || {};
        return supabase
          .from("matters")
          .update({ meta: { ...meta, canonical_matter_id: plan.canonical.id, merge_reason: "admin-review" } })
          .eq("id", a.id);
      }),
      // Earlier aliases of an absorbed matter point straight at the new canonical.
      ...(repointRows || []).map((r: any) =>
        supabase
          .from("matters")
          .update({ meta: { ...(r.meta || {}), canonical_matter_id: plan.canonical.id } })
          .eq("id", r.id),
      ),
    ];
    for (const res of await Promise.all(updates)) {
      if (res.error) return { error: res.error.message };
    }
  } else if (intent !== "reject") {
    return { error: "Unknown action." };
  }

  if (intent === "merge") {
    // The matters list is served from computed_cache; drop it so the merge shows up now.
    await supabase.from("computed_cache").delete().eq("key", "matters-list");
  }
  const { error } = await supabase
    .from("matter_merge_proposals")
    .update({
      status: intent === "merge" ? "approved" : "rejected",
      decided_at: new Date().toISOString(),
      decided_by: user.email ?? null,
    })
    .eq("id", id);
  return error ? { error: error.message } : { ok: intent === "merge" ? "Merged." : "Kept separate." };
}

const VERDICTS = [
  ["same_matter", "Same matter", "One application, permit or bylaw at different stages."],
  ["same_project", "Same project", "Separate approvals residents see as one application, e.g. an OCP amendment and its rezoning."],
  ["different", "Different", "Separate applications, even for the same property."],
] as const;

const LETTERS = ["A", "B", "C", "D", "E"];
const LETTER_TONES = [
  "bg-brand-50 text-brand-800 ring-brand-200",
  "bg-amber-50 text-amber-800 ring-amber-200",
  "bg-violet-50 text-violet-800 ring-violet-200",
  "bg-sky-50 text-sky-800 ring-sky-200",
  "bg-rose-50 text-rose-800 ring-rose-200",
];

function Letter({ index }: { index: number }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ring-1",
        LETTER_TONES[index % LETTER_TONES.length],
      )}
      aria-hidden="true"
    >
      {LETTERS[index] ?? index + 1}
    </span>
  );
}

const shortDate = { month: "short", day: "numeric", year: "numeric" } as const;
const monthYear = { month: "short", year: "numeric" } as const;

function activeSpan(m: any) {
  const count = m.history.length;
  const first = m.history[0]?.date ?? m.first_seen;
  const last = m.history.at(-1)?.date ?? m.last_seen;
  const span =
    first && last && first.slice(0, 7) !== last.slice(0, 7)
      ? `${formatDate(first, monthYear)} – ${formatDate(last, monthYear)}`
      : first
        ? formatDate(first, monthYear)
        : "No dates";
  return `${span} · ${count} ${count === 1 ? "item" : "items"}`;
}

function gapLabel(from: string, to: string) {
  const months =
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
  if (months < 12) return null;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return `${years} year${years === 1 ? "" : "s"}${rest ? ` ${rest} month${rest === 1 ? "" : "s"}` : ""} later`;
}

function VerdictSplit({ pair }: { pair: MergeDecision }) {
  const probabilities = pair.probabilities;
  if (!probabilities) {
    const label = VERDICTS.find(([key]) => key === pair.verdict)?.[1] ?? pair.verdict;
    return (
      <span>
        <span className="font-medium text-zinc-900">{label}</span>
        <span className="tabular-nums"> {Math.round(pair.confidence * 100)}%</span>
      </span>
    );
  }
  const leading = VERDICTS.reduce((best, [key]) =>
    (probabilities[key] ?? 0) > (probabilities[best] ?? 0) ? key : best,
  VERDICTS[0][0] as string);
  return (
    <span className="tabular-nums">
      {VERDICTS.map(([key, label], i) => (
        <span key={key}>
          {i > 0 && <span className="text-zinc-300"> · </span>}
          <span className={key === leading ? "font-medium text-zinc-900" : undefined}>
            {label} {Math.round((probabilities[key] ?? 0) * 100)}%
          </span>
        </span>
      ))}
    </span>
  );
}

function CompareRow({
  label,
  columns,
  children,
}: {
  label: string;
  columns: number;
  children: ReactNode[];
}) {
  return (
    <div
      className="grid gap-x-6 border-t border-zinc-100 px-5 py-2.5 text-sm"
      style={{ gridTemplateColumns: `96px repeat(${columns}, minmax(0, 1fr))` }}
    >
      <div className="text-zinc-500">{label}</div>
      {children}
    </div>
  );
}

function ProposalCard({ proposal, busy }: { proposal: any; busy: boolean }) {
  const matters = proposal.matters as any[];
  const indexById = new Map(matters.map((m, i) => [m.id, i]));
  const columns = matters.length;
  const timeline = matters
    .flatMap((m, i) => m.history.map((item: any) => ({ ...item, index: i })))
    .sort((x: any, y: any) => x.date.localeCompare(y.date) || x.index - y.index);
  const reasons = (proposal.reasons as string[]).map((reason) =>
    reason === "Same address" && proposal.sharedAddresses.length
      ? `Same address: ${proposal.sharedAddresses.join(", ")}`
      : reason,
  );
  const [canonical, ...absorbed] = matters;

  return (
    <li className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 bg-zinc-50/70 px-5 py-3 text-sm">
        <p className="text-zinc-700">
          <span className="text-zinc-500">Proposed because </span>
          {reasons.length ? reasons.join(" · ") : "the model linked them"}
        </p>
        <div className="space-y-0.5 text-right text-zinc-500">
          {(proposal.pairs as MergeDecision[]).map((pair) => (
            <p key={`${pair.a}-${pair.b}`} className="flex items-center justify-end gap-1.5">
              {columns > 2 &&
                [indexById.get(pair.a) ?? 0, indexById.get(pair.b) ?? 1]
                  .sort((x, y) => x - y)
                  .map((index) => <Letter key={index} index={index} />)}
              <span>Model:</span>
              <VerdictSplit pair={pair} />
            </p>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div
            className="grid gap-x-6 px-5 pb-2 pt-4"
            style={{ gridTemplateColumns: `96px repeat(${columns}, minmax(0, 1fr))` }}
          >
            <div />
            {matters.map((m, i) => (
              <div key={m.id} className="flex items-start gap-2">
                <Letter index={i} />
                <Link
                  to={matterPath(m)}
                  target="_blank"
                  className="font-semibold leading-snug text-zinc-900 hover:text-brand-700 hover:underline"
                >
                  {m.title}
                </Link>
              </div>
            ))}
          </div>
          <CompareRow label="Identifier" columns={columns}>
            {matters.map((m) => (
              <div key={m.id} className={m.identifier ? "text-zinc-900" : "text-zinc-400"}>
                {m.identifier || "None"}
              </div>
            ))}
          </CompareRow>
          <CompareRow label="Type" columns={columns}>
            {matters.map((m) => (
              <div key={m.id} className="text-zinc-700">
                {m.category || "—"}
              </div>
            ))}
          </CompareRow>
          <CompareRow label="Active" columns={columns}>
            {matters.map((m) => (
              <div key={m.id} className="tabular-nums text-zinc-700">
                {activeSpan(m)}
              </div>
            ))}
          </CompareRow>
          <CompareRow label="Status" columns={columns}>
            {matters.map((m) => (
              <div key={m.id} className={m.status_line ? "text-zinc-700" : "text-zinc-400"}>
                {m.status_line || "Not recorded"}
              </div>
            ))}
          </CompareRow>
          <CompareRow label="Summary" columns={columns}>
            {matters.map((m) => (
              <p key={m.id} className="leading-relaxed text-zinc-600">
                {m.summary || <span className="text-zinc-400">No summary</span>}
              </p>
            ))}
          </CompareRow>
        </div>
      </div>

      <div className="border-t border-zinc-100 px-5 py-4">
        <h3 className="mb-2 text-sm font-medium text-zinc-500">Combined timeline</h3>
        {timeline.length === 0 ? (
          <p className="text-sm text-zinc-400">No dated agenda items.</p>
        ) : (
          <ol className="space-y-1.5 text-sm">
            {timeline.map((item: any, i: number) => {
              const gap = i > 0 ? gapLabel(timeline[i - 1].date, item.date) : null;
              return (
                <Fragment key={item.id}>
                  {gap && (
                    <li className="py-1 pl-[124px] text-xs italic text-zinc-400" aria-label={gap}>
                      {gap}
                    </li>
                  )}
                  <li className="grid grid-cols-[20px_96px_minmax(0,1fr)] items-baseline gap-x-2">
                    <Letter index={item.index} />
                    <span className="tabular-nums text-zinc-500">{formatDate(item.date, shortDate)}</span>
                    <span className="text-zinc-800">{item.text}</span>
                  </li>
                </Fragment>
              );
            })}
          </ol>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-5 py-3">
        <p className="text-sm text-zinc-500">
          Merging keeps <span className="font-medium text-zinc-800">{canonical.title}</span> as the main
          record; {absorbed.map((m) => m.title).join(" and ")} {absorbed.length === 1 ? "becomes" : "become"}{" "}
          part of its history.
        </p>
        <Form method="post" className="flex gap-2">
          <input type="hidden" name="proposal_id" value={proposal.id} />
          <Button type="submit" name="intent" value="reject" variant="outline" disabled={busy}>
            Keep separate
          </Button>
          <Button type="submit" name="intent" value="merge" disabled={busy}>
            Merge
          </Button>
        </Form>
      </div>
    </li>
  );
}

export default function AdminMatters({ loaderData, actionData }: Route.ComponentProps) {
  const { proposals, decided } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 py-12">
        <DetailHeader
          back={{ to: "/admin", label: "Admin" }}
          meta={[
            <span key="count" className="tabular-nums">
              {proposals.length} awaiting review
              {decided > 0 ? ` · ${decided} decided` : ""}
            </span>,
          ]}
          title="Matter merge review"
          description="Possible duplicates the resolver wasn't sure about. Merging is reversible: the later matters become aliases of the earliest, and their history shows on its page."
        />

        <dl className="mb-8 grid gap-x-6 gap-y-2 rounded-2xl border border-zinc-200 bg-surface px-5 py-4 text-sm sm:grid-cols-3">
          {VERDICTS.map(([key, label, meaning]) => (
            <div key={key}>
              <dt className="font-medium text-zinc-900">{label}</dt>
              <dd className="text-zinc-500">{meaning}</dd>
            </div>
          ))}
        </dl>

        {actionData && "error" in actionData && actionData.error && (
          <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {actionData.error}
          </p>
        )}
        {actionData && "ok" in actionData && actionData.ok && (
          <p role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {actionData.ok}
          </p>
        )}

        {proposals.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing to review.</p>
        ) : (
          <ul className="space-y-6">
            {proposals.map((p: any) => (
              <ProposalCard key={p.id} proposal={p} busy={busy} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
