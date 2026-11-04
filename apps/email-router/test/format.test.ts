import { describe, expect, it } from "vitest";
import { bodyText, discordPayload, failedSenderChecks, who } from "../src/format";

describe("discordPayload", () => {
  const base = { envelopeFrom: "jane@example.com", envelopeTo: "admin@openlangford.ca" };

  it("shows sender, subject, recipient, body and attachments, and never pings anyone", () => {
    const payload = discordPayload({
      ...base,
      email: {
        from: { name: "Jane Doe", address: "jane@example.com" },
        subject: "Question about the tree bylaw",
        date: "Tue, 4 Nov 2026 10:00:00 -0800",
        text: "Hi @everyone,\n\nWhen does it take effect?",
        attachments: [{ filename: "photo.jpg", content: new Uint8Array(2048) }],
      },
    });
    const embed = payload.embeds[0];
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(embed.author.name).toBe("Jane Doe <jane@example.com>");
    expect(embed.title).toBe("Question about the tree bylaw");
    expect(embed.description).toContain("When does it take effect?");
    expect(embed.fields).toContainEqual({ name: "To", value: "admin@openlangford.ca", inline: true });
    expect(embed.fields.find((f) => f.name.startsWith("Attachments"))?.value).toBe("photo.jpg · 2 KB");
    expect(embed.fields.find((f) => f.name === "Sent")?.value).toMatch(/^Nov 4, 2026, \d{1,2}:\d\d [ap]\.m\.$/);
  });

  it("cuts long messages to fit Discord and says so", () => {
    const payload = discordPayload({ ...base, email: { subject: "Long", text: "a".repeat(10_000) } });
    const description = payload.embeds[0].description;
    expect(description.length).toBeLessThan(4096);
    expect(description).toContain("Cut off here: 10,000 characters in all.");
  });

  it("flags mail that failed sender checks", () => {
    const flagged = discordPayload({ ...base, email: { subject: "Invoice" }, authenticationResults: "mx.cloudflare.net; spf=pass; dmarc=fail" });
    expect(flagged.embeds[0].fields.some((f) => f.name.includes("Sender checks failed"))).toBe(true);
    expect(failedSenderChecks("spf=pass; dkim=pass; dmarc=pass")).toBe(false);
  });

  it("falls back to the HTML part, the envelope sender, and placeholders", () => {
    expect(bodyText({ html: "<p>Hello&nbsp;there</p><style>p{}</style><div>Line two</div>" })).toBe("Hello there\nLine two");
    expect(who(undefined, "bounce@example.com")).toBe("bounce@example.com");
    const empty = discordPayload({ ...base, email: {} });
    expect(empty.embeds[0].title).toBe("(no subject)");
    expect(empty.embeds[0].description).toBe("*(no text)*");
  });
});
