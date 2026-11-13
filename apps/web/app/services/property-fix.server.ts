import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { FLAG_PROBLEM_LABELS, entryLabel, keepStaffRatings, type PageFlag } from "../lib/page-review-types";
import { recheckClaims, type Claim } from "./page-verify.server";
import { findingText, investigate, investigatedRecords, investigationLine, needsInvestigation } from "./fix-investigation.server";
import { applyRecheck, recheckSummary, flagLabel } from "../lib/page-recheck";
import { logStaffAction } from "./staff.server";
import { splitLead, withClosing } from "../lib/property-lead";
import { rewriteSummaries } from "./topic-summaries.server";
import { sourcesFor, sourcesForMatters, sourceRecordLines } from "./sources.server";
import { EDIT_SOURCE_FIELDS, EDIT_SOURCE_PROMPT, MERGE_ADDRESS_FIELDS, MERGE_ADDRESS_PROMPT, UNLINK_ADDRESS_FIELDS, mergeAddress, type AddressRef, capital, checkFollowed, editSourceOnPage, heldByHandLine, loadSources, quoteInRecords, saveEditorNotes, squash, summaryInstruction, unfollowedLine, writeEntryText } from "./fix-ops.server";
import type { Source } from "../lib/sources";
import { getMatterReportMentions, type ReportMention } from "./matters";
import type { StaffRole } from "../lib/auth.server";

/**
 * The fix agent on a property page (/properties/<slug>): an address, or a street with its addresses. The page's
 * own text is its lead (properties.meta.summary, written by the pipeline's property-summaries stage); the rest is
 * the topics and meeting items the pipeline linked to the address, each shown from its own record. So the menu is
 * small: unlink an entry that's about a different address (or only names this one in passing), rewrite the lead,
 * correct a source (its headline, quote, note or date label), rewrite one entry's line, have a topic's summary rewritten, or say the page is right or
 * that a person is needed. A lead the agent writes is locked
 * (meta.summary_locked), so the pipeline keeps it rather than writing its own over it. Same flow as the topic and
 * meeting agents: investigate, plan, act, re-check.
 */

export const PROPERTY_FIX_BUDGET_MS = 90_000;
/** The lead's narrative part, as the pipeline caps it (property_summaries.NARRATIVE_MAX is 320 characters). */
const LEAD_MAX = 650;

const Action = z.object({
  action: z.enum(["unlink_entry", "rewrite_lead", "edit_source", "rewrite_entry", "rewrite_summary", "merge_address", "no_change", "cannot_fix"]),
  key: z.string().nullable().describe("The key of the flag this answers (matter-<id>, item-<id> or source-<id>), or null for the whole page or the note. unlink_entry: the entry to take off (matter-<id> or item-<id>)."),
  entry_key: z.string().nullable().describe("rewrite_entry: the row whose line changes, as RECORDS keys it: step-<id> (a step of a topic), item-<id> (a meeting item linked to this address) or report-<id> (an annual report row). Otherwise null."),
  ...EDIT_SOURCE_FIELDS,
  ...UNLINK_ADDRESS_FIELDS,
  ...MERGE_ADDRESS_FIELDS,
  new_text: z.string().nullable().describe("rewrite_summary: the instruction for the topic's summary writer, one or two sentences saying what the text must say or stop saying (it is followed on every later rewrite too). rewrite_entry: the row's new line, one plain sentence (under 140 characters) saying what happened at this address. rewrite_lead: the page's new lead. By default one or two plain sentences (under 320 characters), outcome first, saying what happened at this address and whether it affects the reader; when staff asked for another shape (a timeline, more detail), what they asked for, up to 600 characters. The closing \"Mentioned in council meetings…\" line is kept for you. Otherwise null."),
  source: z.string().nullable().describe("rewrite_lead, rewrite_entry, edit_source, rewrite_summary, merge_address: the record's (or the source text's) own words the change rests on, quoted exactly, at most 250 characters. Otherwise null."),
  not_supported: z.string().nullable().describe("rewrite_lead: the parts of staff's request the records don't support, so you left them out (say which, in one sentence). null when everything asked is in the lead."),
  reason: z.string().describe("One short sentence a resident would understand (under 30 words): what you're doing and why, or why it can't be done."),
});
const PlanSchema = z.object({ actions: z.array(Action) });

type Property = { id: number; slug: string; address: string; civic_number: string | null; street: string | null; meta: Record<string, any> | null };
type Topic = { id: number; title: string; status: string | null; first_seen: string | null; last_seen: string | null; plain_english_summary: string | null; meta: Record<string, any> | null; addresses: string[] };
type Item = { id: number; title: string | null; plain_english_summary: string | null; meeting_date: string | null; meeting_title: string | null };
/** One meeting item filed under a topic: a row of the topic's own timeline, so a row on this page. `line` is what the page shows now. */
export type Step = { id: number; matter_id: number; title: string | null; meeting_date: string | null; meeting_title: string | null; line: string | null };

