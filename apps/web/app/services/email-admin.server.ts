import type { SupabaseClient } from "@supabase/supabase-js";
import { boundedPage, requireUuid } from "../lib/admin-read.server";

export const EMAIL_PAGE_SIZE = 25;
import { EMAIL_STATUSES, EMAIL_TYPES } from "../lib/email-ledger";
const columns =
  "id, user_id, recipient, subject, message_type, status, attempt_count, provider_message_id, created_at, updated_at, accepted_at, delivered_at, failed_at, last_error";
const missingSchema = (error: any) =>
  error?.code === "PGRST205" || error?.code === "42P01";

/** Never pass provider payloads, URLs, auth credentials or auth email bodies to a loader. */
export function safeEmailText(value: unknown, maxLength = 500): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, 10000)
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link omitted]")
    .replace(
      /\b(?:Bearer\s+\S+|(?:sb_secret_|sb_publishable_|re_|whsec_)[a-z0-9_-]+)\b/gi,
      "[credential omitted]",
    )
    .replace(
      /\b(?:token|password|secret|otp|code|pin|passcode|api[ _-]?key)(?:\s*[:=]\s*|\s+(?:(?:is|was)\s+)?)\S+/gi,
      "[sensitive value omitted]",
    )
    .replace(/\b\d{6,8}\b/g, "[code omitted]")
    .replace(/\b[a-z0-9_+\/-]{32,}={0,2}\b/gi, "[value omitted]")
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")
    .slice(0, maxLength);
}

function preview(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  // Only a dedicated, deliberately short plaintext excerpt is eligible. Never raw HTML.
  if (
    value.length > 4000 ||
    /<|>|https?:|www\.|\b(?:token|password|secret|otp|code|pin|passcode|one[ -]?time|reset|confirm|verification|authorization|magic[ -]?link)\b|\b\d{4,8}\b|\b[a-z0-9_+\/-]{32,}={0,2}\b/i.test(
      value,
    )
  )
    return null;
  return safeEmailText(value, 4000);
}

export function emailFilters(url: URL) {
  const status = url.searchParams.get("status") || "";
  const type = url.searchParams.get("type") || "";
  const user = url.searchParams.get("user") || "";
  const recipient = (url.searchParams.get("q") || "").trim().slice(0, 120);
  if (status && !EMAIL_STATUSES.includes(status as any))
    throw new Response("Invalid email status.", { status: 400 });
  if (type && !EMAIL_TYPES.includes(type as any))
    throw new Response("Invalid email type.", { status: 400 });
  if (user) requireUuid(user);
  const dates = ["from", "to"].map((key) => {
    const value = url.searchParams.get(key) || "";
    if (
      value &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    )
      throw new Response("Invalid date.", { status: 400 });
    return value;
  });
  if (dates[0] && dates[1] && dates[0] > dates[1])
    throw new Response("Invalid date range.", { status: 400 });
  return {
    page: boundedPage(url.searchParams.get("page")),
    status,
    type,
    user,
    recipient,
    from: dates[0],
    to: dates[1],
  };
}

function providerId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : null;
}

function message(row: any) {
  return {
    id: row.id,
    userId: row.user_id,
    recipient: safeEmailText(row.recipient, 320),
    subject: safeEmailText(row.subject, 300),
    type: row.message_type,
    status: row.status,
    attempts: row.attempt_count,
    providerId: providerId(row.provider_message_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    deliveredAt: row.delivered_at,
    failedAt: row.failed_at,
    error: safeEmailText(row.last_error),
  };
}

export async function getEmailPage(
  client: SupabaseClient,
  filters: ReturnType<typeof emailFilters>,
) {
  let query = client.from("email_messages").select(columns, { count: "exact" });
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.type) query = query.eq("message_type", filters.type);
  if (filters.user) query = query.eq("user_id", filters.user);
  if (filters.recipient)
    query = query.ilike(
      "recipient",
      `%${filters.recipient.replace(/[\\%_]/g, "\\$&")}%`,
    );
  if (filters.from)
    query = query.gte("created_at", `${filters.from}T00:00:00Z`);
  if (filters.to)
    query = query.lt(
      "created_at",
      new Date(
        new Date(`${filters.to}T00:00:00Z`).getTime() + 86400000,
      ).toISOString(),
    );
  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(
      (filters.page - 1) * EMAIL_PAGE_SIZE,
      filters.page * EMAIL_PAGE_SIZE - 1,
    );
  if (missingSchema(error))
    return { available: false, messages: [], hasMore: false, total: 0 };
  if (error) throw error;
  return {
    available: true,
    messages: (data ?? []).map(message),
    hasMore: (count ?? 0) > filters.page * EMAIL_PAGE_SIZE,
    total: count ?? 0,
  };
}

export async function getEmailDetail(
  client: SupabaseClient,
  id: string,
  page: number,
) {
  const result = await client
    .from("email_messages")
    .select(`${columns}, preview_text`)
    .eq("id", id)
    .maybeSingle();
  if (missingSchema(result.error))
    return { available: false, message: null, events: [], hasMore: false };
  if (result.error) throw result.error;
  if (!result.data)
    throw new Response("Email record not found.", { status: 404 });
  const events = await client
    .from("email_events")
    .select(
      "id, event_type, attempt_number, provider_message_id, occurred_at, error_text",
      { count: "exact" },
    )
    .eq("message_id", id)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .range((page - 1) * EMAIL_PAGE_SIZE, page * EMAIL_PAGE_SIZE - 1);
  if (missingSchema(events.error))
    return { available: false, message: null, events: [], hasMore: false };
  if (events.error) throw events.error;
  return {
    available: true,
    message: {
      ...message(result.data),
      preview: preview(result.data.preview_text),
    },
    events: (events.data ?? []).map((event) => ({
      id: event.id,
      type: event.event_type,
      attempt: event.attempt_number,
      providerId: providerId(event.provider_message_id),
      occurredAt: event.occurred_at,
      error: safeEmailText(event.error_text),
    })),
    hasMore: (events.count ?? 0) > page * EMAIL_PAGE_SIZE,
  };
}
