import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as vimeoLoader, isAllowedEscribeUrl } from "~/routes/api.vimeo-url";
import { action as failureAction } from "~/routes/api.report-video-failure";

const mocks = vi.hoisted(() => ({ adminClient: vi.fn(), vimeo: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: () => ({ supabase: {}, headers: new Headers() }),
  getSupabaseAdminClient: mocks.adminClient,
}));
vi.mock("~/services/vimeo.server", () => ({
  getVimeoVideoData: mocks.vimeo,
  clearVimeoCache: vi.fn(),
}));
vi.mock("~/services/municipality", () => ({ getMunicipality: async () => ({ website_url: null }) }));

let ipCounter = 0;
const freshIp = () => `10.0.0.${++ipCounter}`;

const vimeoReq = (videoUrl: string, ip = freshIp()) =>
  vimeoLoader({
    request: new Request(`https://openlangford.ca/api/vimeo-url?video_url=${encodeURIComponent(videoUrl)}`, {
      headers: { "cf-connecting-ip": ip },
    }),
  }) as Promise<Response>;

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

beforeEach(() => {
  vi.clearAllMocks();
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

describe("/api/vimeo-url", () => {
  it.each([
    "https://escribemeetings.com.evil.tld/Players/ISIStandAlonePlayer.aspx",
    "http://pub-langford.escribemeetings.com/Players/ISIStandAlonePlayer.aspx",
    "http://vimeo.com/123",
    "https://evil.tld/",
    "https://169.254.169.254/latest/meta-data",
    "not a url",
  ])("returns 400 for %s without fetching", async (u) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await vimeoReq(u);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.vimeo).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("passes an https Vimeo URL through to the resolver", async () => {
    mocks.vimeo.mockResolvedValue({ direct_url: "https://cdn/x.mp4", direct_audio_url: null });
    const res = await vimeoReq("https://vimeo.com/123");
    expect(res.status).toBe(200);
    expect(mocks.vimeo).toHaveBeenCalled();
  });

  it("rate limits per IP", async () => {
    mocks.vimeo.mockResolvedValue(null);
    const ip = freshIp();
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await vimeoReq("https://vimeo.com/1", ip)).status;
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

  it("returns 404 for a meeting that does not exist and writes nothing", async () => {
    const update = vi.fn();
    mocks.adminClient.mockImplementation(() => ({
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: { message: "none" } }) }) }),
        update,
      }),
    }));
    expect(status(await failureReq("999999"))).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it("rate limits per IP", async () => {
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push(status(await failureReq("abc", ip)));
    expect(codes.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(codes[6]).toBe(429);
  });
});