export { withClosing };

/** What the planner reads: the page's lead and each entry from its own record, keyed as the page keys them. */
export function propertyRecords(property: Property, lead: string | null, topics: Topic[], items: Item[], steps: Step[] = [], sources: Source[] = [], reports: ReportMention[] = []): string {
  const lines = [`ADDRESS: ${property.address}${property.civic_number ? "" : " (a street: the topics below are about the street itself)"}`,
    `LEAD (the page's own text${(property.meta as any)?.summary_locked?.hand ? "; written by hand by a person" : ""}): ${lead ? squash(lead) : "(none yet)"}`];
  for (const t of topics) {
    lines.push("", `TOPIC matter-${t.id} (${[t.first_seen, t.last_seen].filter(Boolean).map((d) => String(d).slice(0, 10)).join(" to ") || "no dates"}; ${t.status || "no status"}): ${squash(t.title)}`);
    if (t.plain_english_summary) lines.push(`  summary: ${squash(t.plain_english_summary)}`);
    if (t.meta?.status_line) lines.push(`  where it stands: ${squash(t.meta.status_line)}`);
    if (t.addresses.length) lines.push(`  addresses the pipeline linked to this topic: ${t.addresses.slice(0, 12).join("; ")}${t.addresses.length > 12 ? "; …" : ""}`);
    for (const st of steps.filter((x) => x.matter_id === t.id).slice(0, 30)) {
      lines.push(`  STEP step-${st.id} (${st.meeting_date ?? "no date"}, ${st.meeting_title ?? "meeting"}): ${squash(st.title || "")}${st.line ? ` | the page now shows: ${squash(st.line)}` : ""}`);
    }
  }
  for (const i of items) {
    lines.push("", `ITEM item-${i.id} (${i.meeting_date ?? "no date"}, ${i.meeting_title ?? "meeting"}): ${squash(i.title || "")}`);
    if (i.plain_english_summary) lines.push(`  summary: ${squash(i.plain_english_summary)}`);
  }
  for (const r of reports) lines.push("", `REPORT report-${r.id} (${r.year} annual report, page ${r.page}): ${squash(r.quote)}`);
  if (sources.length) lines.push("", "Sources from outside the meeting record. The page's key for one is source-<id> (the number after source:). They are not record: a line about what one says must name who said it.", sourceRecordLines(sources));
  return lines.join("\n");
}

export function propertyPlanPrompt(property: Property, agreed: PageFlag[], note: string | null, records: string, findings: (string | null)[], pageFinding: string | null): string {
  const flagLines = agreed.map((f, i) => `- ${f.key ?? "(whole page)"} · ${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}${f.fix ? ` Suggested: ${f.fix}` : ""}${f.note && squash(f.note) !== squash(f.reason) ? `\n  Editor's instruction for this (do what it asks, over the defaults below): ${f.note}` : ""}${findings[i] ? `\n  FOUND: ${findings[i]}` : ""}`);
  return `You fix the page for ${property.address} on Open Langford, a site that follows Langford City council. The page
lists the council business the pipeline linked to this address: topics (rezonings, permits, projects) and meeting
items, each shown from its own record, under a short lead the pipeline wrote. A reader checked it and flagged
problems; staff agreed with these:
${flagLines.join("\n") || "(none)"}
${note ? `\nStaff's note (an instruction from the editor: do what it asks, even where it differs from the defaults below): ${note}${pageFinding ? `\n  FOUND: ${pageFinding}` : ""}` : ""}

Actions, one entry in "actions" per flag (and per note):
- unlink_entry: the entry (matter-<id> or item-<id>) is about a different address, or names this one only in
  passing (one address in a list of many, a street mentioned as a landmark). It comes off this page and stays on its
  own. Say which address it is really about.
- rewrite_lead: the lead is wrong, vague or missing. By default write one or two plain sentences (under 320
  characters) for a resident on a phone: what happened at this address and whether it affects them, outcome first,
  everyday words, the number of homes or lots and dollar amounts when the records give them, no bylaw or file
  numbers. These are defaults: when staff's note or a flag's instruction asks for something else (a timeline in the
  order things happened, more detail, particular facts), do what it asks instead, in plain sentences, up to 600
  characters. Use only what the records give. If part of the request isn't in the records (a claim about consultation
  or plans, say), leave that part out and name it in "not_supported", never state it. Quote the record the lead
  rests on in "source". The closing count line is kept for you; don't write one. A lead marked as written by hand
  was written by a person: change it only as far as a flag or the note asks.
  An entry counts as passing when the topic's record lists many addresses and this is one of them ("addresses the
  pipeline linked to this topic"), unless the records show something decided or done about this address in particular.
${EDIT_SOURCE_PROMPT}
${MERGE_ADDRESS_PROMPT}
  This page is address-${property.id}; the other spellings of its civic number are listed under OTHER SPELLINGS below.
  Either way round works: merge this page into the right spelling, or a wrong spelling into this page.
- rewrite_entry: one row's line is repetitive, vague or says more than the record does. entry_key is the row (step-<id>,
  item-<id> or report-<id> in RECORDS), key is the flag it answers. Write one plain sentence (under 140 characters) of what the
  record shows happened at this address; when the record is silent on the detail, say so ("Staff updated the
  committee on four capital projects, including this waterfront property; the minutes don't say what was covered."),
  never fill the gap. Quote the record it rests on in "source".
- rewrite_summary: a topic's own text (its summary or "where it stands", shown under the topic and used by the page's
  lead) is wrong or misleading for this address. key is the flag (matter-<id>); put the instruction for the summary
  writer in new_text, and the record's words behind it in "source". The topic is then rewritten from its timeline and
  checked against the records.
