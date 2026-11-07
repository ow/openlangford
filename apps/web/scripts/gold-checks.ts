/**
 * Scores the page check against what staff decided, read-only: it re-runs the check on pages whose flags staff
 * rated (nothing is written to page_reviews, no usage rows) and reports, per page and in total:
 *   - recall:      agreed flags that are still open (not fixed) which the check raised again;
 *   - regressions: agreed flags marked fixed which the check raised again (the fix didn't hold, or the check is wrong);
 *   - false alarms: flags staff disagreed with which the check raised again;
 *   - new:         flags on entries staff never rated (could be real; listed, not scored);
 *   - agreement:   with --runs 2+, how often two runs raise the same flags (run-to-run consistency).
 * Hand-kept cases in tests/gold/page-checks.json add `expect` (must raise) and `reject` (must not raise) flags.
 *
 *   npx tsx scripts/gold-checks.ts [--days 14] [--limit 20] [--runs 1] [--paths /matters/a,/matters/b] [--origin https://openlangford.ca]
 *
 * The admin keys come from .env (repo root and apps/web); nothing secret is printed. Each page costs the check's
 * usual AI calls (two readings, the records check, related topics) per run.
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

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const days = Number(opt("--days") ?? 14);
const limit = Number(opt("--limit") ?? 20);
const runs = Math.max(1, Number(opt("--runs") ?? 1));
const only = opt("--paths")?.split(",").map((p) => p.trim()).filter(Boolean);
const origin = opt("--origin") ?? "https://openlangford.ca";

type Flag = { key: string | null; problem: string; reason: string; fix?: string | null; verdict: string | null; fixed?: boolean };
type HandCase = { path: string; expect?: Rule[]; reject?: Rule[]; lesson?: string };
type Rule = { key?: string | null; problem?: string; about?: string };

const matches = (rule: Rule, f: Flag) =>
  (rule.key === undefined || rule.key === f.key) && (!rule.problem || rule.problem.split("|").includes(f.problem))
  && (!rule.about || new RegExp(rule.about, "i").test(`${f.reason} ${f.fix || ""}`));
const same = (a: Flag, b: Flag) => a.key === b.key && a.problem === b.problem;
const label = (f: Flag) => `${f.key ?? "page"} ${f.problem}: ${f.reason.slice(0, 90)}`;

async function main() {
  const { setPageRenderer } = await import("../app/lib/page-render.server");
  const { runCheck } = await import("../app/services/page-check.server");
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !process.env.OPENAI_API_KEY) throw new Error("SUPABASE_URL, SUPABASE_SECRET_KEY and OPENAI_API_KEY are needed (.env).");
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  setPageRenderer((request) => fetch(request));

  const hand = JSON.parse(readFileSync(resolve(here, "../tests/gold/page-checks.json"), "utf8")).cases as HandCase[];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: rows } = await supabase.from("page_reviews").select("path, status, ai_flags, ai_checked_at").like("path", "/matters/%")
    .gte("ai_checked_at", since).order("ai_checked_at", { ascending: false }).limit(400);
  const rated = (rows || []).filter((r: any) => (r.ai_flags as Flag[]).some((f) => f.verdict !== null)).map((r: any) => r.path as string);
  const paths = [...new Set([...(only ?? [...rated, ...hand.map((c) => c.path)])])].filter((p) => !only || only.includes(p)).slice(0, only ? undefined : limit);
  console.log(`${paths.length} pages (${rated.length} with staff ratings in the last ${days} days, ${hand.length} hand cases); ${runs} run(s) each; origin ${origin}`);

  const totals = { open: 0, openHit: 0, fixed: 0, fixedBack: 0, rejected: 0, rejectedBack: 0, expect: 0, expectHit: 0, reject: 0, rejectBack: 0, newFlags: 0, pairs: 0, agree: 0 };
  for (const path of paths) {
    const prior = ((rows || []).find((r: any) => r.path === path)?.ai_flags || []) as Flag[];
    const open = prior.filter((f) => f.verdict === "agree" && !f.fixed && f.problem !== "editor_issue");
    const fixed = prior.filter((f) => f.verdict === "agree" && f.fixed && f.problem !== "editor_issue");
    const rejected = prior.filter((f) => f.verdict === "disagree");
    const c = hand.find((h) => h.path === path);
    const results: Flag[][] = [];
    for (let i = 0; i < runs; i++) {
      try {
        results.push((await runCheck(supabase, origin, path)).flags.filter((f) => f.problem !== "editor_issue") as Flag[]);
      } catch (error) {
        console.log(`\n${path}\n  check failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (!results.length) continue;
    const got = results[0];
    const hit = (f: Flag) => got.some((g) => same(g, f));
    const lines: string[] = [];
    for (const f of open) { totals.open++; if (hit(f)) totals.openHit++; else lines.push(`  MISSED (agreed, still open)  ${label(f)}`); }
    for (const f of fixed) { totals.fixed++; if (hit(f)) { totals.fixedBack++; lines.push(`  BACK (agreed and fixed)      ${label(f)}`); } }
    for (const f of rejected) { totals.rejected++; if (hit(f)) { totals.rejectedBack++; lines.push(`  FALSE ALARM (staff said no)  ${label(f)}`); } }
    for (const r of c?.expect || []) { totals.expect++; if (got.some((g) => matches(r, g))) totals.expectHit++; else lines.push(`  MISSED (hand case)           ${JSON.stringify(r)}`); }
    for (const r of c?.reject || []) { totals.reject++; const g = got.find((x) => matches(r, x)); if (g) { totals.rejectBack++; lines.push(`  REJECTED FLAG RAISED         ${label(g)}`); } }
    const fresh = got.filter((g) => !prior.some((p) => same(p, g)));
    totals.newFlags += fresh.length;
    for (const g of fresh) lines.push(`  new                          ${label(g)}`);
    for (let i = 1; i < results.length; i++) {
      const a = results[i - 1], b = results[i];
      const union = [...a, ...b.filter((f) => !a.some((x) => same(x, f)))];
      for (const f of union) { totals.pairs++; if (a.some((x) => same(x, f)) && b.some((x) => same(x, f))) totals.agree++; }
    }
    console.log(`\n${path}\n  open ${open.filter(hit).length}/${open.length} re-raised, fixed ${fixed.filter(hit).length}/${fixed.length} back, rejected ${rejected.filter(hit).length}/${rejected.length} back, ${fresh.length} new${c?.lesson ? `\n  hand case: ${c.lesson}` : ""}`);
    for (const l of lines) console.log(l);
  }
  const pct = (a: number, b: number) => (b ? `${a}/${b} = ${Math.round((100 * a) / b)}%` : "n/a");
  console.log(`\nSCORECARD`);
  console.log(`  recall on open agreed flags:        ${pct(totals.openHit, totals.open)}   (higher is better)`);
  console.log(`  fixed flags raised again:           ${pct(totals.fixedBack, totals.fixed)}   (a fix that didn't hold, or a wrong check)`);
  console.log(`  false alarms (rejected, re-raised): ${pct(totals.rejectedBack, totals.rejected)}   (lower is better)`);
  console.log(`  hand cases: must-raise ${pct(totals.expectHit, totals.expect)}, must-not-raise broken ${pct(totals.rejectBack, totals.reject)}`);
  console.log(`  new flags on unrated entries:       ${totals.newFlags}   (not scored: rate them and they join the set)`);
  if (runs > 1) console.log(`  run-to-run agreement:               ${pct(totals.agree, totals.pairs)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
