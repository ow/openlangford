import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, useLocation, useRouteLoaderData } from "react-router";
import { Flag } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { REPORT_CATEGORIES, type ReportCategory } from "../lib/data-reports";

/** Other entry points (the header's Report issue button) open the panel with this event. */
const OPEN_EVENT = "open-report-issue";
const DRAFT_KEY = "report-issue-draft";

type Draft = { path: string; quote: string; entryKey: string | null; category: ReportCategory; note: string; suggestion: string; sourceUrl: string; notify: boolean };

export function openReportIssue(detail: { quote?: string; entryKey?: string | null } = {}) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
}

/** Whether this page takes reports (set by the root layout, which also renders the panel). */
export const ReportsEnabled = createContext(false);

/** A quiet "Report issue" button for a page's header, beside Follow; nothing on pages that can't be reported. */
export function ReportIssueButton() {
  if (!useContext(ReportsEnabled)) return null;
  return (
    <button
      type="button"
      onClick={() => openReportIssue()}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
    >
      <Flag className="h-3.5 w-3.5" />
      Report issue
    </button>
  );
}

/** The entry a node sits in: a topic's timeline step (id="timeline-<key>") or a meeting item (data-review-entry). */
function entryKeyOf(node: Node | null): string | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const step = el?.closest('[id^="timeline-"]');
  if (step) return step.id.slice("timeline-".length);
  return el?.closest("[data-review-entry]")?.getAttribute("data-review-entry") ?? null;
}

const readDraft = (): Draft | null => {
  try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; }
};
const saveDraft = (draft: Draft | null) => {
  try { draft ? sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)) : sessionStorage.removeItem(DRAFT_KEY); } catch { /* private mode */ }
};

/**
 * "Report an issue": select text on a public page and a flag appears beside it; the header's Report issue button
 * opens the same panel. Anyone can fill it in; sending needs an account (the draft survives signing in).
 */
