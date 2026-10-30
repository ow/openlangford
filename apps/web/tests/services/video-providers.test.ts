import { describe, expect, it } from "vitest";
import {
  VIDEO_PROVIDERS,
  detectVideoProvider,
  normalizeVideoProviderId,
  selectVideoProvider,
} from "~/services/video/catalog";

const ISI = "https://pub-langford.escribemeetings.com/Players/ISIStandAlonePlayer.aspx?Id=abc";
const VIMEO = "https://vimeo.com/123456";

describe("video provider selection", () => {
  it("reads the pipeline's setting names", () => {
    expect(normalizeVideoProviderId("isilive")).toBe("escribe-isi");
    expect(normalizeVideoProviderId("escribe-isi")).toBe("escribe-isi");
    expect(normalizeVideoProviderId("Vimeo")).toBe("vimeo");
    expect(normalizeVideoProviderId("youtube")).toBeNull();
    expect(normalizeVideoProviderId(undefined)).toBeNull();
  });

  it("detects the provider from the URL host", () => {
    expect(detectVideoProvider(ISI)?.id).toBe("escribe-isi");
    expect(detectVideoProvider(VIMEO)?.id).toBe("vimeo");
    expect(detectVideoProvider("https://player.vimeo.com/video/1")?.id).toBe("vimeo");
    expect(detectVideoProvider("https://evil.tld/vimeo.com/1")).toBeNull();
    expect(detectVideoProvider("http://vimeo.com/1")).toBeNull();
  });

  it("prefers the configured provider but falls back to the URL host", () => {
    expect(selectVideoProvider(ISI, "escribe-isi")?.id).toBe("escribe-isi");
    // An older Vimeo link in an eSCRIBE town still goes to Vimeo.
    expect(selectVideoProvider(VIMEO, "escribe-isi")?.id).toBe("vimeo");
    expect(selectVideoProvider("https://evil.tld/x", "vimeo")).toBeNull();
    expect(selectVideoProvider(null, "vimeo")).toBeNull();
  });
});

describe("provider details", () => {
  it("labels and deep links", () => {
    expect(VIDEO_PROVIDERS["escribe-isi"].label).toBe("Official video");
    expect(VIDEO_PROVIDERS.vimeo.label).toBe("Vimeo");
    expect(VIDEO_PROVIDERS.vimeo.deepLink(VIMEO, 125.7)).toBe(`${VIMEO}#t=125s`);
    expect(VIDEO_PROVIDERS.vimeo.deepLink(VIMEO, 0)).toBe(VIMEO);
    // The eSCRIBE player has no start-time parameter.
    expect(VIDEO_PROVIDERS["escribe-isi"].deepLink(ISI, 125)).toBe(ISI);
  });

  it("Vimeo proxy URLs come from the Vimeo provider's settings (https only); none for Langford's build", async () => {
    const { vimeoProxyConfig } = await import("~/services/video/vimeo.server");
    expect(vimeoProxyConfig({ type: "vimeo", proxy_url: "https://proxy.example/", proxy_fallback_url: "http://x" })).toEqual({
      url: "https://proxy.example",
      fallbackUrl: null,
    });
    expect(vimeoProxyConfig(null)).toEqual({ url: null, fallbackUrl: null });
  });

  it("privacy wording", () => {
    expect(VIDEO_PROVIDERS.vimeo.privacy("Town of View Royal")).toEqual({ weUse: "Vimeo for video hosting", note: null });
    expect(VIDEO_PROVIDERS["escribe-isi"].privacy("City of Langford")).toEqual({
      weUse: null,
      note: "Meeting video is hosted by the City of Langford's meeting video provider, eSCRIBE.",
    });
  });
});
