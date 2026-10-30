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

/**
 * Deletes contact messages (with the sender's IP) and strips the recipient address from email
 * logs once they're 12 months old (`apply_privacy_retention`). Returns counts only.
 */
export async function applyPrivacyRetention(supabase: SupabaseClient, { dryRun = false } = {}) {
  const { data, error } = await supabase.rpc("apply_privacy_retention", { p_dry_run: dryRun });
  if (error) throw new Error(`Privacy retention failed: ${error.message}`);
  return data as { dry_run: boolean; contact_messages_deleted: number; email_messages_anonymized: number };
}
