import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";

/** A quote set as a pull quote: italic, a thin brand-tinted rule, a touch darker than body text. Not loud. */
export const PULL = "border-l-2 border-brand-200 pl-3 italic text-zinc-700";

/**
 * A pull quote that shows about six lines and, when there is more, a "Show more" to read the rest. The check runs
 * after the page loads, so a long quote is clamped at first and the button appears a moment later.
 */
export function PullQuote({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLQuoteElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight - el.clientHeight > 2);
  }, [children]);
  return (
    <div className={className}>
      <blockquote ref={ref} className={cn("text-sm leading-relaxed", PULL, !open && "line-clamp-6")}>{children}</blockquote>
      {(long || open) && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-xs font-medium text-brand-700 hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
