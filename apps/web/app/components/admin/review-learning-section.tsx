import { Form, useNavigation } from "react-router";
import { FLAG_PROBLEM_LABELS } from "../../lib/page-review-types";
import type { LearningRow } from "../../services/review-learning.server";
import { cn } from "../../lib/utils";

const pct = (agreed: number, rated: number) => (rated ? `${Math.round((agreed / rated) * 100)}%` : "—");

/** How the page check is learning: agreement per problem type and guidance version, and the written rules. */
export function ReviewLearningSection({ rows }: { rows: LearningRow[] }) {
  const busy = useNavigation().state !== "idle";
  return (
    <section aria-labelledby="learning-heading" className="mb-6">
      <h2 id="learning-heading" className="text-lg font-semibold text-zinc-900">How the check is learning</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Every flag you rate is kept as an example; each check reads the ones most like its page. Rules written from
        your ratings replace the check's built-in instructions once you approve them.
      </p>
      <ul className="mt-3 space-y-3">
        {rows.map((r) => (
          <li key={r.problem} className="rounded-2xl border border-zinc-200 bg-surface p-4 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-zinc-900">{FLAG_PROBLEM_LABELS[r.problem]}</span>
              <span className="text-sm tabular-nums text-zinc-600">
                {r.rated ? <>{pct(r.agreed, r.rated)} agreed · {r.agreed} of {r.rated} rated</> : "No ratings yet"}
              </span>
            </div>
            {r.byVersion.length > 1 && (
              <p className="mt-1 text-xs tabular-nums text-zinc-500">
                {r.byVersion.map((v) => `${v.version ? `rules v${v.version}` : "built-in"}: ${pct(v.agreed, v.rated)} of ${v.rated}`).join(" · ")}
              </p>
            )}
            {r.approved && (
              <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                <span className="font-medium">Rule in use (v{r.approved.id}):</span> {r.approved.text}
              </p>
            )}
            {r.draft ? (
              <Form method="post" className="mt-2 rounded-lg border border-amber-200 px-3 py-2">
                <input type="hidden" name="id" value={r.draft.id} />
                <label className="text-xs font-medium text-amber-800" htmlFor={`draft-${r.draft.id}`}>
                  Draft rule from {r.draft.based_on} ratings: edit it if needed, then approve
                </label>
                <textarea id={`draft-${r.draft.id}`} name="text" rows={3} defaultValue={r.draft.text}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-transparent p-2 text-sm text-zinc-900" />
                <div className="mt-1 flex gap-2 text-sm">
                  <button name="intent" value="approve_rule" disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-700">Approve</button>
                  <button name="intent" value="reject_rule" disabled={busy} className="rounded-lg px-3 py-1 text-zinc-600 hover:bg-zinc-100">Discard</button>
                </div>
              </Form>
            ) : r.rated >= 3 && (
              <Form method="post" className="mt-2">
                <input type="hidden" name="problem" value={r.problem} />
                <button name="intent" value="draft_rule" disabled={busy}
                  className={cn("rounded-lg border px-3 py-1 text-sm font-medium",
                    r.sinceDraft >= 5 ? "border-brand-300 text-brand-800 hover:bg-brand-50" : "border-zinc-200 text-zinc-600 hover:bg-zinc-50")}>
                  {r.approved ? "Redraft the rule" : "Draft a rule"}{r.sinceDraft ? ` (${r.sinceDraft} new ratings)` : ""}
                </button>
              </Form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
