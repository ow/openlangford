import { getSupabaseAdminClient } from "../lib/supabase.server";

export interface SearchBudget {
  available: boolean;
  remaining: number;
  resetsAt: string | null;
}

/** Defaults to 50; invalid configuration fails closed. Zero disables generation. */
export async function getSearchBudget(
  configuredLimit: unknown,
  reserve = false,
): Promise<SearchBudget> {
  const limit = Number(configuredLimit ?? 50);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return { available: false, remaining: 0, resetsAt: null };
  }
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("search_daily_budget", {
      p_limit: limit,
      p_reserve: reserve,
    });
    const row = data?.[0];
    if (error || !row) throw new Error(error?.message || "No budget returned");
    return { available: row.allowed === true, remaining: row.remaining, resetsAt: row.resets_at };
  } catch (error) {
    console.error("Search budget unavailable:", error instanceof Error ? error.message : "Database failure");
    return { available: false, remaining: 0, resetsAt: null };
  }
}

// Shown on every page (search availability); a minute's staleness is harmless. Spending
// still goes through getSearchBudget(limit, true), which never uses this copy.
let displayed: { limit: unknown; at: number; value: Promise<SearchBudget> } | null = null;
export function getSearchBudgetForDisplay(configuredLimit: unknown, now = Date.now()): Promise<SearchBudget> {
  if (!displayed || displayed.limit !== configuredLimit || now - displayed.at > 60_000) {
    const value = getSearchBudget(configuredLimit);
    displayed = { limit: configuredLimit, at: now, value };
    // A failed read must not be served for a minute.
    value.then((budget) => { if (!budget.available && budget.resetsAt === null && displayed?.value === value) displayed = null; });
  }
  return displayed.value;
}

/** SSE keeps EventSource clients from silently treating a quota response as a network error. */
export function searchBudgetExceeded(budget: SearchBudget): Response {
  return new Response(`data: ${JSON.stringify({ type: "budget_exhausted", resetsAt: budget.resetsAt })}\n\ndata: {"type":"done"}\n\n`, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}
