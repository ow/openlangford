import { useEffect, useRef, useState } from "react";
import { useFetcher, useLocation, useNavigate } from "react-router";
import { Check, EyeOff, Flag, Loader2, Pencil, RefreshCw, Sparkles, ThumbsDown, ThumbsUp, Wrench, X } from "lucide-react";
import { FLAG_PROBLEM_LABELS, reviewTime, unresolvedFlags, type PageFlag, type PageReview } from "../../lib/page-review-types";
import { cn } from "../../lib/utils";

type Suggestion = {
  table: string; id: number; kind: "mention" | "related" | "report"; date: string | null; title: string; quote: string | null;
  href: string | null; reason: string | null; score: number | null; foundIn: "item" | "document" | "spoken" | "report" | "topic" | "similar" | null;
};
const FOUND_IN = { item: "In the item's text", document: "In a document attached to the item", spoken: "Said at the meeting", report: "In the annual report", topic: "Shares a name with this topic", similar: "Similar in meaning (doesn't name this topic)" };
type FindJob = { status: string; requested_at: string; finished_at: string | null; suggested: number | null };
type Links = { suggestions: Suggestion[]; findJob: FindJob | null; hidden?: boolean } | null;
type Loaded = { path: string | null; review: PageReview | null; links: Links };
type Saved = { ok?: true; review?: PageReview | null; links?: Links; message?: string | null; error?: string };

/** Entries found for this topic can be removed here; items filed under the topic itself can't. */
const removable = (key: string | null) => !!key && /^(mention|background|report)-\d+$/.test(key);