export function ReportIssue() {
  const { pathname } = useLocation();
  const root = useRouteLoaderData("root") as { user?: unknown } | undefined;
  const signedIn = !!root?.user;
  const [flag, setFlag] = useState<{ top: number; left: number; quote: string; entryKey: string | null } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const open = (quote = "", entryKey: string | null = null) => {
    setFlag(null);
    setState("idle");
    setDraft({ path: pathname, quote: quote.slice(0, 2000), entryKey, category: "wrong_fact", note: "", suggestion: "", sourceUrl: "", notify: true });
  };

  // A draft kept through signing in reopens on the same page.
  useEffect(() => {
    const kept = readDraft();
    if (kept && kept.path === pathname && signedIn) setDraft(kept);
  }, [pathname, signedIn]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ quote?: string; entryKey?: string | null }>).detail || {};
      open(detail.quote, detail.entryKey ?? null);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  });

  useEffect(() => {
    const onSelect = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const selection = window.getSelection();
        const text = selection?.toString().trim() || "";
        if (!selection || selection.isCollapsed || text.length < 3 || text.length > 2000) return setFlag(null);
        const range = selection.getRangeAt(0);
        const anchor = range.commonAncestorContainer;
        const el = anchor instanceof Element ? anchor : anchor.parentElement;
        // Only the page's own content: not forms, the review bar, or this panel.
        if (!el?.closest("main") || el.closest("input, textarea, [contenteditable], [data-report-ignore]")) return setFlag(null);
        // Next to where the selection ends (its last line), not the corner of the box around every selected line.
        const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0);
        const rect = lines[lines.length - 1] || range.getBoundingClientRect();
        setFlag({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.right - 24, window.innerWidth - 150)), quote: text, entryKey: entryKeyOf(anchor) });
      }, 200);
    };
    const hide = () => setFlag(null);
    document.addEventListener("selectionchange", onSelect);
    window.addEventListener("scroll", hide, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", onSelect);
      window.removeEventListener("scroll", hide);
      clearTimeout(timer.current);
    };
  }, []);

  const send = async () => {
    if (!draft) return;
    if (!signedIn) {
      saveDraft(draft);
      window.location.assign(`/login?redirectTo=${encodeURIComponent(pathname)}`);
      return;
    }
    setState("sending");
    try {
      const response = await fetch("/api/report-issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not send the report.");
      saveDraft(null);
      setState("sent");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the report.");
      setState("error");
    }
  };

  const update = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const close = () => { setDraft(null); saveDraft(null); };

  return (
    <>
      {flag && (
        <button
          type="button"
          data-report-ignore
          // Keep the selection when the button is pressed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => open(flag.quote, flag.entryKey)}
          className="fixed z-50 inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white shadow-lg hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          style={{ top: flag.top, left: flag.left }}
        >
          <Flag className="h-3.5 w-3.5" aria-hidden="true" />
          Report an issue
        </button>
      )}
      <Dialog open={!!draft} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent data-report-ignore className="sm:max-w-lg">
          {state === "sent" ? (
            <>
              <DialogHeader>
                <DialogTitle>Thanks for the report</DialogTitle>
                <DialogDescription>
                  A moderator will check it against the City's records.{draft?.notify ? " We'll email you when it's been looked at." : ""}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <button type="button" onClick={close} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Done</button>
              </DialogFooter>
            </>
          ) : draft && (
            <>
              <DialogHeader>
                <DialogTitle>Report an issue</DialogTitle>
                <DialogDescription>Tell us what's wrong on this page. A moderator reviews every report.</DialogDescription>
              </DialogHeader>
              {draft.quote && (
                <blockquote className="max-h-32 overflow-y-auto border-l-2 border-brand-500 pl-3 text-sm text-zinc-700">{draft.quote}</blockquote>
              )}
              <fieldset className="grid gap-1.5">
                <legend className="mb-1 text-sm font-medium text-zinc-900">What's wrong?</legend>
                {REPORT_CATEGORIES.map(({ value, label }) => (
                  <label key={value} className="flex items-center gap-2 text-sm text-zinc-700">
                    <input type="radio" name="category" value={value} checked={draft.category === value} onChange={() => update({ category: value })} />
                    {label}
                  </label>
                ))}
              </fieldset>
              <label className="grid gap-1 text-sm">
                <span className="font-medium text-zinc-900">Tell us more</span>
                <textarea rows={3} maxLength={2000} value={draft.note} onChange={(e) => update({ note: e.target.value })}
                  className="rounded-lg border border-zinc-300 bg-surface px-3 py-2" placeholder="What's wrong, and how do you know?" />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="font-medium text-zinc-900">What should it say? <span className="font-normal text-zinc-500">(optional)</span></span>
                <textarea rows={2} maxLength={2000} value={draft.suggestion} onChange={(e) => update({ suggestion: e.target.value })}
                  className="rounded-lg border border-zinc-300 bg-surface px-3 py-2" />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="font-medium text-zinc-900">Source <span className="font-normal text-zinc-500">(optional link, e.g. the minutes)</span></span>
                <input type="url" maxLength={1000} value={draft.sourceUrl} onChange={(e) => update({ sourceUrl: e.target.value })}
                  className="rounded-lg border border-zinc-300 bg-surface px-3 py-2" placeholder="https://" />
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" checked={draft.notify} onChange={(e) => update({ notify: e.target.checked })} />
                Email me when it's been looked at
              </label>
              {state === "error" && <p className="text-sm text-red-700">{error}</p>}
              <DialogFooter className="items-center gap-3">
                {!signedIn && (
                  <p className="mr-auto text-xs text-zinc-500">
                    You'll sign in or <Link to={`/signup?redirectTo=${encodeURIComponent(pathname)}`} onClick={() => saveDraft(draft)} className="underline">create an account</Link> to send. We'll keep what you wrote.
                  </p>
                )}
                <button type="button" onClick={send} disabled={state === "sending" || (!draft.note.trim() && !draft.quote)}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                  {signedIn ? (state === "sending" ? "Sending…" : "Send report") : "Sign in to send"}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
