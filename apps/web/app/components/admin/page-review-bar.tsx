import { useEffect, useState } from "react";
import { useFetcher, useLocation } from "react-router";
import { Check, Flag, X } from "lucide-react";
import type { PageReview } from "../../services/page-reviews.server";
import { formatDate } from "../../lib/utils";
import { cn } from "../../lib/utils";

type Loaded = { path: string | null; review: PageReview | null };
type Saved = { ok?: true; review?: PageReview | null; error?: string };

/** Admins only: mark the public page you're on as reviewed or needing work. Tracked in /admin/reviews. */
export function PageReviewBar() {
  const { pathname } = useLocation();
  const load = useFetcher<Loaded>();
  const save = useFetcher<Saved>();
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    setWriting(false);
    load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const loaded = load.data?.path === pathname ? load.data : null;
  if (!loaded?.path) return null;
  const saved = save.data && "review" in save.data && save.state === "idle" ? save.data.review : undefined;
  const review = save.formData ? null : saved !== undefined ? saved : loaded.review;
  const busy = save.state !== "idle";

  const submit = (intent: "reviewed" | "needs_work" | "clear", withNote?: string) => {
    save.submit({ intent, path: pathname, title: document.title, note: withNote ?? "" }, { method: "post", action: "/api/page-review" });
    setWriting(false);
  };

  return (
    <div className="fixed bottom-4 left-4 z-50 max-w-[calc(100vw-2rem)] print:hidden" aria-label="Page review (admin)">
      {writing ? (
        <form
          className="w-80 max-w-full rounded-2xl border border-zinc-200 bg-surface p-3 shadow-lg"
          onSubmit={(e) => { e.preventDefault(); submit("needs_work", note); }}
        >
          <label htmlFor="page-review-note" className="text-xs font-medium text-zinc-600">What needs work?</label>
          <textarea
            id="page-review-note" autoFocus rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-transparent p-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <div className="mt-2 flex justify-end gap-2 text-sm">
            <button type="button" onClick={() => setWriting(false)} className="rounded-lg px-3 py-1.5 text-zinc-600 hover:bg-zinc-100">Cancel</button>
            <button type="submit" className="rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700">Save</button>
          </div>
        </form>
      ) : (
        <div className={cn(
          "flex items-center gap-1 rounded-full border bg-surface py-1 pl-3 pr-1 text-sm shadow-lg",
          review?.status === "reviewed" ? "border-emerald-300" : review?.status === "needs_work" ? "border-amber-300" : "border-zinc-200",
          busy && "opacity-60",
        )}>
          {review?.status === "reviewed" ? (
            <span className="flex items-center gap-1.5 pr-1 text-emerald-700"><Check className="h-4 w-4" />Reviewed {formatDate(review.reviewed_at)}</span>
          ) : review?.status === "needs_work" ? (
            <button type="button" onClick={() => { setNote(review.note || ""); setWriting(true); }}
              className="flex min-w-0 items-center gap-1.5 pr-1 text-amber-700" title={review.note || undefined}>
              <Flag className="h-4 w-4 shrink-0" /><span className="truncate max-w-48">Needs work{review.note ? `: ${review.note}` : ""}</span>
            </button>
          ) : (
            <span className="pr-1 text-zinc-500">Not reviewed</span>
          )}
          {review?.status !== "reviewed" && (
            <button type="button" disabled={busy} onClick={() => submit("reviewed")}
              className="rounded-full px-2.5 py-1 font-medium text-emerald-700 hover:bg-emerald-50">Reviewed</button>
          )}
          {!review && (
            <button type="button" disabled={busy} onClick={() => { setNote(""); setWriting(true); }}
              className="rounded-full px-2.5 py-1 font-medium text-amber-700 hover:bg-amber-50">Needs work</button>
          )}
          {review && (
            <button type="button" disabled={busy} onClick={() => submit("clear")} aria-label="Clear review"
              className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X className="h-4 w-4" /></button>
          )}
        </div>
      )}
      {save.data?.error && <p className="mt-1 rounded-lg bg-surface px-2 py-1 text-xs text-red-700 shadow">{save.data.error}</p>}
    </div>
  );
}
