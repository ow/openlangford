import { useEffect, useRef, useState } from "react";
import { useFetcher, useLocation, useNavigate, useRevalidator } from "react-router";
import { INTERNAL_NOTE_CHANGED, OPEN_INTERNAL_NOTE } from "./internal-note-banner";
import { TopicEditDialog } from "./topic-edit-dialog";
import { Tip } from "../ui/tooltip";
import { ArrowRight, Check, Eye, EyeOff, Flag, Loader2, Pencil, RefreshCw, Sparkles, StickyNote, ThumbsDown, ThumbsUp, Undo2, Wrench, X } from "lucide-react";
import { FLAG_PROBLEM_LABELS, reviewTime, unresolvedFlags, type PageFlag, type PageReview } from "../../lib/page-review-types";
import { cn } from "../../lib/utils";

type Suggestion = {
  table: string; id: number; kind: "mention" | "related" | "report"; date: string | null; title: string; quote: string | null;
  href: string | null; reason: string | null; score: number | null; foundIn: "item" | "document" | "spoken" | "report" | "topic" | "similar" | null; agreed?: boolean;
};
const FOUND_IN = { item: "In the item's text", document: "In a document attached to the item", spoken: "Said at the meeting", report: "In the annual report", topic: "Shares a name with this topic", similar: "Similar in meaning (doesn't name this topic)" };
type FindJob = { status: string; requested_at: string; finished_at: string | null; suggested: number | null };
type Links = { suggestions: Suggestion[]; findJob: FindJob | null; edited?: { locked: string[]; newEntries: number; photos?: number } } | null;
type Loaded = { path: string | null; review: PageReview | null; links: Links; hidden?: boolean };
type Saved = { ok?: true; review?: PageReview | null; links?: Links; hidden?: boolean; message?: string | null; error?: string };

/** Entries found for this topic can be removed here; items filed under the topic itself can't. */
const removable = (key: string | null) => !!key && /^(mention|background|report)-\d+$/.test(key);


/** Outline the flagged timeline entries while the panel is open. */
/** Outlines on the page: open flags in red (agreed) or amber, and, after the agent's fix (`changed`), what it changed in
 * green: each fixed entry, and the summary and "where it stands" when a whole-page problem was fixed. */
function useHighlights(flags: PageFlag[], on: boolean, changed = false) {
  useEffect(() => {
    if (!on && !changed) return;
    const marked: HTMLElement[] = [];
    const mark = (el: HTMLElement | null | undefined, color: string, title: string) => {
      if (!el) return;
      el.style.outline = `2px solid ${color}`;
      el.style.outlineOffset = "2px";
      el.title = title;
      marked.push(el);
    };
    const green = "rgb(5 150 105)";
    flags.forEach((flag) => {
      const card = flag.key ? document.getElementById(`timeline-${flag.key}`)?.querySelector<HTMLElement>(":scope > div") : null;
      if (flag.fixed) {
        if (!changed) return;
        if (card) mark(card, green, `Changed by the agent: ${flag.reason}`);
        else if (!flag.key) for (const id of ["topic-summary", "topic-status"]) mark(document.getElementById(id), green, `Changed by the agent: ${flag.reason}`);
        return;
      }
      if (!on || !card || flag.verdict === "disagree") return;
      mark(card, flag.verdict === "agree" ? "rgb(220 38 38)" : "rgb(245 158 11)", `${FLAG_PROBLEM_LABELS[flag.problem]}: ${flag.reason}`);
    });
    return () => marked.forEach((el) => { el.style.outline = ""; el.style.outlineOffset = ""; el.title = ""; });
  }, [flags, on, changed]);
}

