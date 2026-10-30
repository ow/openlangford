import { describe, expect, it, vi } from "vitest";
import {
  buildMeetingDigest,
  decisionOutcome,
  linkSegments,
  type DigestMeetingRow,
  type DigestMotionRow,
} from "../../app/services/channels/digest";
import {
  DiscordWebhook,
  DiscordWebhookError,
  LIMITS,
  bulletMarkdown,
  embedLength,
  redactWebhookUrls,
  toDiscordPayload,
} from "../../app/services/channels/discord";
import { memoryPostStore, publishToChannel } from "../../app/services/channels/posts";
import { planDiscordPosts, runDiscordPosts } from "../../workers/discord-posts";

const meeting: DigestMeetingRow = {
  id: 6,
  slug: "2026-04-20-regular-council",
  title: "Regular Council",
  meeting_date: "2026-04-20",
  summary: "- Gave 1st, 2nd and 3rd readings (Bylaw 2272)",
  video_url: "https://pub-langford.escribemeetings.com/Players/ISIStandAlonePlayer.aspx?Id=x",
  highlights: {
    bullets: ["Moved the parking rules one step from final approval (passed 6–1).", "", "Made the park dedication final for *Goldstream* lands."],
    // v2: aligned with bullets (the empty bullet keeps its slot).
    links: [[], [], [{ text: "park dedication", agenda_item_id: 2504 }, { text: "missing", agenda_item_id: 9 }, { text: "lands", agenda_item_id: "x" }]],
    version: "2",
    description: "April 20, 2026: Council moved the budget forward.",
  },
  share_card: { url: "https://pub.example.r2.dev/meeting-cards/6/a.jpg" },
  organization: { name: "Council" },
};

const council7 = (no: number) =>
  Array.from({ length: 7 }, (_, i) => ({ person_id: i + 1, vote: i < no ? "No" : "Yes" }));

const motion = (over: Partial<DigestMotionRow> = {}): DigestMotionRow => ({
  id: 1625,
  agenda_item_id: 2508,
  result: "CARRIED",
  disposition: "Substantive",
  time_offset_seconds: 11385.52,
  meta: { headline: "Minimum parking dropped for City Centre buildings", individual_vote_coverage: "reconstructed_complete" },
  votes: council7(1),
  ...over,
});

const MEETING_URL = "https://openlangford.ca/meetings/2026-04-20-regular-council";

describe("buildMeetingDigest", () => {
  it("uses highlights and links v2 phrases to their agenda items", () => {
    const d = buildMeetingDigest(meeting, []);
    expect(d.title).toBe("Regular Council — April 20, 2026");
    expect(d.url).toBe(MEETING_URL);
    expect(d.fromSummary).toBe(false);
    expect(d.bullets).toHaveLength(2);
    expect(d.bullets[1]).toEqual([
      { text: "Made the " },
      { text: "park dedication", url: `${MEETING_URL}#item-2504` },
      { text: " final for *Goldstream* lands." },
    ]);
    // Escaped text, masked link.
    expect(bulletMarkdown(d.bullets[1])).toBe(
      `Made the [park dedication](${MEETING_URL}#item-2504) final for \\*Goldstream\\* lands.`,
    );
    expect(d.imageUrl).toBe("https://pub.example.r2.dev/meeting-cards/6/a.jpg");
    const withPoster = buildMeetingDigest({ ...meeting, poster: { url: "https://pub.example.r2.dev/meeting-posters/6/p.webp" } });
    expect(withPoster.imageUrl).toBe("https://pub.example.r2.dev/meeting-posters/6/p.webp");
    expect(d.videoUrl).toBe(`${MEETING_URL}?t=0`);
    expect(d.footer).toBe("Open Langford");
  });

  it("falls back to the stored summary when there are no highlights", () => {
    const d = buildMeetingDigest({ ...meeting, highlights: null }, []);
    expect(d.fromSummary).toBe(true);
    expect(d.bullets).toEqual([[{ text: "Gave 1st, 2nd and 3rd readings (Bylaw 2272)" }]]);
  });

  it("ignores phrases that aren't in the bullet, repeat, or have bad ids", () => {
    expect(linkSegments("Sooke Road and Sooke Road", [{ text: "Sooke Road", agenda_item_id: 1 }, { text: "Sooke Road", agenda_item_id: 2 }], MEETING_URL))
      .toEqual([
        { text: "Sooke Road", url: `${MEETING_URL}#item-1` },
        { text: " and " },
        { text: "Sooke Road", url: `${MEETING_URL}#item-2` },
      ]);
    expect(linkSegments("Plain text", [{ text: "nope", agenda_item_id: 1 }, { text: "Plain", agenda_item_id: -1 }], MEETING_URL))
      .toEqual([{ text: "Plain text" }]);
    expect(linkSegments("Plain text", null, MEETING_URL)).toEqual([{ text: "Plain text" }]);
  });

  it("lists headline decisions with split votes, video times and no procedural motions", () => {
    const d = buildMeetingDigest(meeting, [
      motion(),
      motion({ id: 1, disposition: "Procedural", meta: { headline: "Agenda approved" } }),
      motion({ id: 2, meta: { headline: null } }),
      motion({ id: 3, agenda_item_id: 2504, votes: council7(0), time_offset_seconds: null, meta: { headline: "Park land made final.", individual_vote_coverage: "reconstructed_complete" } }),
    ]);
    expect(d.decisions).toEqual([
      { text: "Park land made final", outcome: "Passed", url: `${MEETING_URL}#item-2504`, videoUrl: null },
      {
        text: "Minimum parking dropped for City Centre buildings",
        outcome: "Passed 6–1",
        url: `${MEETING_URL}#item-2508`,
        videoUrl: `${MEETING_URL}?t=11385`,
      },
    ]);
  });

  it("counts named dissent when the roll call is partial, and never names anyone", () => {
    expect(decisionOutcome(motion({ meta: { headline: "x" }, votes: [{ person_id: 22, vote: "No" }] }))).toBe("Passed, 1 opposed");
    expect(decisionOutcome(motion({ result: "DEFEATED", votes: council7(4) }))).toBe("Failed 3–4");
  });
});