- no_change: the flag is not a problem (say why in a sentence a resident would understand).
- cannot_fix: a judgement these actions can't make; say exactly what a person needs to decide.
Work only from the records below. Never invent an outcome, a number or a date.

RECORDS:
${records}`;
}

/** Other lots with this one's civic number on a street of the same name (another spelling of the same address),
 * with the titles of the items that name each, for the planner. Exported for tests. */
export async function otherSpellings(supabase: SupabaseClient, property: Property): Promise<{ list: AddressRef[]; text: string }> {
  const name = (property.street || "").split(/\s+/)[0];
  if (!property.civic_number || !name) return { list: [], text: "" };
  const { data } = await supabase.from("properties").select("id, slug, address, civic_number, meta").eq("civic_number", property.civic_number)
    .ilike("street", `${name} %`).eq("hidden", false).neq("id", property.id).limit(10);
  const list = ((data || []) as any[]).filter((p) => !p.meta?.merged_into).map((p) => ({ id: p.id, slug: p.slug, address: p.address, civic_number: p.civic_number }));
  if (!list.length) return { list, text: "" };
  const { data: links } = await supabase.from("property_links").select("property_id, agenda_items(title)").in("property_id", list.map((p) => p.id)).eq("hidden", false).limit(60);
  const titles = (id: number) => [...new Set(((links || []) as any[]).filter((l) => l.property_id === id)
    .map((l) => squash(String((Array.isArray(l.agenda_items) ? l.agenda_items[0] : l.agenda_items)?.title || "").split("\n")[0])).filter(Boolean))].slice(0, 5);
  return { list, text: `OTHER SPELLINGS OF THIS ADDRESS (merge_address by id; this page is address-${property.id}):\n${list.map((p) =>
    `- address-${p.id}: ${p.address}${titles(p.id).length ? `\n  items that name it: ${titles(p.id).map((t) => `"${t}"`).join("; ")}` : " (nothing visible linked to it)"}`).join("\n")}` };
}

/** One revision of a lead that didn't do what staff asked: the same lead with what is missing added, from the records only. */
async function reviseLead(lead: string, unmet: { instruction: string; missing: string }[], records: string, signal?: AbortSignal): Promise<string> {
  const body = splitLead(lead).body;
  const { data } = await getAiClient().json({ stage: "review", signal, schema: z.object({ new_text: z.string() }), schemaName: "property_lead_revision",
    prompt: `Revise the lead (the short text at the top of a page about an address) so it does what staff asked. Keep what it already does well.
Use only facts in the records below; leave out any part of the request the records don't support. Plain sentences, up to 600
characters, no bylaw or file numbers. Don't write a "Mentioned in council meetings" line; it is added for you.

Current lead: ${body}

Not yet done:
${unmet.map((u) => `- Asked: ${squash(u.instruction)}\n  Missing: ${u.missing || "not done"}`).join("\n")}

