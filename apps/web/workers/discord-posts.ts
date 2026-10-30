/**
 * Discord meeting digests, run by the 5-minute cron next to the email enqueue.
 *
 * Off unless DISCORD_POSTS_ENABLED is "true" (wrangler var, the global pause)
 * and the DISCORD_WEBHOOK_URL secret is set. Uses the email alerts' guard:
 * only published meetings with minutes or a transcript, dated on/after
 * EMAIL_ALERT_START_DATE (or DISCORD_POSTS_START_DATE) and within the last
 * CANDIDATE_WINDOW_DAYS, settled for SETTLE_MINUTES. Never a backfill.
 * The cron also waits for the plain-language highlights; the stored summary
 * fallback is only for manual posts.
 *
 * Without the channel_posts table nothing posts: no record means no way to
 * avoid posting the same meeting every five minutes.
 */
import { candidateWindow, loadCandidates, type CandidateMeeting, type EnqueueDb } from "./email-enqueue";
import { hasPostableContent, loadMeetingDigest, type MeetingDigest } from "../app/services/channels/digest";
import { DISCORD_CHANNEL, DiscordWebhook, redactWebhookUrls, toDiscordPayload, type DiscordPayload } from "../app/services/channels/discord";
import { payloadHash, publishToChannel, supabasePostStore, type ChannelPostStore, type PublishAction } from "../app/services/channels/posts";

export const MAX_POSTS_PER_RUN = 2;
export const MAX_FAILED_ATTEMPTS = 6;

export type DiscordEnv = {
  DISCORD_POSTS_ENABLED?: string;
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_POSTS_START_DATE?: string;
  EMAIL_ALERT_START_DATE?: string;
};

export function discordStartDate(env: DiscordEnv): string | null {
  const value = (env.DISCORD_POSTS_START_DATE || env.EMAIL_ALERT_START_DATE || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function discordStatus(env: DiscordEnv) {
  return {
    enabled: env.DISCORD_POSTS_ENABLED === "true",
    webhookConfigured: !!env.DISCORD_WEBHOOK_URL,
    startDate: discordStartDate(env),
  };
}

export function discordPostsEnabled(env: DiscordEnv) {
  const s = discordStatus(env);
  return s.enabled && s.webhookConfigured && s.startDate !== null;
}

export type DiscordPlan = {
  meeting: CandidateMeeting;
  digest: MeetingDigest;
  payload: DiscordPayload;
  /** What a run would do now. */
  next: "post" | "edit" | "unchanged" | "gave_up";
};

/** Eligible meetings (oldest first) and what posting each would do. Reads only. */
export async function planDiscordPosts(
  env: DiscordEnv,
  db: EnqueueDb,
  store: ChannelPostStore,
  now: Date = new Date(),
): Promise<DiscordPlan[]> {
  const start = discordStartDate(env);
  if (!start) return [];
  const window = candidateWindow(start, now);
  if (!window) return [];
  const candidates = (await loadCandidates(db, window, now)).reverse();
  const plans: DiscordPlan[] = [];
  for (const meeting of candidates) {
    const digest = await loadMeetingDigest(db, meeting.id);
    if (!digest || !hasPostableContent(digest) || digest.fromSummary) continue;
    const payload = toDiscordPayload(digest);
    const previous = await store.get(meeting.id, DISCORD_CHANNEL);
    let next: DiscordPlan["next"];
    if (!previous?.message_id) next = previous && previous.attempts >= MAX_FAILED_ATTEMPTS ? "gave_up" : "post";
    else next = previous.payload_hash === (await payloadHash(payload)) ? "unchanged" : "edit";
    plans.push({ meeting, digest, payload, next });
  }
  return plans;
}

export type DiscordRunSummary = {
  ran: boolean;
  results: Array<{ meeting_id: number; action: PublishAction | "failed" }>;
};

export async function runDiscordPosts(
  env: DiscordEnv,
  db: EnqueueDb,
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<DiscordRunSummary> {
  const summary: DiscordRunSummary = { ran: false, results: [] };
  if (!discordPostsEnabled(env)) return summary;
  const store = supabasePostStore(db);
  const plans = await planDiscordPosts(env, db, store, options.now);
  summary.ran = true;
  const webhook = new DiscordWebhook(env.DISCORD_WEBHOOK_URL!, { fetcher: options.fetcher, maxRetries: 1, maxWaitMs: 10_000 });
  const sender = { send: (p: DiscordPayload) => webhook.execute(p), edit: (id: string, p: DiscordPayload) => webhook.edit(id, p) };
  for (const plan of plans) {
    if (summary.results.length >= MAX_POSTS_PER_RUN) break;
    if (plan.next === "unchanged" || plan.next === "gave_up") continue;
    try {
      const result = await publishToChannel({
        meetingId: plan.meeting.id,
        channel: DISCORD_CHANNEL,
        payload: plan.payload,
        sender,
        store,
      });
      summary.results.push({ meeting_id: plan.meeting.id, action: result.action });
    } catch (error) {
      console.error("[Discord] Post failed:", redactWebhookUrls(error instanceof Error ? error.message : String(error)));
      summary.results.push({ meeting_id: plan.meeting.id, action: "failed" });
    }
  }
  return summary;
}
