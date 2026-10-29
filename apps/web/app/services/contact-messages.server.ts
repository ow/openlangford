import type { SupabaseClient } from "@supabase/supabase-js";
import { SITE_ORIGIN } from "../lib/og";
import { CONTACT_ADMIN_PATH, civicTime, type ContactFilter, type ContactMessage } from "../lib/contact-messages";

export { CONTACT_ADMIN_PATH, CONTACT_FILTERS, CONTACT_REPLY_SUBJECT, civicTime, contactFilter, replyMailto } from "../lib/contact-messages";
export type { ContactFilter, ContactMessage } from "../lib/contact-messages";

/** Verified sender shared with supabase/functions/_shared/alerts.ts. */
export const CONTACT_FROM_EMAIL = "Open Langford <alerts@openlangford.ca>";

const LIST_COLUMNS = "id, name, email, message, created_at, handled_at, notified_at";
const LIST_LIMIT = 200;

export async function listContactMessages(supabase: SupabaseClient, filter: ContactFilter) {
  let query = supabase
    .from("contact_messages")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (filter === "open") query = query.is("handled_at", null);
  if (filter === "handled") query = query.not("handled_at", "is", null);
  const [{ data, error }, { count, error: countError }] = await Promise.all([
    query,
    supabase.from("contact_messages").select("id", { count: "exact", head: true }).is("handled_at", null),
  ]);
  if (error) throw error;
  if (countError) throw countError;
  return { messages: (data || []) as ContactMessage[], openCount: count ?? 0 };
}

export async function setContactMessageHandled(
  supabase: SupabaseClient,
  id: string,
  handled: boolean,
  adminUserId: string,
) {
  const { error } = await supabase
    .from("contact_messages")
    .update(handled ? { handled_at: new Date().toISOString(), handled_by: adminUserId } : { handled_at: null, handled_by: null })
    .eq("id", id);
  if (error) throw error;
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}



export type NewContactMessage = Pick<ContactMessage, "id" | "name" | "email" | "message" | "created_at">;

export function buildContactNotification(message: NewContactMessage, recipients: string[]) {
  const who = message.name ? `${message.name} <${message.email}>` : message.email;
  const adminUrl = `${SITE_ORIGIN}${CONTACT_ADMIN_PATH}`;
  const received = `${civicTime(message.created_at)} (Pacific)`;
  // Header-safe: subject lines must not carry newlines.
  const subject = `Contact form: ${(message.name || message.email).replace(/[\r\n]+/g, " ")}`.slice(0, 200);
  const text = [
    `New message from the Open Langford contact form.`,
    ``,
    `From: ${who}`,
    `Received: ${received}`,
    ``,
    message.message,
    ``,
    `Reply to this email to answer them directly.`,
    `Admin: ${adminUrl}`,
  ].join("\n");
  const html = `<p>New message from the Open Langford contact form.</p>
<p><strong>From:</strong> ${escapeHtml(who)}<br><strong>Received:</strong> ${escapeHtml(received)}</p>
<div style="white-space:pre-wrap;border-left:3px solid #0d9488;padding-left:12px">${escapeHtml(message.message)}</div>
<p>Reply to this email to answer them directly. <a href="${escapeHtml(adminUrl)}">Open contact messages</a></p>`;
  return {
    from: CONTACT_FROM_EMAIL,
    to: recipients,
    reply_to: message.email,
    subject,
    text,
    html,
  };
}

/**
 * Emails every admin about a new submission and stamps notified_at on success.
 * Never throws: a missing key, no admins or a provider error only leave notified_at null.
 * Logs carry no addresses or message content.
 */
export async function notifyContactMessage({
  apiKey,
  recipients,
  message,
  supabase,
  fetcher = fetch,
}: {
  apiKey: string | undefined;
  recipients: string[];
  message: NewContactMessage;
  supabase: SupabaseClient;
  fetcher?: typeof fetch;
}): Promise<"sent" | "skipped" | "failed"> {
  if (!apiKey || recipients.length === 0) return "skipped";
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `contact-${message.id}`,
      },
      body: JSON.stringify(buildContactNotification(message, recipients)),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error(`[Contact] Notification email failed (status ${response.status})`);
      return "failed";
    }
  } catch {
    console.error("[Contact] Notification email failed (network)");
    return "failed";
  }
  const { error } = await supabase
    .from("contact_messages")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", message.id);
  if (error) console.error("[Contact] Could not record notification time");
  return "sent";
}
