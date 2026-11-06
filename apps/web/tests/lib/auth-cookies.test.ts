import { describe, expect, it } from "vitest";
import { appendCookies, collectAuthCookie, withAuthCookies } from "../../app/lib/auth-cookies.server";
import { loginReturnPath } from "../../app/lib/auth.server";

describe("withAuthCookies", () => {
  it("adds cookies set during the request to a response that dropped them", async () => {
    const res = await withAuthCookies(async () => {
      collectAuthCookie("sb-x-auth-token=new; Path=/; HttpOnly");
      return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
    });
    expect(res.headers.getSetCookie()).toEqual(["sb-x-auth-token=new; Path=/; HttpOnly"]);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("does not double up cookies a route already forwarded", async () => {
    const res = await withAuthCookies(async () => {
      collectAuthCookie("a=1; Path=/");
      collectAuthCookie("b=2; Path=/");
      return new Response(null, { status: 302, headers: { Location: "/login", "Set-Cookie": "a=1; Path=/" } });
    });
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("leaves a response alone when nothing was set", async () => {
    const original = new Response("hi");
    expect(await withAuthCookies(async () => original)).toBe(original);
    expect(appendCookies(original, [])).toBe(original);
  });

  it("ignores cookies set outside a request", () => {
    expect(() => collectAuthCookie("x=1")).not.toThrow();
  });
});

describe("loginReturnPath", () => {
  const req = (url: string, referer?: string) => new Request(url, { headers: referer ? { referer } : {} });
  it("returns a page to itself", () => {
    expect(loginReturnPath(req("https://openlangford.ca/admin/reviews?x=1"))).toBe("/admin/reviews?x=1");
  });
  it("returns the review bar's API request to the page it was about", () => {
    expect(loginReturnPath(req("https://openlangford.ca/api/page-review?path=%2Fmatters%2Fabc"))).toBe("/matters/abc");
  });
  it("falls back to the referring page, never to an API URL or another site", () => {
    expect(loginReturnPath(req("https://openlangford.ca/api/intel", "https://openlangford.ca/admin?tab=2"))).toBe("/admin?tab=2");
    expect(loginReturnPath(req("https://openlangford.ca/api/intel", "https://evil.example/x"))).toBe("/");
    expect(loginReturnPath(req("https://openlangford.ca/api/page-review?path=//evil.example"))).toBe("/");
    expect(loginReturnPath(req("https://openlangford.ca/api/intel"))).toBe("/");
  });
});
