import PostalMime from "postal-mime";
import { discordPayload } from "./format";

export interface Env {
  /** A private channel's webhook (secret). */
  DISCORD_WEBHOOK_URL?: string;
  /** Optional verified Email Routing destination that also receives every message. */
  FORWARD_TO?: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const email = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
    const payload = discordPayload({
      email,
      envelopeFrom: message.from,
      envelopeTo: message.to,
      authenticationResults: message.headers.get("authentication-results"),
    });

    const webhook = env.DISCORD_WEBHOOK_URL;
    let posted = false;
    if (webhook) {
      try {
        const response = await fetch(`${webhook}?wait=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        posted = response.ok;
        if (!response.ok) console.error(`[email] Discord answered ${response.status}`);
      } catch (error) {
        console.error("[email] Discord unreachable", error instanceof Error ? error.message : error);
      }
    }

    if (env.FORWARD_TO) {
      await message.forward(env.FORWARD_TO);
    } else if (!posted) {
      // Nowhere to put it: refuse it, so the sender learns it didn't arrive instead of it vanishing.
      message.setReject("This mailbox is temporarily unavailable. Please try again later.");
    }
  },
};
