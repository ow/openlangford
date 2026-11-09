import { useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { ImageOff, Loader2, RotateCcw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { FIELD_LABELS, IMAGE_KIND_LABELS, IMAGE_KINDS, type EditField, type TopicEditState } from "../../lib/topic-edit";
import { reviewTime } from "../../lib/page-review-types";
import { cn } from "../../lib/utils";

type Loaded = { path: string | null; edit: TopicEditState | null };
type Saved = { ok?: true; message?: string | null; error?: string };
type Draft = { title: string; summary: string; statusLine: string; image: number | "none" | "current"; kind: string };

const input = "w-full rounded-lg border border-zinc-300 bg-surface px-3 py-2 text-sm";

/** Staff: edit a topic's title, summary, "where it stands" and feature photo, or an address's summary. Fields saved here are the editor's: the
 * pipeline leaves them alone until someone presses "Reset to automatic". */
export function TopicEditDialog({ open, onOpenChange, path, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; path: string; onSaved: () => void;
}) {
  const load = useFetcher<Loaded>();
  const save = useFetcher<Saved>();
  const revalidator = useRevalidator();
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (open) { setDraft(null); load.load(`/api/page-review?path=${encodeURIComponent(path)}&edit=1`); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path]);
  const state = load.data?.path === path ? load.data.edit : null;
  useEffect(() => {
    if (state && open) setDraft({ title: state.title, summary: state.summary, statusLine: state.statusLine, image: "current", kind: state.image?.kind ?? "" });
  }, [state, open]);

  // After a save: the page shows the new text, the bar its new state, and the panel the stored values.
  // Acts on the server's answer, not on the page reload that follows it: a reload can hang (a deploy landing mid-save
  // swaps the build it loads from), and the dialog shouldn't sit on "Saving…" for a save that's done.
  const [sent, setSent] = useState<string | null>(null);
  const answerBefore = useRef<unknown>(undefined);
  useEffect(() => {
    if (!sent || save.state === "submitting" || save.data === answerBefore.current) return;
    const intent = sent;
    setSent(null);
    if (!save.data?.ok) return;
    revalidator.revalidate();
    onSaved();
    if (intent === "edit_topic") onOpenChange(false);
    else load.load(`/api/page-review?path=${encodeURIComponent(path)}&edit=1`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.state, save.data]);

  const send = (intent: string, fields: Record<string, string> = {}) => {
    answerBefore.current = save.data;
    setSent(intent);
    save.submit({ intent, path, title: document.title, ...fields }, { method: "post", action: "/api/page-review" });
  };
  const busy = save.state === "submitting" || !!sent;
  const locked = (field: EditField) => state?.locked.includes(field);
  const has = (field: EditField) => !state || state.fields.includes(field);

  const submit = () => {
    if (!state || !draft) return;
    const fields: Record<string, string> = {};
    if (has("title") && draft.title.trim() !== state.title) fields.topic_title = draft.title;
    if (draft.summary.trim() !== state.summary) fields.summary = draft.summary;
    if (has("status_line") && draft.statusLine.trim() !== state.statusLine) fields.status_line = draft.statusLine;
    if (!has("image")) { /* an address has no photo to choose */ }
    else if (draft.image !== "current") { fields.image = String(draft.image); fields.image_kind = draft.kind; }
    else if (state.image && draft.kind !== (state.image.kind ?? "")) {
      // Only the caption changed: send the same picture again.
      const same = state.candidates.find((c) => c.url === state.image!.url);
      if (same) { fields.image = String(same.id); fields.image_kind = draft.kind; }
    }
    if (!Object.keys(fields).length) return onOpenChange(false);
    send("edit_topic", fields);
  };

  const label = (field: EditField, extra?: string) => (
    <span className="flex items-center gap-2 font-medium text-zinc-900">
      {FIELD_LABELS[field]}{extra && <span className="font-normal text-zinc-500">{extra}</span>}
      {locked(field) && (
        <>
          <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-800">Edited by hand</span>
          <button type="button" disabled={busy} onClick={() => send("reset_field", { field })}
            className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-zinc-500 hover:text-zinc-800">
            <RotateCcw className="h-3 w-3" />Reset to automatic
          </button>
        </>
      )}
    </span>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-report-ignore className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit this {state?.noun ?? "topic"}</DialogTitle>
          <DialogDescription>
            What you change here stays: the pipeline won't rewrite an edited field when new meetings come in, until you
            reset it to automatic.
          </DialogDescription>
        </DialogHeader>
        {!state || !draft ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : (
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {state.newEntries > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <span>
                  {state.newEntries} new {state.newEntries === 1 ? "entry" : "entries"} on this {state.noun} since the last edit
                  {state.editedAt ? ` (${reviewTime(state.editedAt)})` : ""}. Check the edited text still holds.
                </span>
                <button type="button" disabled={busy} onClick={() => send("keep_edits")} className="text-xs font-medium text-amber-900 underline">It still holds</button>
              </div>
            )}
            {has("title") && <label className="grid gap-1 text-sm">
              {label("title")}
              <input value={draft.title} maxLength={200} required onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={input} />
            </label>}
            <label className="grid gap-1 text-sm">
              {label("summary")}
              <textarea value={draft.summary} rows={5} maxLength={4000} required onChange={(e) => setDraft({ ...draft, summary: e.target.value })} className={input} />
            </label>
            {has("status_line") && <label className="grid gap-1 text-sm">
              {label("status_line", "(optional)")}
              <input value={draft.statusLine} maxLength={400} onChange={(e) => setDraft({ ...draft, statusLine: e.target.value })} className={input}
                placeholder="e.g. Third reading given Sep 28, 2026; final adoption still to come." />
            </label>}
            {has("image") && <fieldset className="grid gap-2 text-sm">
              <legend className="mb-1 w-full">{label("image", state.candidates.length ? `· ${state.candidates.length} from this topic's reports` : "· no report pictures found")}</legend>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                <button type="button" onClick={() => setDraft({ ...draft, image: "none" })}
                  className={cn("flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-lg border text-xs text-zinc-500",
                    (draft.image === "none" || (draft.image === "current" && !state.image)) ? "border-brand-600 ring-2 ring-brand-600" : "border-zinc-200 hover:border-zinc-400")}>
                  <ImageOff className="h-5 w-5" />No photo
                </button>
                {state.candidates.map((c) => {
                  const chosen = draft.image === c.id || (draft.image === "current" && state.image?.url === c.url);
                  return (
                    <button key={c.id} type="button" onClick={() => setDraft({ ...draft, image: c.id })}
                      title={[c.report, c.page ? `page ${c.page}` : ""].filter(Boolean).join(", ")}
                      className={cn("overflow-hidden rounded-lg border bg-zinc-50", chosen ? "border-brand-600 ring-2 ring-brand-600" : "border-zinc-200 hover:border-zinc-400")}>
                      <img src={c.url} alt={c.report || "Report picture"} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                    </button>
                  );
                })}
              </div>
              {(draft.image === "current" ? !!state.image : draft.image !== "none") && (
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  Caption
                  <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className="rounded-lg border border-zinc-300 bg-surface px-2 py-1 text-sm">
                    <option value="">From the staff report</option>
                    {IMAGE_KINDS.map((k) => <option key={k} value={k}>{IMAGE_KIND_LABELS[k]}</option>)}
                  </select>
                </label>
              )}
            </fieldset>}
            {state.noun === "address" && <p className="-mt-2 text-xs text-zinc-500">The line counting how often the address came up is added for you.</p>}
            {save.data?.error && save.state === "idle" && <p className="text-sm text-red-700">{save.data.error}</p>}
            <DialogFooter className="gap-2">
              <button type="button" onClick={() => onOpenChange(false)} className="rounded-lg px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100">Cancel</button>
              <button type="submit" disabled={busy || !draft.title.trim() || !draft.summary.trim()}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                {busy && sent === "edit_topic" ? "Saving…" : "Save"}
              </button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
