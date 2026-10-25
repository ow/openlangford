export const FROM_EMAIL = "Open Langford <alerts@openlangford.ca>";
export const SITE_URL = "https://openlangford.ca";
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Rpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: any; error: any }>;
export type AlertEnv = {
  ALERT_WORKER_KEY?: string;
  ALERT_DELIVERY_MODE?: string;
  ALERT_START_DATE?: string;
  ALERT_TEST_RECIPIENT?: string;
  RESEND_API_KEY?: string;
};
export type Message = {
  id: string;
  recipient: string;
  subject: string;
  payload: any;
  unsubscribe_token: string;
  lease_token: string;
  attempt_count: number;
  is_test: boolean;
  provider_payload?: any;
};
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function providerBody(message: Message) {
  const meeting = message.payload?.meeting;
  if (
    !UUID.test(message.id) ||
    !UUID.test(message.unsubscribe_token) ||
    !meeting ||
    typeof meeting.title !== "string"
  )
    throw Error("Invalid queued payload");
  const url = `${SITE_URL}/meetings/${encodeURIComponent(meeting.slug || String(meeting.id))}`;
  const unsubscribe = `${SITE_URL}/email/unsubscribe/${message.unsubscribe_token}`;
  const decisions = Array.isArray(message.payload.decisions)
    ? message.payload.decisions.slice(0, 12)
    : [];
  const text = `${message.is_test ? "TEST EMAIL\n\n" : ""}Open Langford\n${meeting.title}\n${meeting.date}\n\n${String(meeting.summary ?? "").slice(0, 5000)}\n\n${decisions.map((d: any) => `${d.title ?? "Council decision"}: ${d.summary ?? ""} (${d.result ?? "Result not recorded"})`).join("\n\n")}\n\nRead the meeting: ${url}\n\nYou opted into per-meeting council updates. Manage preferences: ${SITE_URL}/settings\nUnsubscribe from all council alert emails: ${unsubscribe}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(message.subject)}</title></head><body style="font-family:system-ui,sans-serif;color:#18181b;max-width:600px;margin:auto;padding:24px;line-height:1.6"><p style="color:#175c57;font-weight:700">Open Langford${message.is_test ? " · Test email" : ""}</p><h1 style="font-size:24px">${escapeHtml(meeting.title)}</h1><p>${escapeHtml(meeting.date)}</p><p style="white-space:pre-line">${escapeHtml(String(meeting.summary ?? "").slice(0, 5000))}</p>${decisions.map((d: any) => `<h2 style="font-size:18px">${escapeHtml(d.title || "Council decision")}</h2><p>${escapeHtml(d.summary)}</p><p><strong>${escapeHtml(d.result || "Result not recorded")}</strong></p>`).join("")}<p><a href="${url}">Read the meeting and source records</a></p><hr><p style="font-size:13px">You opted into per-meeting council updates. <a href="${SITE_URL}/settings">Manage preferences</a> · <a href="${unsubscribe}">Unsubscribe from all council alert emails</a></p><p style="font-size:12px">Open Langford is an independent civic information project, not the City of Langford.</p></body></html>`;
  return {
    from: FROM_EMAIL,
    to: [message.recipient],
    subject: message.subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [{ name: "message_id", value: message.id }],
  };
}
export async function constantTimeEqual(a: string, b: string) {
  if (a.length > 512 || b.length > 512) return false;
  const digest = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let different = 0;
  for (let i = 0; i < x.length; i++) different |= x[i] ^ y[i];
  return different === 0;
}
export async function readJson(request: Request, max = 4096) {
  const reader = request.body?.getReader();
  if (!reader) throw new Response("Body required", { status: 400 });
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Response("Body too large", { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = new TextDecoder().decode(bytes);
  return {
    raw,
    parse: () => {
      try {
        return JSON.parse(raw);
      } catch {
        throw new Response("Invalid JSON", { status: 400 });
      }
    },
  };
}
function settings(env: AlertEnv) {
  const mode = env.ALERT_DELIVERY_MODE ?? "off";
  if (mode === "off") return null;
  const date = env.ALERT_START_DATE ?? "";
  if (
    !["test", "live"].includes(mode) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw Error("Delivery configuration incomplete");
  const recipient =
    mode === "test" ? env.ALERT_TEST_RECIPIENT?.trim().toLowerCase() : null;
  if (
    mode === "test" &&
    (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient))
  )
    throw Error("Approved test recipient required");
  return { mode, date, recipient };
}
async function call(rpc: Rpc, name: string, args: Record<string, unknown>) {
  const result = await rpc(name, args);
  if (result.error) throw Error("Alert database operation failed");
  return result.data;
}
export async function dispatchOne(
  env: AlertEnv,
  rpc: Rpc,
  fetcher: typeof fetch = fetch,
) {
  const config = settings(env);
  if (!config) return false;
  if (!env.RESEND_API_KEY) throw Error("Provider configuration incomplete");
  const rows = await call(rpc, "claim_email_alert", {
    p_test_recipient: config.recipient,
  });
  const message: Message = rows?.[0];
  if (!message) return false;
  const finish = async (
    state: string,
    error: string | null = null,
    id: string | null = null,
    retry = 60,
  ) =>
    call(rpc, "finish_email_alert", {
      p_message: message.id,
      p_lease: message.lease_token,
      p_state: state,
      p_provider_id: id,
      p_error: error,
      p_retry_seconds: retry,
    });
  if (
    message.is_test !== (config.mode === "test") ||
    (config.recipient && message.recipient !== config.recipient)
  ) {
    await finish("suppressed", "Delivery mode mismatch");
    return true;
  }
  const eligible = () =>
    call(rpc, "email_alert_eligible", {
      p_message: message.id,
      p_start_date: config.date,
    });
  if (!(await eligible())) {
    await finish(
      "suppressed",
      "Consent, recipient or cutoff no longer eligible",
    );
    return true;
  }
  let body;
  try {
    body = message.provider_payload ?? providerBody(message);
  } catch {
    await finish("failed", "Invalid queued content");
    return true;
  }
  const frozen = await call(rpc, "freeze_email_alert", {
    p_message: message.id,
    p_lease: message.lease_token,
    p_body: body,
  });
  const allowedKeys = [
    "from",
    "to",
    "subject",
    "text",
    "html",
    "headers",
    "tags",
  ];
  if (
    frozen &&
    (Object.keys(frozen).some((key) => !allowedKeys.includes(key)) ||
      frozen.from !== FROM_EMAIL ||
      !Array.isArray(frozen.to) ||
      frozen.to.length !== 1 ||
      frozen.to[0] !== message.recipient ||
      frozen.tags?.[0]?.value !== message.id)
  ) {
    await finish("failed", "Stored recipient or sender mismatch");
    return true;
  }
  if (!frozen || !(await eligible())) {
    await finish("suppressed", "Consent changed before delivery");
    return true;
  }
  let response: Response;
  try {
    response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `openlangford/${message.id}`,
      },
      body: JSON.stringify(frozen),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    await finish(
      "retry",
      "Provider network outcome unknown",
      null,
      Math.min(3600, 60 * 2 ** (message.attempt_count - 1)),
    );
    return true;
  }
  if (response.ok) {
    let result: any;
    try {
      result = await response.json();
    } catch {
      /* Ambiguous response: retry the same key/body. */
    }
    if (result && typeof result.id === "string" && UUID.test(result.id))
      await finish("accepted", null, result.id);
    else await finish("retry", "Provider acknowledgement unavailable");
  } else if (response.status === 429 || response.status >= 500) {
    const after = Number(response.headers.get("retry-after"));
    await finish(
      "retry",
      `Provider HTTP ${response.status}`,
      null,
      Number.isFinite(after) && after > 0
        ? Math.min(3600, after)
        : Math.min(3600, 60 * 2 ** (message.attempt_count - 1)),
    );
  } else await finish("failed", `Provider HTTP ${response.status}`);
  return true;
}
export function createAlertHandler(
  env: AlertEnv,
  rpc: Rpc,
  fetcher: typeof fetch = fetch,
) {
  return async (request: Request) => {
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    try {
      if (request.method !== "POST")
        return reply({ error: "POST required" }, 405);
      if (
        !env.ALERT_WORKER_KEY ||
        env.ALERT_WORKER_KEY.length < 32 ||
        !(await constantTimeEqual(
          request.headers.get("X-Alert-Worker-Key") ?? "",
          env.ALERT_WORKER_KEY,
        ))
      )
        return reply({ error: "Unauthorized" }, 401);
      const config = settings(env);
      if (!config) return reply({ skipped: true, reason: "Delivery disabled" });
      const body = (await readJson(request)).parse();
      if (body.action === "dispatch") {
        let processed = 0;
        for (let i = 0; i < 5; i++) {
          if (!(await dispatchOne(env, rpc, fetcher))) break;
          processed++;
          if (i < 4) await new Promise((resolve) => setTimeout(resolve, 550));
        }
        return reply({ processed });
      }
      if (
        !["enqueue", "test"].includes(body.action) ||
        !Number.isSafeInteger(body.meeting_id) ||
        body.meeting_id <= 0 ||
        (body.mode && body.mode !== "digest")
      )
        return reply({ error: "Invalid per-meeting request" }, 400);
      if ((body.action === "test") !== (config.mode === "test"))
        return reply({
          skipped: true,
          reason: "Delivery mode prevents this enqueue",
        });
      const queued = await call(rpc, "enqueue_meeting_emails", {
        p_meeting: body.meeting_id,
        p_start_date: config.date,
        p_test_recipient: config.recipient,
      });
      return reply({ queued });
    } catch (error) {
      if (error instanceof Response) return error;
      return reply(
        { error: "Alert processing unavailable; no provider details logged" },
        503,
      );
    }
  };
}
