import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Supabase rotates the refresh token whenever a session is refreshed. When that refresh happens on the server
 * (an auth check in a loader or action with an access token about to expire), the new cookies must reach the
 * browser, or it keeps the old refresh token, which is now revoked, and its next request lands on the login page.
 * (2026-11-04/05/06: every rotation of the owner's session was followed by a forced login within a minute.)
 *
 * Routes don't pass the server client's headers through (26 call sites), so the worker collects every cookie the
 * client sets during a request here and appends them to whatever response the route returns.
 */
const storage = new AsyncLocalStorage<string[]>();

/** Runs a request handler and adds any auth cookies set during it to its response. */
export async function withAuthCookies(fn: () => Promise<Response>): Promise<Response> {
  const collected: string[] = [];
  const response = await storage.run(collected, fn);
  return appendCookies(response, collected);
}

/** Called by the server Supabase client for every cookie it sets. */
export function collectAuthCookie(setCookie: string) {
  storage.getStore()?.push(setCookie);
}

/** The response with the collected cookies added, skipping any it already carries (a route that forwarded them). */
export function appendCookies(response: Response, cookies: string[]): Response {
  if (!cookies.length) return response;
  const present = new Set(response.headers.getSetCookie?.() ?? []);
  const missing = cookies.filter((c) => !present.has(c));
  if (!missing.length) return response;
  const out = new Response(response.body, response);
  for (const cookie of missing) out.headers.append("Set-Cookie", cookie);
  return out;
}
