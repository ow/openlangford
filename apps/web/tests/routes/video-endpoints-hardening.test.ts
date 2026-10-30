import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as vimeoLoader, isAllowedEscribeUrl } from "~/routes/api.vimeo-url";
import { loader as videoSourceLoader } from "~/routes/api.video-source";
import { action as failureAction } from "~/routes/api.report-video-failure";

const mocks = vi.hoisted(() => ({ adminClient: vi.fn(), vimeo: vi.fn(), vimeoRpcResult: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: () => ({ supabase: {}, headers: new Headers() }),
  getSupabaseAdminClient: mocks.adminClient,
}));
// The real Vimeo provider, with its network lookup replaced.
vi.mock("~/services/video/vimeo.server", async () => {
  const { vimeoInfo } = await vi.importActual<typeof import("~/services/video/catalog")>("~/services/video/catalog");
  return {
    vimeoProvider: {
      ...vimeoInfo,
      resolveSource: async (url: string, ctx: unknown) => {
        const data = await mocks.vimeo(url, ctx);
        return data?.direct_url ? { url: data.direct_url, audioUrl: null, kind: "mp4", expiresAt: null } : null;
      },
      invalidate: async (meetingId: number) => {
        const { data, error } = await mocks
          .adminClient()
          .rpc("invalidate_meeting_vimeo_cache", { p_meeting_id: meetingId });
        if (error) throw error;
        return Boolean(data?.length);
      },
    },
  };
});
vi.mock("~/services/municipality", () => ({ getMunicipality: async () => ({ website_url: null }) }));

let ipCounter = 0;
const freshIp = () => `10.0.0.${++ipCounter}`;

const videoReq = (loader: typeof vimeoLoader, path: string, videoUrl: string, ip = freshIp()) =>
  loader({
    request: new Request(`https://openlangford.ca${path}?video_url=${encodeURIComponent(videoUrl)}`, {
      headers: { "cf-connecting-ip": ip },
    }),
  }) as Promise<Response>;
const vimeoReq = (videoUrl: string, ip?: string) => videoReq(vimeoLoader, "/api/vimeo-url", videoUrl, ip);
const sourceReq = (videoUrl: string, ip?: string) => videoReq(videoSourceLoader, "/api/video-source", videoUrl, ip);

const failureReq = (meetingId: string | null, ip = freshIp()) =>
  failureAction({
    request: new Request("https://openlangford.ca/api/report-video-failure", {
      method: "POST",
      headers: { "cf-connecting-ip": ip },
      body: new URLSearchParams(meetingId === null ? {} : { meetingId }),
    }),
    params: {},
    context: {},
  } as any) as Promise<any>;

const status = (r: any) => r?.init?.status ?? r?.status;

/** Admin client stub: meetings lookup returns `meeting`, municipalities returns no provider setting. */
function adminWith(meeting: { video_url: string | null } | null, rpcResult: { data: unknown; error: unknown } = { data: [{ video_url: "x" }], error: null }) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const from = vi.fn((table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: table === "meetings" ? meeting : null, error: null }),
    };
    return q;
  });
  const client = { rpc, from };
  mocks.adminClient.mockImplementation(() => client);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mocks.adminClient.mockImplementation(() => {
    throw new Error("Unexpected privileged database access");
  });
});

describe("isAllowedEscribeUrl", () => {
  it.each([
    "https://escribemeetings.com/x",
    "https://pub-langford.escribemeetings.com/Players/ISIStandAlonePlayer.aspx?Id=1",
  ])("accepts %s", (u) => expect(isAllowedEscribeUrl(u)).toBe(true));

  it.each([
    "https://escribemeetings.com.evil.tld/Players/ISIStandAlonePlayer.aspx",
    "https://evilescribemeetings.com/x",
    "http://pub-langford.escribemeetings.com/x",
    "https://evil.tld/?u=escribemeetings.com",
    "https://user@evil.tld/escribemeetings.com",
    "not a url",
  ])("rejects %s", (u) => expect(isAllowedEscribeUrl(u)).toBe(false));
});

