import { useEffect } from "react";
import posthog from "posthog-js";
import { anonymizeEvent } from "../lib/analytics-privacy";

/**
 * Client-side PostHog analytics provider.
 * Initializes PostHog on mount. It records a $pageview on every route change (history_change) and a $pageleave
 * when a page is left, which bounce rate and time on page need. Events go through the site's own /relay path
 * (workers/posthog-proxy.ts). Renders nothing -- this is a side-effect-only component.
 *
 * Anonymous by design (lib/analytics-privacy.ts): no person profiles and never identify(), no session
 * recording, no IP or GeoIP. A random id is kept in a first-party cookie (a year, like Google Analytics'
 * `_ga`) so returning visitors can be counted.
 *
 * Uses posthog-js directly (not posthog-js/react) to avoid SSR/bundling
 * issues on Cloudflare Workers.
 */
export function PostHogProvider() {
  // Initialize PostHog once on mount (client-side only)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const key =
      import.meta.env.VITE_POSTHOG_KEY || process.env.VITE_POSTHOG_KEY || "";

    if (!key) return; // Graceful no-op when key is missing (e.g. local dev)

    posthog.init(key, {
      api_host: "/relay",
      ui_host: "https://us.posthog.com",
      person_profiles: "never",
      // A random id kept in this tab only: no cookie, nothing that outlives the visit.
      persistence: "localStorage+cookie",
      disable_session_recording: true,
      disable_surveys: true,
      mask_personal_data_properties: true,
      custom_personal_data_properties: ["code", "token", "token_hash", "access_token", "refresh_token", "email"],
      // Never send opt-out bearer URLs or admin pages; strip identifiers from everything else.
      before_send: (event) => anonymizeEvent(event, window.location.pathname),
      capture_pageview: "history_change", // the first load and every client-side route change
      capture_pageleave: true,
    });
  }, []);

  return null;
}
