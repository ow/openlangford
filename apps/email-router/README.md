# Email router

Receives all mail for `openlangford.ca` (a Cloudflare Email Routing catch-all) and posts each message to a private
Discord channel. It only receives: the site's outgoing mail (alerts, contact notifications) stays on Resend.

- Sender, subject, recipient, Pacific send time and the text (HTML stripped if there's no text part).
- Long messages are cut to fit Discord, with a note saying so. Attachments are listed by name and size, not uploaded.
- Mentions in an email never ping anyone.
- Mail that fails SPF, DKIM or DMARC is posted in amber with a warning, not dropped.
- If Discord is unreachable and no `FORWARD_TO` is set, the message is rejected, so the sender knows it didn't arrive.

## Setup

1. Discord: create a webhook in a **private** channel (not the public meeting-digest channel).
2. Deploy and set the secret, from this folder:
   ```
   npx wrangler deploy
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```
3. Cloudflare dashboard → openlangford.ca → Email → Email Routing:
   - Enable it. This replaces the domain's MX records, so any other mail provider stops receiving.
   - Routing rules → Catch-all → Action "Send to a Worker" → `langford-email-router` → Enable.
4. Optional: to also get every message in a personal inbox, add it under Destination addresses, verify it, and set
   `FORWARD_TO` (`npx wrangler deploy --var FORWARD_TO:you@example.com`, or a `[vars]` entry in `wrangler.toml`).

## Develop

`pnpm test` runs the formatting tests. To try it end to end, run `npx wrangler dev --var DISCORD_WEBHOOK_URL:<url>`
and POST a raw message (with a Message-ID header) to
`http://localhost:8787/cdn-cgi/handler/email?from=a@example.com&to=admin@openlangford.ca`.
