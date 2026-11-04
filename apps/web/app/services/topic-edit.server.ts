import type { SupabaseClient } from "@supabase/supabase-js";
import { documentImageUrl } from "../lib/document-images.server";
import { topicItemIds } from "./page-verify.server";
import {
  EDIT_FIELDS, IMAGE_KINDS, type EditField, type ImageCandidate, type TopicEditState,
} from "../lib/topic-edit";

/**
 * Staff edits to a topic's title, summary, "where it stands" line and feature photo (the review bar's pencil).
 *
 * The edited value goes where the page already reads it (meta.display_title, plain_english_summary,
 * meta.status_line, meta.images.lead), and meta.manual records which fields a person set: { field: { by, at, auto } }
 * plus `items`, the topic's agenda items at the last edit. The pipeline never overwrites a field listed there; it
 * keeps its own latest version in `auto` instead, so "Reset to automatic" is instant. New items since the edit are
 * shown to staff, to decide whether the edit still holds.
 */
type Lock = { by: string; at: string; auto: unknown };
type Manual = Partial<Record<EditField, Lock>> & { items?: number[] };

// The pipeline's own limits for a usable picture (pipeline/ingestion/matter_images.py).
const MIN_W = 400, MIN_H = 250, MIN_BYTES = 20_000, MAX_CANDIDATES = 40;

type LeadImage = {
  r2_key: string; kind: string | null; width: number | null; height: number | null; page: number | null;
  agenda_item_id: number | null; document_id: number | null; meeting_id: number | null; report_title: string | null;
};

async function loadTopic(supabase: SupabaseClient, matterId: number) {
  const { data, error } = await supabase.from("matters").select("id, title, plain_english_summary, meta").eq("id", matterId).single();
  if (error || !data) throw new Error("Could not load this topic.");
  return data as { id: number; title: string; plain_english_summary: string | null; meta: Record<string, any> | null };
}

const current = (topic: Awaited<ReturnType<typeof loadTopic>>): Record<EditField, unknown> => ({
  title: topic.meta?.display_title ?? null,
  summary: topic.plain_english_summary ?? null,
  status_line: topic.meta?.status_line ?? null,
  image: topic.meta?.images?.lead ?? null,
});

