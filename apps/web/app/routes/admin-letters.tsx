import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/admin-letters";
import { requireAdmin } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Button } from "../components/ui/button";
import { DetailHeader } from "../components/ui/detail-header";
import { NativeSelect } from "../components/ui/native-select";
import { displayTitle, matterTitle } from "../lib/display-text";
import { documentPath, meetingPath } from "../lib/paths";
import { cn, formatDate } from "../lib/utils";
import { addToItem, shortItemLabel, specificTerms, takeHeld, type UnplacedDocument, type WrittenLetter } from "../lib/written";

export const meta: Route.MetaFunction = () => [
  { title: "Letter placement | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];

type Supabase = ReturnType<typeof getSupabaseAdminClient>;

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return loadLetterQueue(getSupabaseAdminClient());
}

/** The letter itself: from its own header line ("Submission: Name", "From: Name") when we can find it. */
function excerptFor(text: string, who: string) {
  const name = who.replace(/\s*\([^()]*\)\s*$/, "").split(",")[0].trim();
  const surname = /^(A resident|Petition)/i.test(name) ? "" : name.split(/\s+/).at(-1) || "";
  let start = 0;
  if (surname.length > 2) {
    const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const header = new RegExp(`^.*(?:submission|from|sender|name)\\s*:?[^\\n]*${escaped}.*$`, "im").exec(text);
    const anyLine = new RegExp(`^.*${escaped}.*$`, "im").exec(text);
    start = header?.index ?? anyLine?.index ?? 0;
  }
  const slice = text.slice(start, start + 1200).replace(/^#+\s*/gm, "").replace(/\*\*/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return slice + (start + 1200 < text.length ? "…" : "");
}

export async function loadLetterQueue(supabase: Supabase) {
  const { data: meetings, error } = await supabase
    .from("meetings")
    .select("id, slug, title, meeting_date, meta")
    .not("meta->written_unplaced", "is", null)
    .order("meeting_date", { ascending: false });
  if (error) throw error;

  const meetingIds = (meetings || []).map((m) => m.id);
  const extractedIds = (meetings || []).flatMap((m) => Object.keys(m.meta?.written_unplaced || {}).map(Number));
  const [{ data: items, error: itemsError }, sections] = await Promise.all([
    meetingIds.length
      ? supabase
          .from("agenda_items")
          .select("id, meeting_id, item_order, title, plain_english_summary, written:meta->written_participation, matters(id, slug, title, meta)")
          .in("meeting_id", meetingIds)
          .order("item_order")
      : Promise.resolve({ data: [] as any[], error: null }),
    (async () => {
      const rows: any[] = [];
      for (let i = 0; i < extractedIds.length; i += 100) {
        const { data, error: sectionsError } = await supabase
          .from("document_sections")
          .select("extracted_document_id, section_text, section_order")
          .in("extracted_document_id", extractedIds.slice(i, i + 100))
          .order("section_order");
        if (sectionsError) throw sectionsError;
        rows.push(...(data || []));
      }
      return rows;
    })(),
  ]);
  if (itemsError) throw itemsError;

  // What each candidate item contains: the documents filed under it and what Council decided.
  const candidateItemIds = [
    ...new Set(
      (meetings || []).flatMap((m) =>
        Object.values((m.meta?.written_unplaced || {}) as Record<string, UnplacedDocument>).flatMap((doc) =>
          doc.letters.flatMap((l) => l.candidates.map((c) => c.item_id)),
        ),
      ),
    ),
  ];
  const [{ data: itemDocs }, { data: itemMotions }] = candidateItemIds.length
    ? await Promise.all([
        supabase.from("extracted_documents").select("agenda_item_id, title, summary").in("agenda_item_id", candidateItemIds),
        supabase.from("motions").select("agenda_item_id, text_content, plain_english_summary, result").in("agenda_item_id", candidateItemIds),
      ])
    : [{ data: [] as any[] }, { data: [] as any[] }];
  const docsByItem = new Map<number, string[]>();
  const summariesByItem = new Map<number, string[]>();
  for (const d of itemDocs || []) {
    docsByItem.set(d.agenda_item_id, [...(docsByItem.get(d.agenda_item_id) || []), d.title]);
    if (d.summary) summariesByItem.set(d.agenda_item_id, [...(summariesByItem.get(d.agenda_item_id) || []), d.summary]);
  }
  const motionsByItem = new Map<number, string[]>();
  for (const m of itemMotions || []) {
    const text = (m.plain_english_summary || m.text_content || "").replace(/\s+/g, " ").trim();
    if (text) motionsByItem.set(m.agenda_item_id, [...(motionsByItem.get(m.agenda_item_id) || []), `${text.length > 160 ? `${text.slice(0, 159)}…` : text}${m.result ? ` (${m.result.toLowerCase()})` : ""}`]);
  }

  const textByDoc = new Map<number, string>();
  for (const s of sections) textByDoc.set(s.extracted_document_id, `${textByDoc.get(s.extracted_document_id) || ""}\n\n${s.section_text || ""}`);

  return {
    meetings: (meetings || [])
      .map((meeting) => {
        const meetingItems = (items || []).filter((it: any) => it.meeting_id === meeting.id);
        const itemTerms = new Map<number, Set<string>>(
          meetingItems.map((it: any) => [
            it.id,
            specificTerms([it.title, it.plain_english_summary, ...(docsByItem.get(it.id) || []), ...(summariesByItem.get(it.id) || []), ...(motionsByItem.get(it.id) || [])].filter(Boolean).join(" ")),
          ]),
        );
        const entries = Object.entries((meeting.meta?.written_unplaced || {}) as Record<string, UnplacedDocument>).flatMap(
          ([extractedId, doc]) =>
            doc.letters.map((held) => {
              const { key, candidates, ...letter } = held;
              const top = candidates[0]?.probability ?? 0;
              const excerpt = excerptFor(textByDoc.get(Number(extractedId)) || "", letter.who);
              const letterTerms = specificTerms(`${doc.title || ""} ${letter.topic} ${letter.point} ${excerpt}`);
              return {
                id: `${extractedId}::${key}`,
                // The document viewer is keyed by the extracted document, not the parent PDF.
                documentId: Number(extractedId),
                documentTitle: doc.title || "Letters",
                letter: letter as WrittenLetter,
                candidates: candidates.map((c) => ({
                  itemId: c.item_id,
                  probability: c.probability,
                  shared: [...letterTerms].filter((t) => itemTerms.get(c.item_id)?.has(t)).sort(),
                })),
                likelyNone: top < 0.15,
                excerpt,
              };
            }),
        );
        const candidateIds = [...new Set(entries.flatMap((e) => e.candidates.map((c) => c.itemId)))];
        const itemInfo = candidateIds
          .map((id) => meetingItems.find((it: any) => it.id === id))
          .filter(Boolean)
          .map((it: any) => ({
            id: it.id as number,
            label: shortItemLabel(it.item_order, displayTitle(it.title)),
            title: displayTitle(it.title),
            summary: (it.plain_english_summary as string | null) || null,
            matter: it.matters ? { slug: it.matters.slug as string | null, id: it.matters.id as number, title: matterTitle(it.matters) } : null,
            placed: (it.written?.documents || []).reduce((n: number, d: any) => n + (d.letters?.length || 0), 0) as number,
            documents: [...new Set(docsByItem.get(it.id) || [])].slice(0, 6),
            decisions: (motionsByItem.get(it.id) || []).slice(0, 4),
            suggested: entries.filter((e) => !e.likelyNone && e.candidates[0]?.itemId === it.id).map((e) => e.id),
          }))
          .sort((a, b) => b.suggested.length - a.suggested.length);
        return {
          id: meeting.id as number,
          slug: meeting.slug as string | null,
          title: meeting.title as string,
          meeting_date: meeting.meeting_date as string,
          entries,
          items: itemInfo,
          allItems: meetingItems.map((it: any) => ({ id: it.id as number, label: shortItemLabel(it.item_order, displayTitle(it.title), 140) })),
        };
      })
      .filter((m) => m.entries.length > 0)
      .sort((a, b) => b.entries.length - a.entries.length),
  };
}

/**
 * Read-modify-write guarded by a revision number in meta, so fast clicks on
 * letters from the same meeting can't overwrite each other.
 */
async function guardedUpdate(
  supabase: Supabase,
  table: "meetings" | "agenda_items",
  id: number,
  mutate: (meta: Record<string, any>) => Record<string, any> | null,
) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await supabase.from(table).select("id, meta").eq("id", id).single();
    if (error) throw error;
    const next = mutate(data.meta || {});
    if (!next) return null;
    const rev = Number(data.meta?.written_rev || 0);
    let query = supabase.from(table).update({ meta: { ...next, written_rev: rev + 1 } }).eq("id", id);
    query = rev ? query.eq("meta->>written_rev", String(rev)) : query.is("meta->>written_rev", null);
    const { data: rows, error: updateError } = await query.select("id");
    if (updateError) throw updateError;
    if (rows?.length) return next;
  }
  throw new Error("Someone else is editing this meeting; try again.");
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const form = await request.formData();
  const meetingId = Number(form.get("meeting_id"));
  const intent = String(form.get("intent") || "");
  const entries = form.getAll("entry").map(String);
  const itemId = intent === "dismiss" ? null : Number(form.get("item")) || null;
  if (!meetingId || !entries.length) return { error: "Missing letter.", entries };
  if (intent !== "dismiss" && intent !== "place") return { error: "Unknown action.", entries };
  if (intent === "place" && !itemId) return { error: "Choose an agenda item.", entries };

  let itemTitle: string | null = null;
  try {
    if (itemId) {
      const { data: item, error } = await supabase.from("agenda_items").select("meeting_id, title").eq("id", itemId).single();
      if (error) throw error;
      if (item.meeting_id !== meetingId) return { error: "That item belongs to another meeting.", entries };
      itemTitle = item.title;
    }

    // 1. Take the letters off the meeting's queue (and remember the decision).
    const taken = new Map<string, { source: UnplacedDocument; letters: WrittenLetter[] }>();
    const updated = await guardedUpdate(supabase, "meetings", meetingId, (meta) => {
      taken.clear();
      let next: Record<string, any> = meta;
      for (const entry of entries) {
        const [extractedId, key] = entry.split("::");
        const result = takeHeld(next, extractedId, key, itemId, itemTitle);
        if (!result) continue;
        next = result.meetingMeta;
        const group = taken.get(extractedId) || { source: result.source, letters: [] };
        group.letters.push(result.letter);
        taken.set(extractedId, group);
      }
      return taken.size ? next : null;
    });
    // Already decided (e.g. a double click): nothing to undo on the page.
    if (!updated) return { ok: true, count: 0, entries };

    // 2. Put them on the item.
    if (itemId) {
      await guardedUpdate(supabase, "agenda_items", itemId, (meta) =>
        [...taken.entries()].reduce((acc, [extractedId, group]) => addToItem(acc, extractedId, group.source, group.letters), meta),
      );
    }
    const count = [...taken.values()].reduce((n, g) => n + g.letters.length, 0);
    return { ok: true, count, entries };
  } catch (error: any) {
    return { error: error?.message || "Couldn't save.", entries };
  }
}

