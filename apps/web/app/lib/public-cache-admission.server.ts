/** Shared anonymous-cache admission. Unknown cookies always fail closed. */
function onlyPostHogCookie(header: string, key: string | undefined) {
  if (!key) return false;
  // posthog-js parseName(), with this app's default persistence_name. This is
  // one configured project's exact cookie, never a ph_* or consent wildcard.
  const name = `ph_${key.replace(/\+/g, "PL").replace(/\//g, "SL").replace(/=/g, "EQ")}_posthog`;
  return header.split(";").every((part) => {
    const separator = part.indexOf("=");
    return separator > 0 && part.slice(0, separator).trim() === name;
  });
}

const UNCACHED_HEADERS = ["authorization", "range", "if-none-match", "if-modified-since", "cache-control", "pragma"];

export function anonymousPublicRequest(request: Request, posthogKey?: string): boolean {
  const cookie = request.headers.get("cookie");
  return (cookie === null || onlyPostHogCookie(cookie, posthogKey)) && publicReadRequest(request);
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