describe("toDiscordPayload", () => {
  it("builds one embed with brand footer, image, no pings", () => {
    const p = toDiscordPayload(buildMeetingDigest(meeting, [motion()]));
    expect(p.username).toBe("Open Langford");
    expect(p.allowed_mentions).toEqual({ parse: [] });
    const [e] = p.embeds;
    expect(e.title).toBe("Regular Council — April 20, 2026");
    expect(e.author).toBeUndefined(); // the title already says Council
    expect(p.content).toBe("Here's a summary of the latest meeting: Regular Council on April 20, 2026.");
    expect(e.description).toMatch(/^Here's a summary of what happened:\n• Moved the parking rules/);
    expect(e.fields?.[0].name).toBe("Key decisions");
    expect(e.fields?.[0].value).toContain("**Passed 6–1**");
    expect(e.fields?.at(-1)?.name).toBe("Read more:");
    expect(e.image?.url).toContain("meeting-cards"); // no poster in this fixture
    expect(e.footer?.text).toBe("Open Langford");
  });

  it("shows a committee's name above the title", () => {
    const p = toDiscordPayload(buildMeetingDigest({ ...meeting, title: "Advisory Committee", organization: { name: "Community Advisory Committee" } }));
    expect(p.embeds[0].author?.name).toBe("Community Advisory Committee");
  });

  it("stays within Discord limits and never cuts a link", () => {
    const long = "word ".repeat(400) + "Sooke Road";
    const motions = Array.from({ length: 40 }, (_, i) =>
      motion({ id: i + 10, agenda_item_id: i + 100, meta: { headline: `Decision ${i} ${"about a long thing ".repeat(12)}` } }),
    );
    const d = buildMeetingDigest(
      {
        ...meeting,
        title: "T".repeat(400),
        highlights: {
          bullets: Array.from({ length: 12 }, () => long),
          links: Array.from({ length: 12 }, (_, i) => [{ text: "Sooke Road", agenda_item_id: i + 1 }]),
        },
      },
      motions,
    );
    const [e] = toDiscordPayload(d).embeds;
    expect(e.title.length).toBeLessThanOrEqual(LIMITS.title);
    expect(e.description!.length).toBeLessThanOrEqual(LIMITS.description);
    expect(e.fields!.length).toBeLessThanOrEqual(LIMITS.fields);
    for (const f of e.fields!) expect(f.value.length).toBeLessThanOrEqual(LIMITS.fieldValue);
    expect(embedLength(e)).toBeLessThanOrEqual(LIMITS.total);
    // Every "[" that opens a link is closed by "](...)".
    const opened = (e.description!.match(/\[/g) ?? []).length;
    const complete = (e.description!.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
    expect(opened).toBe(complete);
    expect(e.fields!.at(-1)!.name).toBe("Read more:");
    expect(d.moreDecisions).toBe(34);
  });
});

const HOOK = "https://discord.com/api/webhooks/123456/secret-token_ABC";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("DiscordWebhook", () => {
  it("posts with wait=true and returns the message id", async () => {
    const fetcher = vi.fn(async () => json({ id: "999", channel_id: "1" }));
    const hook = new DiscordWebhook(HOOK, { fetcher: fetcher as any });
    await expect(hook.execute({ embeds: [], allowed_mentions: { parse: [] } })).resolves.toEqual({ id: "999", channel_id: "1" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/webhooks/123456/secret-token_ABC?wait=true");
    expect(init.method).toBe("POST");
  });

  it("edits with PATCH /messages/{id} and drops username/avatar", async () => {
    const fetcher = vi.fn(async () => json({ id: "999" }));
    const hook = new DiscordWebhook(HOOK, { fetcher: fetcher as any });
    await hook.edit("999", { username: "x", avatar_url: "y", embeds: [], allowed_mentions: { parse: [] } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/webhooks/123456/secret-token_ABC/messages/999");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ embeds: [], allowed_mentions: { parse: [] } });
  });

  it("waits retry_after on 429, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "You are being rate limited.", retry_after: 1.5, global: false }, 429))
      .mockResolvedValueOnce(json({ id: "42" }));
    const hook = new DiscordWebhook(HOOK, { fetcher, sleep });
    await expect(hook.execute({ embeds: [], allowed_mentions: { parse: [] } })).resolves.toMatchObject({ id: "42" });
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("gives up on repeated or long 429s with a status", async () => {
    const fetcher = vi.fn(async () => json({ retry_after: 120 }, 429));
    const hook = new DiscordWebhook(HOOK, { fetcher: fetcher as any, sleep: async () => {} });
    await expect(hook.execute({ embeds: [], allowed_mentions: { parse: [] } })).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never puts the token in errors", async () => {
    expect(() => new DiscordWebhook("https://example.com/hook")).toThrow(DiscordWebhookError);
    const fetcher = vi.fn(async () => {
      throw new Error(`connect failed ${HOOK}`);
    });
    const hook = new DiscordWebhook(HOOK, { fetcher: fetcher as any });
    const error = await hook.execute({ embeds: [], allowed_mentions: { parse: [] } }).catch((e) => e);
    expect(error.message).not.toContain("secret-token");
    expect(redactWebhookUrls(HOOK)).toBe("https://discord.com/api/webhooks/123456/[redacted]");
  });
});

describe("publishToChannel", () => {
  const sender = () => {
    let n = 0;
    return {
      send: vi.fn(async () => ({ id: `m${++n}` })),
      edit: vi.fn(async (id: string) => ({ id })),
    };
  };

  it("posts once, skips an unchanged re-run and edits when the payload changes", async () => {
    const store = memoryPostStore();
    const s = sender();
    const base = { meetingId: 6, channel: "discord", sender: s, store };
    expect((await publishToChannel({ ...base, payload: { a: 1 } })).action).toBe("posted");
    expect((await publishToChannel({ ...base, payload: { a: 1 } })).action).toBe("unchanged");
    const edited = await publishToChannel({ ...base, payload: { a: 2 } });
    expect(edited).toMatchObject({ action: "edited", messageId: "m1" });
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.edit).toHaveBeenCalledWith("m1", { a: 2 });
    expect((await publishToChannel({ ...base, payload: { a: 2 }, force: true })).action).toBe("edited");
  });

  it("posts again when the original message was deleted", async () => {
    const store = memoryPostStore();
    const s = sender();
    await publishToChannel({ meetingId: 6, channel: "discord", sender: s, store, payload: { a: 1 } });
    s.edit.mockRejectedValueOnce(new DiscordWebhookError("gone", 404));
    const result = await publishToChannel({ meetingId: 6, channel: "discord", sender: s, store, payload: { a: 2 } });
    expect(result).toMatchObject({ action: "reposted", messageId: "m2" });
  });

  it("records failures without losing an existing message id", async () => {
    const store = memoryPostStore();
    const s = sender();
    s.send.mockRejectedValueOnce(new Error("boom"));
    await expect(publishToChannel({ meetingId: 6, channel: "discord", sender: s, store, payload: {} })).rejects.toThrow("boom");
    expect(await store.get(6, "discord")).toMatchObject({ status: "failed", attempts: 1, message_id: null });
  });
});

describe("runDiscordPosts", () => {
  const env = { DISCORD_POSTS_ENABLED: "true", DISCORD_WEBHOOK_URL: HOOK, EMAIL_ALERT_START_DATE: "2026-10-29" };

  it("does nothing while paused or without a webhook", async () => {
    const db = { from: vi.fn() };
    expect((await runDiscordPosts({ ...env, DISCORD_POSTS_ENABLED: "false" }, db)).ran).toBe(false);
    expect((await runDiscordPosts({ ...env, DISCORD_WEBHOOK_URL: "" }, db)).ran).toBe(false);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("never plans meetings before the start date (no backfill)", async () => {
    const now = new Date("2026-10-28T12:00:00Z");
    expect(await planDiscordPosts(env, { from: vi.fn() }, memoryPostStore(), now)).toEqual([]);
  });
});
