/**
 * Replays the page review's cheaper-model candidates against the strong model, read-only: it re-runs only the check
 * prompts (no database writes, no usage rows) and prints each check's disagreement rate and latency.
 *
 *   npx tsx scripts/replay-checks.ts [N] [--origin https://openlangford.ca] [--checks note,related]
 *
 * N (default 30) is how many of the latest page paths with a completed check (page_reviews.ai_checked_at) to use.
 *  - note:    the approved summary instructions kept on those topics (meta.editor_notes), each judged against the
 *             topic's current summary: followed or not (checkSummaryNotes).
 *  - related: the Related topics cards on those pages, each judged belongs / not (checkRelatedTopics); the page is read
 *             from `origin` as a visitor sees it.
 * The admin keys come from .env (repo root and apps/web); nothing secret is printed.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));
for (const file of [resolve(here, "../../../.env"), resolve(here, "../.env")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
process.env.AI_USAGE_LOGGING = "false";

const toml = readFileSync(resolve(here, "../wrangler.toml"), "utf8");
const tomlVar = (name: string) => toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
const FAST = process.env.AI_MODEL || tomlVar("AI_MODEL") || "gpt-6-luna";
const STRONG = process.env.REVIEW_AI_MODEL || tomlVar("REVIEW_AI_MODEL") || "gpt-6.1-terra";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
const origin = flag("--origin") ?? "https://openlangford.ca";
const checks = (flag("--checks") ?? "note,related").split(",");

async function main() {
  const { createAiClient, setAiClientForTesting } = await import("../app/services/ai/client.server");
  const { resolveAiConfig } = await import("../app/services/ai/config.server");
  const { createOpenAIProvider } = await import("../app/services/ai/providers/openai.server");
  const { setPageRenderer } = await import("../app/lib/page-render.server");
  const { readPage, checkRelatedTopics } = await import("../app/services/page-check.server");
  const { checkSummaryNotes } = await import("../app/services/topic-summaries.server");
  const { matterForPath } = await import("../app/services/page-links.server");
  const { sameSiteTopics } = await import("../app/services/properties");

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !process.env.OPENAI_API_KEY) throw new Error("SUPABASE_URL, SUPABASE_SECRET_KEY and OPENAI_API_KEY are needed (.env).");
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  setPageRenderer((request) => fetch(request));

  const latencies: Record<string, number[]> = {};
  const use = (model: string, label: string) => {
    const config = resolveAiConfig({ OPENAI_API_KEY: process.env.OPENAI_API_KEY, NOTE_CHECK_AI_MODEL: model, RELATED_CHECK_AI_MODEL: model });
    setAiClientForTesting(createAiClient({
      config, provider: createOpenAIProvider({ apiKey: config.apiKey }),
      onUsage: (e) => { (latencies[label] ||= []).push(e.latencyMs); },
    }));
  };
  const stat = (label: string) => {
    const xs = [...(latencies[label] || [])].sort((a, b) => a - b);
    if (!xs.length) return "no calls";
    return `${xs.length} calls, median ${(xs[Math.floor(xs.length / 2)] / 1000).toFixed(1)} s, max ${(xs[xs.length - 1] / 1000).toFixed(1)} s`;
  };

  // Newest completed checks first. The note check needs topics that carry instructions, so it reads further back.
  const { data: rows } = await supabase.from("page_reviews").select("path, ai_checked_at").not("ai_checked_at", "is", null)
    .like("path", "/matters/%").order("ai_checked_at", { ascending: false }).limit(Math.max(n, 400));
  const paths = (rows || []).map((r: any) => r.path as string);
  console.log(`models: fast=${FAST} strong=${STRONG}; ${paths.length} checked topic pages found`);

  if (checks.includes("note")) {
    const samples: { matter_id: number; note: string; path: string }[] = [];
    for (const path of paths) {
      if (samples.length >= n) break;
      const id = await matterForPath(supabase, path);
      if (!id) continue;
      const { data: m } = await supabase.from("matters").select("meta").eq("id", id).single();
      for (const note of ((m?.meta as any)?.editor_notes || []) as unknown[]) {
        if (typeof note === "string" && note.trim() && samples.length < n) samples.push({ matter_id: id, note, path });
      }
    }
    const verdicts: Record<string, boolean[]> = {};
    for (const [label, model] of [["fast", FAST], ["strong", STRONG]] as const) {
      use(model, `note:${label}`);
      const out: boolean[] = [];
      // One at a time: latency is per call, not per batch.
      for (const s of samples) out.push((await checkSummaryNotes(supabase, [{ matter_id: s.matter_id, note: s.note }])).length === 0);
      verdicts[label] = out;
    }
    const diff = samples.filter((_, i) => verdicts.fast[i] !== verdicts.strong[i]).length;
    console.log(`\nnote check (is a summary instruction followed?): ${samples.length} instructions from the latest checked topics`);
    console.log(`  disagreement ${diff}/${samples.length} = ${samples.length ? ((100 * diff) / samples.length).toFixed(0) : 0}%`
      + `  (followed: fast ${verdicts.fast.filter(Boolean).length}, strong ${verdicts.strong.filter(Boolean).length})`);
    console.log(`  fast:   ${stat("note:fast")}\n  strong: ${stat("note:strong")}`);
  }

  if (checks.includes("related")) {
    type Case = { path: string; matterId: number; entries: { key: string; text: string }[]; sameSite: Set<number> };
    const cases: Case[] = [];
    for (const path of paths.slice(0, n)) {
      try {
        const html = await (await fetch(new URL(path, origin), { headers: { Accept: "text/html" } })).text();
        const entries = readPage(html).entries.filter((e) => /^related-\d+$/.test(e.key));
        const matterId = await matterForPath(supabase, path);
        if (!entries.length || !matterId) continue;
        cases.push({ path, matterId, entries, sameSite: new Set((await sameSiteTopics(supabase, matterId).catch(() => [])).map((m: any) => m.id)) });
      } catch (error) {
        console.log(`  skipped ${path}: ${error instanceof Error ? error.message : error}`);
      }
    }
    const results: Record<string, Map<string, string>[]> = { fast: [], strong: [] };
    for (const [label, model] of [["fast", FAST], ["strong", STRONG]] as const) {
      use(model, `related:${label}`);
      for (const c of cases) {
        const flags = await checkRelatedTopics(supabase, c.matterId, c.entries, c.sameSite).catch(() => null);
        results[label].push(new Map(c.entries.slice(0, 8).map((e) => [e.key, flags?.find((f) => f.key === e.key)?.problem ?? (flags ? "belongs" : "error")])));
      }
    }
    let total = 0, diff = 0, pagesDiff = 0;
    cases.forEach((_, i) => {
      let any = false;
      for (const [k, v] of results.fast[i]) { total++; if (v !== results.strong[i].get(k)) { diff++; any = true; } }
      if (any) pagesDiff++;
    });
    console.log(`\nrelated-topics check (does each Related topics card belong?): ${cases.length} pages with cards of the latest ${Math.min(n, paths.length)} checked, ${total} cards`);
    console.log(`  disagreement ${diff}/${total} cards = ${total ? ((100 * diff) / total).toFixed(0) : 0}%  (${pagesDiff} of ${cases.length} pages differ)`);
    console.log(`  fast:   ${stat("related:fast")}\n  strong: ${stat("related:strong")}`);
  }
  setAiClientForTesting(null);
}

main().catch((error) => { console.error("replay failed:", error instanceof Error ? error.message : error); process.exit(1); });
