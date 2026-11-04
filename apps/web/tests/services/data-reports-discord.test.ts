import { describe, expect, it, vi } from "vitest";
import { postReportToDiscord, reportDiscordPayload } from "../../app/services/data-reports-discord.server";

const report = {
  id: 42, path: "/matters/zoning-amendment-for-772-hockley-avenue", entryKey: "background-855", category: "wrong_topic" as const,
  quote: "Public hearing for the four Hockley lots", note: "This hearing is the 2016 rezoning, @everyone", suggestion: null,
  sourceUrl: "https://example.com/minutes.pdf", notify: true,
};

describe("reader reports on Discord", () => {
  it("posts the details with a link to the report in the queue, pinging no one", () => {
    const payload = reportDiscordPayload(report);
    const embed = payload.embeds[0];
    expect(embed.title).toBe("Reader report #42: It belongs to a different topic or meeting");
    expect(embed.url).toBe("https://openlangford.ca/admin/reports/42");
    expect(embed.fields?.map((f) => f.name)).toEqual(["Page", "They highlighted", "What's wrong", "Source"]);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("says only where a privacy report is, not what it quotes", () => {
    const text = JSON.stringify(reportDiscordPayload({ ...report, category: "private", quote: "a resident's phone number" }));
    expect(text).not.toContain("phone number");
    expect(text).not.toContain("2016 rezoning");
  });

  it("does nothing without the webhook, and never throws when Discord fails", async () => {
    expect(await postReportToDiscord(undefined, report)).toBe("skipped");
    const fetcher = vi.fn(async () => new Response("nope", { status: 500 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await postReportToDiscord("https://discord.com/api/webhooks/123/abc", report, fetcher as any)).toBe("failed");
    error.mockRestore();
  });
});
