import { useEffect, useState } from "react";
import { useFetcher, useLocation } from "react-router";
import { Pencil, StickyNote } from "lucide-react";
import { reviewTime, type PageReview } from "../../lib/page-review-types";

type Loaded = { path?: string; review?: PageReview | null };

/** Opens the banner's editor from elsewhere (the review bar's note button). */
export const OPEN_INTERNAL_NOTE = "internal-note:open";

/**
 * Staff's internal note on this page, as a banner at the top of the page (moderators and admins only; root.tsx
 * renders it beside the review bar). Context for whoever looks at the page next; never public.
 */
export function InternalNoteBanner() {
  const { pathname } = useLocation();
  const load = useFetcher<Loaded>();
  const save = useFetcher<Loaded & { ok?: boolean }>();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  useEffect(() => {
    setEditing(false);
    load.load(`/api/page-review?path=${encodeURIComponent(pathname)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  useEffect(() => {
    const open = () => { setText(note || ""); setEditing(true); window.scrollTo({ top: 0, behavior: "smooth" }); };
    window.addEventListener(OPEN_INTERNAL_NOTE, open);
    return () => window.removeEventListener(OPEN_INTERNAL_NOTE, open);
  });

  const saved = save.data && save.data.review?.path === pathname ? save.data.review : undefined;
  const review = saved ?? (load.data?.path === pathname ? load.data.review : null);
  const pending = save.state !== "idle" ? String(save.formData?.get("note") ?? "") : null;
  const note = pending ?? review?.internal_note ?? null;
  const submit = (value: string) => {
    save.submit({ intent: "internal_note", path: pathname, title: document.title, note: value }, { method: "post", action: "/api/page-review" });
    setEditing(false);
  };
  if (!editing && !note) return null;

  return (
    // The page's own width: meeting pages are wider than topic and property pages.
    <div className={`container mx-auto px-4 pt-4 print:hidden ${pathname.startsWith("/meetings/") ? "max-w-6xl" : "max-w-4xl"}`}>
      <div className="rounded-xl border border-dashed border-amber-400 bg-amber-50 px-4 py-3 text-sm">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800">
          <StickyNote className="h-3.5 w-3.5" />Internal note
          <span className="font-normal normal-case tracking-normal text-amber-700/80">
            · only staff see this{review?.internal_note_at && !editing ? ` · ${reviewTime(review.internal_note_at)}` : ""}
          </span>
          {!editing && (
            <button type="button" onClick={() => { setText(note || ""); setEditing(true); }} aria-label="Edit the internal note"
              className="ml-auto rounded-full p-1 text-amber-700 hover:bg-amber-100"><Pencil className="h-3.5 w-3.5" /></button>
          )}
        </div>
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); submit(text); }}>
            <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Context for whoever looks at this page next."
              className="w-full rounded-lg border border-amber-200 bg-white p-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-amber-300" />
            <div className="mt-1.5 flex gap-2 text-xs">
              <button type="submit" className="rounded-md bg-amber-600 px-2.5 py-1 font-medium text-white hover:bg-amber-700">Save note</button>
              <button type="button" onClick={() => setEditing(false)} className="rounded-md px-2.5 py-1 text-zinc-600 hover:bg-amber-100">Cancel</button>
              {review?.internal_note && (
                <button type="button" onClick={() => submit("")} className="ml-auto rounded-md px-2.5 py-1 text-zinc-500 hover:bg-amber-100">Delete</button>
              )}
            </div>
          </form>
        ) : (
          <p className="whitespace-pre-line text-zinc-800">{note}</p>
        )}
      </div>
    </div>
  );
}