/** The report pictures from this topic's own agenda items, largest first, repeats left out. */
export async function imageCandidates(supabase: SupabaseClient, matterId: number): Promise<(ImageCandidate & { lead: LeadImage })[]> {
  const { data: items } = await supabase.from("agenda_items").select("id, meeting_id").eq("matter_id", matterId);
  if (!items?.length) return [];
  const meetingOf = new Map(items.map((i) => [i.id as number, i.meeting_id as number]));
  const { data: docs } = await supabase.from("extracted_documents").select("id, document_id, agenda_item_id, title")
    .in("agenda_item_id", [...meetingOf.keys()]);
  if (!docs?.length) return [];
  const docOf = new Map(docs.map((d) => [d.id as number, d]));
  const { data: images } = await supabase.from("document_images")
    .select("id, extracted_document_id, r2_key, page, width, height, file_size")
    .in("extracted_document_id", [...docOf.keys()])
    .gte("width", MIN_W).gte("height", MIN_H).gte("file_size", MIN_BYTES)
    .order("file_size", { ascending: false }).limit(200);
  const seen = new Set<string>();
  const out: (ImageCandidate & { lead: LeadImage })[] = [];
  for (const img of images || []) {
    const key = `${img.width}x${img.height}x${img.file_size}`; // the same picture repeated across packages
    const url = documentImageUrl(img.r2_key);
    if (seen.has(key) || !url) continue;
    seen.add(key);
    const doc = docOf.get(img.extracted_document_id)!;
    const lead: LeadImage = {
      r2_key: img.r2_key, kind: null, width: img.width, height: img.height, page: img.page,
      agenda_item_id: doc.agenda_item_id, document_id: doc.document_id, meeting_id: meetingOf.get(doc.agenda_item_id) ?? null,
      report_title: doc.title ?? null,
    };
    out.push({ id: img.id, url, width: img.width, height: img.height, page: img.page, report: doc.title ?? null, lead });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export async function topicEditState(supabase: SupabaseClient, matterId: number, { withImages = false } = {}): Promise<TopicEditState> {
  const topic = await loadTopic(supabase, matterId);
  const manual = (topic.meta?.manual || {}) as Manual;
  const locked = EDIT_FIELDS.filter((f) => manual[f]);
  const now = current(topic);
  const lead = now.image as LeadImage | null;
  let newEntries = 0;
  if (locked.length) {
    const before = new Set(manual.items || []);
    newEntries = (await topicItemIds(supabase, matterId)).filter((id) => !before.has(id)).length;
  }
  return {
    title: (now.title as string | null) ?? topic.title,
    summary: (now.summary as string | null) ?? "",
    statusLine: (now.status_line as string | null) ?? "",
    image: lead?.r2_key ? { r2_key: lead.r2_key, url: documentImageUrl(lead.r2_key), kind: lead.kind ?? null } : null,
    locked,
    editedAt: locked.map((f) => manual[f]!.at).sort().at(-1) ?? null,
    newEntries,
    candidates: withImages ? (await imageCandidates(supabase, matterId)).map(({ lead: _, ...c }) => c) : [],
  };
}

export type TopicEdit = {
  title?: string; summary?: string; status_line?: string;
  /** A document_images id from this topic's candidates, or "none" for no photo; with the caption kind. */
  image?: { id: number | "none"; kind: string | null };
};

/** Saves the fields that changed; each becomes a person's (locked against the pipeline) until reset. */
export async function saveTopicEdit(supabase: SupabaseClient, matterId: number, edit: TopicEdit, userId: string) {
  const topic = await loadTopic(supabase, matterId);
  const meta = { ...(topic.meta || {}) } as Record<string, any>;
  const manual = { ...((meta.manual || {}) as Manual) };
  const before = current(topic);
  const update: Record<string, unknown> = {};
  const at = new Date().toISOString();
  const set = (field: EditField, value: unknown) => {
    if (JSON.stringify(value ?? null) === JSON.stringify(before[field] ?? null)) return;
    manual[field] = { by: userId, at, auto: manual[field] ? manual[field]!.auto : before[field] ?? null };
    if (field === "title") meta.display_title = value;
    else if (field === "summary") update.plain_english_summary = value;
    else if (field === "status_line") meta.status_line = value;
    else {
      const images = { ...(meta.images || {}) };
      if (value) images.lead = value; else delete images.lead;
      meta.images = images;
    }
  };

  if (edit.title !== undefined) {
    const title = edit.title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title) throw new Error("Could not save: the title can't be empty.");
    set("title", title);
  }
  if (edit.summary !== undefined) {
    const summary = edit.summary.trim().slice(0, 4000);
    if (!summary) throw new Error("Could not save: the summary can't be empty.");
    set("summary", summary);
  }
  if (edit.status_line !== undefined) set("status_line", edit.status_line.replace(/\s+/g, " ").trim().slice(0, 400) || null);
  if (edit.image !== undefined) {
    const kind = edit.image.kind && (IMAGE_KINDS as readonly string[]).includes(edit.image.kind) ? edit.image.kind : null;
    if (edit.image.id === "none") set("image", null);
    else {
      const chosen = (await imageCandidates(supabase, matterId)).find((c) => c.id === edit.image!.id);
      if (!chosen) throw new Error("Could not save: that picture isn't from this topic's reports.");
      const lead = before.image as LeadImage | null;
      // Same picture, new caption: only the kind changes.
      set("image", { ...chosen.lead, kind: kind ?? (lead?.r2_key === chosen.lead.r2_key ? lead.kind : null) });
    }
  }
  if (!EDIT_FIELDS.some((f) => manual[f] && manual[f]!.at === at)) return { changed: false };
  manual.items = await topicItemIds(supabase, matterId);
  meta.manual = manual;
  const { error } = await supabase.from("matters").update({ ...update, meta }).eq("id", matterId);
  if (error) throw new Error("Could not save the changes.");
  return { changed: true };
}

/** Puts the pipeline's own latest version back and lets it write the field again. */
export async function resetTopicField(supabase: SupabaseClient, matterId: number, field: EditField) {
  const topic = await loadTopic(supabase, matterId);
  const meta = { ...(topic.meta || {}) } as Record<string, any>;
  const manual = { ...((meta.manual || {}) as Manual) };
  const lock = manual[field];
  if (!lock) return;
  const update: Record<string, unknown> = {};
  if (field === "title") meta.display_title = lock.auto ?? null;
  else if (field === "summary") update.plain_english_summary = lock.auto ?? null;
  else if (field === "status_line") meta.status_line = lock.auto ?? null;
  else {
    const images = { ...(meta.images || {}) };
    if (lock.auto) images.lead = lock.auto; else delete images.lead;
    meta.images = images;
  }
  delete manual[field];
  if (EDIT_FIELDS.some((f) => manual[f])) meta.manual = manual; else delete meta.manual;
  const { error } = await supabase.from("matters").update({ ...update, meta }).eq("id", matterId);
  if (error) throw new Error("Could not reset that field.");
}

/** Keeps the edits after new entries came in: the "since your edit" count starts again from now. */
export async function confirmTopicEdits(supabase: SupabaseClient, matterId: number) {
  const topic = await loadTopic(supabase, matterId);
  const meta = { ...(topic.meta || {}) } as Record<string, any>;
  if (!meta.manual) return;
  meta.manual = { ...meta.manual, items: await topicItemIds(supabase, matterId) };
  const { error } = await supabase.from("matters").update({ meta }).eq("id", matterId);
  if (error) throw new Error("Could not save that.");
}
