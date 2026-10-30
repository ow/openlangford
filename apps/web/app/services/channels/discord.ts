/**
 * Discord adapter for meeting digests: an incoming-webhook embed (no bot).
 * https://discord.com/developers/docs/resources/webhook
 *
 * The webhook URL is a credential (its last path segment is a token). It is
 * never logged, returned or put in error messages: see redactWebhookUrls().
 */
import { clip } from "../../lib/page-meta";
import { SITE_ORIGIN } from "../../lib/og";
import type { DigestDecision, DigestSegment, MeetingDigest } from "./digest";

export const DISCORD_CHANNEL = "discord";
export const DISCORD_USERNAME = "Open Langford";
export const DISCORD_AVATAR_URL = `${SITE_ORIGIN}/apple-touch-icon.png`;
/** Brand teal (--color-brand-500, oklch(0.6 0.105 199)). */
export const DISCORD_COLOR = 0x009398;

/** https://discord.com/developers/docs/resources/message#embed-object-embed-limits */
export const LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  total: 6000,
  content: 2000,
} as const;

export const DESCRIPTION_LEAD = "Here's a summary of what happened:";
export const READ_MORE = "Read more:";

/** The line the bot "says" above the embed. Depends only on the meeting, so edits keep it. */
export function messageContent(digest: Pick<MeetingDigest, "name" | "dateLabel">): string {
  return `Here's a summary of the latest meeting: ${digest.name} on ${digest.dateLabel}.`;
}

export type DiscordEmbed = {
  title: string;
  url?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  author?: { name: string; url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  image?: { url: string };
  footer?: { text: string; icon_url?: string };
};

export type DiscordPayload = {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: string[] };
};

// ── formatting ───────────────────────────────────────────────────────────

const LINK = /\[((?:\\.|[^\]\\])+)\]\(([^)\s]+)\)/g;

/** Markdown links collapse to their label: a clipped link would break the post. */
function stripLinks(text: string) {
  return text.replace(LINK, "$1");
}

/** Fit `max` characters, never cutting through a link. */
export function fitText(text: string, max: number): string {
  if (text.length <= max) return text;
  return clip(stripLinks(text), max);
}

/** Lines joined with "\n" until the next would pass `max`; returns what fit and the rest. */
function packLines(lines: string[], max: number): { packed: string; rest: string[] } {
  let packed = "";
  let i = 0;
  for (; i < lines.length; i++) {
    const line = fitText(lines[i], max);
    const next = packed ? `${packed}\n${line}` : line;
    if (next.length > max) break;
    packed = next;
  }
  return { packed, rest: lines.slice(i) };
}

/** Backslash-escapes Discord markdown so stored text shows as written. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|[\]])/g, "\\$1");
}

/** A masked link `[label](url)`; the URL is ours (https, no spaces or parentheses). */
function maskedLink(label: string, url: string): string {
  return `[${escapeMarkdown(label)}](${url.replace(/[()\s]/g, encodeURIComponent)})`;
}

export function bulletMarkdown(bullet: DigestSegment[]): string {
  return bullet.map((s) => (s.url ? maskedLink(s.text, s.url) : escapeMarkdown(s.text))).join("");
}

function decisionLine(d: DigestDecision): string {
  const parts = [`• ${maskedLink(d.text, d.url)}`];
  if (d.outcome) parts.push(`**${d.outcome}**`);
  if (d.videoUrl) parts.push(`[watch](${d.videoUrl})`);
  return parts.join(" · ");
}