describe.each([
  ["/api/vimeo-url", vimeoReq],
  ["/api/video-source", sourceReq],
])("%s", (_path, req) => {
  it.each([
    "https://escribemeetings.com.evil.tld/Players/ISIStandAlonePlayer.aspx",
    "http://pub-langford.escribemeetings.com/Players/ISIStandAlonePlayer.aspx",
    "http://vimeo.com/123",
    "https://evil.tld/",
    "https://169.254.169.254/latest/meta-data",
    "not a url",
  ])("returns 400 for %s without fetching", async (u) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await req(u);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.vimeo).not.toHaveBeenCalled();
  });

  it("passes an https Vimeo URL through to the Vimeo provider", async () => {
    mocks.vimeo.mockResolvedValue({ direct_url: "https://cdn/x.mp4", direct_audio_url: null });
    const res = await req("https://vimeo.com/123");
    expect(res.status).toBe(200);
    expect(mocks.vimeo).toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ provider: "vimeo", direct_url: "https://cdn/x.mp4", direct_audio_url: null });
  });

  it("resolves an eSCRIBE ISI player page to the isilive mp4 without touching Vimeo", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('<div id="isi_player" data-client_id="langford" data-file_name="Council_2026-01-05.mp4"></div>'),
    );
    const page = `https://pub-langford.escribemeetings.com/Players/ISIStandAlonePlayer.aspx?Id=${Math.random()}`;
    const res = await req(page);
    expect(await res.json()).toEqual({
      provider: "escribe-isi",
      direct_url: "https://video.isilive.ca/langford/Council_2026-01-05.mp4",
      direct_audio_url: null,
      kind: "mp4",
      expires_at: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the eSCRIBE page only: never the Vimeo proxy
    expect(fetchSpy).toHaveBeenCalledWith(page, expect.anything());
    expect(mocks.vimeo).not.toHaveBeenCalled();
  });

  it("rate limits per IP", async () => {
    mocks.vimeo.mockResolvedValue(null);
    const ip = freshIp();
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await req("https://vimeo.com/1", ip)).status;
    expect(last).toBe(429);
  });
});

describe("/api/report-video-failure", () => {
  it.each(["abc", "-1", "0", "1.5", "1e3", "12345678901", " 5", "1 OR 1=1"])(
    "rejects malformed meetingId %j before touching the database",
    async (id) => {
      const res = await failureReq(id);
      expect(status(res)).toBe(400);
      expect(mocks.adminClient).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing meetingId", async () => {
    expect(status(await failureReq(null))).toBe(400);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it("returns 404 for a meeting that does not exist", async () => {
    const client = adminWith(null);
    expect(status(await failureReq("999999"))).toBe(404);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("clears Vimeo's cached URLs in one atomic call for a Vimeo meeting", async () => {
    const client = adminWith({ video_url: "https://vimeo.com/1" });
    const res = await failureReq("42");
    expect(res.data).toEqual({ success: true });
    expect(client.rpc).toHaveBeenCalledWith("invalidate_meeting_vimeo_cache", { p_meeting_id: 42 });
  });

  it("does not touch Vimeo's cache for an eSCRIBE meeting", async () => {
    const client = adminWith({
      video_url: "https://pub-langford.escribemeetings.com/Players/ISIStandAlonePlayer.aspx?Id=1",
    });
    const res = await failureReq("43");
    expect(res.data).toEqual({ success: true });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("returns a generic 500 when the database call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    adminWith({ video_url: "https://vimeo.com/1" }, { data: null, error: { message: "x" } });
    expect(status(await failureReq("42"))).toBe(500);
  });

  it("rate limits per IP", async () => {
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push(status(await failureReq("abc", ip)));
    expect(codes.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(codes[6]).toBe(429);
  });
});
