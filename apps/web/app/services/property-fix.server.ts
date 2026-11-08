import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { FLAG_PROBLEM_LABELS, entryLabel, keepStaffRatings, type PageFlag } from "../lib/page-review-types";
import { recheckClaims, type Claim } from "./page-verify.server";
import { findingText, investigate, investigatedRecords, investigationLine, needsInvestigation } from "./fix-investigation.server";
import { applyRecheck, recheckSummary, flagLabel } from "../lib/page-recheck";
import { logStaffAction } from "./staff.server";
import { quoteInRecords } from "./meeting-fix.server";
import type { StaffRole } from "../lib/auth.server";

/**
 * The fix agent on a property page (/properties/<slug>): an address, or a street with its addresses. The page's
 * own text is its lead (properties.meta.summary, written by the pipeline's property-summaries stage); the rest is
 * the topics and meeting items the pipeline linked to the address, each shown from its own record. So the menu is
 * small: unlink an entry that's about a different address (or only names this one in passing), rewrite the lead,
 * or say the page is right or that a person is needed. A lead the agent writes is locked
 * (meta.summary_locked), so the pipeline keeps it rather than writing its own over it. Same flow as the topic and
 * meeting agents: investigate, plan, act, re-check.
 */

export const PROPERTY_FIX_BUDGET_MS = 90_000;
/** The lead's narrative part, as the pipeline caps it (property_summaries.NARRATIVE_MAX is 320 characters). */
const LEAD_MAX = 400;

const Action = z.object({
  action: z.enum(["unlink_entry", "rewrite_lead", "no_change", "cannot_fix"]),
  key: z.string().nullable().describe("unlink_entry: the entry's key (matter-<id> or item-<id>). no_change / cannot_fix: the key of the flag answered, or null for the whole page. rewrite_lead: null."),
  new_text: z.string().nullable().describe("rewrite_lead: the page's new lead, one or two plain sentences (under 320 characters), outcome first: what happened at this address and whether it affects the reader. The closing \"Mentioned in council meetings…\" line is kept for you. Otherwise null."),
  source: z.string().nullable().describe("rewrite_lead: the record's own words the new lead rests on, quoted exactly, at most 250 characters. Otherwise null."),
  reason: z.string().describe("One short sentence a resident would understand (under 30 words): what you're doing and why, or why it can't be done."),
});
const PlanSchema = z.object({ actions: z.array(Action) });

type Property = { id: number; slug: string; address: string; civic_number: string | null; street: string | null; meta: Record<string, any> | null };
type Topic = { id: number; title: string; status: string | null; first_seen: string | null; last_seen: string | null; plain_english_summary: string | null; meta: Record<string, any> | null; addresses: string[] };
type Item = { id: number; title: string | null; plain_english_summary: string | null; meeting_date: string | null; meeting_title: string | null };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const CLOSING = /(?:^|\s)(Mentioned in council meetings[^.]*\.)\s*$/;

/** The new lead with the old one's closing count line ("Mentioned in council meetings 12 times since 2009.") kept,
 * since the pipeline computes that line and the agent must not guess it. Exported for tests. */
export function withClosing(oldLead: string | null | undefined, text: string): string {
  const body = squash(text);
  const closing = (oldLead || "").match(CLOSING)?.[1];
  if (!closing || /Mentioned in council meetings/i.test(body)) return body;
  return `${body.replace(/\s+$/, "")} ${closing}`;
}

/** What the planner reads: the page's lead and each entry from its own record, keyed as the page keys them. */
export function propertyRecords(property: Property, lead: string | null, topics: Topic[], items: Item[]): string {
  const lines = [`ADDRESS: ${property.address}${property.civic_number ? "" : " (a street: the topics below are about the street itself)"}`,
    `LEAD (the page's own text): ${lead ? squash(lead) : "(none yet)"}`];
  for (const t of topics) {
    lines.push("", `TOPIC matter-${t.id} (${[t.first_seen, t.last_seen].filter(Boolean).map((d) => String(d).slice(0, 10)).join(" to ") || "no dates"}; ${t.status || "no status"}): ${squash(t.title)}`);
    if (t.plain_english_summary) lines.push(`  summary: ${squash(t.plain_english_summary)}`);
    if (t.meta?.status_line) lines.push(`  where it stands: ${squash(t.meta.status_line)}`);
    if (t.addresses.length) lines.push(`  addresses the pipeline linked to this topic: ${t.addresses.slice(0, 12).join("; ")}${t.addresses.length > 12 ? "; …" : ""}`);
  }
  for (const i of items) {
    lines.push("", `ITEM item-${i.id} (${i.meeting_date ?? "no date"}, ${i.meeting_title ?? "meeting"}): ${squash(i.title || "")}`);
    if (i.plain_english_summary) lines.push(`  summary: ${squash(i.plain_english_summary)}`);
  }
  return lines.join("\n");
}

