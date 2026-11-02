import { useEffect, useState } from "react";
import { useFetcher, useLocation } from "react-router";
import { Check, Flag, RefreshCw, Sparkles, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { FLAG_PROBLEM_LABELS, reviewTime, type PageFlag, type PageReview } from "../../lib/page-review-types";
import { cn } from "../../lib/utils";

type Loaded = { path: string | null; review: PageReview | null };
type Saved = { ok?: true; review?: PageReview | null; error?: string };

/** Outline the flagged timeline entries while the panel is open. */
function useHighlights(flags: PageFlag[], on: boolean) {
  useEffect(() => {
    if (!on) return;
    const marked: HTMLElement[] = [];
    flags.forEach((flag) => {
      const card = flag.key ? document.getElementById(`timeline-${flag.key}`)?.querySelector<HTMLElement>(":scope > div") : null;
      if (!card || flag.verdict === "disagree") return;
      card.style.outline = `2px solid ${flag.verdict === "agree" ? "rgb(220 38 38)" : "rgb(245 158 11)"}`;
      card.style.outlineOffset = "2px";
      card.title = `${FLAG_PROBLEM_LABELS[flag.problem]}: ${flag.reason}`;
      marked.push(card);
    });
    return () => marked.forEach((card) => { card.style.outline = ""; card.style.outlineOffset = ""; card.title = ""; });
  }, [flags, on]);
}

function readWhat(review: PageReview) {
  const n = review.ai_entries ?? 0;
  return n > 0 ? `the title, summary and ${n} timeline ${n === 1 ? "entry" : "entries"}` : "the page's text";
}

/** Admins and moderators: mark the public page you're on as reviewed or needing work, or have the model read it
 * the way a resident would and flag problems. Rate each flag; ratings calibrate later checks. See /admin/reviews. */
export function PageReviewBar() {
  const { pathname } = useLocation();
  const load = useFetcher<Loaded>();
  const save = useFetcher<Saved>();
  const [writing, setWriting] = useState(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    setWriting(false);
    setOpen(false);
    load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const loaded = load.data?.path === pathname ? load.data : null;
  const saved = save.state === "idle" && save.data && "review" in save.data && save.data.review?.path === pathname ? save.data.review : undefined;
  const review = saved !== undefined ? saved : loaded?.review ?? null;
  const flags = review?.ai_flags || [];
  useHighlights(flags, open);
  if (!loaded?.path) return null;

  const pending = save.formData?.get("intent");
  const checking = pending === "check";
  const busy = save.state !== "idle";
  const submit = (intent: string, extra: Record<string, string> = {}) => {
    save.submit({ intent, path: pathname, title: document.title, ...extra }, { method: "post", action: "/api/page-review" });
    if (intent === "check") setOpen(true);
    setWriting(false);
  };
  const agreedNote = () => flags.filter((f) => f.verdict === "agree").map((f) => `${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}`).join("\n");
  const button = "whitespace-nowrap rounded-full px-2.5 py-1 font-medium";

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 flex flex-col items-start gap-2 sm:right-auto print:hidden" aria-label="Page review (staff)">
      {open && (review?.ai_checked_at || checking) && !writing && (
        <div className="max-h-[60vh] w-full overflow-y-auto rounded-2xl border border-zinc-200 bg-surface p-4 text-sm shadow-lg sm:w-[26rem]">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-zinc-900">
                {checking ? "Reading the page…" : flags.length ? `${flags.length} ${flags.length === 1 ? "problem" : "problems"} flagged` : "No problems flagged"}
              </div>
              {!checking && review?.ai_checked_at && (
                <p className="text-xs text-zinc-500">Read {readWhat(review)} · {reviewTime(review.ai_checked_at)}</p>
              )}
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
          </div>
          {checking ? (
            <p className="text-zinc-500">The model is reading this page as a resident would. This takes a few seconds.</p>
          ) : (
            <>
              {review?.ai_summary && <p className="mb-3 leading-relaxed text-zinc-700">{review.ai_summary}</p>}
              {review?.ai_page_issue && (
                <p className="mb-3 rounded-lg bg-amber-50 px-2.5 py-2 text-amber-900">Whole page: {review.ai_page_issue}</p>
              )}
              {flags.length > 0 && (
                <ol className="mb-3 space-y-2">
                  {flags.map((flag, index) => (
                    <li key={index} className={cn("rounded-lg border px-2.5 py-2", flag.verdict === "disagree" ? "border-zinc-100 opacity-50" : "border-zinc-200")}>
                      <div className="flex items-start justify-between gap-2">
                        <a href={flag.key ? `#timeline-${flag.key}` : undefined} className="min-w-0">
                          <span className="text-xs font-semibold uppercase tracking-wide text-amber-700">{FLAG_PROBLEM_LABELS[flag.problem]}</span>
                          <p className="text-zinc-800">{flag.reason}</p>
                          <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{flag.excerpt}</p>
                        </a>
                        <div className="flex shrink-0 gap-0.5">
                          {(["agree", "disagree"] as const).map((verdict) => (
                            <button key={verdict} type="button" disabled={busy}
                              aria-label={verdict === "agree" ? "Right, this is a problem" : "Wrong, this is fine"}
                              aria-pressed={flag.verdict === verdict}
                              onClick={() => submit("rate", { index: String(index), verdict: flag.verdict === verdict ? "none" : verdict })}
                              className={cn("rounded-full p-1.5",
                                flag.verdict === verdict ? (verdict === "agree" ? "bg-red-100 text-red-700" : "bg-zinc-200 text-zinc-700") : "text-zinc-400 hover:bg-zinc-100")}>
                              {verdict === "agree" ? <ThumbsUp className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
                            </button>
                          ))}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {flags.length > 0 && <p className="mb-3 text-xs text-zinc-500">👍 it's a real problem · 👎 it's fine. Your ratings teach later checks.</p>}
              <details className="text-xs text-zinc-500">
                <summary className="cursor-pointer select-none font-medium text-zinc-600">What it looks for</summary>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                  {Object.values(FLAG_PROBLEM_LABELS).map((label) => <li key={label}>{label}</li>)}
                </ul>
                <p className="mt-1.5">It reads only what's on this page, as a signed-out resident sees it. It doesn't open the minutes or agendas behind each entry, so it can't confirm facts against the source.</p>
              </details>
              <button type="button" disabled={busy} onClick={() => submit("check")}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
                <RefreshCw className="h-3.5 w-3.5" />Check again
              </button>
            </>
          )}
        </div>
      )}
      {writing ? (
        <form
          className="w-full rounded-2xl border border-zinc-200 bg-surface p-3 shadow-lg sm:w-80"
          onSubmit={(e) => { e.preventDefault(); submit("needs_work", { note }); }}
        >
          <label htmlFor="page-review-note" className="text-xs font-medium text-zinc-600">What needs work?</label>
          <textarea
            id="page-review-note" autoFocus rows={4} value={note} onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-transparent p-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <div className="mt-2 flex justify-end gap-2 text-sm">
            <button type="button" onClick={() => setWriting(false)} className="rounded-lg px-3 py-1.5 text-zinc-600 hover:bg-zinc-100">Cancel</button>
            <button type="submit" className="rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700">Save</button>
          </div>
        </form>
      ) : (
        <div className={cn(
          "flex max-w-full items-center gap-0.5 rounded-full border bg-surface py-1 pl-3 pr-1 text-sm shadow-lg",
          review?.status === "reviewed" ? "border-emerald-300" : review?.status === "needs_work" ? "border-amber-300" : "border-zinc-200",
          busy && !checking && "opacity-60",
        )}>
          {review?.status === "reviewed" ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap pr-1 text-emerald-700"><Check className="h-4 w-4" />Reviewed<span className="hidden sm:inline"> {reviewTime(review.reviewed_at)}</span></span>
          ) : review?.status === "needs_work" ? (
            <button type="button" onClick={() => { setNote(review.note || ""); setWriting(true); }}
              className="flex min-w-0 items-center gap-1.5 pr-1 text-amber-700" title={review.note || undefined}>
              <Flag className="h-4 w-4 shrink-0" /><span className="max-w-40 truncate">Needs work{review.note ? `: ${review.note}` : ""}</span>
            </button>
          ) : (
            <span className="hidden whitespace-nowrap pr-1 text-zinc-500 sm:inline">Not reviewed</span>
          )}
          {review?.status !== "reviewed" && (
            <button type="button" disabled={busy} onClick={() => submit("reviewed")} className={cn(button, "text-emerald-700 hover:bg-emerald-50")}>Reviewed</button>
          )}
          {!review?.status && (
            <button type="button" disabled={busy} onClick={() => { setNote(agreedNote()); setWriting(true); }}
              className={cn(button, "text-amber-700 hover:bg-amber-50")}>Needs work</button>
          )}
          <button type="button" disabled={busy}
            onClick={() => (review?.ai_checked_at ? setOpen(!open) : submit("check"))}
            title={review?.ai_checked_at ? "Show what the check found" : "Have the model read this page and flag problems"}
            className={cn(button, "flex items-center gap-1 text-brand-700 hover:bg-brand-50")}>
            <Sparkles className={cn("h-4 w-4", checking && "animate-pulse")} />
            {checking ? "Checking…" : review?.ai_checked_at ? (flags.length ? `${flags.length} ${flags.length === 1 ? "flag" : "flags"}` : "Checked") : "Check"}
          </button>
          {review?.status && (
            <button type="button" disabled={busy} onClick={() => submit("clear")} aria-label="Clear review"
              className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X className="h-4 w-4" /></button>
          )}
        </div>
      )}
      {save.data?.error && save.state === "idle" && <p className="rounded-lg bg-surface px-2 py-1 text-xs text-red-700 shadow">{save.data.error}</p>}
    </div>
  );
}
