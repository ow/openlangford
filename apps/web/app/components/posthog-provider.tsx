import { useEffect } from "react";
import { useLocation } from "react-router";
import posthog from "posthog-js";
import { anonymizeEvent } from "../lib/analytics-privacy";

/** Removes the long-lived PostHog cookie and storage this site used to set (it now keeps nothing past the tab). */
function forgetOldAnalyticsId(key: string) {
  const name = `ph_${key}_posthog`;
  try {
    window.localStorage.removeItem(name);
  } catch {
    // Storage blocked: nothing to remove.
  }
  if (!document.cookie.includes(`${name}=`)) return;
  const expired = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
  const parts = window.location.hostname.split(".");
  document.cookie = expired;
  for (let i = 0; i < parts.length - 1; i++) document.cookie = `${expired}; domain=.${parts.slice(i).join(".")}`;
}

/**
 * Client-side PostHog analytics provider.
 * Initializes PostHog on mount and tracks $pageview on every route change.
 * Renders nothing -- this is a side-effect-only component.
 *
 * Anonymous by design (lib/analytics-privacy.ts): no person profiles and never identify(), a random
 * id that lasts only for the browser tab (no cookie), no session recording, no IP or GeoIP.
 *
 * Uses posthog-js directly (not posthog-js/react) to avoid SSR/bundling
 * issues on Cloudflare Workers.
 */
export function PostHogProvider() {
  const { pathname, search } = useLocation();

  // Initialize PostHog once on mount (client-side only)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const key =
      import.meta.env.VITE_POSTHOG_KEY || process.env.VITE_POSTHOG_KEY || "";

    if (!key) return; // Graceful no-op when key is missing (e.g. local dev)

    forgetOldAnalyticsId(key);
    posthog.init(key, {
      api_host: "https://us.i.posthog.com",
      ui_host: "https://us.posthog.com",
      person_profiles: "never",
      // A random id kept in this tab only: no cookie, nothing that outlives the visit.
      persistence: "sessionStorage",
      disable_session_recording: true,
      disable_surveys: true,
      mask_personal_data_properties: true,
      custom_personal_data_properties: ["code", "token", "token_hash", "access_token", "refresh_token", "email"],
      // Never send opt-out bearer URLs or admin pages; strip identifiers from everything else.
      before_send: (event) => anonymizeEvent(event, window.location.pathname),
      capture_pageview: false, // We track route changes manually (SPA)
    });
  }, []);

  // Track pageview on every route change
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!posthog.__loaded) return; // Skip if PostHog wasn't initialized

    posthog.capture("$pageview");
  }, [pathname, search]);

  return null;
}
