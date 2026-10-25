import { readJson, UUID, type Rpc } from "./alerts.ts";
export function createEmailEventHandler(secret: string | undefined, rpc: Rpc) {
  return async (request: Request) => {
    try {
      if (request.method !== "POST")
        return new Response("POST required", { status: 405 });
      if (!secret?.startsWith("whsec_"))
        return new Response("Webhook not configured", { status: 503 });
      const id = request.headers.get("svix-id") ?? "",
        stamp = request.headers.get("svix-timestamp") ?? "",
        signatures = request.headers.get("svix-signature") ?? "";
      const time = Number(stamp);
      if (
        !/^msg_[a-zA-Z0-9]+$/.test(id) ||
        !Number.isSafeInteger(time) ||
        Math.abs(Date.now() / 1000 - time) > 300
      )
        return new Response("Invalid signature", { status: 400 });
      const { raw, parse } = await readJson(request, 65536);
      const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      let valid = false;
      for (const signature of signatures.split(" ")) {
        if (!signature.startsWith("v1,")) continue;
        try {
          if (
            await crypto.subtle.verify(
              "HMAC",
              key,
              Uint8Array.from(atob(signature.slice(3)), (c) => c.charCodeAt(0)),
              new TextEncoder().encode(`${id}.${stamp}.${raw}`),
            )
          )
            valid = true;
        } catch {
          /* Invalid candidates never authorize. */
        }
      }
      if (!valid) return new Response("Invalid signature", { status: 400 });
      const event = parse();
      const type: Record<string, string> = {
        "email.sent": "accepted",
        "email.delivered": "delivered",
        "email.bounced": "bounced",
        "email.complained": "complained",
        "email.suppressed": "suppressed",
        "email.failed": "failed",
      };
      if (!type[event.type]) return new Response(null, { status: 204 });
      const data = event.data ?? {},
        message = data.tags?.message_id;
      if (
        !UUID.test(data.email_id ?? "") ||
        !Array.isArray(data.to) ||
        data.to.length !== 1 ||
        typeof data.to[0] !== "string" ||
        typeof event.created_at !== "string" ||
        Number.isNaN(Date.parse(event.created_at))
      )
        return new Response("Invalid event", { status: 400 });
      let result;
      try {
        result = await rpc("record_email_provider_event", {
          p_event_id: id,
          p_provider_id: data.email_id,
          p_type: type[event.type],
          p_at: event.created_at,
          p_message: UUID.test(message ?? "") ? message : null,
          p_recipient: data.to[0].toLowerCase(),
        });
      } catch {
        return new Response("Event persistence unavailable", { status: 503 });
      }
      if (result.error)
        return new Response("Event persistence unavailable", { status: 503 });
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Webhook rejected", { status: 400 });
    }
  };
}
