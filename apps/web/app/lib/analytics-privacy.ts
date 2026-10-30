/**
 * Analytics carry what was viewed, searched or asked, never who did it: no IP address, account id,
 * email or person profile, and no session recording. Shared by the browser (posthog-provider) and
 * server events (analytics.server).
 */

/** Added to every event: no person profile, no GeoIP lookup, no IP address. */
export const ANONYMOUS_EVENT_PROPERTIES = {
  $process_person_profile: false,
  $geoip_disable: true,
  $ip: null,
} as const;

/** Pages whose events are never sent: opt-out bearer links and admin pages (account emails). */
const PRIVATE_PATHS = ["/email/unsubscribe/", "/admin"];

/** Query and hash parameters that can carry a sign-in code, token or email address. */
const SECRET_PARAMS = /^(code|token|token_hash|access_token|refresh_token|email)$/i;

/** A URL with sign-in codes, tokens and emails removed from its query and hash. */
export function scrubUrl(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (SECRET_PARAMS.test(key)) url.searchParams.delete(key);
    if (url.hash.includes("=")) url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

type AnalyticsEvent = { event?: string; properties?: Record<string, any> | null; $set?: unknown; $set_once?: unknown } | null;

/**
 * PostHog's before_send: drops events from private pages, strips person properties and anything
 * identifying, and marks the event anonymous. Search and question text stays (the owner's choice).
 */
export function anonymizeEvent<T extends AnalyticsEvent>(event: T, currentPath = ""): T | null {
  if (!event) return null;
  const properties = { ...(event.properties || {}) };
  const urls = [currentPath, String(properties.$current_url || ""), String(properties.$pathname || "")];
  if (urls.some((value) => PRIVATE_PATHS.some((path) => value.includes(path)))) return null;
  if (event.event === "$identify" || event.event === "$create_alias" || event.event === "$groupidentify") return null;
  for (const key of ["$current_url", "$referrer", "$initial_current_url", "$initial_referrer"]) {
    if (typeof properties[key] === "string") properties[key] = scrubUrl(properties[key]);
  }
  for (const key of ["$set", "$set_once", "$user_id", "email", "$email"]) delete properties[key];
  const out: any = { ...event, properties: { ...properties, ...ANONYMOUS_EVENT_PROPERTIES } };
  delete out.$set;
  delete out.$set_once;
  return out;
}
