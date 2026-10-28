/// <reference types="@cloudflare/workers-types" />
import { getSupabaseAdminClient } from "../app/lib/supabase.server";

// When public content last changed (database triggers stamp it, at most once a minute).
// Part of every public cache key, so day-long entries end within about a minute of an
// ingest or correction. Read at most once a minute per isolate; a failed read disables
// caching for the request rather than serving a stale stamp.
const READ_EVERY_MS = 60_000;
let last: { at: number; value: Promise<string | null> } | null = null;

export function contentVersion(now = Date.now(), read: () => Promise<string | null> = readStamp): Promise<string | null> {
  if (!last || now - last.at > READ_EVERY_MS) {
    const value = read().catch(() => null);
    last = { at: now, value };
    value.then((stamp) => { if (stamp === null && last?.value === value) last = null; });
  }
  return last.value;
}

async function readStamp(): Promise<string | null> {
  const { data, error } = await getSupabaseAdminClient().from("public_content_version").select("changed_at").eq("id", 1).maybeSingle();
  if (error || !data?.changed_at) return null;
  return String(Date.parse(data.changed_at));
}

export function resetContentVersionForTests() {
  last = null;
}
