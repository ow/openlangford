export const EMAIL_DISPATCH_CRON = "*/5 * * * *";
type DispatchEnv = {
  EMAIL_ALERT_DISPATCH_ENABLED?: string;
  ALERT_WORKER_KEY?: string;
  VITE_SUPABASE_URL: string;
};
/** Runtime-only credentials. Calling this never enables Edge delivery mode. */
export async function dispatchEmailAlerts(
  env: DispatchEnv,
  fetcher: typeof fetch = fetch,
) {
  if (env.EMAIL_ALERT_DISPATCH_ENABLED !== "true" || !env.ALERT_WORKER_KEY)
    return;
  const response = await fetcher(
    `${env.VITE_SUPABASE_URL}/functions/v1/send-alerts`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Alert-Worker-Key": env.ALERT_WORKER_KEY,
      },
      body: JSON.stringify({ action: "dispatch" }),
      signal: AbortSignal.timeout(55000),
    },
  );
  if (!response.ok)
    throw new Error("Alert dispatch failed; durable queue retained");
}
