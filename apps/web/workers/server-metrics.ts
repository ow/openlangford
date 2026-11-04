/// <reference types="@cloudflare/workers-types" />
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseServerMetrics } from "../app/lib/server-metrics";

/** Keep a week of five-minute readings. */
const KEEP_DAYS = 7;

/** Reads the database host's metrics (Supabase's privileged endpoint, service-role basic auth) and stores one row. */
export async function recordServerMetrics(supabase: SupabaseClient, fetcher: typeof fetch = fetch) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return { recorded: false, reason: "not configured" };
  const response = await fetcher(`${url.replace(/\/$/, "")}/customer/v1/privileged/metrics`, {
    headers: { Authorization: `Basic ${btoa(`service_role:${key}`)}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Metrics endpoint answered ${response.status}`);
  const sample = parseServerMetrics(await response.text());
  const { error } = await supabase.from("server_metrics").insert(sample);
  if (error) throw new Error(`Could not store server metrics: ${error.message}`);
  await supabase.from("server_metrics").delete().lt("sampled_at", new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString());
  return { recorded: true };
}
