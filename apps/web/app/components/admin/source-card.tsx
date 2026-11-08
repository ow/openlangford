import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Newspaper, Trash2 } from "lucide-react";
import { useJsonFetcher } from "../../lib/use-json-fetcher";
import { sourceByline, type Source, type SourceOrigin } from "../../lib/sources";
import { cn } from "../../lib/utils";

type Draft = {
  headline: string; happened_on: string | null; published_on: string | null; publisher: string; title: string; quote: string;
  origin: SourceOrigin; date_label: string | null; caution: string | null; pageTitle: string; fetched: boolean;
};
type Reply = { ok?: true; draft?: Draft; message?: string | null; error?: string };

const field = "w-full rounded-lg border border-zinc-300 bg-surface px-2.5 py-1.5 text-sm";
const label = "grid gap-1 text-xs";
const labelText = "font-medium text-zinc-800";

/**
 * "Add a source": a link from outside the meeting record (a City news release, a news report) becomes a dated line
 * on this page's timeline, labelled by who said it. Staff paste the link (and, if they like, the words and the date);
 * the draft reads the page and proposes the line; staff change what they want and add it. See services/sources.server.ts.
 */
export function SourceCard({ path, sources, onClose, onChanged }: { path: string; sources: Source[]; onClose: () => void; onChanged: () => void }) {
  const api = useJsonFetcher<Reply>();
  const [url, setUrl] = useState("");
  const [quote, setQuote] = useState("");
  const [date, setDate] = useState("");
  const [what, setWhat] = useState("");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const busy = api.state !== "idle";
  const intent = busy ? String(api.formData?.get("intent") || "") : "";

  // A draft comes back: show it to edit. An add or remove lands: the page reloads its data and the form clears.
  useEffect(() => {
    if (api.state !== "idle" || !api.data) return;
    if (api.data.draft) setDraft(api.data.draft);
    else if (api.data.ok) { setDraft(null); setUrl(""); setQuote(""); setDate(""); setWhat(""); setNote(""); setRemoving(null); onChanged(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.state, api.data]);

  const send = (intent: string, extra: Record<string, string>) =>
    api.submit({ intent, path, title: typeof document !== "undefined" ? document.title : "", ...extra }, { method: "post", action: "/api/page-review" });

  return (
    <div className="w-full rounded-2xl border border-dashed border-amber-400 bg-surface p-4 text-sm shadow-lg sm:w-[30rem]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 font-semibold text-zinc-900"><Newspaper className="h-4 w-4" />Sources outside the meeting record</p>
          <p className="mt-1 text-xs text-zinc-600">
            A City news release, a notice or a news report that says what happened when the minutes don't (a land purchase decided in a closed meeting, say).
            It joins the timeline as a dated line labelled by who said it. It is never treated as the City's record.
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100">Close</button>
      </div>

      {sources.length > 0 && (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {sources.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-2 px-2.5 py-2">
              <div className="min-w-0">
                <p className="text-xs text-zinc-500"><span className="tabular-nums">{s.date_label || s.happened_on}</span> · {sourceByline(s)}</p>
                <p className="text-zinc-900">{s.headline}</p>
                {s.url && <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">{s.title}<ExternalLink className="h-3 w-3" /></a>}
              </div>
              {removing === s.id ? (
                <span className="flex shrink-0 items-center gap-1 text-xs">
                  <button type="button" disabled={busy} onClick={() => send("remove_source", { source_id: String(s.id) })} className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700">Remove</button>
                  <button type="button" onClick={() => setRemoving(null)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">Keep</button>
                </span>
              ) : (
                <button type="button" onClick={() => setRemoving(s.id)} aria-label="Remove this source from the page" className="shrink-0 rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-700"><Trash2 className="h-4 w-4" /></button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!draft ? (
        <form className="mt-3 grid gap-2" onSubmit={(e) => { e.preventDefault(); if (url.trim()) send("draft_source", { url: url.trim(), quote, date, what }); }}>
          <label className={label}><span className={labelText}>Link</span>
            <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} className={field} placeholder="https://www.vicnews.com/news/…" /></label>
          <label className={label}><span className={labelText}>What happened <span className="font-normal text-zinc-500">(optional; the draft reads the page)</span></span>
            <input value={what} onChange={(e) => setWhat(e.target.value)} className={field} placeholder="City bought the land for about $2.2M" /></label>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <label className={label}><span className={labelText}>Its words <span className="font-normal text-zinc-500">(optional)</span></span>
              <input value={quote} onChange={(e) => setQuote(e.target.value)} className={field} placeholder="Paste the sentence that says it" /></label>
            <label className={label}><span className={labelText}>Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} /></label>
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy || !url.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {intent === "draft_source" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Newspaper className="h-3.5 w-3.5" />}{intent === "draft_source" ? "Reading the page…" : "Draft the line"}
            </button>
            <span className="text-xs text-zinc-500">You'll see the line before it goes on the page.</span>
          </div>
        </form>
      ) : (
        <form className="mt-3 grid gap-2" onSubmit={(e) => {
          e.preventDefault();
          send("add_source", {
            url: url.trim(), headline: draft.headline, happened_on: draft.happened_on || "", published_on: draft.published_on || "", publisher: draft.publisher,
            origin: draft.origin, source_title: draft.title, quote: draft.quote, note, date_label: draft.date_label || "",
          });
        }}>
          {!draft.fetched && <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">The page couldn't be read, so the draft rests on what you typed. Check it before adding.</p>}
          {draft.caution && <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">{draft.caution}</p>}
          <label className={label}><span className={labelText}>The line residents read</span>
            <input required maxLength={160} value={draft.headline} onChange={(e) => setDraft({ ...draft, headline: e.target.value })} className={cn(field, "font-medium")} /></label>
          <label className={label}><span className={labelText}>Its words</span>
            <textarea rows={2} maxLength={400} value={draft.quote} onChange={(e) => setDraft({ ...draft, quote: e.target.value })} className={field} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className={label}><span className={labelText}>When it happened</span>
              <input required type="date" value={draft.happened_on || ""} onChange={(e) => setDraft({ ...draft, happened_on: e.target.value })} className={field} /></label>
            <label className={cn(label, "col-span-2")}><span className={labelText}>Show the date as <span className="font-normal text-zinc-500">(optional; for an approximate date, such as "Spring 2019". The date above still orders it)</span></span>
              <input value={draft.date_label || ""} onChange={(e) => setDraft({ ...draft, date_label: e.target.value })} className={field} placeholder="Spring 2019" /></label>
            <label className={label}><span className={labelText}>Published</span>
              <input type="date" value={draft.published_on || ""} onChange={(e) => setDraft({ ...draft, published_on: e.target.value })} className={field} /></label>
            <label className={label}><span className={labelText}>Who said it</span>
              <input required value={draft.publisher} onChange={(e) => setDraft({ ...draft, publisher: e.target.value })} className={field} /></label>
            <label className={label}><span className={labelText}>Kind</span>
              <select value={draft.origin} onChange={(e) => setDraft({ ...draft, origin: e.target.value as SourceOrigin })} className={field}>
                <option value="city">The City's own publication</option>
                <option value="press">News report</option>
                <option value="other">Another body or document</option>
              </select></label>
          </div>
          <label className={label}><span className={labelText}>Page title</span>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={field} /></label>
          <label className={label}><span className={labelText}>Note for staff <span className="font-normal text-zinc-500">(optional; not shown to residents)</span></span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={field} /></label>
          <p className="text-xs text-zinc-500">Shown as: <span className="tabular-nums">{draft.date_label || draft.happened_on || "date"}</span> · {sourceByline({ origin: draft.origin, publisher: draft.publisher || "…", published_on: draft.published_on, happened_on: draft.happened_on || "" })}</p>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !draft.headline.trim() || !draft.happened_on} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {intent === "add_source" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Add to the timeline
            </button>
            <button type="button" onClick={() => setDraft(null)} className="rounded-lg px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100">Back</button>
          </div>
        </form>
      )}
      {api.data?.error && <p className="mt-2 text-xs text-red-700">{api.data.error}</p>}
    </div>
  );
}
