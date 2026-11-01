import { useEffect, useState } from "react";
import { useFetcher, useLocation } from "react-router";
import { Check, Flag, Sparkles, ThumbsDown, ThumbsUp, X } from "lucide-react";
import type { PageFlag, PageReview } from "../../lib/page-review-types";
import { cn, formatDate } from "../../lib/utils";

type Loaded = { path: string | null; review: PageReview | null };
type Saved = { ok?: true; review?: PageReview | null; error?: string };

const PROBLEM_LABELS: Record<PageFlag["problem"], string> = {
  unclear_why: "Unclear why it's here",
  generic_text: "Generic text",
  different_story: "Different story",
  duplicate: "Duplicate",
  wrong_detail: "Wrong detail",
};

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
      card.title = `${PROBLEM_LABELS[flag.problem]}: ${flag.reason}`;
      marked.push(card);
    });
    return () => marked.forEach((card) => { card.style.outline = ""; card.style.outlineOffset = ""; card.title = ""; });
  }, [flags, on]);
}

/** Admins only: mark the public page you're on as reviewed or needing work, or have the model read it and flag
 * what a resident would trip over. Rate each flag; ratings calibrate later checks. Tracked in /admin/reviews. */
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
  const busy = save.state !== "idle";
  const submit = (intent: string, extra: Record<string, string> = {}) => {
    save.submit({ intent, path: pathname, title: document.title, ...extra }, { method: "post", action: "/api/page-review" });
    if (intent === "check") setOpen(true);
    setWriting(false);
  };
  const agreedNote = () => flags.filter((f) => f.verdict === "agree").map((f) => `${PROBLEM_LABELS[f.problem]}: ${f.reason}`).join("\n");

  return (
    <div className="fixed bottom-4 left-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col items-start gap-2 print:hidden" aria-label="Page review (admin)">
      {open && (review?.ai_checked_at || pending === "check") && !writing && (
        <div className="max-h-[60vh] w-96 max-w-full overflow-y-auto rounded-2xl border border-zinc-200 bg-surface p-3 text-sm shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-medium text-zinc-900">
              {pending === "check" ? "Reading the page…" : `${flags.length} ${flags.length === 1 ? "flag" : "flags"}`}
            </span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
          </div>
          {pending !== "check" && review?.ai_page_issue && (
            <p className="mb-2 rounded-lg bg-amber-50 px-2.5 py-2 text-amber-900">Whole page: {review.ai_page_issue}</p>
          )}
          {pending !== "check" && flags.length === 0 && !review?.ai_page_issue && <p className="text-zinc-500">Nothing stood out.</p>}
          {pending !== "check" && (
            <ol className="space-y-2">
              {flags.map((flag, index) => (
                <li key={index} className={cn("rounded-lg border px-2.5 py-2", flag.verdict === "disagree" ? "border-zinc-100 opacity-50" : "border-zinc-200")}>
                  <div className="flex items-start justify-between gap-2">
                    <a href={flag.key ? `#timeline-${flag.key}` : undefined} className="min-w-0">
                      <span className="text-xs font-semibold uppercase tracking-wide text-amber-700">{PROBLEM_LABELS[flag.problem]}</span>
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
          {pending !== "check" && review?.ai_checked_at && (
            <p className="mt-2 text-xs text-zinc-400">Checked {formatDate(review.ai_checked_at)} · 👍 means it's a real problem</p>
          )}
        </div>
      )}
      {writing ? (
        <form
          className="w-80 max-w-full rounded-2xl border border-zinc-200 bg-surface p-3 shadow-lg"
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
          "flex items-center gap-1 rounded-full border bg-surface py-1 pl-3 pr-1 text-sm shadow-lg",
          review?.status === "reviewed" ? "border-emerald-300" : review?.status === "needs_work" ? "border-amber-300" : "border-zinc-200",
          busy && pending !== "check" && "opacity-60",
        )}>
          {review?.status === "reviewed" ? (
            <span className="flex items-center gap-1.5 pr-1 text-emerald-700"><Check className="h-4 w-4" />Reviewed {review.reviewed_at ? formatDate(review.reviewed_at) : ""}</span>
          ) : review?.status === "needs_work" ? (
            <button type="button" onClick={() => { setNote(review.note || ""); setWriting(true); }}
              className="flex min-w-0 items-center gap-1.5 pr-1 text-amber-700" title={review.note || undefined}>
              <Flag className="h-4 w-4 shrink-0" /><span className="max-w-48 truncate">Needs work{review.note ? `: ${review.note}` : ""}</span>
            </button>
          ) : (
            <span className="pr-1 text-zinc-500">Not reviewed</span>
          )}
          {review?.status !== "reviewed" && (
            <button type="button" disabled={busy} onClick={() => submit("reviewed")}
              className="rounded-full px-2.5 py-1 font-medium text-emerald-700 hover:bg-emerald-50">Reviewed</button>
          )}
          {!review?.status && (
            <button type="button" disabled={busy} onClick={() => { setNote(agreedNote()); setWriting(true); }}
              className="rounded-full px-2.5 py-1 font-medium text-amber-700 hover:bg-amber-50">Needs work</button>
          )}
          <button type="button" disabled={busy}
            onClick={() => (review?.ai_checked_at && !open ? setOpen(true) : submit("check"))}
            title={review?.ai_checked_at ? "Show flags (opens) · run again from the panel" : "Have the model read this page and flag problems"}
            className="flex items-center gap-1 rounded-full px-2.5 py-1 font-medium text-brand-700 hover:bg-brand-50">
            <Sparkles className={cn("h-4 w-4", pending === "check" && "animate-pulse")} />
            {pending === "check" ? "Checking…" : review?.ai_checked_at ? (open ? "Check again" : `${flags.length} ${flags.length === 1 ? "flag" : "flags"}`) : "Check"}
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
