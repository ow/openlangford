// Named site-analytics, not google-analytics: ad blockers (AdGuard for Safari) block any URL with that name, which on the
// dev server is this module itself, so the client bundle never loaded and nothing on localhost hydrated in Safari (2026-11-08).
import { useEffect } from "react";
import { useLocation } from "react-router";
import { isPrivatePath, scrubUrl } from "../lib/analytics-privacy";

export const GA_MEASUREMENT_ID = "G-78T8YKCH1Y";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Google's tag, set up so it never sees a sign-in code or token: no automatic page views (we send them, with the
 * address scrubbed by the same rules as PostHog), and every other event carries the scrubbed address too. Not
 * loaded on private pages (unsubscribe links, admin) or in local development.
 */
export const GA_INIT_SCRIPT = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','${GA_MEASUREMENT_ID}',{send_page_view:false});`;

export function gaEnabledFor(pathname: string) {
  return !import.meta.env.DEV && !isPrivatePath(pathname);
}

/** One page view per route change, with a scrubbed address; nothing on private pages. */
export function GoogleAnalyticsPageViews() {
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    if (!window.gtag || import.meta.env.DEV) return;
    const location = scrubUrl(window.location.href);
    window.gtag("set", { page_location: location, page_referrer: scrubUrl(document.referrer) });
    if (isPrivatePath(pathname)) return;
    window.gtag("event", "page_view", { page_location: location, page_title: document.title });
  }, [pathname, search, hash]);
  return null;
}