/** Characters Discord counts toward the 6,000 limit. */
export function embedLength(embed: DiscordEmbed): number {
  return (
    embed.title.length +
    (embed.description?.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

export function toDiscordPayload(digest: MeetingDigest): DiscordPayload {
  const bullets = digest.bullets.map((b) => `• ${bulletMarkdown(b)}`);
  const description = bullets.length
    ? packLines([DESCRIPTION_LEAD, ...bullets], LIMITS.description).packed
    : undefined;

  const fields: DiscordEmbed["fields"] = [];
  if (digest.decisions.length) {
    let rest = digest.decisions.map(decisionLine);
    if (digest.moreDecisions > 0) {
      rest.push(`[See all ${digest.decisions.length + digest.moreDecisions} decisions](${digest.decisionsUrl})`);
    }
    let first = true;
    while (rest.length && fields.length < LIMITS.fields - 1) {
      const { packed, rest: remaining } = packLines(rest, LIMITS.fieldValue);
      if (!packed) break;
      fields.push({ name: first ? "Key decisions" : "Key decisions (continued)", value: packed });
      rest = remaining;
      first = false;
    }
  }
  const links = [`[Meeting page](${digest.url})`];
  if (digest.videoUrl) links.push(`[Watch the video](${digest.videoUrl})`);
  fields.push({ name: READ_MORE, value: links.join(" · ") });

  const embed: DiscordEmbed = {
    title: fitText(digest.title, LIMITS.title),
    url: digest.url,
    color: DISCORD_COLOR,
    // The body as a line above the title, unless the title already names it (as the meeting page does).
    ...(digest.body && !digest.title.toLowerCase().includes(digest.body.toLowerCase())
      ? { author: { name: fitText(digest.body, LIMITS.author) } }
      : {}),
    ...(description ? { description } : {}),
    fields,
    ...(digest.imageUrl ? { image: { url: digest.imageUrl } } : {}),
    footer: { text: fitText(digest.footer, LIMITS.footer), icon_url: DISCORD_AVATAR_URL },
    // Noon Pacific keeps the shown date on the meeting day in every North American zone.
    timestamp: `${digest.date}T19:00:00.000Z`,
  };

  // Over the 6,000 total: drop decision fields from the end (keeping "Read more"), then shorten the description.
  while (embedLength(embed) > LIMITS.total && embed.fields!.length > 1) {
    embed.fields!.splice(embed.fields!.length - 2, 1);
  }
  if (embedLength(embed) > LIMITS.total && embed.description) {
    const room = LIMITS.total - (embedLength(embed) - embed.description.length);
    embed.description = fitText(embed.description, Math.max(1, room));
  }

  return {
    username: DISCORD_USERNAME,
    avatar_url: DISCORD_AVATAR_URL,
    content: fitText(messageContent(digest), LIMITS.content),
    embeds: [embed],
    // Never ping anyone, whatever the text contains.
    allowed_mentions: { parse: [] },
  };
}

// ── webhook client ───────────────────────────────────────────────────────

const WEBHOOK_URL =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/;

/** Hides webhook tokens in any text that may reach a log or a page. */
export function redactWebhookUrls(text: string): string {
  return text.replace(/(discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/)[\w-]+/g, "$1[redacted]");
}

export class DiscordWebhookError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(redactWebhookUrls(message));
    this.name = "DiscordWebhookError";
  }
}

export type DiscordWebhookOptions = {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after a 429 before giving up. */
  maxRetries?: number;
  /** Longest single wait we accept from retry_after; longer means give up for now. */
  maxWaitMs?: number;
};

export type DiscordMessage = { id: string; channel_id?: string };

export class DiscordWebhook {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxWaitMs: number;

  constructor(webhookUrl: string, options: DiscordWebhookOptions = {}) {
    const match = WEBHOOK_URL.exec((webhookUrl || "").trim());
    if (!match) throw new DiscordWebhookError("DISCORD_WEBHOOK_URL is not a Discord webhook URL");
    this.base = `https://discord.com/api/v10/webhooks/${match[1]}/${match[2]}`;
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
  }

  /** Posts a new message; `wait=true` makes Discord return it (we keep its id). */
  async execute(payload: DiscordPayload): Promise<DiscordMessage> {
    return this.request("POST", `${this.base}?wait=true`, payload);
  }

  /** Edits a message this webhook posted. Username and avatar can't change on edit. */
  async edit(messageId: string, payload: DiscordPayload): Promise<DiscordMessage> {
    if (!/^\d+$/.test(messageId)) throw new DiscordWebhookError("Invalid Discord message id");
    const { username: _u, avatar_url: _a, ...body } = payload;
    return this.request("PATCH", `${this.base}/messages/${messageId}`, body);
  }

  private async request(method: "POST" | "PATCH", url: string, body: unknown): Promise<DiscordMessage> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new DiscordWebhookError(`Discord unreachable: ${error instanceof Error ? error.message : "network error"}`);
      }
      if (response.status === 429) {
        const waitMs = await retryAfterMs(response);
        if (attempt >= this.maxRetries || waitMs > this.maxWaitMs) {
          throw new DiscordWebhookError(`Discord rate limit: retry after ${Math.ceil(waitMs / 1000)}s`, 429);
        }
        await this.sleep(waitMs);
        continue;
      }
      if (!response.ok) {
        let detail = "";
        try {
          const json: any = await response.json();
          detail = typeof json?.message === "string" ? `: ${json.message}` : "";
        } catch {
          // body not JSON
        }
        throw new DiscordWebhookError(`Discord ${method} failed (HTTP ${response.status})${detail}`, response.status);
      }
      const message: any = await response.json().catch(() => null);
      if (!message || typeof message.id !== "string") throw new DiscordWebhookError("Discord returned no message id");
      return { id: message.id, channel_id: message.channel_id };
    }
  }
}

/** retry_after (seconds, JSON body) or the Retry-After header; at least 250 ms. */
async function retryAfterMs(response: Response): Promise<number> {
  let seconds = Number.NaN;
  try {
    const json: any = await response.clone().json();
    seconds = Number(json?.retry_after);
  } catch {
    // fall through to the header
  }
  if (!Number.isFinite(seconds)) seconds = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 1;
  return Math.max(250, Math.ceil(seconds * 1000));
}