/** Decisions update the page optimistically; don't reload the whole queue after each one. */
export function shouldRevalidate({ formMethod, defaultShouldRevalidate }: { formMethod?: string; defaultShouldRevalidate: boolean }) {
  return formMethod ? false : defaultShouldRevalidate;
}

type Queue = Awaited<ReturnType<typeof loadLetterQueue>>;
type MeetingGroup = Queue["meetings"][number];
type Entry = MeetingGroup["entries"][number];
type Handlers = { hide: (ids: string[]) => void; restore: (ids: string[], error: string) => void };

const POSITION: Record<string, { label: string; tone: string }> = {
  supports: { label: "Supports", tone: "text-emerald-700" },
  opposes: { label: "Opposes", tone: "text-red-700" },
  concerned: { label: "Concerned", tone: "text-amber-700" },
  asks: { label: "Asks", tone: "text-zinc-600" },
  mixed: { label: "Mixed", tone: "text-zinc-600" },
};

/** Submits in the background; rows hide immediately and come back if the save fails. */
function useDecision(meetingId: number, ids: string[], handlers: Handlers) {
  const fetcher = useFetcher<typeof action>();
  useEffect(() => {
    const data = fetcher.data as { error?: string; entries?: string[] } | undefined;
    if (fetcher.state === "idle" && data?.error) handlers.restore(data.entries || ids, data.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);
  return (intent: "place" | "dismiss", item?: number) => {
    if (!ids.length) return;
    handlers.hide(ids);
    const data = new FormData();
    data.set("intent", intent);
    data.set("meeting_id", String(meetingId));
    if (item) data.set("item", String(item));
    ids.forEach((id) => data.append("entry", id));
    fetcher.submit(data, { method: "post" });
  };
}

function SuggestedItem({ meeting, item, hidden, handlers }: { meeting: MeetingGroup; item: MeetingGroup["items"][number]; hidden: Set<string>; handlers: Handlers }) {
  const remaining = item.suggested.filter((id) => !hidden.has(id));
  const decide = useDecision(meeting.id, remaining, handlers);
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium text-zinc-900" title={item.title}>{item.label}</p>
        {item.summary && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-zinc-500">{item.summary}</p>}
        {item.documents.length > 0 && (
          <div className="mt-1.5 text-xs text-zinc-600">
            <span className="font-medium text-zinc-500">Documents: </span>
            {item.documents.join(" · ")}
          </div>
        )}
        {item.decisions.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-zinc-600">
            {item.decisions.map((d, i) => (
              <li key={i}>
                <span className="font-medium text-zinc-500">Decided: </span>
                {d}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-zinc-500">
          {item.matter && (
            <>
              Matter:{" "}
              <Link to={`/matters/${item.matter.slug || item.matter.id}`} target="_blank" className="text-brand-700 hover:underline">
                {item.matter.title}
              </Link>
              {" · "}
            </>
          )}
          <span className="tabular-nums">{item.placed} {item.placed === 1 ? "letter" : "letters"} already here</span>
        </p>
      </div>
      {remaining.length > 0 && (
        <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => decide("place", item.id)}>
          Place {remaining.length} suggested here
        </Button>
      )}
    </li>
  );
}

function LetterRow({ meeting, entry, hidden, handlers }: { meeting: MeetingGroup; entry: Entry; hidden: boolean; handlers: Handlers }) {
  const decide = useDecision(meeting.id, [entry.id], handlers);
  const [other, setOther] = useState(false);
  const [otherItem, setOtherItem] = useState("");
  const labels = new Map(meeting.allItems.map((it) => [it.id, it.label]));
  const position = POSITION[entry.letter.position];
  return (
    <li hidden={hidden} className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-zinc-900">{entry.letter.who}</span>
        {position && <span className={cn("text-xs font-medium", position.tone)}>{position.label}</span>}
        <span className="text-xs text-zinc-400">· {entry.letter.topic}</span>
      </div>
      <p className="mt-0.5 text-sm leading-relaxed text-zinc-700">{entry.letter.point}</p>
      {entry.excerpt && (
        <details className="group mt-1">
          <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-brand-700">
            <span className="group-open:hidden">Read the letter</span>
            <span className="hidden group-open:inline">Hide the letter</span>
          </summary>
          <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-700">
            {entry.excerpt}
            <div className="mt-2">
              <Link to={documentPath(meeting, entry.documentId)} target="_blank" className="font-medium text-brand-700 hover:underline">
                Open {entry.documentTitle}
              </Link>
            </div>
          </div>
        </details>
      )}
      <div className="mt-2 space-y-1.5">
        {entry.candidates.slice(0, 3).map((c) => {
          const label = labels.get(c.itemId);
          if (!label) return null;
          return (
            <button
              key={c.itemId}
              type="button"
              onClick={() => decide("place", c.itemId)}
              className="flex w-full items-start justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm text-zinc-800 transition-colors hover:border-brand-300 hover:bg-brand-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <span className="min-w-0 break-words">
                {label}
                {c.shared.length > 0 && (
                  <span className="mt-0.5 block text-xs font-medium text-brand-700">Matches the letter: {c.shared.join(", ")}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums text-xs text-zinc-400">{Math.round(c.probability * 100)}%</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {other ? (
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
            <NativeSelect className="h-9 w-full min-w-0 sm:max-w-md" value={otherItem} onChange={(e) => setOtherItem(e.target.value)}>
              <option value="" disabled>
                Choose an item
              </option>
              {meeting.allItems.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.label}
                </option>
              ))}
            </NativeSelect>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={!otherItem} onClick={() => decide("place", Number(otherItem))}>
                Place
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setOther(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setOther(true)} className="font-medium text-brand-700 hover:underline">
            Other item…
          </button>
        )}
        {!other && (
          <button type="button" onClick={() => decide("dismiss")} className="font-medium text-zinc-500 hover:text-zinc-800 hover:underline">
            Not about an item
          </button>
        )}
      </div>
    </li>
  );
}

function NoItemGroup({ meeting, entries, handlers }: { meeting: MeetingGroup; entries: Entry[]; handlers: Handlers }) {
  const decide = useDecision(meeting.id, entries.map((e) => e.id), handlers);
  if (!entries.length) return null;
  return (
    <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-zinc-500">Probably not about any agenda item ({entries.length})</p>
        <Button type="button" size="sm" variant="outline" onClick={() => decide("dismiss")}>
          Leave {entries.length === 1 ? "it" : `all ${entries.length}`} off
        </Button>
      </div>
      <ul className="mt-1 space-y-0.5 text-xs text-zinc-600">
        {entries.map((e) => (
          <li key={e.id}>
            <span className="font-medium text-zinc-800">{e.letter.who}</span> · {e.letter.point}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MeetingQueue({ meeting, hidden, handlers }: { meeting: MeetingGroup; hidden: Set<string>; handlers: Handlers }) {
  const visible = meeting.entries.filter((e) => !hidden.has(e.id));
  if (!visible.length) return null;
  const toDecide = meeting.entries.filter((e) => !e.likelyNone);
  const noItem = visible.filter((e) => e.likelyNone);
  const decideCount = toDecide.filter((e) => !hidden.has(e.id)).length;
  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-100 px-4 py-3">
        <h2 className="text-base font-semibold text-zinc-900">
          <Link to={meetingPath(meeting)} target="_blank" className="hover:text-brand-700 hover:underline">
            {meeting.title} · {formatDate(meeting.meeting_date, { month: "short", day: "numeric", year: "numeric" })}
          </Link>
        </h2>
        <span className="text-sm tabular-nums text-zinc-500">
          {visible.length} {visible.length === 1 ? "letter" : "letters"}
        </span>
      </div>

      {decideCount > 0 && meeting.items.length > 0 && (
        <div className="border-b border-zinc-100 bg-zinc-50/60">
          <p className="px-4 pt-3 text-xs font-medium text-zinc-500">Agenda items the letters might be about</p>
          <ul className="divide-y divide-zinc-100">
            {meeting.items.map((item) => (
              <SuggestedItem key={item.id} meeting={meeting} item={item} hidden={hidden} handlers={handlers} />
            ))}
          </ul>
        </div>
      )}

      <ul className="divide-y divide-zinc-100">
        {toDecide.map((entry) => (
          <LetterRow key={entry.id} meeting={meeting} entry={entry} hidden={hidden.has(entry.id)} handlers={handlers} />
        ))}
      </ul>
      <NoItemGroup meeting={meeting} entries={noItem} handlers={handlers} />
    </section>
  );
}

export default function AdminLetters({ loaderData }: Route.ComponentProps) {
  const { meetings } = loaderData;
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const handlers: Handlers = {
    hide: (ids) => setHidden((prev) => new Set([...prev, ...ids])),
    restore: (ids, error) => {
      setHidden((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      setErrors((prev) => [...prev.slice(-2), error]);
    },
  };
  const all = meetings.flatMap((m) => m.entries);
  const remaining = all.filter((e) => !hidden.has(e.id));
  const toDecide = remaining.filter((e) => !e.likelyNone).length;

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-12">
        <DetailHeader
          back={{ to: "/admin", label: "Admin" }}
          meta={[
            <span key="count" className="tabular-nums">
              {toDecide} to place · {remaining.length - toDecide} probably not about an item
              {hidden.size > 0 ? ` · ${hidden.size} done this session` : ""}
            </span>,
          ]}
          title="Letter placement"
          description="Residents' letters the pipeline couldn't confidently match to an agenda item, grouped by meeting. Decisions save in the background."
        />

        {errors.length > 0 && (
          <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {errors.at(-1)} The letter is back in the list.
          </div>
        )}

        {remaining.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing to place.</p>
        ) : (
          <div className="space-y-6">
            {meetings.map((meeting) => (
              <MeetingQueue key={meeting.id} meeting={meeting} hidden={hidden} handlers={handlers} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
