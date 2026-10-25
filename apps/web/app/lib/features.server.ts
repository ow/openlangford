/**
 * Feature flags read from env (wrangler.toml [vars], inlined at build time by
 * vite.config.ts). Server-only; expose to the UI via the root loader.
 */
export function signupsEnabled(): boolean {
  return (
    (process.env.ENABLE_SIGNUPS ?? "true").trim().toLowerCase() !== "false"
  );
}

/** Public discovery is separate from accepting direct-link signups. */
export function publicSignupsEnabled(): boolean {
  return (
    signupsEnabled() &&
    (process.env.PUBLIC_SIGNUP_LINKS ?? "true").trim().toLowerCase() !== "false"
  );
}

/** Operator-verified delivery readiness; default off until the sender is activated. */
export function emailAlertsAvailable(): boolean {
  return (
    (process.env.EMAIL_ALERTS_AVAILABLE ?? "false").trim().toLowerCase() ===
    "true"
  );
}
