import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin-names";
import { requireAdmin } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Button } from "../components/ui/button";
import { DetailHeader } from "../components/ui/detail-header";
import { Input } from "../components/ui/input";
import { meetingPath } from "../lib/paths";
import { formatDate } from "../lib/utils";
import { applyNameDecision, suggestedSpellings, type Participation } from "../lib/public-names";

export const meta: Route.MetaFunction = () => [
  { title: "Speaker names | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];

type NameRow = {
  id: number;
  meeting_id: number;
  agenda_item_id: number;
  name_key: string;
  transcribed_name: string;
  conflict: { near?: { name: string; source: string }[] };
  start_time: number | null;
  created_at: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return loadNameQueue(getSupabaseAdminClient());
}

export async function loadNameQueue(supabase: ReturnType<typeof getSupabaseAdminClient>) {
  const [{ data: rows, error }, { count: decided }] = await Promise.all([
    supabase
      .from("public_speaker_names")
      .select("id, meeting_id, agenda_item_id, name_key, transcribed_name, conflict, start_time, created_at")
      .eq("status", "review")
      .is("decided_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("public_speaker_names")
      .select("id", { count: "exact", head: true })
      .not("decided_at", "is", null),
  ]);
  if (error) throw error;

  const itemIds = [...new Set((rows || []).map((r) => r.agenda_item_id))];
  const { data: items, error: itemsError } = itemIds.length
    ? await supabase
        .from("agenda_items")
        .select("id, title, meta, meetings(id, slug, title, meeting_date)")
        .in("id", itemIds)
    : { data: [] as any[], error: null };
  if (itemsError) throw itemsError;
  const itemById = new Map((items || []).map((i: any) => [i.id, i]));

  // One card per introduced name; the same spelling may be held in several items.
  const byKey = new Map<string, NameRow[]>();
  for (const row of (rows || []) as NameRow[]) byKey.set(row.name_key, [...(byKey.get(row.name_key) || []), row]);

  return {
    decided: decided || 0,
    names: [...byKey.entries()].map(([key, group]) => {
      const near = group.flatMap((r) => r.conflict?.near || []);
      const sources = new Map<string, string>();
      for (const n of near) sources.set(n.name, n.source);
      return {
        key,
        transcribed: group[0].transcribed_name,
        near: [...sources.entries()].map(([name, source]) => ({ name, source })),
        options: suggestedSpellings(group[0].transcribed_name, near),
        occurrences: group.map((r) => {
          const item: any = itemById.get(r.agenda_item_id);
          const speaker = (item?.meta?.participation?.speakers || []).find((s: any) => s.name_ref === key);
          return {
            id: r.id,
            itemTitle: item?.title ?? "Agenda item",
            meeting: item?.meetings ?? null,
            startTime: r.start_time,
            point: speaker?.point ?? null,
            topic: speaker?.topic ?? null,
          };
        }),
      };
    }),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const form = await request.formData();
  const key = String(form.get("name_key") || "");
  const intent = String(form.get("intent") || "");
  const choice = String(form.get("spelling") || "");
  const custom = String(form.get("custom") || "").trim().replace(/\s+/g, " ");
  if (!key) return { error: "Missing name." };
  if (intent !== "publish" && intent !== "anonymous") return { error: "Unknown action." };

  const shown = intent === "publish" ? (choice === "__custom" ? custom : choice) : null;
  if (intent === "publish" && (!shown || shown.split(" ").length < 2)) {
    return { error: "Enter a first and last name, or keep the speaker anonymous." };
  }

  const { data: rows, error } = await supabase
    .from("public_speaker_names")
    .select("id, agenda_item_id")
    .eq("name_key", key)
    .eq("status", "review")
    .is("decided_at", null);
  if (error) return { error: error.message };
  if (!rows?.length) return { error: "That name was already decided." };

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("public_speaker_names")
    .update({
      status: intent === "publish" ? "published" : "anonymous",
      display_name: shown,
      basis: "admin",
      decided_by: user.email ?? null,
      decided_at: now,
      updated_at: now,
    })
    .in("id", rows.map((r) => r.id));
  if (updateError) return { error: updateError.message };

  // Rewrite the published summaries that mention this speaker.
  const itemIds = [...new Set(rows.map((r) => r.agenda_item_id))];
  const { data: items, error: itemsError } = await supabase.from("agenda_items").select("id, meta").in("id", itemIds);
  if (itemsError) return { error: itemsError.message };
  for (const item of items || []) {
    const { participation, changed } = applyNameDecision(item.meta?.participation as Participation, key, shown);
    if (!changed) continue;
    const { error: metaError } = await supabase
      .from("agenda_items")
      .update({ meta: { ...(item.meta || {}), participation } })
      .eq("id", item.id);
    if (metaError) return { error: metaError.message };
  }

  return { ok: intent === "publish" ? `Published as ${shown}.` : "Kept anonymous." };
}

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

const SOURCE_LABEL: Record<string, string> = {
  minutes: "in the minutes",
  known: "already on the site",
};

function NameCard({ name, busy }: { name: any; busy: boolean }) {
  const [choice, setChoice] = useState<string>(name.options[0]);
  return (
    <li className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="px-5 pt-4">
        <p className="text-sm text-zinc-500">Heard on the recording</p>
        <h2 className="text-xl font-semibold text-zinc-900">{name.transcribed}</h2>
        {name.near.length > 0 && (
          <p className="mt-1 text-sm text-zinc-600">
            Close to{" "}
            {name.near.map((n: any, i: number) => (
              <span key={n.name}>
                {i > 0 && ", "}
                <span className="font-medium text-zinc-900">{n.name}</span>{" "}
                <span className="text-zinc-500">({SOURCE_LABEL[n.source] ?? n.source})</span>
              </span>
            ))}
          </p>
        )}
      </div>

      <ul className="mt-3 divide-y divide-zinc-100 border-t border-zinc-100">
        {name.occurrences.map((o: any) => (
          <li key={o.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
            <div className="min-w-0">
              <p className="text-zinc-500">
                {o.meeting ? (
                  <>
                    {o.meeting.title} · {formatDate(o.meeting.meeting_date, { month: "short", day: "numeric", year: "numeric" })}
                  </>
                ) : (
                  "Meeting"
                )}{" "}
                · {o.itemTitle}
              </p>
              {o.point && <p className="mt-0.5 text-zinc-800">{o.point}</p>}
            </div>
            {o.meeting && o.startTime != null && (
              <Link
                to={meetingPath(o.meeting, `?t=${Math.floor(o.startTime)}`)}
                target="_blank"
                className="shrink-0 font-medium text-brand-700 hover:underline"
              >
                Listen at {clock(o.startTime)}
              </Link>
            )}
          </li>
        ))}
      </ul>

      <Form method="post" className="border-t border-zinc-100 px-5 py-4">
        <input type="hidden" name="name_key" value={name.key} />
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-zinc-700">Publish as</legend>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {name.options.map((option: string) => (
              <label key={option} className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="spelling"
                  value={option}
                  checked={choice === option}
                  onChange={() => setChoice(option)}
                  className="accent-brand-600"
                />
                {option}
              </label>
            ))}
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="spelling"
                value="__custom"
                checked={choice === "__custom"}
                onChange={() => setChoice("__custom")}
                className="accent-brand-600"
              />
              Other
            </label>
            {choice === "__custom" && (
              <Input name="custom" placeholder="First and last name" className="h-8 w-56" autoFocus />
            )}
          </div>
        </fieldset>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="submit" name="intent" value="anonymous" variant="outline" disabled={busy}>
            Keep anonymous
          </Button>
          <Button type="submit" name="intent" value="publish" disabled={busy}>
            Publish name
          </Button>
        </div>
      </Form>
    </li>
  );
}

export default function AdminNames({ loaderData, actionData }: Route.ComponentProps) {
  const { names, decided } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-12">
        <DetailHeader
          back={{ to: "/admin", label: "Admin" }}
          meta={[
            <span key="count" className="tabular-nums">
              {names.length} to review{decided > 0 ? ` · ${decided} decided` : ""}
            </span>,
          ]}
          title="Speaker names"
          description="Residents who introduced themselves on the recording with a name close to, but not the same as, one in the minutes or already on the site. Names that match cleanly publish on their own; these wait for you. Until then they show as “A resident”."
        />

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

        {names.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing to review.</p>
        ) : (
          <ul className="space-y-6">
            {names.map((name: any) => (
              <NameCard key={name.key} name={name} busy={busy} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
