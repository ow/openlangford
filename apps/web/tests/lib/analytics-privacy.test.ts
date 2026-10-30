import { afterEach, describe, expect, it, vi } from "vitest";
import { anonymizeEvent, scrubUrl } from "~/lib/analytics-privacy";
import { captureServerEvent, serverEventBody } from "~/lib/analytics.server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("server analytics events", () => {
  it("use a fresh random id, never the visitor's IP, and keep the question text", () => {
    const a = serverEventBody("key", "$ai_generation", { $ai_input: "When is the next council meeting?" });
    const b = serverEventBody("key", "$ai_generation", {});
    expect(a.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.distinct_id).not.toBe(b.distinct_id);
    expect(a.properties).toMatchObject({
      $ai_input: "When is the next council meeting?",
      $process_person_profile: false,
      $geoip_disable: true,
      $ip: null,
    });
  });

  it("can't be given an identifier: callers pass only properties", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const request = new Request("https://openlangford.ca/api/search", { headers: { "cf-connecting-ip": "203.0.113.9" } });
    captureServerEvent("$ai_generation", { $ai_input: "parks" });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(JSON.stringify(body)).not.toContain(request.headers.get("cf-connecting-ip"));
    expect(body.properties.$process_person_profile).toBe(false);
  });
});

describe("browser analytics events", () => {
  it("strip person properties and sign-in tokens, and mark the event anonymous", () => {
    const event = anonymizeEvent(
      {
        event: "$pageview",
        $set: { email: "reader@example.test" },
        properties: {
          $current_url: "https://openlangford.ca/auth/callback?code=abc&next=%2Fsettings#access_token=x&refresh_token=y",
          $user_id: "11111111-1111-4111-8111-111111111111",
          email: "reader@example.test",
          query: "tree bylaw",
        },
      },
      "/auth/callback",
    )!;
    expect(event.$set).toBeUndefined();
    expect(event.properties).toMatchObject({ query: "tree bylaw", $process_person_profile: false, $geoip_disable: true, $ip: null });
    expect(event.properties!.$current_url).toBe("https://openlangford.ca/auth/callback?next=%2Fsettings");
    expect(JSON.stringify(event)).not.toMatch(/reader@example|1111-4111|abc|access_token/);
  });

  it("drop admin pages, unsubscribe links and identify calls", () => {
    expect(anonymizeEvent({ event: "$pageview", properties: {} }, "/admin/contact")).toBeNull();
    expect(anonymizeEvent({ event: "$pageview", properties: { $current_url: "https://openlangford.ca/email/unsubscribe/abc" } }, "/")).toBeNull();
    expect(anonymizeEvent({ event: "$identify", properties: {} }, "/")).toBeNull();
  });

  it("keep search text in the page address", () => {
    expect(scrubUrl("https://openlangford.ca/search?q=skatepark+lights")).toBe("https://openlangford.ca/search?q=skatepark+lights");
  });
});