export function propertyPlanPrompt(property: Property, agreed: PageFlag[], note: string | null, records: string, findings: (string | null)[], pageFinding: string | null): string {
  const flagLines = agreed.map((f, i) => `- ${f.key ?? "(whole page)"} · ${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}${f.fix ? ` Suggested: ${f.fix}` : ""}${findings[i] ? `\n  FOUND: ${findings[i]}` : ""}`);
  return `You fix the page for ${property.address} on Open Langford, a site that follows Langford City council. The page
lists the council business the pipeline linked to this address: topics (rezonings, permits, projects) and meeting
items, each shown from its own record, under a short lead the pipeline wrote. A reader checked it and flagged
problems; staff agreed with these:
${flagLines.join("\n") || "(none)"}
${note ? `\nStaff's note: ${note}${pageFinding ? `\n  FOUND: ${pageFinding}` : ""}` : ""}

Actions, one entry in "actions" per flag (and per note):
- unlink_entry: the entry (matter-<id> or item-<id>) is about a different address, or names this one only in
  passing (one address in a list of many, a street mentioned as a landmark). It comes off this page and stays on its
  own. Say which address it is really about.
- rewrite_lead: the lead is wrong, vague or missing. Write one or two plain sentences (under 320 characters) for a
  resident on a phone: what happened at this address and whether it affects them, outcome first, everyday words, the
  number of homes or lots and dollar amounts when the records give them, no bylaw or file numbers. Quote the record
  it rests on in "source". The closing count line is kept for you; don't write one.
- no_change: the flag is not a problem (say why in a sentence a resident would understand).
- cannot_fix: a judgement these actions can't make; say exactly what a person needs to decide.
Work only from the records below. Never invent an outcome, a number or a date.

RECORDS:
${records}`;
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
    const records = [propertyRecords(property as Property, lead, topics, items), researchText].filter(Boolean).join("\n\n");

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
    const at = new Date().toISOString();
    const agreedKeys = new Set(agreed.map((f) => f.key));
    const pageLevel = agreedKeys.has(null) || !!row?.note?.trim();
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
      if (step.action === "rewrite_lead") {
        if (!pageLevel) { left.push(`${step.reason} (no page-level problem was flagged, so the lead stays)`); continue; }
        if (!quoteInRecords(step.source, records)) { left.push(`${step.reason} (its quote isn't the record's exact words, so the lead stays; press Fix again)`); continue; }
        const text = withClosing(lead, step.new_text || "");
        if (squash(step.new_text || "").length < 20 || text.length > LEAD_MAX + 120) { left.push(`${step.reason} (the new lead wasn't usable, so it stays)`); continue; }
        const { data: fresh } = await supabase.from("properties").select("meta").eq("id", property.id).single();
        const current = { ...((fresh?.meta || {}) as Record<string, any>) };
        const meta = { ...current, summary: text, summary_updated_at: at,
          summary_locked: { by: requester.id, at, auto: current.summary_locked?.auto ?? current.summary ?? null, source: squash(step.source || "").slice(0, 400), reason: step.reason.slice(0, 300) } };
        const { error } = await supabase.from("properties").update({ meta }).eq("id", property.id);
        if (error) { left.push(`${step.reason} (couldn't save the new lead)`); continue; }
        pageFixed = true;
        claims.push({ id: "lead", key: null, text: `Page lead: ${text}` });
        done.push(`The lead now reads: "${text}"`);
        await log("agent:rewrite_property_lead", { property_id: String(property.id), text: text.slice(0, 400), reason: step.reason.slice(0, 300) });
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
    await finish(!recheckFailed && (done.length || (answered.length && !left.length)) ? "fixed" : "needs_work", note, updated);
  } catch (error) {
    console.error("[property-fix]", error instanceof Error ? error.message : error);
    await finish("needs_work", budget.aborted
      ? "The agent ran out of time (about 90 seconds of model work) before it could plan the fix, and changed nothing. Press Fix again, or fix it by hand."
      : `The agent hit an error and changed nothing: ${error instanceof Error ? error.message : String(error)}`);
  }
}
