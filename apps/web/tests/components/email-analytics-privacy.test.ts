// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { PostHogProvider } from "~/components/posthog-provider";
const mocks = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn() }));
vi.mock("posthog-js", () => ({
  default: { init: mocks.init, capture: mocks.capture, __loaded: true },
}));
it("drops analytics events containing unsubscribe capabilities or admin URLs before transmission", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv("VITE_POSTHOG_KEY", "synthetic-key");
  const host = document.createElement("div"),
    root = createRoot(host);
  try {
    await act(async () => root.render(h(MemoryRouter, {}, h(PostHogProvider))));
    const before = mocks.init.mock.calls[0][1].before_send;
    for (const path of [
      "/email/unsubscribe/11111111-1111-4111-8111-111111111111",
      "/admin/users",
    ])
      expect(
        before({
          properties: { $current_url: "https://openlangford.ca" + path },
        }),
      ).toBeNull();
    const publicEvent = {
      properties: { $current_url: "https://openlangford.ca/meetings" },
    };
    expect(before(publicEvent)).toEqual({
      properties: { $current_url: "https://openlangford.ca/meetings", $process_person_profile: false, $geoip_disable: true, $ip: null },
    });
    // Anonymous: no person profiles, no long-lived cookie, no session recording.
    expect(mocks.init.mock.calls[0][1]).toMatchObject({
      person_profiles: "never",
      persistence: "sessionStorage",
      disable_session_recording: true,
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllEnvs();
  }
});