RECORDS:
${records.slice(0, 30_000)}` });
  return data.new_text;
}

export async function fixPropertyPage(supabase: SupabaseClient, origin: string, path: string, requester: { id: string; staffRole: StaffRole }): Promise<"nothing_new" | "refiling" | void> {
  const startedAt = Date.now();
  const budget = AbortSignal.timeout(PROPERTY_FIX_BUDGET_MS);
  const timeLeft = () => PROPERTY_FIX_BUDGET_MS - (Date.now() - startedAt);
  const withStaffRatings = async (mine: PageFlag[]) => {
    const { data: now } = await supabase.from("page_reviews").select("ai_flags").eq("path", path).maybeSingle();
    return keepStaffRatings(now?.ai_flags as PageFlag[] | null, mine);
  };
  const progress = (text: string) => {
    supabase.from("page_reviews").update({ agent_note: text, agent_at: new Date().toISOString() }).eq("path", path).eq("status", "fixing")
      .then(({ error }) => { if (error) console.error("[property-fix] progress:", error.message); });
  };
  const finish = async (status: "fixed" | "needs_work", agent_note: string, flags?: PageFlag[]) => {
    await supabase.from("page_reviews").update({
      status, agent_note, agent_at: new Date().toISOString(), ...(flags ? { ai_flags: await withStaffRatings(flags) } : {}),
    }).eq("path", path);
  };
  const log = (action: string, detail: Record<string, string>) =>
    logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action, detail });
  try {
    const slug = path.match(/^\/properties\/([^/]+)$/)?.[1];
    const { data: row } = await supabase.from("page_reviews").select("ai_flags, note").eq("path", path).maybeSingle();
    const flags = ((row?.ai_flags || []) as PageFlag[]);
    const agreed = flags.filter((f) => f.verdict === "agree" && !f.fixed);
    const { data: property } = slug ? await supabase.from("properties").select("id, slug, address, civic_number, street, meta").eq("slug", slug).maybeSingle() : { data: null };
    if (!property) return finish("needs_work", "The agent couldn't find this address. This one needs a person.");
    if (!agreed.length && !row?.note) {
      if (flags.some((f) => f.verdict === "agree" && f.fixed)) {
        await supabase.from("page_reviews").update({ status: "fixed" }).eq("path", path);
        return "nothing_new";
      }
      return finish("needs_work", "Nothing to fix: no flags were rated 👍 and there's no note.");
    }
    const toResearch = agreed.filter((f) => !f.research && needsInvestigation(f)).length + (row?.note?.trim() ? 1 : 0);
    progress(toResearch ? `Reading this address's records and searching the City's records for ${toResearch === 1 ? "1 problem" : `${toResearch} problems`}…` : "Reading this address's records…");

    // The page's entries, from their own records.
    const { data: links } = await supabase.from("property_links").select("matter_id, agenda_item_id").eq("property_id", property.id).eq("hidden", false);
    const matterIds = [...new Set(((links || []) as any[]).map((l) => l.matter_id).filter((x): x is number => x != null))];
    const itemIds = [...new Set(((links || []) as any[]).map((l) => l.agenda_item_id).filter((x): x is number => x != null))];
    const [{ data: matterRows }, { data: itemRows }, { data: otherLinks }] = await Promise.all([
      matterIds.length ? supabase.from("matters").select("id, title, status, first_seen, last_seen, plain_english_summary, meta, merged_into").in("id", matterIds) : Promise.resolve({ data: [] as any[] }),
      itemIds.length ? supabase.from("agenda_items").select("id, title, plain_english_summary, meetings(title, meeting_date)").in("id", itemIds) : Promise.resolve({ data: [] as any[] }),
      matterIds.length ? supabase.from("property_links").select("matter_id, properties(address)").in("matter_id", matterIds).eq("hidden", false).limit(400) : Promise.resolve({ data: [] as any[] }),
    ]);
    const addressesOf = new Map<number, string[]>();
    for (const l of (otherLinks || []) as any[]) {
      const addr = (Array.isArray(l.properties) ? l.properties[0] : l.properties)?.address;
      if (addr && addr !== property.address) addressesOf.set(l.matter_id, [...new Set([...(addressesOf.get(l.matter_id) || []), addr])]);
    }
    const topics: Topic[] = ((matterRows || []) as any[]).filter((m) => !m.merged_into).map((m) => ({ ...m, addresses: addressesOf.get(m.id) || [] }));
    // Each topic's own steps (its timeline rows) and the sources on this page, so the agent can see what a flag points at.
    const topicIds = topics.map((t) => t.id);
    const [{ data: stepRows }, ownSources, topicSources, reports] = await Promise.all([
      topicIds.length ? supabase.from("agenda_items").select("id, title, matter_id, meetings(title, meeting_date)").in("matter_id", topicIds).order("id").limit(400) : Promise.resolve({ data: [] as any[] }),
      sourcesFor(supabase, { propertyId: property.id }),
      sourcesForMatters(supabase, topicIds),
      topicIds.length ? getMatterReportMentions(supabase, topicIds) : Promise.resolve([] as ReportMention[]),
    ]);
    const steps: Step[] = ((stepRows || []) as any[]).filter((r) => !(topics.find((t) => t.id === r.matter_id)?.meta?.hidden_duplicates || {})[String(r.id)]).map((r) => {
      const mt = Array.isArray(r.meetings) ? r.meetings[0] : r.meetings;
      const meta = topics.find((t) => t.id === r.matter_id)?.meta;
      return { id: r.id, matter_id: r.matter_id, title: r.title, meeting_date: mt?.meeting_date ?? null, meeting_title: mt?.title ?? null,
        line: meta?.staff_headlines?.[String(r.id)] ?? meta?.timeline_headlines?.[String(r.id)] ?? null };
    });
    const { sources, textOf } = await loadSources(supabase, [...ownSources, ...[...topicSources.values()].flat()]);
    const items: Item[] = ((itemRows || []) as any[]).map((i) => {
      const mt = Array.isArray(i.meetings) ? i.meetings[0] : i.meetings;
      return { id: i.id, title: i.title, plain_english_summary: i.plain_english_summary, meeting_date: mt?.meeting_date ?? null, meeting_title: mt?.title ?? null };
    });
    const lead: string | null = (property.meta as any)?.summary ?? null;
    const investigations = await investigate(supabase, { path, topic: property.address, flags: agreed.map((flag) => ({ flag, index: flags.indexOf(flag) })),
      note: row?.note ?? null, signal: budget });
    const findingFor = (i: { finding: Parameters<typeof findingText>[0] } | undefined) => findingText(i?.finding);
    const found = investigations.filter((i) => i.finding?.ref && i.finding.verdict !== "not_found");
    const lookedInto = found.length ? `Evidence, from the City's records:\n${found.map((i) =>
      `• ${capital(entryLabel(i.key, flags))}: ${squash(i.finding!.explanation).slice(0, 220)} (${i.finding!.ref})`).join("\n")}` : "";
    const researchText = [investigations.map(investigationLine).filter(Boolean).join("\n"), await investigatedRecords(supabase, investigations)].filter(Boolean).join("\n\n");
    // The same civic number on a street of the same name ("245 Atkins Road" beside "245 Atkins Avenue"): merge_address.
    const others = await otherSpellings(supabase, property as Property);
    const records = [propertyRecords(property as Property, lead, topics, items, steps, sources, reports), others.text, researchText].filter(Boolean).join("\n\n");

    progress("Planning the fix…");
    const result = await getAiClient().json({
      stage: "review",
      prompt: propertyPlanPrompt(property as Property, agreed, row?.note ?? null, records,
        agreed.map((f) => findingFor(investigations.find((i) => i.index === flags.indexOf(f)))),
        findingFor(investigations.find((i) => i.index === null))),
      schema: PlanSchema, schemaName: "property_fix_plan", signal: budget,
    });

    progress(`Making ${result.data.actions.length === 1 ? "1 change" : `${result.data.actions.length} changes`}…`);
    const done: string[] = []; const answered: string[] = []; const left: string[] = [];
    const fixedKeys = new Set<string>(); let pageFixed = false;
    const claims: Claim[] = [];
    let leadUnmet = false;  // a rewritten lead that still doesn't do what staff asked: the page is not "fixed"
    const at = new Date().toISOString();
    const agreedKeys = new Set(agreed.map((f) => f.key));
    const pageLevel = agreedKeys.has(null) || !!row?.note?.trim();
    // What staff asked of the page as a whole: the agreed page-level flags (an editor's own wording is the flag's note,
    // or its reason) and the page note. The new lead is checked against these.
    const pageAsked = [...new Set([...agreed.filter((f) => !f.key).map((f) => squash(f.note || f.reason || "")), squash(row?.note || "")].filter(Boolean))];
    const summaryNotes: { matter_id: number; note: string; key: string | null }[] = [];
    for (const step of result.data.actions) {
      const key = step.key && agreedKeys.has(step.key) ? step.key : null;
      if (step.action === "no_change") { answered.push(step.reason); if (key) fixedKeys.add(key); else if (agreedKeys.has(null)) pageFixed = true; continue; }
      if (step.action === "cannot_fix") { left.push(step.reason); continue; }
      if (step.action === "unlink_entry") {
        const m = step.key?.match(/^(matter|item)-(\d+)$/);
        if (!m || !(key || pageLevel)) { left.push(`${step.reason} (that entry isn't flagged on this page, so nothing changed)`); continue; }
        const id = Number(m[2]);
        const onPage = m[1] === "matter" ? topics.some((t) => t.id === id) : items.some((i) => i.id === id);
        if (!onPage) { left.push(`${step.reason} (no such entry on this page)`); continue; }
        const { error } = await supabase.from("property_links").update({ hidden: true }).eq("property_id", property.id)
          .eq(m[1] === "matter" ? "matter_id" : "agenda_item_id", id);
        if (error) { left.push(`${step.reason} (couldn't unlink it)`); continue; }
        if (key) fixedKeys.add(key); else pageFixed = true;
        done.push(`Took ${entryLabel(step.key, flags)} off this page: ${step.reason}`);
        await log("agent:unlink_property_entry", { property_id: String(property.id), [m[1] === "matter" ? "matter_id" : "agenda_item_id"]: String(id), reason: step.reason.slice(0, 300) });
        continue;
      }
      if (step.action === "merge_address") {
        const self: AddressRef = { id: property.id, address: property.address, slug: property.slug, civic_number: property.civic_number || "" };
        const pick = (id: number | null) => (id === property.id ? self : others.list.find((o) => o.id === id));
        const from = pick(step.property_id), into = pick(step.into_property_id);
        const why = !(key || pageLevel) ? "nothing flagged on this page asks for it"
          : !from || !into || (from.id !== property.id && into.id !== property.id) ? "it can only merge this address with one of the other spellings listed"
          : !quoteInRecords(step.source, records) ? "its quote isn't the record's exact words"
          : await mergeAddress(supabase, from, into, requester.id);
        if (why) { left.push(`${step.reason} (${why}, so nothing changed)`); continue; }
        if (key) fixedKeys.add(key); else pageFixed = true;
        done.push(`Merged ${from!.address} into ${into!.address}; ${from!.id === property.id ? "this page now redirects there" : "its page now redirects here"}: ${step.reason}`);
        await log("agent:merge_address", { from: String(from!.id), into: String(into!.id), reason: step.reason.slice(0, 300) });
        continue;
      }
      if (step.action === "edit_source") {
        const result = await editSourceOnPage(supabase, step, { sources, textOf, records, flagged: (k) => pageLevel || (!!k && agreedKeys.has(k)) });
        if (!result.ok) { left.push(`${step.reason} (${result.why})`); continue; }
        if (key) fixedKeys.add(key); else pageFixed = true;
        done.push(`Corrected ${entryLabel(`source-${result.source.id}`, flags)}${result.edit.headline ? `, now headed "${result.edit.headline}"` : ""}: ${step.reason}`);
        await log("agent:edit_source", { source_id: String(result.source.id), ...Object.fromEntries(Object.entries(result.edit).map(([k, v]) => [k, v.slice(0, 300)])), reason: step.reason.slice(0, 300) });
        continue;
      }
      if (step.action === "rewrite_summary") {
        const mm = step.key?.match(/^matter-(\d+)$/);
        const matterId = mm ? Number(mm[1]) : null;
        if (!matterId || !topics.some((t) => t.id === matterId)) { left.push(`${step.reason} (no such topic on this page)`); continue; }
        if (!key && !pageLevel) { left.push(`${step.reason} (that topic isn't flagged on this page, so nothing changed)`); continue; }
        const note = summaryInstruction(step.new_text, step.source);
        if (!note || squash(step.new_text || "").length < 15) { left.push(`${step.reason} (the agent didn't say what the summary should say)`); continue; }
        if (squash(step.source || "") && !quoteInRecords(step.source, records)) { left.push(`${step.reason} (its quote isn't the record's exact words, so the summary stays; press Fix again)`); continue; }
        summaryNotes.push({ matter_id: matterId, key, note });
        continue;
      }
      if (step.action === "rewrite_entry") {
        const em = step.entry_key?.match(/^(step|item|report)-(\d+)$/);
        if (!em || !(key || pageLevel)) { left.push(`${step.reason} (that row isn't flagged on this page, so nothing changed)`); continue; }
        const id = Number(em[2]);
        const stepRow = em[1] === "step" ? steps.find((x) => x.id === id) : undefined;
        const reportRow = em[1] === "report" ? reports.find((x) => x.id === id) : undefined;
        if (!(stepRow || reportRow || (em[1] === "item" && items.some((i) => i.id === id)))) { left.push(`${step.reason} (no such row on this page)`); continue; }
        const text = squash(step.new_text || "").replace(/\.$/, "");
        if (text.length < 15 || text.length > 200) { left.push(`${step.reason} (the new line wasn't usable, so the row stays)`); continue; }
        if (!quoteInRecords(step.source, records)) { left.push(`${step.reason} (its quote isn't the record's exact words, so the row stays; press Fix again)`); continue; }
        let failed: string | null = null;
        if (stepRow) failed = await writeEntryText(supabase, stepRow.matter_id, { headlines: { [String(id)]: text } });
        else if (reportRow) {
          if (!reportRow.matter_id) failed = "no topic";
          else failed = await writeEntryText(supabase, reportRow.matter_id, { lines: { [`report-${id}`]: { line: text, source: squash(step.source || "").slice(0, 250) } } });
        } else {
          // A linked mention: the property's own staff copy, which the lead stage never rewrites (it rewrites entry_lines).
          const { data: fresh } = await supabase.from("properties").select("meta").eq("id", property.id).single();
          const meta = { ...((fresh?.meta || {}) as Record<string, any>) };
          meta.staff_entry_lines = { ...(meta.staff_entry_lines || {}), [String(id)]: text };
          failed = (await supabase.from("properties").update({ meta }).eq("id", property.id)).error?.message ?? null;
        }
        if (failed) { left.push(`${step.reason} (couldn't save the new line)`); continue; }
        if (key) fixedKeys.add(key); else pageFixed = true;
        done.push(`The ${stepRow ? `${stepRow.meeting_date ?? ""} step` : reportRow ? `${reportRow.year} annual report row` : "row"} now reads "${text}": ${step.reason}`);
        await log("agent:rewrite_property_entry", { entry: step.entry_key!, text: text.slice(0, 300), reason: step.reason.slice(0, 300) });
        continue;
      }
      if (step.action === "rewrite_lead") {
        if (!pageLevel) { left.push(`${step.reason} (no page-level problem was flagged, so the lead stays)`); continue; }
        if (!quoteInRecords(step.source, records)) { left.push(`${step.reason} (its quote isn't the record's exact words, so the lead stays; press Fix again)`); continue; }
        let text = withClosing(lead, step.new_text || "");
        if (squash(step.new_text || "").length < 20 || text.length > LEAD_MAX + 120) { left.push(`${step.reason} (the new lead wasn't usable, so it stays)`); continue; }
        const saveLead = async (value: string): Promise<boolean> => {
          const { data: fresh } = await supabase.from("properties").select("meta").eq("id", property.id).single();
          const current = { ...((fresh?.meta || {}) as Record<string, any>) };
          const meta = { ...current, summary: value, summary_updated_at: at,
            summary_locked: { by: requester.id, at, auto: current.summary_locked?.auto ?? current.summary ?? null, source: squash(step.source || "").slice(0, 400), reason: step.reason.slice(0, 300) } };
          return !(await supabase.from("properties").update({ meta }).eq("id", property.id)).error;
        };
        if (!(await saveLead(text))) { left.push(`${step.reason} (couldn't save the new lead)`); continue; }
        // The fact check later asks only whether the lead is true. Whether it does what staff asked is judged here,
        // with one revision when it doesn't, so an accurate lead that ignores the request is never called fixed.
        let followed = true;
        if (pageAsked.length) {
          try {
            progress("Checking the new lead against what was asked…");
            let verdicts = timeLeft() > 15_000 ? await checkFollowed(pageAsked, text, records, budget) : [];
            let unmet = verdicts.filter((v) => !v.followed);
            if (!verdicts.length) followed = false;
            if (unmet.length && timeLeft() > 25_000) {
              const revised = withClosing(lead, await reviseLead(text, unmet, records, budget));
              if (squash(revised).length >= 20 && revised.length <= LEAD_MAX + 120 && await saveLead(revised)) {
                text = revised;
                verdicts = await checkFollowed(pageAsked, text, records, budget);
                unmet = verdicts.filter((v) => !v.followed);
              }
            }
            if (unmet.length) {
              followed = false; leadUnmet = true;
              for (const v of unmet) left.push(`The lead was rewritten but doesn't yet do what was asked: "${squash(v.instruction).slice(0, 200)}"${v.missing ? ` Still missing: ${v.missing}` : ""}`);
            } else if (!verdicts.length) { leadUnmet = true; left.push("The lead was rewritten but not checked against what was asked: the agent ran out of time. Press Fix again."); }
          } catch (error) {
            console.error("[property-fix] instruction check failed:", error instanceof Error ? error.message : error);
            followed = false; leadUnmet = true;
            left.push("The lead was rewritten but not checked against what was asked: the check itself failed. Press Fix again.");
          }
        }
        if (step.not_supported?.trim()) left.push(`Not added, since the records don't say so: ${squash(step.not_supported)}`);
        if (followed) pageFixed = true;
        claims.push({ id: "lead", key: null, text: `Page lead: ${text}` });
        done.push(`The lead now reads: "${text}"`);
        await log("agent:rewrite_property_lead", { property_id: String(property.id), text: text.slice(0, 400), reason: step.reason.slice(0, 300) });
      }
    }
    if (summaryNotes.length) {
      if (timeLeft() < 20_000) left.push("Ran out of time before the summary rewrite could start. Press Fix again to finish it.");
      else {
        progress("Rewriting the topic's summary and checking it against the records…");
        // Kept on the topic so this rewrite and every later one follow the instruction, as the topic agent does.
        for (const matterId of new Set(summaryNotes.map((n) => n.matter_id))) await saveEditorNotes(supabase, matterId, summaryNotes.filter((n) => n.matter_id === matterId).map((n) => n.note));
        const report = await rewriteSummaries(supabase, summaryNotes.map((n) => n.matter_id), { notes: summaryNotes.map(({ matter_id, note }) => ({ matter_id, note })), signal: budget });
        const unfollowed = new Set(report.unfollowed.map((u) => u.note));
        for (const n of summaryNotes) {
          // A summary a person edited by hand was kept, so the instruction wasn't carried out.
          const held = (report.heldByHand.get(n.matter_id) || []).filter((f) => f !== "title");
          if (held.length) { left.push(heldByHandLine(entryLabel(`matter-${n.matter_id}`, flags), held)); continue; }
          const reason = result.data.actions.find((a) => a.action === "rewrite_summary" && a.key === n.key)?.reason ?? "";
          if (unfollowed.has(n.note) || !report.written.includes(n.matter_id)) {
            left.push(unfollowedLine({ note: n.note, missing: report.unfollowed.find((u) => u.note === n.note)?.missing }));
            continue;
          }
          if (n.key) fixedKeys.add(n.key); else pageFixed = true;
          done.push(`Rewrote the summary of ${entryLabel(`matter-${n.matter_id}`, flags)}${reason ? `: ${reason}` : ""}`);
          await log("agent:rewrite_summary", { matter_id: String(n.matter_id), note: n.note.slice(0, 400) });
        }
        if (report.edited.length) done.push("Edited the summary directly, since the first draft didn't follow the instruction or the records.");
        if (budget.aborted) left.push("Ran out of time (about 90 seconds of model work) before the summary check finished. Press Fix again to finish it.");
      }
    }
    const newlyFixed = flags.map((f, i) => (agreed.includes(f) && ((f.key && fixedKeys.has(f.key)) || (!f.key && pageFixed)) ? i : -1)).filter((i) => i >= 0);
    let updated = flags.map((f, i) => newlyFixed.includes(i) ? { ...f, fixed: true } : f);
    let checkedNote = "";
    let recheckFailed = false;
    if (claims.length && timeLeft() > 10_000) {
      progress("Checking that the fixes hold…");
      try {
        const scopes = new Map<number, string[]>();
        for (const i of newlyFixed) if (!flags[i].key) scopes.set(i, claims.map((c) => c.id));
        const verdicts = scopes.size ? await recheckClaims(claims, records, budget) : new Map();
        const outcome = applyRecheck(updated, newlyFixed, scopes, verdicts, new Date().toISOString());
        updated = outcome.flags;
        const failures = outcome.failed.map((x) => `${flagLabel(flags[x.index])} on ${flags[x.index].key ?? "the page"}: ${x.reason}`);
        checkedNote = recheckSummary(outcome.held, outcome.total, newlyFixed.filter((i) => scopes.has(i)).length, failures);
        for (const failure of failures) left.push(`The fix doesn't hold: ${failure}`);
        recheckFailed = failures.length > 0;
      } catch (error) {
        console.error("[property-fix] re-check failed:", error instanceof Error ? error.message : error);
        checkedNote = "Not re-checked: the check itself failed. Press Check to look again.";
      }
    }
    const note = [
      done.length ? `Changed:\n${done.map((d) => `• ${d}`).join("\n")}` : answered.length ? "" : result.data.actions.length ? "Changed nothing." : "Changed nothing: the agent didn't say what to do.",
      answered.length ? `Left as is:\n${answered.map((d) => `• ${d}`).join("\n")}` : "",
      left.length ? `Needs a person:\n${left.map((d) => `• ${d}`).join("\n")}` : "",
      lookedInto, checkedNote,
    ].filter(Boolean).join("\n\n");
    await finish(!recheckFailed && !leadUnmet && (done.length || (answered.length && !left.length)) ? "fixed" : "needs_work", note, updated);
  } catch (error) {
    console.error("[property-fix]", error instanceof Error ? error.message : error);
    await finish("needs_work", budget.aborted
      ? "The agent ran out of time (about 90 seconds of model work) before it could plan the fix, and changed nothing. Press Fix again, or fix it by hand."
      : `The agent hit an error and changed nothing: ${error instanceof Error ? error.message : String(error)}`);
  }
}
