import { Form } from "react-router";
import type { DiscordAdminData } from "../../services/channels/discord-admin.server";
import type { DiscordEmbed } from "../../services/channels/discord";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn, formatRelativeTime } from "../../lib/utils";

const card = "rounded-2xl border border-zinc-200 bg-surface shadow-sm";

/** Discord's link syntax as plain text with the label kept; bold markers dropped. */
function plain(text: string) {
  return text
    .replace(/\[((?:\\.|[^\]\\])+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\\(.)/g, "$1");
}

/** A rough Discord-style rendering of the embed, for a quick read before posting. */
function EmbedPreview({ embed, content }: { embed: DiscordEmbed; content?: string }) {
  return (
    <div className="rounded-lg bg-[#2b2d31] p-4 text-sm text-[#dbdee1]">
      <div className="mb-1 font-semibold text-white">Open Langford</div>
      {content && <p className="mb-2">{content}</p>}
      <div className="max-w-[520px] rounded border-l-4 border-[#009398] bg-[#232428] p-3">
        {embed.author && <div className="mb-1 text-xs font-semibold text-white">{embed.author.name}</div>}
        <div className="font-semibold text-[#00a8fc]">{embed.title}</div>
        {embed.description && <p className="mt-1 whitespace-pre-line">{plain(embed.description)}</p>}
        {embed.fields?.map((f) => (
          <div key={f.name} className="mt-2">
            <div className="text-xs font-semibold text-white">{f.name}</div>
            <p className="whitespace-pre-line">{plain(f.value)}</p>
          </div>
        ))}
        {embed.image && <img src={embed.image.url} alt="" className="mt-3 w-full rounded" loading="lazy" />}
        {embed.footer && <div className="mt-2 text-xs text-[#949ba4]">{embed.footer.text}</div>}
      </div>
    </div>
  );
}

export function DiscordPostsSection({ discord, isSubmitting }: { discord: DiscordAdminData; isSubmitting: boolean }) {
  const { preview } = discord;
  const canPost = discord.enabled && discord.webhookConfigured && discord.storeReady;
  return (
    <section aria-labelledby="discord-heading" className="mt-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 id="discord-heading" className="text-lg font-semibold text-zinc-900">
            Discord posts
          </h2>
          <Badge variant={discord.enabled ? "success" : "muted"}>{discord.enabled ? "On" : "Paused"}</Badge>
        </div>
        <Form method="get" className="flex gap-2">
          <Input name="discord_preview" placeholder="Meeting slug to preview" className="h-9 w-64" aria-label="Meeting slug to preview" />
          <Button type="submit" variant="outline" size="sm">
            Preview
          </Button>
        </Form>
      </div>
      <div className={cn(card, "space-y-4 p-4 text-sm text-zinc-700")}>
        <p>
          {discord.enabled
            ? "New meeting digests post automatically every five minutes."
            : "Paused. Set DISCORD_POSTS_ENABLED to \"true\" in wrangler.toml to turn automatic posts on."}{" "}
          Webhook {discord.webhookConfigured ? "set" : "not set (DISCORD_WEBHOOK_URL secret)"}. Meetings from{" "}
          {discord.startDate ?? "no start date"}.
          {!discord.storeReady && " The channel_posts table isn't there yet, so nothing can post."}
        </p>
        {discord.error && <p className="text-red-700">{discord.error}</p>}
        {preview ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium text-zinc-900">{preview.title}</span>{" "}
                <span className="text-zinc-500">· {preview.reason}</span>
              </div>
              <Form method="post">
                <input type="hidden" name="intent" value="discord_post" />
                <input type="hidden" name="discord_slug" value={preview.slug} />
                <Button type="submit" size="sm" disabled={!canPost || isSubmitting}>
                  Post / re-post now
                </Button>
              </Form>
            </div>
            <EmbedPreview embed={preview.payload.embeds[0]} content={preview.payload.content} />
            <details>
              <summary className="cursor-pointer text-zinc-500">Webhook JSON</summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-zinc-50 p-3 text-xs">{JSON.stringify(preview.payload, null, 2)}</pre>
            </details>
          </div>
        ) : (
          !discord.error && <p className="text-zinc-500">No meeting is waiting to post.</p>
        )}
        {discord.recent.length > 0 && (
          <ul className="divide-y divide-zinc-100 border-t border-zinc-100">
            {discord.recent.map((p) => (
              <li key={`${p.meeting_id}`} className="flex justify-between gap-3 py-2">
                <span>Meeting #{p.meeting_id}</span>
                <span className={p.status === "failed" ? "text-red-700" : "text-zinc-500"}>
                  {p.status === "failed" ? `Failed (${p.attempts}): ${p.last_error ?? ""}` : "Posted"}
                  {p.updated_at ? ` · ${formatRelativeTime(p.updated_at)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
