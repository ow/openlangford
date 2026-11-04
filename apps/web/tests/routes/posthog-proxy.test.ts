import { describe, expect, it, vi } from "vitest";
import { posthogProxy, posthogTarget } from "../../workers/posthog-proxy";

const target = (path: string) => posthogTarget(new URL(`https://openlangford.ca${path}`))?.toString() ?? null;

describe("PostHog relay", () => {
  it("sends events to PostHog and scripts to its asset host, keeping the path and query", () => {
    expect(target("/relay/e/?ip=0&ver=1")).toBe("https://us.i.posthog.com/e/?ip=0&ver=1");
    expect(target("/relay/flags/?v=2")).toBe("https://us.i.posthog.com/flags/?v=2");
    expect(target("/relay/static/array.js")).toBe("https://us-assets.i.posthog.com/static/array.js");
  });
  it("leaves the rest of the site alone", () => {
    expect(target("/relayed-page")).toBeNull();
    expect(target("/meetings")).toBeNull();
  });
  it("never passes on the site's cookies or the visitor's IP, and drops cookies PostHog sets", async () => {
    const send = vi.fn(async () => new Response("ok", { headers: { "set-cookie": "x=1", "content-type": "text/plain" } }));
    const request = new Request("https://openlangford.ca/relay/e/", {
      method: "POST", body: "{}",
      headers: { cookie: "sb-access-token=secret", "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "1.2.3.4", "content-type": "application/json", "user-agent": "test" },
    });
    const response = await posthogProxy(request, new URL(request.url), send as any);
    const [, init] = send.mock.calls[0] as any;
    const sent = init.headers as Headers;
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("cf-connecting-ip")).toBeNull();
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(sent.get("content-type")).toBe("application/json");
    expect(response?.headers.get("set-cookie")).toBeNull();
    expect(await response?.text()).toBe("ok");
  });
});