/** A suggestion's internal key ("suggestion-L37015") reads as "the suggested entry". */
const plainKeys = (text: string) => text.replace(/\b(?:add\s+)?suggestion-[LR]\d+\b/gi, (m) => (m.toLowerCase().startsWith("add") ? "add the suggested entry" : "the suggested entry"));

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
  const [fixedRun, setFixedRun] = useState(false);  // this page came up as fixed by the agent, to confirm
  const [stayed, setStayed] = useState(false);  // a fix was sent or confirmed here: offer Next instead of moving on
  const [showCheck, setShowCheck] = useState(false);  // unfold the check's details while the agent's report is shown
  const panel = useRef<HTMLDivElement>(null);
  const sentFrom = useRef<string | null>(null);  // the page the last save was sent from
  const [hiding, setHiding] = useState(false);  // the "Hide page" card is open
  const [hideNote, setHideNote] = useState("");
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    setEditing(null);
    setBlocked(false);
    setOpen(false);
    setConfirming(null);
    setFixedRun(false);
    setStayed(false);
    setShowCheck(false);
    setHiding(false);
    setHideNote("");
    setEditOpen(false);
    load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Done with this page (Reviewed, Needs work, Looks good): on to the next one as soon as it's saved.
  useEffect(() => {
    if (!finishing.current || save.state !== "idle" || !save.data) return;
    finishing.current = false;
    if (save.data.ok) navigate(`/admin/reviews/next?from=${encodeURIComponent(pathname)}`);  // another page of the same kind
  }, [save.state, save.data, navigate, pathname]);

  // A check runs with only the Check button showing it; the panel opens with the results.
  const checkSent = useRef(false);
  useEffect(() => {
    if (!checkSent.current || save.state !== "idle" || !save.data) return;
    checkSent.current = false;
    setOpen(true);
  }, [save.state, save.data]);

  // Hiding saves the reason as the internal note: the banner shows it straight away.
  useEffect(() => {
    if (save.state === "idle" && save.data?.ok && save.data.hidden) window.dispatchEvent(new Event(INTERNAL_NOTE_CHANGED));
  }, [save.state, save.data]);

  // Open the panel by itself once per page when there's something to act on.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    const r = load.data?.path === pathname ? load.data : null;
    if (!r || autoOpened.current === pathname) return;
    autoOpened.current = pathname;
    if (r.review?.status === "fixed") setFixedRun(true);
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
  const hidden = !!(saved && saved.hidden !== undefined ? saved.hidden : loaded?.hidden);
  const edited = links?.edited;
  const suggestions = links?.suggestions || [];
  const searching = links?.findJob?.status === "queued" || links?.findJob?.status === "running";
  // Ratings are sent on their own (not through the router, which would reload the whole page after each one): they
  // show the moment they're pressed, and a failed save puts the stored rating back. A rating holds for the check it
  // was given on: a new check replaces the list, and a 👍 left on its position would show on a different flag the
  // server never got a rating for (2026-11-03: two such flags looked agreed, so Fix kept sending nothing to do).
  const [ratings, setRatings] = useState<Record<string, "agree" | "disagree" | null>>({});
  const ratingQueue = useRef<Promise<unknown>>(Promise.resolve());
  // Ratings still on their way to the server: Fix waits for them, or the agent would start with the old ratings
  // (2026-11-06: "Yes to all" had saved one of four when Fix was pressed).
  const [savingRatings, setSavingRatings] = useState(0);
  const tracked = <T,>(p: Promise<T>) => { setSavingRatings((n) => n + 1); return p.finally(() => setSavingRatings((n) => n - 1)); };
  useEffect(() => setRatings({}), [pathname]);
  const slot = (index: number) => `${review?.ai_checked_at ?? ""}#${index}`;
  const flags = (review?.ai_flags || []).map((f, i) => (slot(i) in ratings ? { ...f, verdict: ratings[slot(i)] } : f));
  const open_ = unresolvedFlags(flags).length;
  // What Fix will do: flags rated 👍 and not fixed yet, plus found entries rated 👍 (added by the agent on Fix).
  const agreed = flags.filter((f) => f.verdict === "agree" && !f.fixed).length + suggestions.filter((x) => x.agreed).length;
  useHighlights(flags, open, review?.status === "fixed" || (stayed && review?.status === "reviewed"));
  // Fix keeps its request open until the agent is done, so a pending Fix counts as the agent working.
  // The save request can outlive the page it was sent from (Fix waits for the agent, and you may move on): only a
  // request for this page counts as this page's.
  const savingHere = save.state !== "idle" && save.formData?.get("path") === pathname;
  const savedHere = save.state === "idle" && sentFrom.current === pathname;
  const fixing = review?.status === "fixing" || (savingHere && save.formData?.get("intent") === "needs_work");
  const agentMode = fixing || review?.status === "fixed";
  // Fix pressed (or the agent finished): show its report from the top.
  useEffect(() => {
    if (agentMode) { setShowCheck(false); panel.current?.scrollTo({ top: 0, behavior: "smooth" }); }
  }, [agentMode]);
  // When the agent finishes while you're on the page, reload the page's own content so its edits show (outlined).
  const revalidator = useRevalidator();
  const lastStatus = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastStatus.current === "fixing" && review?.status && review.status !== "fixing") { revalidator.revalidate(); setOpen(true); }
    lastStatus.current = review?.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.status]);
  const waiting = fixing || searching;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, pathname]);
  if (!loaded?.path) return null;

  const pending = savingHere ? save.formData?.get("intent") : undefined;
  const checking = pending === "check";
  const busy = savingHere;
  const submit = (intent: string, extra: Record<string, string> = {}) => {
    // Plain "Reviewed" moves on to the next page. Sending fixes to the agent, or confirming its fixes, stays here so
    // the edits can be seen; the Next button moves on from there.
    const confirmingFix = intent === "reviewed" && (fixedRun || review?.status === "fixed");
    finishing.current = intent === "reviewed" && !confirmingFix;
    if (intent === "needs_work" || confirmingFix) setStayed(true);
    sentFrom.current = pathname;
    save.submit({ intent, path: pathname, title: document.title, ...extra }, { method: "post", action: "/api/page-review" });
    if (intent === "check") { checkSent.current = true; setOpen(false); }
    setEditing(null);
  };
  // One rating, sent on its own; the returned promise settles when it's saved (or rolled back).
  const sendRating = (index: number, verdict: "agree" | "disagree" | null) => {
    // Queued: each save rewrites the page's list of flags, so two at once could overwrite each other.
    const at = slot(index);
    const next = ratingQueue.current.then(() => sendOne(index, verdict, at));
    ratingQueue.current = next;
    return tracked(next);
  };
  const sendOne = (index: number, verdict: "agree" | "disagree" | null, at: string) => {
    const body = new FormData();
    Object.entries({ intent: "rate", path: pathname, title: document.title, index: String(index), verdict: verdict ?? "none" })
      .forEach(([k, v]) => body.set(k, v));
    return fetch("/api/page-review", { method: "POST", body, headers: { Accept: "application/json" } })
      .then((res) => { if (!res.ok) throw new Error(String(res.status)); })
      .catch(() => setRatings((r) => { const next = { ...r }; delete next[at]; return next; }));
  };
  const rate = (index: number, verdict: "agree" | "disagree" | null) => {
    setRatings((r) => ({ ...r, [slot(index)]: verdict }));
    sendRating(index, verdict).then(() => load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`));
  };
  // The "All" row: every undecided flag and found entry at once (already-decided ones are left alone).
  const undecidedFlags = flags.map((f, i) => ({ f, i })).filter(({ f }) => f.verdict === null && !f.fixed && f.problem !== "editor_issue");
  const undecidedFound = suggestions.filter((x) => !x.agreed);
  const unrated = undecidedFlags.length + undecidedFound.length;  // still waiting for a 👍 or 👎
  const decideAll = (verdict: "agree" | "disagree") => tracked((async () => {
    // Shown at once and saved in one request (rate_all), after any single rating still on its way; a failed save puts
    // the stored ratings back.
    const slots = undecidedFlags.map(({ i }) => slot(i));
    setRatings((r) => ({ ...r, ...Object.fromEntries(slots.map((s) => [s, verdict])) }));
    if (slots.length) {
      const body = new FormData();
      Object.entries({ intent: "rate_all", path: pathname, title: document.title, verdict }).forEach(([k, v]) => body.set(k, v));
      const next = ratingQueue.current.then(() => fetch("/api/page-review", { method: "POST", body, headers: { Accept: "application/json" } })
        .then((res) => { if (!res.ok) throw new Error(String(res.status)); })
        .catch(() => setRatings((r) => { const next = { ...r }; for (const s of slots) delete next[s]; return next; })));
      ratingQueue.current = next;
      await next;
    }
    for (const x of undecidedFound) {
      const body = new FormData();
      Object.entries({ intent: verdict === "agree" ? "accept" : "reject", path: pathname, title: document.title, table: x.table, id: String(x.id), agree: "1" })
        .forEach(([k, v]) => body.set(k, v));
      await fetch("/api/page-review", { method: "POST", body, headers: { Accept: "application/json" } }).catch(() => null);
    }
    load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`);
  })());
  const button = "whitespace-nowrap rounded-full px-2.5 py-1 font-medium";
  const markReviewed = () => {
    if (open_ > 0) { setBlocked(true); setOpen(true); return; }
    setBlocked(false);
    submit("reviewed");
  };
  const spinner = (intent: string) => pending === intent ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin align-[-2px]" /> : null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-40 flex flex-col items-start gap-2 sm:right-auto print:hidden" aria-label="Page review (staff)">
      {open && !checking && (review?.ai_checked_at || links || review?.agent_note || editing === -1) && (
        <div ref={panel} className="max-h-[60vh] w-full overflow-y-auto rounded-2xl border border-dashed border-amber-400 bg-surface p-4 text-sm shadow-lg sm:w-[26rem]">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-zinc-900">
                {!review?.ai_checked_at ? "Not checked yet" : !flags.length ? "No problems flagged"
                  : open_ ? `${open_} of ${flags.length} ${flags.length === 1 ? "flag" : "flags"} still open` : `All ${flags.length} ${flags.length === 1 ? "flag" : "flags"} resolved`}
              </div>
              {review?.ai_checked_at && (
                <p className="text-xs text-zinc-500">Read {readWhat(review)} · {reviewTime(review.ai_checked_at)}</p>
              )}
            </div>
            <Tip label={"Close"}>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
            </Tip>
          </div>
            <>
              {blocked && open_ > 0 && (
                <p className="mb-3 rounded-lg bg-amber-50 px-2.5 py-2 text-sm text-amber-900">
                  Rate or fix the {open_} open {open_ === 1 ? "flag" : "flags"} below first, then mark the page Reviewed.
                </p>
              )}
              {!!edited?.photos && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-zinc-100 px-2.5 py-2 text-xs text-zinc-700">
                  <span>No feature photo yet: {edited.photos} report {edited.photos === 1 ? "picture" : "pictures"} to choose from.</span>
                  <button type="button" onClick={() => setEditOpen(true)} className="font-medium text-brand-700 hover:underline">Choose one</button>
                </div>
              )}
              {hidden && (
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
                      {/* Flags or found entries nobody has rated yet must be answered first: then the next step is
                          Still needs work (rate them, or say what's wrong), shown as the main button. */}
                      <button type="button" disabled={busy || unrated > 0} onClick={() => (open_ > 0 ? submit("reviewed", { set_aside: "1" }) : markReviewed())}
                        title={unrated > 0 ? `Rate the ${unrated} ${unrated === 1 ? "item" : "items"} the check found first (👍 or 👎)`
                          : open_ > 0 ? `The agent couldn't finish ${open_} ${open_ === 1 ? "flag" : "flags"}; they're set aside as handled` : undefined}
                        className={cn("rounded-md px-2.5 py-1 font-medium disabled:cursor-not-allowed",
                          unrated > 0 ? "border border-zinc-200 text-zinc-400" : "bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60")}>
                        {spinner("reviewed")}{open_ > 0 ? `Looks good, set aside the ${open_} left` : "Looks good"}</button>
                      {/* With something still agreed and unfixed, run the agent again; with nothing, rerunning would do
                          nothing, so ask what's still wrong (that becomes the agent's next job). */}
                      <button type="button" disabled={busy || savingRatings > 0} title={savingRatings > 0 ? "Saving your ratings…" : undefined}
                        onClick={() => (unrated > 0 ? setShowCheck(true) : agreed > 0 ? submit("needs_work") : (setShowCheck(true), setNote(""), setEditing(-1)))}
                        className={cn("rounded-md px-2.5 py-1 font-medium",
                          unrated > 0 ? "bg-amber-600 text-white hover:bg-amber-700" : "text-amber-800 hover:bg-amber-100")}>{spinner("needs_work")}Still needs work</button>
                    </div>
                  )}
                </div>
              )}
              {/* While the agent works, or waits for its fix to be confirmed, its report is what matters: the check's
                  details fold away behind a link. */}
              {agentMode && !showCheck ? (
                <button type="button" onClick={() => setShowCheck(true)} className="flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:underline">
                  Show what the check found
                  {unrated > 0 && (
                    <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white no-underline" title={`${unrated} to rate`}>{unrated} to rate</span>
                  )}
                </button>
              ) : (
                <>
              {(review?.ai_summary || review?.ai_checked_at) && (
                <div className="mb-3 flex items-start gap-2">
                  {review?.ai_summary && <p className="min-w-0 flex-1 leading-relaxed text-zinc-700">{review.ai_summary}</p>}
                  <Tip label={"Add an issue of your own for the agent to fix"}>
                    <button type="button" disabled={busy} onClick={() => { setNote(""); setEditing(-1); }}
                      aria-label="Add an issue of your own for the agent to fix"
                      className="ml-auto shrink-0 rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </Tip>
                </div>
              )}
              {editing === -1 && (
                <form className="mb-3" onSubmit={(e) => { e.preventDefault(); if (note.trim()) submit("add_issue", { note }); }}>
                  <textarea autoFocus rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="What should change? e.g. Say whether the 2023 agreement renews or replaces the 2021 one"
                    className="w-full rounded-lg border border-zinc-200 bg-transparent p-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  <div className="mt-1 flex gap-2 text-xs">
                    <button type="submit" disabled={busy || !note.trim()} className="rounded-md bg-brand-600 px-2 py-1 font-medium text-white hover:bg-brand-700 disabled:opacity-50">Add issue</button>
                    <span className="self-center text-zinc-500">then press Fix (or Still needs work) to send it to the agent</span>
                    <button type="button" onClick={() => setEditing(null)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">Cancel</button>
                  </div>
                </form>
              )}
              {review?.ai_page_issue && !(review.agent_at && review.ai_checked_at && review.agent_at > review.ai_checked_at) && (
                <p className="mb-3 rounded-lg bg-amber-50 px-2.5 py-2 text-amber-900">Whole page: {plainKeys(review.ai_page_issue)}</p>
              )}
              {undecidedFlags.length + undecidedFound.length >= 2 && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600">
                  <span>All {undecidedFlags.length + undecidedFound.length} undecided</span>
                  <div className="flex shrink-0 gap-0.5">
                    <Tip label="Yes to all: fix every flag, add every found entry (on Fix)">
                      <button type="button" disabled={busy} onClick={() => decideAll("agree")} aria-label="Yes to all"
                        className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-200"><ThumbsUp className="h-3.5 w-3.5" /></button>
                    </Tip>
                    <Tip label="No to all: leave every flag, reject every found entry">
                      <button type="button" disabled={busy} onClick={() => decideAll("disagree")} aria-label="No to all"
                        className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-200"><ThumbsDown className="h-3.5 w-3.5" /></button>
                    </Tip>
                  </div>
                </div>
              )}
              {flags.length > 0 && (
                <ol className="mb-3 space-y-2">
                  {flags.map((flag, index) => (
                    <li key={index} className={cn("rounded-lg border px-2.5 py-2", flag.verdict === "disagree" || flag.fixed ? "border-zinc-100 opacity-60" : "border-zinc-200")}>
                      <div className="flex items-start justify-between gap-2">
                        <a href={flag.key ? `#timeline-${flag.key}` : undefined} className="min-w-0">
                          <span className="text-xs font-semibold uppercase tracking-wide text-amber-700">{FLAG_PROBLEM_LABELS[flag.problem]}</span>
                          <p className="text-zinc-800">{plainKeys(flag.reason)}</p>
                          {flag.fix && !flag.fixed && flag.problem !== "editor_issue" && (
                            <p className="mt-1 rounded-md bg-brand-50 px-2 py-1 text-xs text-brand-900">
                              <span className="font-semibold">Suggested fix:</span> {flag.fix}
                            </p>
                          )}
                          <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{flag.excerpt}</p>
                        </a>
                        <div className={cn("flex shrink-0 gap-0.5", flag.fixed && "hidden")}>
                          {flag.verdict !== "disagree" && (
                            <Tip label={flag.note ? "Edit instructions for the agent" : "Add instructions for the agent"}>
                              <button type="button" disabled={busy} onClick={() => { setNote(flag.note || ""); setEditing(index); }}
                                aria-label={flag.note ? "Edit instructions for the agent" : "Add instructions for the agent"}
                               
                                className={cn("rounded-full p-1.5", flag.note ? "bg-brand-100 text-brand-700" : "text-zinc-400 hover:bg-zinc-100")}>
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </Tip>
                          )}
                          {flag.problem !== "editor_issue" && (["agree", "disagree"] as const).map((verdict) => (
                            <Tip key={verdict} label={verdict === "agree" ? "Yes, fix it" : "No, leave it"}>
                              <button type="button"
                                aria-label={verdict === "agree" ? "Yes, fix it" : "No, leave it"}
                               
                                aria-pressed={flag.verdict === verdict}
                                onClick={() => rate(index, flag.verdict === verdict ? null : verdict)}
                                className={cn("rounded-full p-1.5",
                                  flag.verdict === verdict ? (verdict === "agree" ? "bg-red-100 text-red-700" : "bg-zinc-200 text-zinc-700") : "text-zinc-400 hover:bg-zinc-100")}>
                                {verdict === "agree" ? <ThumbsUp className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
                              </button>
                            </Tip>
                          ))}
                        </div>
                      </div>
                      {flag.fixed && <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-emerald-700"><Check className="h-3.5 w-3.5" />Fixed{flag.recheck?.holds ? (flag.recheck.checked ? " · checked against the records" : " · checked") : ""}</p>}
                      {!flag.fixed && flag.recheck && !flag.recheck.holds && <p className="mt-1.5 text-xs font-medium text-amber-700">The agent&apos;s fix didn&apos;t hold when checked: {flag.recheck.reason}</p>}
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
                              {flag.key!.startsWith("background-") ? "Take this entry off this page? Its own topic keeps it." : "Remove this entry from the page?"}
                            </span>
                            <button type="button" disabled={busy} onClick={() => { submit("remove_entry", { key: flag.key! }); setConfirming(null); }}
                              className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700">Remove</button>
                            <button type="button" onClick={() => setConfirming(null)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">Cancel</button>
                          </div>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => setConfirming(flag.key)}
                            className="mt-1.5 text-xs font-medium text-red-700 hover:underline">
                            Remove from page
                          </button>
                        )
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {links && (
                <div className="mb-3">
                  <p className="text-xs text-zinc-500">
                    {searching ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Searching meetings and reports for entries missing from this page…</span>
                      : suggestions.length ? null
                      : links.findJob?.status === "succeeded" ? <>No missing entries found · {reviewTime(links.findJob.finished_at)}</>
                      : links.findJob?.status === "failed" ? "The search for missing entries didn't finish. Check again to retry."
                      : null}
                  </p>
                  {suggestions.length > 0 && (
                    <ol className="mt-2 space-y-2">
                      {suggestions.map((s) => {
                        // The one being decided shows it at once: the pressed button spins and the card fades.
                        const deciding = (pending === "accept" || pending === "reject") && save.formData?.get("table") === s.table
                          && save.formData?.get("id") === String(s.id) ? pending : null;
                        return (
                        <li key={`${s.table}-${s.id}`} className={cn("rounded-lg border border-brand-200 px-2.5 py-2 transition-opacity", deciding && "opacity-60")}>
                          {/* Decided like a flag: 👍 adds it to the page, 👎 says it doesn't belong. */}
                          <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                          <span className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                            Possibly missing · {s.kind === "related" ? "related topic" : s.kind === "report" ? "annual report" : "meeting item"}{s.date && s.kind !== "report" ? ` · ${s.date.slice(0, 10)}` : ""}
                            {s.score != null && <span className="ml-1 font-normal normal-case tracking-normal text-zinc-500" title="How likely the linking model thinks it belongs">· {Math.round(s.score * 100)}% likely</span>}
                          </span>
                          {s.href ? <a href={s.href} target="_blank" rel="noreferrer" className="block text-zinc-900 hover:underline">{s.title}</a> : <p className="text-zinc-900">{s.title}</p>}
                          {s.reason && <p className="mt-0.5 text-zinc-700">{s.reason}</p>}
                          {s.quote && (
                            <p className="mt-0.5 line-clamp-3 text-xs text-zinc-500">
                              {s.foundIn && <span className="font-medium text-zinc-600">{FOUND_IN[s.foundIn]}: </span>}“{s.quote}”
                            </p>
                          )}
                          </div>
                          <div className="flex shrink-0 gap-0.5">
                            <Tip label={s.agreed ? "Agreed: Fix adds it. Click to take it back" : "Yes, add it (on Fix)"}>
                              <button type="button" disabled={busy} aria-pressed={s.agreed}
                                onClick={() => submit("accept", { table: s.table, id: String(s.id), agree: s.agreed ? "0" : "1" })}
                                aria-label="Yes, add it to the page"
                                className={cn("rounded-full p-1.5", s.agreed ? "bg-red-100 text-red-700" : "text-zinc-400 hover:bg-zinc-100")}>
                                {deciding === "accept" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ThumbsUp className="h-3.5 w-3.5" />}
                              </button>
                            </Tip>
                            <Tip label="No, it doesn't belong">
                              <button type="button" disabled={busy} onClick={() => submit("reject", { table: s.table, id: String(s.id) })}
                                aria-label="No, it doesn't belong" className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
                                {deciding === "reject" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ThumbsDown className="h-3.5 w-3.5" />}
                              </button>
                            </Tip>
                          </div>
                          </div>
                        </li>
                        );
                      })}
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
                </div>
              )}
                </>
              )}
              {save.data?.message && savedHere && <p className="mb-3 rounded-lg bg-zinc-50 px-2.5 py-2 text-xs text-zinc-700">{save.data.message}</p>}
              {/* The page tools belong with the check: folded away with it while the agent's report is shown. */}
              {(!agentMode || showCheck) && (
                <>
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
            </>
        </div>
      )}
      {hiding && (
        <div className="w-full rounded-2xl border border-dashed border-red-300 bg-surface p-4 text-sm shadow-lg sm:w-[26rem]">
          {hidden ? (
            <>
              <p className="font-semibold text-zinc-900">Hidden from the public</p>
              <p className="mt-1 text-xs text-zinc-600">Anyone who isn't staff gets “not found” here. The reason is in this page's internal note.</p>
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy} onClick={() => { submit("unhide_page"); setHiding(false); }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"><Eye className="h-3.5 w-3.5" />Make it public again</button>
                <button type="button" onClick={() => setHiding(false)} className="rounded-lg px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100">Close</button>
              </div>
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); if (!hideNote.trim()) return; submit("hide_page", { note: hideNote.trim() }); setHiding(false); setHideNote(""); }}>
              <p className="font-semibold text-zinc-900">Hide this page?</p>
              <p className="mt-1 text-xs text-zinc-600">
                It goes at once: anyone who isn't staff gets “not found”, and search engines drop it.
                {links ? " The topic also leaves topic lists, links and search." : ""} You can make it public again from here.
              </p>
              <label className="mt-3 grid gap-1 text-xs">
                <span className="font-medium text-zinc-800">Why? <span className="font-normal text-zinc-500">(saved as the page's internal note; only staff see it)</span></span>
                <textarea autoFocus required rows={2} maxLength={1000} value={hideNote} onChange={(e) => setHideNote(e.target.value)}
                  className="rounded-lg border border-zinc-300 bg-surface px-2.5 py-1.5 text-sm" placeholder="e.g. Names a resident's medical details; checking with the City" />
              </label>
              <div className="mt-3 flex gap-2">
                <button type="submit" disabled={busy || !hideNote.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"><EyeOff className="h-3.5 w-3.5" />Hide page</button>
                <button type="button" onClick={() => setHiding(false)} className="rounded-lg px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100">Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}
      {links && (
        <TopicEditDialog open={editOpen} onOpenChange={setEditOpen} path={pathname}
          onSaved={() => load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`)} />
      )}
      {(
        <div className={cn(
          // The admin-only treatment (components/ui/admin-only.tsx): a dashed amber frame.
          "flex max-w-full items-center gap-0.5 rounded-full border border-dashed border-amber-400 bg-amber-50 py-1 pl-3 pr-1 text-sm shadow-lg",
          busy && !checking && "opacity-60",
        )}>
          {hidden && (
            <button type="button" onClick={() => setHiding(!hiding)} title="Hidden from the public. Click to make it public again."
              className="mr-1 flex items-center gap-1 whitespace-nowrap rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-red-700">
              <EyeOff className="h-3.5 w-3.5" />Hidden
            </button>
          )}
          {fixing ? (
            <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 whitespace-nowrap pr-1 text-brand-700"><Loader2 className="h-4 w-4 animate-spin" />Agent fixing…</button>
          ) : review?.status === "fixed" ? (
            <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 whitespace-nowrap pr-1 font-medium text-brand-700">
              <Wrench className="h-4 w-4" />Fixed, confirm
            </button>
          ) : review?.status === "reviewed" ? (
            // Pressing it again undoes the review.
            <button type="button" disabled={busy} onClick={() => submit("clear")} title="Reviewed. Click to undo the review."
              className="group flex items-center gap-1.5 whitespace-nowrap rounded-full pr-1 text-emerald-700 hover:text-zinc-600">
              {/* Only the icon changes on hover: swapping the text changed the button's width, so it flickered. */}
              {pending === "clear" ? <Loader2 className="h-4 w-4 animate-spin" />
                : <><Check className="h-4 w-4 group-hover:hidden" /><Undo2 className="hidden h-4 w-4 group-hover:block" /></>}
              <span>Reviewed<span className="hidden sm:inline"> {reviewTime(review.reviewed_at)}</span></span>
            </button>
          ) : review?.status === "needs_work" ? (
            <button type="button" onClick={() => setOpen(true)}
              className="flex min-w-0 items-center gap-1.5 pr-1 text-amber-700" title={review.note || undefined}>
              <Flag className="h-4 w-4 shrink-0" /><span className="max-w-40 truncate">Needs work{review.note ? `: ${review.note}` : ""}</span>
            </button>
          ) : (
            // A status, not a button: shown as a badge so it doesn't read like the buttons beside it.
            <span className="hidden whitespace-nowrap rounded-full bg-zinc-200/70 px-2 py-0.5 text-xs font-medium text-zinc-600 sm:inline">Not reviewed</span>
          )}
          {review?.status !== "reviewed" && !fixing && review?.status !== "fixed" && (
            <button type="button" disabled={busy} onClick={markReviewed}
              className={cn(button, "text-emerald-700 hover:bg-emerald-100", open_ > 0 && "text-emerald-700/60")}>{spinner("reviewed")}Reviewed</button>
          )}
          {/* After a review or a fix, an issue you add or a flag you agree with still needs a way to the agent. */}
          {(!review?.status || review.status === "needs_work" || agreed > 0) && !fixing && (
            <button type="button" disabled={busy || savingRatings > 0}
              onClick={() => (agreed > 0 || review?.note ? submit("needs_work") : (setOpen(true), setNote(""), setEditing(-1)))}
              title={savingRatings > 0 ? "Saving your ratings…" : agreed ? `Send the ${agreed} agreed ${agreed === 1 ? "fix" : "fixes"} to the agent` : "Describe what needs work"}
              className={cn(button, agreed ? "bg-amber-600 text-white hover:bg-amber-700" : "text-amber-700 hover:bg-amber-200/70")}>
              {spinner("needs_work")}{agreed ? `Fix ${agreed}` : "Needs work"}</button>
          )}
          <Tip label={[
              open_ ? `${open_} open ${open_ === 1 ? "flag" : "flags"}` : "",
              suggestions.length ? `${suggestions.length} possibly missing ${suggestions.length === 1 ? "entry" : "entries"}` : "",
            ].filter(Boolean).join(" · ") || (review?.ai_checked_at ? "Checked: nothing open. Show what the check found" : "Have the model read this page and flag problems")}>
            <button type="button" disabled={busy}
              onClick={() => (review?.ai_checked_at || suggestions.length ? setOpen(!open) : submit("check"))}
              className={cn(button, "flex items-center gap-1 text-brand-700 hover:bg-brand-100")}>
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {checking ? "AI checking…" : "Check"}
              {/* One count, like an unread count: open flags plus entries the search found that need a decision. */}
              {!checking && open_ + suggestions.length > 0 && (
                <span className="rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">{open_ + suggestions.length}</span>
              )}
            </button>
          </Tip>
          {/* Words for the decisions above; icons for the tools around them, with Next last. */}
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-amber-300" />
          {links && (
            <Tip label={edited?.newEntries ? `Edit the title, summary or photo. ${edited.newEntries} new ${edited.newEntries === 1 ? "entry" : "entries"} since the last edit: check it still holds`
              : edited?.photos ? `No feature photo yet: ${edited.photos} report ${edited.photos === 1 ? "picture" : "pictures"} to choose from`
              : edited?.locked.length ? "Edit the title, summary or photo (some are edited by hand)" : "Edit the title, summary or photo"}>
              <button type="button" onClick={() => setEditOpen(true)} aria-label="Edit this topic"
                className={cn("relative rounded-full p-1.5 hover:bg-amber-100", edited?.locked.length ? "text-brand-700" : "text-zinc-500")}>
                <Pencil className="h-4 w-4" />
                {!!(edited?.newEntries || edited?.photos) && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-red-600" aria-hidden="true" />}
              </button>
            </Tip>
          )}
          {!hidden && (
            <Tip label="Hide this page from the public">
              <button type="button" onClick={() => setHiding(!hiding)} aria-label="Hide this page"
                className={cn("rounded-full p-1.5 hover:bg-red-100 hover:text-red-700", hiding ? "text-red-700" : "text-zinc-500")}>
                <EyeOff className="h-4 w-4" />
              </button>
            </Tip>
          )}
          <Tip label={review?.internal_note ? "Edit the internal note (only staff see it)" : "Add an internal note (only staff see it)"}>
            <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_INTERNAL_NOTE))}
              aria-label={review?.internal_note ? "Edit the internal note" : "Add an internal note"}
             
              className={cn("rounded-full p-1.5 hover:bg-amber-100", review?.internal_note ? "text-amber-700" : "text-zinc-500")}>
              <StickyNote className={cn("h-4 w-4", review?.internal_note && "fill-amber-200")} />
            </button>
          </Tip>
          {review?.status && !fixing && (
            <Tip label={"Clear this page's review"}>
              <button type="button" disabled={busy} onClick={() => submit("clear")} aria-label="Clear review"
                className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"><X className="h-4 w-4" /></button>
            </Tip>
          )}
          {/* Always there, so a page that can't be reviewed yet can be skipped (it stays as it is). */}
          <Tip label={fixedRun ? "Next fixed page" : "Next page"}>
            <button type="button" disabled={busy && !fixing}
              onClick={() => navigate(`/admin/reviews/next?${fixedRun ? "status=fixed&" : ""}from=${encodeURIComponent(pathname)}`)}
              aria-label="Next page"
             
              className="rounded-full p-1.5 text-zinc-700 hover:bg-zinc-100"><ArrowRight className="h-4 w-4" /></button>
          </Tip>
        </div>
      )}
      {save.data?.error && savedHere && <p className="rounded-lg bg-surface px-2 py-1 text-xs text-red-700 shadow">{save.data.error}</p>}
    </div>
  );
}
