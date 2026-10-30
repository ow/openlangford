/**
 * Idempotent publishing of a digest to one channel: one message per meeting
 * and channel. Re-runs with the same payload do nothing; a changed payload
 * edits the original message instead of posting again (issue #67).
 *
 * The record of what was posted lives in `channel_posts` (service-role only)
 * for the Worker, or in memory / a local file for the local test script.
 */
export type ChannelPostStatus = "posted" | "failed";

export type ChannelPost = {
  meeting_id: number;
  channel: string;
  message_id: string | null;
  posted_at: string | null;
  payload_hash: string | null;
  status: ChannelPostStatus;
  attempts: number;
  last_error: string | null;
};

export interface ChannelPostStore {
  get(meetingId: number, channel: string): Promise<ChannelPost | null>;
  save(post: ChannelPost): Promise<void>;
}

/** What an adapter needs to send and edit (Discord today; Slack/Mastodon later). */
export interface ChannelSender<P> {
  send(payload: P): Promise<{ id: string }>;
  edit(messageId: string, payload: P): Promise<{ id: string }>;
}

export type PublishAction = "posted" | "edited" | "reposted" | "unchanged";
export type PublishResult = { action: PublishAction; messageId: string; payloadHash: string };

/** Stable SHA-256 of the payload (Web Crypto: Workers and Node). */
export async function payloadHash(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const shortError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Posts, edits or skips. `force` re-sends an unchanged payload (admin
 * "re-post now"), still editing the existing message rather than duplicating it.
 */
export async function publishToChannel<P>(opts: {
  meetingId: number;
  channel: string;
  payload: P;
  sender: ChannelSender<P>;
  store: ChannelPostStore;
  force?: boolean;
  now?: () => Date;
}): Promise<PublishResult> {
  const { meetingId, channel, payload, sender, store, force = false } = opts;
  const now = opts.now ?? (() => new Date());
  const hash = await payloadHash(payload);
  const previous = await store.get(meetingId, channel);

  if (previous?.message_id && previous.status === "posted" && previous.payload_hash === hash && !force) {
    return { action: "unchanged", messageId: previous.message_id, payloadHash: hash };
  }

  try {
    let action: PublishAction;
    let messageId: string;
    if (previous?.message_id) {
      try {
        messageId = (await sender.edit(previous.message_id, payload)).id;
        action = "edited";
      } catch (error) {
        // The message was deleted in Discord: post a fresh one.
        if ((error as { status?: number })?.status !== 404) throw error;
        messageId = (await sender.send(payload)).id;
        action = "reposted";
      }
    } else {
      messageId = (await sender.send(payload)).id;
      action = "posted";
    }
    await store.save({
      meeting_id: meetingId,
      channel,
      message_id: messageId,
      posted_at: action === "edited" ? previous?.posted_at ?? now().toISOString() : now().toISOString(),
      payload_hash: hash,
      status: "posted",
      attempts: 0,
      last_error: null,
    });
    return { action, messageId, payloadHash: hash };
  } catch (error) {
    await store.save({
      meeting_id: meetingId,
      channel,
      message_id: previous?.message_id ?? null,
      posted_at: previous?.posted_at ?? null,
      payload_hash: previous?.payload_hash ?? null,
      status: previous?.message_id ? "posted" : "failed",
      attempts: (previous?.attempts ?? 0) + 1,
      last_error: shortError(error),
    });
    throw error;
  }
}

// ── stores ───────────────────────────────────────────────────────────────

/** In-memory store: for tests and local runs that must not write anywhere. */
export function memoryPostStore(initial: ChannelPost[] = []): ChannelPostStore & { rows: Map<string, ChannelPost> } {
  const key = (meetingId: number, channel: string) => `${meetingId}:${channel}`;
  const rows = new Map(initial.map((p) => [key(p.meeting_id, p.channel), p]));
  return {
    rows,
    async get(meetingId, channel) {
      return rows.get(key(meetingId, channel)) ?? null;
    },
    async save(post) {
      rows.set(key(post.meeting_id, post.channel), { ...post });
    },
  };
}

const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

export class ChannelPostsUnavailable extends Error {
  constructor(readonly missingTable: boolean) {
    super(missingTable ? "channel_posts table is missing" : "channel_posts unavailable");
  }
}

/** `channel_posts` via the service-role client. Throws when the table is absent: no record, no posting. */
export function supabasePostStore(db: { from: (table: string) => any }): ChannelPostStore & {
  recent(channel: string, limit?: number): Promise<(ChannelPost & { updated_at?: string })[]>;
} {
  return {
    async get(meetingId, channel) {
      const { data, error } = await db
        .from("channel_posts")
        .select("meeting_id,channel,message_id,posted_at,payload_hash,status,attempts,last_error")
        .eq("meeting_id", meetingId)
        .eq("channel", channel)
        .maybeSingle();
      if (error) throw new ChannelPostsUnavailable(!!error.code && MISSING_TABLE.has(error.code));
      return data ?? null;
    },
    async save(post) {
      const { error } = await db
        .from("channel_posts")
        .upsert({ ...post, updated_at: new Date().toISOString() }, { onConflict: "meeting_id,channel" });
      if (error) throw new ChannelPostsUnavailable(!!error.code && MISSING_TABLE.has(error.code));
    },
    async recent(channel, limit = 10) {
      const { data, error } = await db
        .from("channel_posts")
        .select("meeting_id,channel,message_id,posted_at,payload_hash,status,attempts,last_error,updated_at")
        .eq("channel", channel)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw new ChannelPostsUnavailable(!!error.code && MISSING_TABLE.has(error.code));
      return data ?? [];
    },
  };
}