/** Outline the flagged timeline entries while the panel is open. */
function useHighlights(flags: PageFlag[], on: boolean) {
  useEffect(() => {
    if (!on) return;
    const marked: HTMLElement[] = [];
    flags.forEach((flag) => {
      const card = flag.key ? document.getElementById(`timeline-${flag.key}`)?.querySelector<HTMLElement>(":scope > div") : null;
      if (!card || flag.verdict === "disagree" || flag.fixed) return;
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
  const [editing, setEditing] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(false);  // pressed Reviewed with flags still open
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const navigate = useNavigate();
  const finishing = useRef(false);

  useEffect(() => {
    setEditing(null);
    setBlocked(false);
    setOpen(false);
    setConfirming(null);
    load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Done with this page (Reviewed, Needs work, Looks good): on to the next one as soon as it's saved.
  useEffect(() => {
    if (!finishing.current || save.state !== "idle" || !save.data) return;
    finishing.current = false;
    if (save.data.ok) navigate(`/admin/reviews/next?from=${encodeURIComponent(pathname)}`);  // another page of the same kind
  }, [save.state, save.data, navigate, pathname]);

  // Open the panel by itself once per page when there's something to act on.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    const r = load.data?.path === pathname ? load.data : null;
    if (!r || autoOpened.current === pathname) return;
    autoOpened.current = pathname;
    if (unresolvedFlags(r.review?.ai_flags).length || r.links?.suggestions?.length || r.review?.status === "fixed") setOpen(true);
  }, [load.data, pathname]);

  const loaded = load.data?.path === pathname ? load.data : null;
  // Show whichever answer is newest: the last button press, or the last refresh (the bar refreshes while the
  // agent fixes or the search runs, and those refreshes must win over the press that started them).
  const [latest, setLatest] = useState<"save" | "load">("load");
  useEffect(() => { if (save.state === "idle" && save.data) setLatest("save"); }, [save.state, save.data]);
  useEffect(() => { if (load.state === "idle" && load.data) setLatest("load"); }, [load.state, load.data]);
  const saved = latest === "save" && save.data && "review" in save.data && save.data.review?.path === pathname ? save.data : undefined;
  const review = saved ? saved.review ?? null : loaded?.review ?? null;
  const links: Links = saved && saved.links !== undefined ? saved.links ?? null : loaded?.links ?? null;
  const suggestions = links?.suggestions || [];
  const searching = links?.findJob?.status === "queued" || links?.findJob?.status === "running";
  const flags = review?.ai_flags || [];
  const open_ = unresolvedFlags(flags).length;
  const agreed = flags.filter((f) => f.verdict === "agree" && !f.fixed).length;
  useHighlights(flags, open);
  const fixing = review?.status === "fixing";
  const waiting = fixing || searching;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, pathname]);
  if (!loaded?.path) return null;

  const pending = save.formData?.get("intent");
  const checking = pending === "check";
  const busy = save.state !== "idle";
  const submit = (intent: string, extra: Record<string, string> = {}) => {
    finishing.current = intent === "reviewed" || intent === "needs_work";
    save.submit({ intent, path: pathname, title: document.title, ...extra }, { method: "post", action: "/api/page-review" });
    if (intent === "check") setOpen(true);
    setEditing(null);
  };
  const button = "whitespace-nowrap rounded-full px-2.5 py-1 font-medium";
  const markReviewed = () => {
    if (open_ > 0) { setBlocked(true); setOpen(true); return; }
    setBlocked(false);
    submit("reviewed");
  };
  const spinner = (intent: string) => pending === intent ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin align-[-2px]" /> : null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-40 flex flex-col items-start gap-2 sm:right-auto print:hidden" aria-label="Page review (staff)">
      {(open || review?.status === "fixed") && (review?.ai_checked_at || checking || links || review?.agent_note || editing === -1) && (
        <div className="max-h-[60vh] w-full overflow-y-auto rounded-2xl border border-zinc-200 bg-surface p-4 text-sm shadow-lg sm:w-[26rem]">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-zinc-900">
                {checking ? "Reading the page…" : !review?.ai_checked_at ? "Not checked yet" : !flags.length ? "No problems flagged"
                  : open_ ? `${open_} of ${flags.length} ${flags.length === 1 ? "flag" : "flags"} still open` : `All ${flags.length} ${flags.length === 1 ? "flag" : "flags"} resolved`}
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
              {blocked && open_ > 0 && (
                <p className="mb-3 rounded-lg bg-amber-50 px-2.5 py-2 text-sm text-amber-900">
                  Rate or fix the {open_} open {open_ === 1 ? "flag" : "flags"} below first, then mark the page Reviewed.
                </p>
              )}
              {links?.hidden && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-zinc-100 px-2.5 py-2 text-xs text-zinc-700">
                  <span className="flex items-center gap-1.5"><EyeOff className="h-3.5 w-3.5" />Hidden from the public. Only staff can see this page.</span>
                  <button type="button" disabled={busy} onClick={() => submit("unhide_page")} className="font-medium text-brand-700 hover:underline">Unhide</button>
                </div>
              )}
              {review?.agent_note && (review.status === "fixed" || review.status === "needs_work" || review.status === "fixing") && (
                <div className={cn("mb-3 rounded-lg px-2.5 py-2", review.status === "needs_work" ? "bg-amber-50" : "bg-brand-50")}>
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-700">
                    {review.status === "fixing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                    {{ fixed: "The agent fixed this page", needs_work: "The agent couldn't fix this page", fixing: "The agent is working" }[review.status]} · {reviewTime(review.agent_at)}
                  </div>
                  <p className="whitespace-pre-line text-zinc-800">{review.agent_note}</p>
                  {review.status === "fixed" && (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <button type="button" disabled={busy} onClick={markReviewed}
                        className="rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white hover:bg-emerald-700 disabled:opacity-60">{spinner("reviewed")}Looks good</button>
                      <button type="button" disabled={busy} onClick={() => submit("needs_work")}
                        className="rounded-md px-2.5 py-1 font-medium text-amber-800 hover:bg-amber-100">{spinner("needs_work")}Still needs work</button>
                    </div>
                  )}
                </div>
              )}
              {(review?.ai_summary || review?.ai_checked_at) && (
                <div className="mb-3 flex items-start gap-2">
                  {review?.ai_summary && <p className="min-w-0 flex-1 leading-relaxed text-zinc-700">{review.ai_summary}</p>}
                  <button type="button" disabled={busy} onClick={() => { setNote(""); setEditing(-1); }}
                    aria-label="Add an issue of your own for the agent to fix" title="Add an issue of your own for the agent to fix"
                    className="ml-auto shrink-0 rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {editing === -1 && (
                <form className="mb-3" onSubmit={(e) => { e.preventDefault(); if (note.trim()) submit("add_issue", { note }); }}>
                  <textarea autoFocus rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="What should change? e.g. Say whether the 2023 agreement renews or replaces the 2021 one"
                    className="w-full rounded-lg border border-zinc-200 bg-transparent p-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  <div className="mt-1 flex gap-2 text-xs">
                    <button type="submit" disabled={busy || !note.trim()} className="rounded-md bg-brand-600 px-2 py-1 font-medium text-white hover:bg-brand-700 disabled:opacity-50">Add issue</button>
                    <span className="self-center text-zinc-500">then press Needs work to send it to the agent</span>
                    <button type="button" onClick={() => setEditing(null)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">Cancel</button>
                  </div>
                </form>
              )}
              {review?.ai_page_issue && (
                <p className="mb-3 rounded-lg bg-amber-50 px-2.5 py-2 text-amber-900">Whole page: {review.ai_page_issue}</p>
              )}
              {flags.length > 0 && (
                <ol className="mb-3 space-y-2">
                  {flags.map((flag, index) => (
                    <li key={index} className={cn("rounded-lg border px-2.5 py-2", flag.verdict === "disagree" || flag.fixed ? "border-zinc-100 opacity-60" : "border-zinc-200")}>
                      <div className="flex items-start justify-between gap-2">
                        <a href={flag.key ? `#timeline-${flag.key}` : undefined} className="min-w-0">
                          <span className="text-xs font-semibold uppercase tracking-wide text-amber-700">{FLAG_PROBLEM_LABELS[flag.problem]}</span>
                          <p className="text-zinc-800">{flag.reason}</p>
                          {flag.fix && !flag.fixed && flag.problem !== "editor_issue" && (
                            <p className="mt-1 rounded-md bg-brand-50 px-2 py-1 text-xs text-brand-900">
                              <span className="font-semibold">Suggested fix:</span> {flag.fix}
                            </p>
                          )}
                          <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{flag.excerpt}</p>
                        </a>
                        <div className={cn("flex shrink-0 gap-0.5", flag.fixed && "hidden")}>
                          {flag.verdict !== "disagree" && (
                            <button type="button" disabled={busy} onClick={() => { setNote(flag.note || ""); setEditing(index); }}
                              aria-label={flag.note ? "Edit instructions for the agent" : "Add instructions for the agent"}
                              title={flag.note ? "Edit instructions for the agent" : "Add instructions for the agent"}
                              className={cn("rounded-full p-1.5", flag.note ? "bg-brand-100 text-brand-700" : "text-zinc-400 hover:bg-zinc-100")}>
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {flag.problem !== "editor_issue" && (["agree", "disagree"] as const).map((verdict) => (
                            <button key={verdict} type="button" disabled={busy}
                              aria-label={verdict === "agree" ? "Yes, fix it" : "No, leave it"}
                              title={verdict === "agree" ? "Yes, fix it" : "No, leave it"}
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
                      {!flag.fixed && flag.verdict !== "disagree" && (editing === index ? (
                        <form className="mt-2" onSubmit={(e) => { e.preventDefault(); submit("flag_note", { index: String(index), note }); }}>
                          <textarea autoFocus rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                            placeholder="Tell the agent what to do, e.g. move it to the 2022 budget topic"
                            className="w-full rounded-lg border border-zinc-200 bg-transparent p-2 text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                          <div className="mt-1 flex gap-2 text-xs">
                            <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-2 py-1 font-medium text-white hover:bg-brand-700">Save</button>
                            <button type="button" onClick={() => setEditing(null)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">Cancel</button>
                          </div>
                        </form>
                      ) : (
                        flag.note && flag.problem !== "editor_issue" ? <p className="mt-1.5 rounded-md bg-zinc-50 px-2 py-1 text-xs text-zinc-700"><span className="font-medium">Your instructions:</span> {flag.note}</p> : null
                      ))}
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
                  <ThumbsUp className="inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" /> yes, fix it ·{" "}
                  <ThumbsDown className="inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" /> no, leave it ·{" "}
                  <Pencil className="inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" /> fix it differently.{" "}
                  {open_ > 0
                    ? agreed > 0
                      ? <>Then press <strong>Fix {agreed}</strong> and the agent makes the changes for you to confirm.</>
                      : <>Answer each flag, then press <strong>Fix</strong> or <strong>Reviewed</strong>.</>
                    : <>Every flag is answered: mark this page <strong>Reviewed</strong>.</>}
                </p>
              )}
              {links && (
                <div className="mb-3 border-t border-zinc-100 pt-3">
                  <p className="text-xs text-zinc-500">
                    {searching ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Searching meetings and reports for entries missing from this page…</span>
                      : suggestions.length ? <span className="font-semibold text-zinc-900">Possibly missing from this page</span>
                      : links.findJob?.status === "succeeded" ? <>No missing entries found · {reviewTime(links.findJob.finished_at)}</>
                      : links.findJob?.status === "failed" ? "The search for missing entries didn't finish. Check again to retry."
                      : null}
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
              {links && !links.hidden && (
                confirming === "hide" ? (
                  <div className="mb-3 rounded-lg border border-red-200 px-2.5 py-2 text-xs">
                    <p className="text-zinc-700">Remove this page from the site? It leaves topic lists, links and search, and anyone with an old link sees a short note that it was removed, with links to its meetings. You can undo it.</p>
                    <div className="mt-1.5 flex gap-2">
                      <button type="button" disabled={busy} onClick={() => { submit("hide_page"); setConfirming(null); }} className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700">Hide page</button>
                      <button type="button" onClick={() => setConfirming(null)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" disabled={busy} onClick={() => setConfirming("hide")}
                    className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-red-700 hover:underline">
                    <EyeOff className="h-3.5 w-3.5" />Hide this page
                  </button>
                )
              )}
              <details className="text-xs text-zinc-500">
                <summary className="cursor-pointer select-none font-medium text-zinc-600">What it looks for</summary>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                  {Object.values(FLAG_PROBLEM_LABELS).map((label) => <li key={label}>{label}</li>)}
                </ul>
                <p className="mt-1.5">The model reads only what's on this page, as a signed-out resident sees it, so it can't confirm facts against the minutes. On a topic page, Check also searches every meeting and annual report for this topic's names and permit numbers, and the model picks what belongs. Nothing is added until you accept it.</p>
              </details>
              <button type="button" disabled={busy} onClick={() => submit("check")}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
                <RefreshCw className="h-3.5 w-3.5" />{review?.ai_checked_at ? "Check again" : "Check this page"}
              </button>
            </>
          )}
        </div>
      )}
      {(
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
            <button type="button" onClick={() => setOpen(true)}
              className="flex min-w-0 items-center gap-1.5 pr-1 text-amber-700" title={review.note || undefined}>
              <Flag className="h-4 w-4 shrink-0" /><span className="max-w-40 truncate">Needs work{review.note ? `: ${review.note}` : ""}</span>
            </button>
          ) : (
            <span className="hidden whitespace-nowrap pr-1 text-zinc-500 sm:inline">Not reviewed</span>
          )}
          {review?.status !== "reviewed" && !fixing && review?.status !== "fixed" && (
            <button type="button" disabled={busy} onClick={markReviewed}
              className={cn(button, "text-emerald-700 hover:bg-emerald-50", open_ > 0 && "text-emerald-700/60")}>{spinner("reviewed")}Reviewed</button>
          )}
          {(!review?.status || review.status === "needs_work") && !fixing && (
            <button type="button" disabled={busy}
              onClick={() => (flags.some((f) => f.verdict === "agree" && !f.fixed) || review?.note ? submit("needs_work") : (setOpen(true), setNote(""), setEditing(-1)))}
              title={agreed ? `Send the ${agreed} agreed ${agreed === 1 ? "fix" : "fixes"} to the agent` : "Describe what needs work"}
              className={cn(button, agreed ? "bg-amber-600 text-white hover:bg-amber-700" : "text-amber-700 hover:bg-amber-50")}>
              {spinner("needs_work")}{agreed ? `Fix ${agreed}` : "Needs work"}</button>
          )}
          <button type="button" disabled={busy}
            onClick={() => (review?.ai_checked_at || suggestions.length ? setOpen(!open) : submit("check"))}
            title={review?.ai_checked_at ? "Show what the check found" : "Have the model read this page and flag problems"}
            className={cn(button, "flex items-center gap-1 text-brand-700 hover:bg-brand-50")}>
            <Sparkles className={cn("h-4 w-4", checking && "animate-pulse")} />
            {checking ? "Checking…" : review?.ai_checked_at ? (open_ ? `${open_} open ${open_ === 1 ? "flag" : "flags"}` : "No problems") : "Check"}
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
