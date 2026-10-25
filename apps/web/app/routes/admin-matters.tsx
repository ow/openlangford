import { Form, Link, useNavigation } from "react-router";
import { matterPath } from "../lib/paths";
import type { Route } from "./+types/admin-matters";
import { requireAdmin } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { PageHeader } from "../components/ui/page-header";
import { Badge } from "../components/ui/badge";
import { matterTitle } from "../lib/display-text";
import { formatDate } from "../lib/utils";
import { currentMatterIds, planMerge, type MatterMergeRow } from "../lib/matter-merge";

type Decision = {
  a: number;
  b: number;
  verdict: "same_matter" | "same_project" | "different";
  confidence: number;
  probabilities?: Record<string, number>;
};

const VERDICT_LABEL: Record<string, string> = {
  same_matter: "Same matter",
  same_project: "Same project",
  different: "Different",
};

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
  const { data: matters } = ids.length
    ? await supabase
        .from("matters")
        .select(
          "id, slug, title, identifier, first_seen, last_seen, meta, plain_english_summary, agenda_items(id, title, meetings(slug, meeting_date))",
        )
        .in("id", ids)
    : { data: [] as any[] };
  const display = new Map((matters || []).map((m: any) => [m.id, m]));

  return {
    decided: decided || 0,
    proposals: open.map((p) => ({
      ...p,
      matters: p.current_ids
        .map((id: number) => display.get(id))
        .filter(Boolean)
        .sort((x: any, y: any) => String(x.first_seen).localeCompare(String(y.first_seen))),
    })),
  };
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

function bestDecision(decisions: Decision[]): Decision | null {
  const same = decisions.filter((d) => d.verdict !== "different");
  return (same.length ? same : decisions).sort((a, b) => b.confidence - a.confidence)[0] || null;
}

export default function AdminMatters({ loaderData, actionData }: Route.ComponentProps) {
  const { proposals, decided } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 py-12">
        <PageHeader
          title="Matter merge review"
          description="Possible duplicates the resolver wasn't sure about. Merging keeps every record: the later matters become aliases of the earliest one and their history shows on its page."
        />

        {actionData && "error" in actionData && actionData.error && (
          <p className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{actionData.error}</p>
        )}
        {actionData && "ok" in actionData && actionData.ok && (
          <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{actionData.ok}</p>
        )}

        <p className="mb-4 text-sm text-zinc-500">
          <span className="font-semibold text-zinc-900">{proposals.length}</span> awaiting review
          {decided > 0 && <> · {decided} decided</>}
        </p>

        {proposals.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-5 text-sm text-zinc-500">
            Nothing to review.
          </div>
        ) : (
          <ul className="space-y-4">
            {proposals.map((p: any) => {
              const top = bestDecision(p.decisions as Decision[]);
              return (
                <li key={p.id} className="rounded-2xl border border-zinc-200 bg-white shadow-sm">
                  <div className="grid gap-px overflow-hidden rounded-t-2xl bg-zinc-100 md:grid-cols-2 lg:grid-flow-col lg:auto-cols-fr lg:grid-cols-none">
                    {p.matters.map((m: any) => {
                      const items = [...(m.agenda_items || [])]
                        .sort((x: any, y: any) =>
                          String(x.meetings?.meeting_date).localeCompare(String(y.meetings?.meeting_date)),
                        )
                        .slice(-3);
                      return (
                        <div key={m.id} className="bg-white p-4">
                          <Link
                            to={matterPath(m)}
                            target="_blank"
                            className="text-sm font-semibold leading-snug text-zinc-900 hover:text-brand-700"
                          >
                            {matterTitle(m)}
                          </Link>
                          <p className="mt-1 text-xs text-zinc-500 tabular-nums">
                            {[m.identifier, m.first_seen && formatDate(m.first_seen), m.last_seen !== m.first_seen && m.last_seen && formatDate(m.last_seen)]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                          {m.plain_english_summary && (
                            <p className="mt-2 text-sm leading-relaxed text-zinc-600 line-clamp-3">{m.plain_english_summary}</p>
                          )}
                          {items.length > 0 && (
                            <ul className="mt-3 space-y-1 border-t border-zinc-100 pt-2">
                              {items.map((it: any) => (
                                <li key={it.id} className="text-xs leading-snug text-zinc-500">
                                  <span className="tabular-nums text-zinc-400">{it.meetings?.meeting_date}</span> {it.title}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-4 py-3">
                    <p className="text-xs text-zinc-500">
                      {top ? (
                        <>
                          Model says <Badge variant={top.verdict === "different" ? "muted" : "brand"}>{VERDICT_LABEL[top.verdict]}</Badge>{" "}
                          <span className="tabular-nums">{Math.round(top.confidence * 100)}%</span>
                        </>
                      ) : (
                        "No model verdict"
                      )}
                    </p>
                    <Form method="post" className="flex gap-2">
                      <input type="hidden" name="proposal_id" value={p.id} />
                      <button
                        name="intent"
                        value="reject"
                        disabled={busy}
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        Keep separate
                      </button>
                      <button
                        name="intent"
                        value="merge"
                        disabled={busy}
                        className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                      >
                        Merge
                      </button>
                    </Form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
