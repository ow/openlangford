import { useEffect, useState } from "react";
import { useFetcher, useLocation } from "react-router";
import { Check, Flag, Loader2, RefreshCw, Search, Sparkles, ThumbsDown, ThumbsUp, Wrench, X } from "lucide-react";
import { FLAG_PROBLEM_LABELS, reviewTime, unresolvedFlags, type PageFlag, type PageReview } from "../../lib/page-review-types";
import { cn } from "../../lib/utils";

type Suggestion = {
  table: string; id: number; kind: "mention" | "related" | "report"; date: string | null; title: string; quote: string | null;
  href: string | null; reason: string | null; score: number | null; foundIn: "item" | "document" | "spoken" | "report" | "topic" | null;
};
const FOUND_IN = { item: "In the item's text", document: "In a document attached to the item", spoken: "Said at the meeting", report: "In the annual report", topic: "Shares a name with this topic" };
type FindJob = { status: string; requested_at: string; finished_at: string | null; suggested: number | null };
type Links = { suggestions: Suggestion[]; findJob: FindJob | null } | null;
type Loaded = { path: string | null; review: PageReview | null; links: Links };
type Saved = { ok?: true; review?: PageReview | null; links?: Links; message?: string | null; error?: string };

/** Entries found for this topic can be removed here; items filed under the topic itself can't. */
const removable = (key: string | null) => !!key && /^(mention|background|report)-\d+$/.test(key);

