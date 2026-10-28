import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";

/**
 * Native <select> styled to match Input. Keeps platform pickers on mobile
 * and full keyboard/screen-reader support.
 */
export function NativeSelect({
  className,
  children,
  ...props
}: ComponentProps<"select">) {
  return (
    <div className={cn("relative", className)}>
      <select
        className="h-10 w-full cursor-pointer appearance-none rounded-lg border border-zinc-200 bg-surface pl-3 pr-9 text-sm font-medium text-zinc-800 shadow-xs transition-colors hover:border-zinc-300 focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
        aria-hidden="true"
      />
    </div>
  );
}
