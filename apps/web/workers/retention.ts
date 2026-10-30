import type { SupabaseClient } from "@supabase/supabase-js";

/** How long legacy AI question traces are kept. Shared answers expire on their own `expires_at`. */
export const RAG_TRACE_RETENTION_DAYS = 30;

/**
 * Deletes residents' AI questions once they're no longer needed: shared answers
 * past their expiry, and legacy question traces (with any feedback, by cascade)
 * older than the retention period. Needs the service-role client.
 */
export async function purgeExpiredQuestions(supabase: SupabaseClient, now = new Date()) {
  const traceCutoff = new Date(now.getTime() - RAG_TRACE_RETENTION_DAYS * 86_400_000).toISOString();
  const [cache, traces] = await Promise.all([
    supabase.from("search_results_cache").delete({ count: "exact" }).lt("expires_at", now.toISOString()),
    supabase.from("rag_traces").delete({ count: "exact" }).lt("created_at", traceCutoff),
  ]);
  if (cache.error || traces.error) {
    throw new Error(`Retention purge failed: ${cache.error?.message ?? traces.error?.message}`);
  }
  return { expiredAnswers: cache.count ?? 0, oldTraces: traces.count ?? 0 };
}
