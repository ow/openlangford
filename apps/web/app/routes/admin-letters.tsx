import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin-letters";
import { requireAdmin } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Button } from "../components/ui/button";
import { DetailHeader } from "../components/ui/detail-header";
import { NativeSelect } from "../components/ui/native-select";
import { displayTitle } from "../lib/display-text";
import { documentPath, meetingPath } from "../lib/paths";
import { formatDate } from "../lib/utils";
import { placeHeldLetter, type UnplacedDocument } from "../lib/written";

export const meta: Route.MetaFunction = () => [
  { title: "Letter placement | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return loadLetterQueue(getSupabaseAdminClient());
}

export async function loadLetterQueue(supabase: ReturnType<typeof getSupabaseAdminClient>) {
  const { data: meetings, error } = await supabase
    .from("meetings")
    .select("id, slug, title, meeting_date, meta")
    .not("meta->written_unplaced", "is", null)
    .order("meeting_date", { ascending: false });
  if (error) throw error;

  const meetingIds = (meetings || []).map((m) => m.id);
  const { data: items, error: itemsError } = meetingIds.length
    ? await supabase.from("agenda_items").select("id, meeting_id, item_order, title").in("meeting_id", meetingIds).order("item_order")
    : { data: [] as any[], error: null };
  if (itemsError) throw itemsError;

  const letters = (meetings || []).flatMap((meeting) =>
    Object.entries((meeting.meta?.written_unplaced || {}) as Record<string, UnplacedDocument>).flatMap(([extractedId, doc]) =>
      doc.letters.map((letter) => ({
        meeting: { id: meeting.id, slug: meeting.slug, title: meeting.title, meeting_date: meeting.meeting_date },
        extractedId,
        documentId: doc.document_id,
        documentTitle: doc.title,
        letter,
        items: (items || [])
          .filter((it) => it.meeting_id === meeting.id)
          .map((it) => ({ id: it.id, label: `${it.item_order ? `${it.item_order} ` : ""}${displayTitle(it.title)}` })),
      })),
    ),
  );
  return { letters };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const form = await request.formData();
  const meetingId = Number(form.get("meeting_id"));
  const extractedId = String(form.get("extracted_id") || "");
  const key = String(form.get("key") || "");
  const intent = String(form.get("intent") || "");
  const choice = String(form.get("item") || "");
  const other = String(form.get("other_item") || "");
  const itemId = intent === "dismiss" ? null : Number(choice === "__other" ? other : choice);
  if (!meetingId || !extractedId || !key) return { error: "Missing letter." };
  if (intent !== "dismiss" && !itemId) return { error: "Choose an agenda item, or mark it as not about any item." };

  const [{ data: meeting, error: meetingError }, { data: item, error: itemError }] = await Promise.all([
    supabase.from("meetings").select("id, meta").eq("id", meetingId).single(),
    itemId
      ? supabase.from("agenda_items").select("id, meeting_id, meta").eq("id", itemId).single()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (meetingError) return { error: meetingError.message };
  if (itemError) return { error: itemError.message };
  if (item && item.meeting_id !== meetingId) return { error: "That item belongs to another meeting." };

  const placed = placeHeldLetter(meeting.meta, item?.meta ?? null, extractedId, key, itemId);
  if (!placed) return { error: "That letter was already placed." };

  if (item && placed.itemMeta) {
    const { error } = await supabase.from("agenda_items").update({ meta: placed.itemMeta }).eq("id", item.id);
    if (error) return { error: error.message };
  }
  const { error } = await supabase.from("meetings").update({ meta: placed.meetingMeta }).eq("id", meetingId);
  if (error) return { error: error.message };
  return { ok: itemId ? "Letter placed." : "Letter left off the meeting page." };
}

function LetterCard({ entry, busy }: { entry: any; busy: boolean }) {
  const { letter, meeting } = entry;
  const [choice, setChoice] = useState<string>(letter.candidates[0] ? String(letter.candidates[0].item_id) : "__other");
  return (
    <li className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="px-5 pt-4">
        <p className="text-sm text-zinc-500">
          <Link to={meetingPath(meeting)} className="hover:text-brand-700 hover:underline">
            {meeting.title} · {formatDate(meeting.meeting_date, { month: "short", day: "numeric", year: "numeric" })}
          </Link>
          {" · "}
          <Link to={documentPath(meeting, entry.documentId)} target="_blank" className="hover:text-brand-700 hover:underline">
            {entry.documentTitle || "Letters"}
          </Link>
        </p>
        <p className="mt-2 text-sm leading-relaxed text-zinc-700">
          <span className="font-medium text-zinc-900">{letter.who}</span>
          <span className="text-zinc-400"> · {letter.topic}</span>
          {letter.sent && <span className="text-zinc-400"> · {letter.sent}</span>}
          <br />
          {letter.point}
        </p>
      </div>

      <Form method="post" className="mt-3 border-t border-zinc-100 px-5 py-4">
        <input type="hidden" name="meeting_id" value={meeting.id} />
        <input type="hidden" name="extracted_id" value={entry.extractedId} />
        <input type="hidden" name="key" value={letter.key} />
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-zinc-700">Which agenda item is this letter about?</legend>
          <div className="space-y-1.5 text-sm">
            {letter.candidates.map((c: any) => (
              <label key={c.item_id} className="flex items-baseline gap-2">
                <input
                  type="radio"
                  name="item"
                  value={c.item_id}
                  checked={choice === String(c.item_id)}
                  onChange={() => setChoice(String(c.item_id))}
                  className="accent-brand-600"
                />
                <span className="min-w-0 text-zinc-800">{displayTitle(c.title)}</span>
                <span className="shrink-0 tabular-nums text-xs text-zinc-400">{Math.round(c.probability * 100)}%</span>
              </label>
            ))}
            <label className="flex flex-wrap items-center gap-2">
              <input
                type="radio"
                name="item"
                value="__other"
                checked={choice === "__other"}
                onChange={() => setChoice("__other")}
                className="accent-brand-600"
              />
              <span className="text-zinc-800">Another item</span>
              {choice === "__other" && (
                <NativeSelect name="other_item" className="h-8 max-w-md" defaultValue="">
                  <option value="" disabled>
                    Choose an item
                  </option>
                  {entry.items.map((it: any) => (
                    <option key={it.id} value={it.id}>
                      {it.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </label>
          </div>
        </fieldset>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="submit" name="intent" value="dismiss" variant="outline" disabled={busy}>
            Not about any item
          </Button>
          <Button type="submit" name="intent" value="place" disabled={busy}>
            Place letter
          </Button>
        </div>
      </Form>
    </li>
  );
}

export default function AdminLetters({ loaderData, actionData }: Route.ComponentProps) {
  const { letters } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-12">
        <DetailHeader
          back={{ to: "/admin", label: "Admin" }}
          meta={[<span key="count" className="tabular-nums">{letters.length} to place</span>]}
          title="Letter placement"
          description="Residents' letters from agenda packages that the pipeline couldn't confidently match to an agenda item. Placed letters show under Written submissions on that item and its matter."
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

        {letters.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing to place.</p>
        ) : (
          <ul className="space-y-6">
            {letters.map((entry: any) => (
              <LetterCard key={`${entry.meeting.id}-${entry.extractedId}-${entry.letter.key}`} entry={entry} busy={busy} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
