/** Turning one inbound email into a Discord webhook message. Pure, so it can be tested without a Worker. */

export type Address = { name?: string; address?: string };
export type ParsedEmail = {
  from?: Address;
  to?: Address[];
  subject?: string;
  date?: string;
  text?: string;
  html?: string;
  attachments?: { filename?: string | null; mimeType?: string; content?: ArrayBuffer | Uint8Array | string }[];
};

// Discord's limits: embed title 256, description 4096, field value 1024, author name 256, 6000 in all.
const TITLE = 256;
const BODY = 3500;
const FIELD = 1000;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export function who(address: Address | undefined, fallback = "") {
  const email = address?.address || fallback;
  const name = address?.name?.trim();
  return name && name !== email ? `${name} <${email}>` : email || "(unknown sender)";
}

/** Plain text of the message: its text part, else its HTML with tags removed. */
export function bodyText(email: ParsedEmail) {
  const text = email.text?.trim()
    || (email.html || "")
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** True when the receiving server reports a failed SPF, DKIM or DMARC check: possibly a forged sender. */
export function failedSenderChecks(authenticationResults: string | null | undefined) {
  return /\b(spf|dkim|dmarc)=(fail|softfail|permerror)\b/i.test(authenticationResults || "");
}

/** "Nov 4, 2026, 10:00 a.m." in Langford's time zone, or the date as given if it can't be read. */
export function pacific(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date
    : parsed.toLocaleString("en-CA", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" });
}

function size(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function contentLength(content: ArrayBuffer | Uint8Array | string | undefined) {
  if (!content) return 0;
  if (typeof content === "string") return content.length;
  return content.byteLength;
}

export function discordPayload({ email, envelopeFrom, envelopeTo, authenticationResults }: {
  email: ParsedEmail;
  envelopeFrom: string;
  envelopeTo: string;
  authenticationResults?: string | null;
}) {
  const suspicious = failedSenderChecks(authenticationResults);
  const body = bodyText(email);
  const description = body.length > BODY
    ? `${clip(body, BODY)}\n\n*Cut off here: ${body.length.toLocaleString("en-CA")} characters in all.*`
    : body || "*(no text)*";
  const attachments = (email.attachments || [])
    .map((a) => `${a.filename || "(unnamed)"} · ${size(contentLength(a.content))}`);
  const fields = [
    { name: "To", value: clip(envelopeTo, FIELD), inline: true },
    ...(email.date ? [{ name: "Sent", value: clip(pacific(email.date), FIELD), inline: true }] : []),
    ...(attachments.length ? [{ name: `Attachments (${attachments.length})`, value: clip(attachments.join("\n"), FIELD) }] : []),
    ...(suspicious ? [{ name: "⚠️ Sender checks failed", value: "SPF, DKIM or DMARC failed: the sender may be forged. Don't trust links or requests in it." }] : []),
  ];
  return {
    username: "openlangford.ca mail",
    // Never let an email ping anyone (@everyone, roles or users in the body).
    allowed_mentions: { parse: [] as string[] },
    embeds: [{
      author: { name: clip(who(email.from, envelopeFrom), 256) },
      title: clip(email.subject?.trim() || "(no subject)", TITLE),
      description,
      color: suspicious ? 0xd97706 : 0x0d9488,
      fields,
    }],
  };
}
