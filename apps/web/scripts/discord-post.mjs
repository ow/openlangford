/**
 * Local test for Discord meeting digests (issue #67).
 *
 *   pnpm --filter web discord:post -- --meeting 2026-04-20-regular-council --dry-run
 *   pnpm --filter web discord:post -- --meeting 2026-04-20-regular-council
 *
 * Reads production data with the publishable key (read-only by RLS; nothing is
 * written to the database). --dry-run prints the webhook JSON; otherwise posts
 * to DISCORD_WEBHOOK_URL. Idempotency is local: pass --state <file.json> to
 * remember message ids so a re-run edits the same message (default: memory only,
 * so every non-dry run posts a new message).
 *
 * Env: loaded from --env-file <path>, else the repository root .env (the main
 * checkout's, also from a git worktree). Existing env vars win. The webhook URL
 * is never printed.
 */
import { createServer } from "vite";
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const root = fileURLToPath(new URL("../", import.meta.url));

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: discord:post -- --meeting <slug|id> [--dry-run] [--out file.json] [--state posts.json] [--force] [--env-file path]");
  process.exit(2);
}

function envFile() {
  const explicit = option("--env-file");
  if (explicit) return explicit;
  const local = path.resolve(root, "../../.env");
  if (existsSync(local)) return local;
  try {
    // In a git worktree, the shared .git dir sits in the main checkout.
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
    const main = path.resolve(common, "../.env");
    if (existsSync(main)) return main;
  } catch {
    // not a git checkout
  }
  return null;
}

const meetingArg = option("--meeting");
if (!meetingArg) usage("Missing --meeting");
const dryRun = flag("--dry-run");

const file = envFile();
if (file) process.loadEnvFile(file);

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY || process.env.SUPABASE_KEY;
if (!url || !key) usage(`Supabase URL and publishable key not found${file ? "" : " (no .env found)"}`);
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
if (!dryRun && !webhookUrl) usage(`DISCORD_WEBHOOK_URL is not set${file ? ` (looked in ${file})` : ""}`);

const server = await createServer({ root, configFile: false, logLevel: "error", server: { middlewareMode: true } });
let redact = (text) => text;
try {
  const digestModule = await server.ssrLoadModule("/app/services/channels/digest.ts");
  const discord = await server.ssrLoadModule("/app/services/channels/discord.ts");
  const posts = await server.ssrLoadModule("/app/services/channels/posts.ts");
  redact = discord.redactWebhookUrls;

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const digest = await digestModule.loadMeetingDigest(db, meetingArg);
  if (!digest) throw new Error(`No meeting ${meetingArg}`);
  if (!digestModule.hasPostableContent(digest)) throw new Error(`${digest.slug} has no highlights or summary yet`);
  const payload = discord.toDiscordPayload(digest);
  const embedChars = discord.embedLength(payload.embeds[0]);

  if (option("--out")) writeFileSync(option("--out"), JSON.stringify(payload, null, 2) + "\n");
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    console.error(`Dry run: ${digest.slug}, ${embedChars} embed characters, ${digest.decisions.length} decisions${digest.fromSummary ? ", summary fallback (no highlights)" : ""}. Nothing posted.`);
  } else {
    const statePath = option("--state");
    const saved = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : [];
    const store = posts.memoryPostStore(saved);
    const webhook = new discord.DiscordWebhook(webhookUrl);
    const result = await posts.publishToChannel({
      meetingId: digest.meetingId,
      channel: discord.DISCORD_CHANNEL,
      payload,
      store,
      force: flag("--force"),
      sender: { send: (p) => webhook.execute(p), edit: (id, p) => webhook.edit(id, p) },
    });
    if (statePath) writeFileSync(statePath, JSON.stringify([...store.rows.values()], null, 2) + "\n");
    console.log(JSON.stringify({ meeting: digest.slug, action: result.action, message_id: result.messageId }));
  }
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await server.close();
}