function findStatus(job: FindJob | null) {
  if (!job) return null;
  if (job.status === "queued") return `Waiting for the pipeline (asked ${reviewTime(job.requested_at)}).`;
  if (job.status === "running" || job.status === "claimed") return "The pipeline is searching now…";
  if (job.status === "succeeded" || job.status === "completed")
    return `Last search ${reviewTime(job.finished_at)}: ${job.suggested ?? 0} new ${job.suggested === 1 ? "suggestion" : "suggestions"}.`;
  return `The last search didn't finish (${job.status}).`;
}

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
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    setWriting(false);
    setOpen(false);
    setConfirming(null);
    load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const loaded = load.data?.path === pathname ? load.data : null;
  const fresher = (a?: string | null, b?: string | null) => (a || "") > (b || "");
  const savedRaw = save.state === "idle" && save.data && "review" in save.data && save.data.review?.path === pathname ? save.data.review : undefined;
  // While the agent works, the poll's copy is newer than the one the "needs work" click returned.
  const saved = savedRaw && loaded?.review && savedRaw.status === "fixing" && loaded.review.status !== "fixing"
    && !fresher(savedRaw.agent_at, loaded.review.agent_at) ? undefined : savedRaw;
  const review = saved !== undefined ? saved : loaded?.review ?? null;
  const links: Links = saved !== undefined && save.data?.links !== undefined ? save.data.links ?? null : loaded?.links ?? null;
  const suggestions = links?.suggestions || [];
  const flags = review?.ai_flags || [];
  const open_ = unresolvedFlags(flags).length;
  useHighlights(flags, open);
  const fixing = review?.status === "fixing";
  useEffect(() => {
    if (!fixing) return;
    const timer = setInterval(() => load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixing, pathname]);
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
      {(open || review?.status === "fixed") && (review?.ai_checked_at || checking || links || review?.agent_note) && !writing && (
        <div className="max-h-[60vh] w-full overflow-y-auto rounded-2xl border border-zinc-200 bg-surface p-4 text-sm shadow-lg sm:w-[26rem]">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-zinc-900">
                {checking ? "Reading the page…" : !review?.ai_checked_at ? "Not checked yet" : flags.length ? `${flags.length} ${flags.length === 1 ? "problem" : "problems"} flagged` : "No problems flagged"}
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
              {review?.agent_note && (review.status === "fixed" || review.status === "needs_work" || review.status === "fixing") && (
                <div className={cn("mb-3 rounded-lg px-2.5 py-2", review.status === "needs_work" ? "bg-amber-50" : "bg-brand-50")}>
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-700">
                    {review.status === "fixing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                    {{ fixed: "The agent fixed this page", needs_work: "The agent couldn't fix this page", fixing: "The agent is working" }[review.status]} · {reviewTime(review.agent_at)}
                  </div>
                  <p className="whitespace-pre-line text-zinc-800">{review.agent_note}</p>
                  {review.status === "fixed" && (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <button type="button" disabled={busy || open_ > 0} onClick={() => submit("reviewed")}
                        title={open_ > 0 ? "Some flags are still open" : undefined}
                        className="rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white hover:bg-emerald-700 disabled:opacity-50">Looks good</button>
                      <button type="button" disabled={busy} onClick={() => { setNote(review.note || ""); setWriting(true); }}
                        className="rounded-md px-2.5 py-1 font-medium text-amber-800 hover:bg-amber-100">Still needs work</button>
                    </div>
                  )}
                </div>
              )}
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
                      {flag.fixed && <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-emerald-700"><Check className="h-3.5 w-3.5" />Fixed</p>}
                      {!flag.fixed && flag.verdict === "agree" && !removable(flag.key) && (
                        <button type="button" disabled={busy} onClick={() => submit("handled", { index: String(index) })}
                          className="mt-1.5 text-xs font-medium text-zinc-600 hover:underline">Mark handled</button>
                      )}
                      {!flag.fixed && removable(flag.key) && flag.verdict !== "disagree" && (
                        confirming === flag.key ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                            <span className="text-zinc-600">
                              {flag.key!.startsWith("background-") ? "Unlink the related topic this came from, with all its entries?" : "Remove this entry from the page?"}
                            </span>
                            <button type="button" disabled={busy} onClick={() => { submit("remove_entry", { key: flag.key! }); setConfirming(null); }}
                              className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700">Remove</button>
                            <button type="button" onClick={() => setConfirming(null)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">Cancel</button>
                          </div>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => setConfirming(flag.key)}
                            className="mt-1.5 text-xs font-medium text-red-700 hover:underline">
                            {flag.key!.startsWith("background-") ? "Unlink related topic" : "Remove from page"}
                          </button>
                        )
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {flags.length > 0 && (
                <p className="mb-3 text-xs text-zinc-500">
                  👍 it's a real problem · 👎 it's fine. Each rating saves as you tap it and teaches later checks.{" "}
                  {open_ > 0
                    ? <>Then press <strong>Needs work</strong> and the agent fixes what you agreed with.</>
                    : <>Every flag is resolved: you can mark this page <strong>Reviewed</strong>.</>}
                </p>
              )}
              {links && (
                <div className="mb-3 border-t border-zinc-100 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-zinc-900">Missing from this page?</span>
                    <button type="button" disabled={busy || links.findJob?.status === "queued" || links.findJob?.status === "running"}
                      onClick={() => submit("find_missing")}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
                      <Search className="h-3.5 w-3.5" />Find missing
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {findStatus(links.findJob) || "Searches every meeting, document and annual report again for this topic's names and file numbers, then the review model picks what belongs in its story. Nothing is added until you accept it."}
                  </p>
                  {suggestions.length > 0 && (
                    <ol className="mt-2 space-y-2">
                      {suggestions.map((s) => (
                        <li key={`${s.table}-${s.id}`} className="rounded-lg border border-brand-200 px-2.5 py-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                            {s.kind === "related" ? "Related topic" : s.kind === "report" ? "Annual report" : "Mention"}{s.date && s.kind !== "report" ? ` · ${s.date.slice(0, 10)}` : ""}
                            {s.score != null && <span className="ml-1 font-normal normal-case tracking-normal text-zinc-500" title="How likely the linking model thinks it belongs">· {Math.round(s.score * 100)}% likely</span>}
                          </span>
                          {s.href ? <a href={s.href} target="_blank" rel="noreferrer" className="block text-zinc-900 hover:underline">{s.title}</a> : <p className="text-zinc-900">{s.title}</p>}
                          {s.reason && <p className="mt-0.5 text-zinc-700">{s.reason}</p>}
                          {s.quote && (
                            <p className="mt-0.5 line-clamp-3 text-xs text-zinc-500">
                              {s.foundIn && <span className="font-medium text-zinc-600">{FOUND_IN[s.foundIn]}: </span>}“{s.quote}”
                            </p>
                          )}
                          <div className="mt-1.5 flex gap-2 text-xs">
                            <button type="button" disabled={busy} onClick={() => submit("accept", { table: s.table, id: String(s.id) })}
                              className="rounded-md bg-brand-600 px-2 py-1 font-medium text-white hover:bg-brand-700">Add to page</button>
                            <button type="button" disabled={busy} onClick={() => submit("reject", { table: s.table, id: String(s.id) })}
                              className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">Doesn't belong</button>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
              {save.data?.message && save.state === "idle" && <p className="mb-3 rounded-lg bg-zinc-50 px-2.5 py-2 text-xs text-zinc-700">{save.data.message}</p>}
              <details className="text-xs text-zinc-500">
                <summary className="cursor-pointer select-none font-medium text-zinc-600">What it looks for</summary>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                  {Object.values(FLAG_PROBLEM_LABELS).map((label) => <li key={label}>{label}</li>)}
                </ul>
                <p className="mt-1.5">It reads only what's on this page, as a signed-out resident sees it. It doesn't open the minutes or agendas behind each entry, so it can't confirm facts against the source.</p>
              </details>
              <button type="button" disabled={busy} onClick={() => submit("check")}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
                <RefreshCw className="h-3.5 w-3.5" />{review?.ai_checked_at ? "Check again" : "Check this page"}
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
          {fixing ? (
            <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 whitespace-nowrap pr-1 text-brand-700"><Loader2 className="h-4 w-4 animate-spin" />Agent fixing…</button>
          ) : review?.status === "fixed" ? (
            <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 whitespace-nowrap pr-1 font-medium text-brand-700">
              <Wrench className="h-4 w-4" />Fixed, confirm
            </button>
          ) : review?.status === "reviewed" ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap pr-1 text-emerald-700"><Check className="h-4 w-4" />Reviewed<span className="hidden sm:inline"> {reviewTime(review.reviewed_at)}</span></span>
          ) : review?.status === "needs_work" ? (
            <button type="button" onClick={() => { setNote(review.note || ""); setWriting(true); }}
              className="flex min-w-0 items-center gap-1.5 pr-1 text-amber-700" title={review.note || undefined}>
              <Flag className="h-4 w-4 shrink-0" /><span className="max-w-40 truncate">Needs work{review.note ? `: ${review.note}` : ""}</span>
            </button>
          ) : (
            <span className="hidden whitespace-nowrap pr-1 text-zinc-500 sm:inline">Not reviewed</span>
          )}
          {review?.status !== "reviewed" && !fixing && review?.status !== "fixed" && (
            <button type="button" disabled={busy || open_ > 0} onClick={() => submit("reviewed")}
              title={open_ > 0 ? `${open_} ${open_ === 1 ? "flag is" : "flags are"} still open` : undefined}
              className={cn(button, "text-emerald-700 hover:bg-emerald-50 disabled:text-zinc-400 disabled:hover:bg-transparent")}>Reviewed</button>
          )}
          {(!review?.status || review.status === "needs_work") && !fixing && (
            <button type="button" disabled={busy} onClick={() => { setNote(agreedNote()); setWriting(true); }}
              className={cn(button, "text-amber-700 hover:bg-amber-50")}>Needs work</button>
          )}
          <button type="button" disabled={busy}
            onClick={() => (review?.ai_checked_at || suggestions.length ? setOpen(!open) : submit("check"))}
            title={review?.ai_checked_at ? "Show what the check found" : "Have the model read this page and flag problems"}
            className={cn(button, "flex items-center gap-1 text-brand-700 hover:bg-brand-50")}>
            <Sparkles className={cn("h-4 w-4", checking && "animate-pulse")} />
            {checking ? "Checking…" : review?.ai_checked_at ? (flags.length ? `${flags.length} ${flags.length === 1 ? "flag" : "flags"}` : "Checked") : "Check"}
            {suggestions.length > 0 && <span className="rounded-full bg-brand-100 px-1.5 text-xs text-brand-800">{suggestions.length} new</span>}
          </button>
          {review?.status && !fixing && (
            <button type="button" disabled={busy} onClick={() => submit("clear")} aria-label="Clear review"
              className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X className="h-4 w-4" /></button>
          )}
        </div>
      )}
      {save.data?.error && save.state === "idle" && <p className="rounded-lg bg-surface px-2 py-1 text-xs text-red-700 shadow">{save.data.error}</p>}
    </div>
  );
}
