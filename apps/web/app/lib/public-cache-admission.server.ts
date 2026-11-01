/** Shared anonymous-cache admission. Unknown cookies always fail closed. */
function postHogCookieName(key: string | undefined) {
  // posthog-js parseName(), with this app's default persistence_name. This is
  // one configured project's exact cookie, never a ph_* or consent wildcard.
  return key ? `ph_${key.replace(/\+/g, "PL").replace(/\//g, "SL").replace(/=/g, "EQ")}_posthog` : null;
}

// Google Analytics' two first-party cookies for this site's one measurement id (components/google-analytics.tsx).
const GOOGLE_ANALYTICS_COOKIES = new Set(["_ga", "_ga_78T8YKCH1Y"]);

/** The configured analytics cookies (PostHog's and Google Analytics'), by exact name: nothing else. */
function isAnalyticsCookie(name: string, key: string | undefined) {
  return name === postHogCookieName(key) || GOOGLE_ANALYTICS_COOKIES.has(name);
}

function onlyAnalyticsCookies(header: string, key: string | undefined) {
  return header.split(";").every((part) => {
    const separator = part.indexOf("=");
    return separator > 0 && isAnalyticsCookie(part.slice(0, separator).trim(), key);
  });
}

const UNCACHED_HEADERS = ["authorization", "range", "if-none-match", "if-modified-since", "cache-control", "pragma"];

export function anonymousPublicRequest(request: Request, posthogKey?: string): boolean {
  const cookie = request.headers.get("cookie");
  return (cookie === null || onlyAnalyticsCookies(cookie, posthogKey)) && publicReadRequest(request);
}

/**
 * Any visitor, signed in or not, but still a plain GET on the public origin: an explicit
 * refresh (Cache-Control/Pragma), credentials header or conditional/range request bypasses.
 * Only for values that never depend on who is asking.
 */
export function publicReadRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.origin === "https://openlangford.ca" && request.method === "GET" &&
    !UNCACHED_HEADERS.some((header) => request.headers.has(header));
}

const SUPABASE_SESSION_COOKIE = /^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/;

/**
 * A signed-in visitor whose only cookies are the Supabase session (plus the configured analytics
 * cookies), on a plain public GET. Only for responses whose loaders read no session at all
 * (route-only navigation data), always rendered from a cookie-free request. Any other cookie
 * (a flash notice, a PKCE verifier, anything unknown) fails closed.
 */
export function signedInPublicRequest(request: Request, posthogKey?: string): boolean {
  const cookie = request.headers.get("cookie");
  if (!cookie || !publicReadRequest(request)) return false;
  let session = false;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return false;
    const name = part.slice(0, separator).trim();
    if (SUPABASE_SESSION_COOKIE.test(name)) session = true;
    else if (!isAnalyticsCookie(name, posthogKey)) return false;
  }
  return session;
}
