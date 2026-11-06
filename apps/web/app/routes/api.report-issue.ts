import { data } from "react-router";
import type { Route } from "./+types/api.report-issue";
import { createSupabaseServerClient, getSupabaseAdminClient } from "../lib/supabase.server";
import { parseReport } from "../lib/data-reports";
import { getConfiguredAdminEmails } from "../lib/auth.server";
import { escalatePrivacyReport } from "../services/data-reports.server";
import { postReportToDiscord } from "../services/data-reports-discord.server";
import { contactNotificationRecipients } from "../services/contact-messages.server";

const HOURLY_LIMIT = 10;

/** POST a reader's data-issue report (JSON from the report panel). Needs an account; at most 10 an hour each.
 * Reports land in data_reports (service role only) for the agent's assessment (the 5-minute cron) and a
 * moderator's decision. A privacy report is emailed to the admins straight away. */
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ error: "Method not allowed" }, { status: 405 });
  const { supabase } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return data({ error: "Sign in to send a report." }, { status: 401 });

  const parsed = parseReport(await request.json().catch(() => null));
  if ("error" in parsed) return data({ error: parsed.error }, { status: 400 });
  const { report } = parsed;

  const admin = getSupabaseAdminClient();
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error: countError } = await admin
    .from("data_reports").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", since);
  if (countError) return data({ error: "Could not send the report." }, { status: 500 });
  if ((count ?? 0) >= HOURLY_LIMIT) {
    return data({ error: "You've sent a lot of reports this hour. Please try again later." }, { status: 429 });
  }

  const { data: saved, error } = await admin.from("data_reports").insert({
    user_id: user.id,
    path: report.path,
    entry_key: report.entryKey,
    quote: report.quote,
    category: report.category,
    note: report.note,
    suggestion: report.suggestion,
    source_url: report.sourceUrl,
    notify_reporter: report.notify,
  }).select("id").single();
  if (error) {
    console.error("[report-issue]", error.message);
    return data({ error: "Could not send the report." }, { status: 500 });
  }
  const { cloudflare } = context as {
    cloudflare?: { env?: { RESEND_API_KEY?: string; CONTACT_ALSO_NOTIFY?: string; DISCORD_REPORTS_WEBHOOK_URL?: string }; ctx?: ExecutionContext };
  };
  // The moderators' Discord channel hears about every report as it comes in.
  cloudflare?.ctx?.waitUntil?.(postReportToDiscord(cloudflare?.env?.DISCORD_REPORTS_WEBHOOK_URL, { ...report, id: saved.id }));
  // Private information on a page shouldn't wait for the queue: the admins hear about it now.
  if (report.category === "private") {
    const recipients = contactNotificationRecipients(getConfiguredAdminEmails(), cloudflare?.env?.CONTACT_ALSO_NOTIFY);
    const sending = escalatePrivacyReport({ apiKey: cloudflare?.env?.RESEND_API_KEY, recipients, report: { ...report, id: saved.id } });
    cloudflare?.ctx?.waitUntil?.(sending);
  }
  return data({ ok: true });
}
