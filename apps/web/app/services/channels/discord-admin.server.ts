/** Discord digests on /admin/pipeline: pause state, next post preview, post/re-post now. */
import { discordStatus, planDiscordPosts, type DiscordEnv } from "../../../workers/discord-posts";
import { hasPostableContent, loadMeetingDigest } from "./digest";
import { DISCORD_CHANNEL, DiscordWebhook, redactWebhookUrls, toDiscordPayload, type DiscordPayload } from "./discord";
import { ChannelPostsUnavailable, memoryPostStore, publishToChannel, supabasePostStore, type ChannelPost } from "./posts";

type Db = { from: (table: string) => any };

export type DiscordAdminData = {
  enabled: boolean;
  webhookConfigured: boolean;
  startDate: string | null;
  /** False until the channel_posts migration is applied. */
  storeReady: boolean;
  recent: (ChannelPost & { updated_at?: string })[];
  preview: {
    slug: string;
    title: string;
    reason: string;
    payload: DiscordPayload;
  } | null;
  error: string | null;
};

/** Reads only. `previewSlug` previews a chosen meeting instead of the next scheduled one. */
export async function getDiscordAdmin(env: DiscordEnv, db: Db, previewSlug?: string | null): Promise<DiscordAdminData> {
  const status = discordStatus(env);
  const data: DiscordAdminData = { ...status, storeReady: true, recent: [], preview: null, error: null };
  const store = supabasePostStore(db);
  try {
    data.recent = await store.recent(DISCORD_CHANNEL, 8);
  } catch (error) {
    data.storeReady = false;
    if (!(error instanceof ChannelPostsUnavailable && error.missingTable)) data.error = "Couldn't read past posts.";
  }
  try {
    if (previewSlug) {
      const digest = await loadMeetingDigest(db, previewSlug);
      if (!digest) data.error = `No meeting “${previewSlug}”.`;
      else if (!hasPostableContent(digest)) data.error = `${digest.title} has no highlights or summary yet.`;
      else data.preview = { slug: digest.slug, title: digest.title, reason: "Chosen meeting", payload: toDiscordPayload(digest) };
    } else {
      const plans = await planDiscordPosts(env, db, data.storeReady ? store : memoryPostStore());
      const next = plans.find((p) => p.next === "post" || p.next === "edit");
      if (next) {
        data.preview = {
          slug: next.digest.slug,
          title: next.digest.title,
          reason: next.next === "edit" ? "Next run edits the earlier post" : "Next run posts this",
          payload: next.payload,
        };
      }
    }
  } catch (error) {
    data.error = redactWebhookUrls(error instanceof Error ? error.message : "Preview failed.");
  }
  return data;
}

/** Admin "Post / re-post now": edits the existing message when there is one. */
export async function postDiscordNow(env: DiscordEnv, db: Db, slug: string): Promise<{ success?: string; error?: string }> {
  const status = discordStatus(env);
  if (!status.enabled) return { error: "Discord posting is paused (DISCORD_POSTS_ENABLED is not \"true\")." };
  if (!status.webhookConfigured) return { error: "DISCORD_WEBHOOK_URL is not set." };
  try {
    const digest = await loadMeetingDigest(db, slug);
    if (!digest || !hasPostableContent(digest)) return { error: "That meeting has nothing to post yet." };
    const webhook = new DiscordWebhook(env.DISCORD_WEBHOOK_URL!, { maxRetries: 1, maxWaitMs: 5_000 });
    const result = await publishToChannel({
      meetingId: digest.meetingId,
      channel: DISCORD_CHANNEL,
      payload: toDiscordPayload(digest),
      store: supabasePostStore(db),
      force: true,
      sender: { send: (p) => webhook.execute(p), edit: (id, p) => webhook.edit(id, p) },
    });
    return { success: `Discord: ${result.action} ${digest.title}.` };
  } catch (error) {
    if (error instanceof ChannelPostsUnavailable) return { error: "channel_posts isn't available, so nothing was posted." };
    return { error: redactWebhookUrls(error instanceof Error ? error.message : "Discord post failed.") };
  }
}
