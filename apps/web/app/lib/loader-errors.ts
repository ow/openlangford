/**
 * Detail loaders tell "no such record" (404) apart from "the database didn't answer" (503).
 * A transient Supabase failure must never look like a missing page to a crawler.
 */
export const RETRY_AFTER_SECONDS = 30;

export function unavailable(cause?: unknown): Response {
  if (cause !== undefined) console.error("[loader] upstream unavailable:", cause);
  return new Response("Service Unavailable", { status: 503, headers: { "Retry-After": String(RETRY_AFTER_SECONDS) } });
}

/** PostgREST's `.single()` reports zero rows as error PGRST116; that is a real "not found". */
export function isNoRows(error: unknown): boolean {
  return (error as any)?.code === "PGRST116";
}

/** Throw a 503 when a Supabase query failed (network, timeout, 5xx). */
export function throwIfFailed(error: unknown): void {
  if (error) throw unavailable(error);
}

/**
 * Loader catch-all: Responses (404s, redirects) pass through; a `.single()` zero-row error or an
 * error whose message is `notFound` becomes a 404; anything else is a backend failure, a 503.
 */
export function loaderFailure(error: unknown, notFound: string): Response {
  if (error instanceof Response) return error;
  if (isNoRows(error) || (error as any)?.message === notFound) return new Response(notFound, { status: 404 });
  return unavailable(error);
}
