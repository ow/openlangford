import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Lightweight Server-Timing for loaders: `timed("home-data", promise)` records how long a
 * named step took, and the Worker adds every step to the response's Server-Timing header.
 * Names and durations only (no data), so it is safe on public responses.
 */
type Entry = { name: string; dur: number };
const storage = new AsyncLocalStorage<Entry[]>();

export async function withServerTiming(render: () => Promise<Response>): Promise<Response> {
  const entries: Entry[] = [];
  const started = performance.now();
  const response = await storage.run(entries, render);
  if (!entries.length || response.status === 101) return response;
  const total = performance.now() - started;
  const delivered = new Response(response.body, response);
  delivered.headers.append("Server-Timing", serverTimingHeader([...entries, { name: "app", dur: total }]));
  return delivered;
}

export function serverTimingHeader(entries: Entry[]): string {
  return entries.map(({ name, dur }) => `${name.replace(/[^A-Za-z0-9_.-]/g, "-")};dur=${Math.round(dur * 10) / 10}`).join(", ");
}

/** Time a named loader step. Outside a request scope (tests, scripts) it just awaits. */
export async function timed<T>(name: string, work: Promise<T> | (() => Promise<T>)): Promise<T> {
  const entries = storage.getStore();
  const started = performance.now();
  try {
    return await (typeof work === "function" ? work() : work);
  } finally {
    entries?.push({ name, dur: performance.now() - started });
  }
}
