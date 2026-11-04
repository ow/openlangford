import { SITE_ORIGIN } from "../lib/og";
import { REPORT_CATEGORIES, type NewReport } from "../lib/data-reports";
import {
  DISCORD_AVATAR_URL, DISCORD_USERNAME, DiscordWebhook, escapeMarkdown, fitText, redactWebhookUrls, type DiscordPayload,
} from "./channels/discord";

/**
 * A new reader report, posted to the moderators' Discord channel (the DISCORD_REPORTS_WEBHOOK_URL secret; never the
 * public digest channel). It links to the report in the queue, where it's decided. Who sent it isn't posted. A
 * report of private information on a page says only where: the quote and note may be the private details themselves.
 */
export function reportDiscordPayload(report: NewReport & { id: number }): DiscordPayload {
  const category = REPORT_CATEGORIES.find((c) => c.value === report.category)?.label ?? report.category;
  const page = `${SITE_ORIGIN}${report.path}`;
  const text = (value: string | null, max: number) => (value ? fitText(escapeMarkdown(value.replace(/\s+/g, " ").trim()), max) : null);
  const fields: { name: string; value: string }[] = [{ name: "Page", value: `[${escapeMarkdown(report.path)}](${page})` }];
  if (report.category === "private") {
    fields.push({ name: "Private information", value: "Details are in the queue only. Admins have been emailed." });
  } else {
    const add = (name: string, value: string | null) => { if (value) fields.push({ name, value }); };
    add("They highlighted", text(report.quote, 600));
    add("What's wrong", text(report.note, 900));
    add("Should say", text(report.suggestion, 600));
    if (report.sourceUrl) add("Source", report.sourceUrl.slice(0, 500));
  }
  return {
    username: DISCORD_USERNAME,
    avatar_url: DISCORD_AVATAR_URL,
    allowed_mentions: { parse: [] }, // a reader's words can't ping anyone
    embeds: [{
      title: `Reader report #${report.id}: ${fitText(category, 180)}`,
      url: `${SITE_ORIGIN}/admin/reports/${report.id}`,
      color: report.category === "private" ? 0xdc2626 : 0xd97706,
      fields,
      footer: { text: "Open the report to have the agent check it, then approve or decline" },
      timestamp: new Date().toISOString(),
    }],
  };
}

/** Never throws: a failed post is logged, and the report is in the queue either way. */
export async function postReportToDiscord(webhookUrl: string | undefined, report: NewReport & { id: number }, fetcher?: typeof fetch) {
  if (!webhookUrl) return "skipped" as const;
  try {
    await new DiscordWebhook(webhookUrl, { fetcher, maxRetries: 1, maxWaitMs: 5_000 }).execute(reportDiscordPayload(report));
    return "sent" as const;
  } catch (error) {
    console.error("[report-issue] Discord post failed:", redactWebhookUrls(error instanceof Error ? error.message : String(error)));
    return "failed" as const;
  }
}
