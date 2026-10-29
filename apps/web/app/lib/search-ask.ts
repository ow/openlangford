import { isbot } from "isbot";

/** URL that opens the search page straight into an AI answer for `query`. */
export function askUrl(query: string, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams({ q: query, mode: "ai" });
  for (const [k, v] of Object.entries(extra ?? {})) if (v) params.set(k, v);
  return `/search?${params.toString()}`;
}

/** URL for the plain records search (no AI answer). */
export function searchUrl(query: string): string {
  return `/search?${new URLSearchParams({ q: query }).toString()}`;
}

/**
 * Whether the search page should start an AI answer on load: only when the URL
 * explicitly asks for one (`mode=ai`), there's no cached answer to show instead,
 * AI search is available, and the visitor isn't a crawler.
 */
export function shouldAutoAsk(opts: {
  query: string;
  mode: string | null;
  cachedId: string | null | undefined;
  aiSearchAvailable: boolean;
  userAgent: string | null | undefined;
}): boolean {
  if (opts.mode !== "ai") return false;
  if (opts.query.trim().length < 2) return false;
  if (opts.cachedId) return false;
  if (!opts.aiSearchAvailable) return false;
  if (!opts.userAgent || isbot(opts.userAgent)) return false;
  return true;
}
