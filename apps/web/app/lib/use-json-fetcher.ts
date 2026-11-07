import { useCallback, useRef, useState } from "react";

/**
 * A fetcher for JSON resource routes that never reaches the route error boundary. React Router's useFetcher hands
 * any failure (a thrown Response, a dropped connection, a request iOS Safari cancels when the tab goes to the
 * background) to the nearest ErrorBoundary, which replaces the whole page with "This page didn't load". The review
 * bar's requests can run for a minute and a half, so its failures belong in the bar, not on the page.
 *
 * Same shape as the parts of useFetcher the bar uses: `state`, `data`, `formData`, `submit(fields, { method, action })`
 * and `load(url)`. A failed submit resolves `data` to `{ error }`; a failed load keeps the data it had.
 */
export type JsonFetcherState = "idle" | "loading" | "submitting";

export function useJsonFetcher<T extends object>() {
  const [state, setState] = useState<JsonFetcherState>("idle");
  const [data, setData] = useState<(T & { error?: string }) | undefined>(undefined);
  const [formData, setFormData] = useState<FormData | undefined>(undefined);
  const seq = useRef(0);

  const run = useCallback(async (kind: Exclude<JsonFetcherState, "idle">, url: string, init: RequestInit, fd?: FormData) => {
    const id = ++seq.current;
    setFormData(fd);
    setState(kind);
    try {
      const res = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init.headers || {}) } });
      let body: any = null;
      try { body = await res.json(); } catch { body = null; }
      if (id !== seq.current) return;
      if (res.ok) setData(body ?? ({} as T));
      else if (kind === "submitting") setData({ ...(body && typeof body === "object" ? body : {}), error: body?.error || failed(`the server answered ${res.status}`) });
      // A failed load keeps what the bar already shows.
    } catch (e) {
      if (id !== seq.current) return;
      if (kind === "submitting") setData({ error: failed(e instanceof Error ? e.message : String(e)) } as T & { error: string });
    } finally {
      if (id === seq.current) setState("idle");
    }
  }, []);

  const submit = useCallback((fields: Record<string, string>, opts: { method?: string; action: string }) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return run("submitting", opts.action, { method: (opts.method || "post").toUpperCase(), body: fd }, fd);
  }, [run]);

  const load = useCallback((url: string) => run("loading", url, { method: "GET" }), [run]);

  return { state, data, formData, submit, load };
}

const failed = (why: string) => `Couldn't reach the server (${why}). Nothing was lost: try again.`;
