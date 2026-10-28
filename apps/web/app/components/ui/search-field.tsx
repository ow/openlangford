import { Search, X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";

interface SearchFieldProps extends Omit<ComponentProps<"input">, "onChange" | "value" | "type"> {
  value: string;
  onValueChange: (value: string) => void;
}

/** Search input matching NativeSelect (h-10), with a clear button. */
export function SearchField({ value, onValueChange, className, ...props }: SearchFieldProps) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className="h-10 w-full rounded-lg border border-zinc-200 bg-surface pl-9 pr-9 text-sm text-zinc-900 shadow-xs placeholder:text-zinc-400 transition-colors hover:border-zinc-300 focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20 [&::-webkit-search-cancel-button]:hidden"
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={() => onValueChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
