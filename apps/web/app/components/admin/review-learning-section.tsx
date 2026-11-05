import { Form, useNavigation } from "react-router";
import { Loader2 } from "lucide-react";
import { DRAFT_AFTER, FLAG_PROBLEM_LABELS, reviewTime } from "../../lib/page-review-types";
import type { LearningRow } from "../../services/review-learning.server";
import { cn } from "../../lib/utils";

const pct = (agreed: number, rated: number) => (rated ? `${Math.round((agreed / rated) * 100)}%` : "—");

/**
 * How the page check is learning, folded to one line until something needs a decision: a problem type you keep
 * disagreeing with (draft a rule for it), a rule you've disagreed with since approving it (look at it again), or a
 * draft waiting. Each type says whether the check uses its built-in instruction or your rule.
 */
export function ReviewLearningSection({ rows }: { rows: LearningRow[] }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  // Drafting is a model call (about ten seconds): the pressed button says so while it runs.
  const pending = navigation.formData;
  const drafting = (problem: string) => pending?.get("intent") === "draft_rule" && pending.get("problem") === problem;
  const deciding = (id: number, intent: string) => pending?.get("intent") === intent && pending.get("id") === String(id);
  const spin = <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin align-[-2px]" />;
  const needs = rows.filter((r) => r.need);
  const rated = rows.reduce((n, r) => n + r.rated, 0), agreed = rows.reduce((n, r) => n + r.agreed, 0);

  return (
    <details open={needs.length > 0} className="group mb-6 rounded-2xl border border-zinc-200 bg-surface shadow-sm">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-2 px-5 py-3">
        <span className="font-medium text-zinc-900">How the check is learning</span>
        <span className={cn("text-sm", needs.length ? "font-medium text-amber-700" : "text-zinc-500")}>
          {needs.length ? `${needs.length} ${needs.length === 1 ? "rule needs" : "rules need"} you`
            : rated ? `Nothing to do · ${pct(agreed, rated)} of flags were real` : "Nothing to do"}
        </span>
      </summary>
      <div className="border-t border-zinc-100 px-5 pb-4 pt-3">
        <p className="text-sm text-zinc-600">
          Every flag you rate guides later checks. Each problem type uses its built-in instruction until you approve a
          rule for it; a rule is worth writing once you've disagreed with the check {DRAFT_AFTER} times on that type.
        </p>
        <ul className="mt-3 divide-y divide-zinc-100">
          {rows.map((r) => (
            <li key={r.problem} className="py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                <span className="font-medium text-zinc-900">{FLAG_PROBLEM_LABELS[r.problem]}</span>
                <span className="tabular-nums text-zinc-600">
                  {r.approved
                    ? <>Your rule · {r.sinceRule.rated ? `${pct(r.sinceRule.agreed, r.sinceRule.rated)} agreed since ${reviewTime(r.approved.decided_at || r.approved.created_at)}` : `approved ${reviewTime(r.approved.decided_at || r.approved.created_at)}, no ratings since`}</>
                    : <>Built-in · {r.rated ? `${pct(r.agreed, r.rated)} agreed (${r.agreed} of ${r.rated})` : "no ratings yet"}</>}
                </span>
              </div>
              {r.approved && !r.draft && (
                <details className="mt-1 text-xs text-zinc-500">
                  <summary className="cursor-pointer select-none">The rule</summary>
                  <p className="mt-1 text-sm text-zinc-700">{r.approved.text}</p>
                </details>
              )}
              {(r.need === "draft_rule" || r.need === "reconsider") && (
                <Form method="post" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <input type="hidden" name="problem" value={r.problem} />
                  <span className="flex-1">
                    {r.need === "draft_rule"
                      ? `You've disagreed with the check ${r.sinceRule.rated - r.sinceRule.agreed} times here. A rule from your ratings could stop it.`
                      : `${r.sinceRule.rated - r.sinceRule.agreed} disagreements since you approved this rule. Redraft it from all your ratings.`}
                  </span>
                  <button name="intent" value="draft_rule" disabled={busy}
                    className="rounded-lg border border-amber-300 bg-surface px-3 py-1 font-medium text-amber-900 hover:bg-amber-100">
                    {drafting(r.problem) ? <>{spin}Drafting…</> : r.need === "draft_rule" ? "Draft a rule" : "Redraft"}
                  </button>
                </Form>
              )}
              {r.draft && (
                <Form method="post" className="mt-2 rounded-lg border border-amber-200 px-3 py-2">
                  <input type="hidden" name="id" value={r.draft.id} />
                  <label className="text-xs font-medium text-amber-800" htmlFor={`draft-${r.draft.id}`}>
                    Draft rule from {r.draft.based_on} ratings: edit it if needed, then approve{r.approved ? " (it replaces the rule in use)" : ""}
                  </label>
                  <textarea id={`draft-${r.draft.id}`} name="text" rows={4} defaultValue={r.draft.text}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-transparent p-2 text-sm text-zinc-900" />
                  <div className="mt-1 flex gap-2 text-sm">
                    <button name="intent" value="approve_rule" disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-700">{deciding(r.draft.id, "approve_rule") && spin}Approve</button>
                    <button name="intent" value="reject_rule" disabled={busy} className="rounded-lg px-3 py-1 text-zinc-600 hover:bg-zinc-100">{deciding(r.draft.id, "reject_rule") && spin}Discard</button>
                  </div>
                </Form>
              )}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
