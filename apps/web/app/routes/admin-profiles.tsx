import { hasSourceIntegrityHold } from "~/lib/key-statement-evidence";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/admin-profiles";
import { requireAdmin } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { PageHeader } from "../components/ui/page-header";
import { Badge } from "../components/ui/badge";
import { personPath } from "../lib/people-paths";
import { cn, formatDate } from "../lib/utils";

type Evidence = { text?: string; meeting_id?: number | null; meeting_date?: string; date?: string };
type Highlight = { title?: string; summary?: string; position?: string; evidence?: Evidence[] };

type ProfileRow = {
  person_id: number;
  overview: string | null;
  highlights: Highlight[] | null;
  published_stances: any[] | null;
  approved_at: string | null;
  approved_by: string | null;
  generated_at: string | null;
  draft_overview: string | null;
  draft_highlights: Highlight[] | null;
  draft_generated_at: string | null;
  draft_evidence: { statements?: number; votes?: number } | null;
};

export const meta: Route.MetaFunction = () => [{ title: "Profile review" }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const url = new URL(request.url);
  const selectedId = Number(url.searchParams.get("person")) || null;

  const [{ data: people }, { data: rows }] = await Promise.all([
    supabase.from("people").select("id, name, slug, image_url").eq("is_councillor", true).order("name"),
    supabase
      .from("councillor_highlights")
      .select(
        "person_id, overview, highlights, published_stances, approved_at, approved_by, generated_at, draft_overview, draft_highlights, draft_generated_at, draft_evidence",
      ),
  ]);

  const byPerson = new Map<number, ProfileRow>((rows || []).map((r: any) => [r.person_id, r]));
  let draftStances: any[] = [];
  let keyVoteCount = 0;
  if (selectedId) {
    const [{ data: stances }, { count }] = await Promise.all([
      supabase
        .from("councillor_stances")
        .select("topic, position, position_score, summary, confidence, statement_count, evidence_quotes, generated_at")
        .eq("person_id", selectedId)
        .order("statement_count", { ascending: false }),
      supabase.from("key_votes").select("id", { count: "exact", head: true }).eq("person_id", selectedId),
    ]);
    draftStances = stances || [];
    keyVoteCount = count || 0;
  }

  return {
    people: (people || []).map((p: any) => ({ ...p, profile: byPerson.get(p.id) || null })),
    selectedId,
    draftStances,
    keyVoteCount,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const personId = Number(form.get("person_id"));
  if (!personId) return { error: "Missing person." };

  if (intent === "approve") {
    const { data: row } = await supabase
      .from("councillor_highlights")
      .select("draft_overview, draft_highlights, draft_generated_at")
      .eq("person_id", personId)
      .maybeSingle();
    if (!row?.draft_generated_at) return { error: "There is no draft to approve." };
    const editedOverview = String(form.get("overview") ?? "").trim();
    const { data: stances, error: stanceError } = await supabase
      .from("councillor_stances")
      .select("topic, position, position_score, summary, confidence, statement_count, evidence_quotes, evidence_motion_ids, generated_at")
      .eq("person_id", personId);
    if (stanceError) {
      return { error: "Could not check policy sources. Please retry before publishing." };
    }
    if ((stances || []).some(hasSourceIntegrityHold)) {
      return { error: "Some policy positions use reclassified source evidence. Regenerate those positions before publishing." };
    }
    const { error } = await supabase
      .from("councillor_highlights")
      .update({
        overview: editedOverview || row.draft_overview,
        highlights: row.draft_highlights || [],
        published_stances: stances || [],
        generated_at: row.draft_generated_at,
        approved_at: new Date().toISOString(),
        approved_by: user.email ?? null,
        draft_overview: null,
        draft_highlights: null,
        draft_generated_at: null,
        draft_evidence: null,
      })
      .eq("person_id", personId);
    return error ? { error: error.message } : { ok: "Published." };
  }

  if (intent === "discard") {
    const { error } = await supabase
      .from("councillor_highlights")
      .update({ draft_overview: null, draft_highlights: null, draft_generated_at: null, draft_evidence: null })
      .eq("person_id", personId);
    return error ? { error: error.message } : { ok: "Draft discarded." };
  }

  if (intent === "unpublish") {
    const { error } = await supabase
      .from("councillor_highlights")
      .update({ approved_at: null, approved_by: null })
      .eq("person_id", personId);
    return error ? { error: error.message } : { ok: "Unpublished." };
  }

  return { error: "Unknown action." };
}

function statusOf(profile: ProfileRow | null) {
  if (!profile) return { label: "No draft", variant: "muted" as const };
  const hasDraft = Boolean(profile.draft_generated_at);
  if (hasDraft && !profile.approved_at) return { label: "Draft ready", variant: "warning" as const };
  if (hasDraft) return { label: "New draft", variant: "warning" as const };
  if (profile.approved_at) return { label: "Published", variant: "success" as const };
  return { label: "No draft", variant: "muted" as const };
}

function HighlightList({ items }: { items: Highlight[] | null }) {
  if (!items?.length) return <p className="text-sm text-zinc-500">No highlights.</p>;
  return (
    <ul className="divide-y divide-zinc-100">
      {items.map((h, i) => (
        <li key={i} className="py-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-semibold text-zinc-900">{h.title}</p>
            {h.position && <Badge variant="muted">{h.position}</Badge>}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-zinc-600">{h.summary}</p>
          {!!h.evidence?.length && (
            <ul className="mt-2 space-y-1.5">
              {h.evidence.map((e, j) => (
                <li key={j} className="border-l-2 border-zinc-200 pl-3 text-xs text-zinc-600">
                  “{e.text}”{" "}
                  {e.meeting_id ? (
                    <Link to={`/meetings/${e.meeting_id}`} target="_blank" className="font-medium text-brand-700 hover:underline">
                      {formatDate(e.meeting_date || e.date || "") || "meeting"}
                    </Link>
                  ) : (
                    <span className="text-zinc-400">{e.meeting_date || e.date || "no meeting link"}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function AdminProfiles({ loaderData, actionData }: Route.ComponentProps) {
  const { people, selectedId, draftStances, keyVoteCount } = loaderData;
  const [params] = useSearchParams();
  const busy = useNavigation().state !== "idle";
  const selected = people.find((p: any) => p.id === selectedId) || null;
  const profile: ProfileRow | null = selected?.profile ?? null;
  const sourceHeld = draftStances.some(hasSourceIntegrityHold);
  const pending = people.filter((p: any) => p.profile?.draft_generated_at).length;

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 pt-6 pb-12 md:pt-10">
        <PageHeader
          title="Profile review"
          description="AI-drafted councillor overviews and policy positions. Nothing is public until you approve it; the published version stays live while a newer draft waits."
        />

        {actionData && "error" in actionData && actionData.error && (
          <p className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{actionData.error}</p>
        )}
        {actionData && "ok" in actionData && actionData.ok && (
          <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{actionData.ok}</p>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <aside className="lg:col-span-4">
            <div className="rounded-2xl border border-zinc-200 bg-surface shadow-sm">
              <p className="border-b border-zinc-100 px-4 py-3 text-sm text-zinc-500">
                <span className="font-semibold text-zinc-900">{pending}</span> awaiting review
              </p>
              <ul className="divide-y divide-zinc-100">
                {people.map((p: any) => {
                  const st = statusOf(p.profile);
                  const active = p.id === selectedId;
                  const next = new URLSearchParams(params);
                  next.set("person", String(p.id));
                  return (
                    <li key={p.id}>
                      <Link
                        to={`?${next}`}
                        className={cn(
                          "flex items-center justify-between gap-3 border-l-2 px-4 py-3 text-sm hover:bg-zinc-50",
                          active ? "border-l-brand-600 bg-brand-50/60" : "border-l-transparent",
                        )}
                      >
                        <span className="font-medium text-zinc-900">{p.name}</span>
                        <Badge variant={st.variant}>{st.label}</Badge>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </aside>

          <section className="space-y-6 lg:col-span-8">
            {!selected ? (
              <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                Choose a councillor to review their draft.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h2 className="text-xl font-bold tracking-tight text-zinc-900">{selected.name}</h2>
                  <Link to={personPath(selected)} target="_blank" className="text-sm font-semibold text-brand-700 hover:text-brand-800">
                    View public profile
                  </Link>
                </div>
                <p className="text-sm text-zinc-500">
                  {profile?.draft_generated_at ? `Draft generated ${formatDate(profile.draft_generated_at.slice(0, 10))}` : "No draft yet"}
                  {profile?.draft_evidence ? ` · from ${profile.draft_evidence.statements ?? 0} statements and ${profile.draft_evidence.votes ?? 0} votes` : ""}
                  {profile?.approved_at ? ` · Published ${formatDate(profile.approved_at.slice(0, 10))}${profile.approved_by ? ` by ${profile.approved_by}` : ""}` : " · Not published"}
                  {` · ${keyVoteCount} key votes (from the record, not AI)`}
                </p>

                {profile?.draft_generated_at ? (
                  <Form method="post" className="space-y-6">
                    <input type="hidden" name="person_id" value={selected.id} />
                    <div className="rounded-2xl border border-amber-200 bg-surface p-5 shadow-sm">
                      <h3 className="text-sm font-semibold text-zinc-900">Draft overview</h3>
                      <p className="mt-1 text-xs text-zinc-500">Edit before publishing if needed. Check pronouns and that each claim is supported below.</p>
                      <textarea
                        name="overview"
                        defaultValue={profile.draft_overview ?? ""}
                        rows={5}
                        className="mt-3 w-full rounded-lg border border-zinc-200 p-3 text-sm leading-relaxed focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20"
                      />
                      <h3 className="mt-5 text-sm font-semibold text-zinc-900">Draft highlights</h3>
                      <HighlightList items={profile.draft_highlights} />
                    </div>

                    <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
                      <h3 className="text-sm font-semibold text-zinc-900">Policy positions (published with this approval)</h3>
                      {draftStances.length ? (
                        <ul className="mt-2 divide-y divide-zinc-100">
                          {draftStances.map((s: any) => (
                            <li key={s.topic} className="py-2.5 text-sm">
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-medium text-zinc-900">{s.topic}</span>
                                <span className="text-xs text-zinc-500">
                                  {s.position} · {s.confidence} confidence · {s.statement_count} statements
                                </span>
                              </div>
                              {hasSourceIntegrityHold(s) && <p className="mt-1 text-xs font-medium text-amber-800">Needs regeneration: source evidence was reclassified.</p>}
                              <p className="mt-0.5 text-zinc-600">{s.summary}</p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm text-zinc-500">No positions generated.</p>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="submit"
                        name="intent"
                        value="approve"
                        disabled={busy || sourceHeld}
                        className="rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                      >
                        Approve and publish
                      </button>
                      <button
                        type="submit"
                        name="intent"
                        value="discard"
                        disabled={busy}
                        className="rounded-full border border-zinc-200 bg-surface px-4 py-2 text-sm font-semibold text-zinc-700 hover:border-zinc-300 disabled:opacity-50"
                      >
                        Discard draft
                      </button>
                    </div>
                  </Form>
                ) : (
                  <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                    No draft waiting. Drafts are generated after each new meeting for councillors with enough
                    recorded statements (20+ across 5+ meetings).
                  </div>
                )}

                {profile?.approved_at && (
                  <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold text-zinc-900">Currently published</h3>
                      <Form method="post">
                        <input type="hidden" name="person_id" value={selected.id} />
                        <button
                          type="submit"
                          name="intent"
                          value="unpublish"
                          disabled={busy}
                          className="text-sm font-semibold text-red-700 hover:text-red-800 disabled:opacity-50"
                        >
                          Unpublish
                        </button>
                      </Form>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-700">{profile.overview}</p>
                    <HighlightList items={profile.highlights} />
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
