import { expect, it, vi } from "vitest";
import { dispatchEmailAlerts } from "../../workers/email-dispatch";
it("keeps scheduled dispatch off without both operator enablement and its runtime credential", async () => {
  const fetcher = vi.fn();
  for (const env of [
    {},
    { EMAIL_ALERT_DISPATCH_ENABLED: "false", ALERT_WORKER_KEY: "secret" },
    { EMAIL_ALERT_DISPATCH_ENABLED: "true" },
  ])
    await dispatchEmailAlerts(
      { ...env, VITE_SUPABASE_URL: "https://project.supabase.co" },
      fetcher,
    );
  expect(fetcher).not.toHaveBeenCalled();
});
it("dispatches only the bounded queue action and preserves failures for the durable retry path", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 503 }));
  const env = {
    EMAIL_ALERT_DISPATCH_ENABLED: "true",
    ALERT_WORKER_KEY: "synthetic-runtime-only-key",
    VITE_SUPABASE_URL: "https://project.supabase.co",
  };
  await expect(dispatchEmailAlerts(env, fetcher)).rejects.toThrow(
    "durable queue retained",
  );
  expect(fetcher).toHaveBeenCalledWith(
    "https://project.supabase.co/functions/v1/send-alerts",
    expect.objectContaining({
      method: "POST",
      body: '{"action":"dispatch"}',
      headers: {
        "Content-Type": "application/json",
        "X-Alert-Worker-Key": "synthetic-runtime-only-key",
      },
    }),
  );
});
