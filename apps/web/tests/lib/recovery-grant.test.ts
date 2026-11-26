import { beforeAll, describe, expect, it } from "vitest";
import {
  clearRecoveryGrant,
  hasRecentRecovery,
  issueRecoveryGrant,
  readGrant,
  requireRecoveryGrant,
  signGrant,
} from "../../app/lib/recovery-grant.server";
import type { TypedSupabaseClient } from "../../app/lib/supabase";

const SECRET = "test-secret";
const now = Date.now();
const inAMinute = Math.floor(now / 1000) + 60;

beforeAll(() => {
  process.env.SUPABASE_SECRET_KEY = SECRET;
});

function fakeSupabase(claims: Record<string, unknown> | null) {
  return {
    auth: { getClaims: async () => ({ data: claims ? { claims } : null, error: null }) },
  } as unknown as TypedSupabaseClient;
}

function requestWith(cookie?: string) {
  return new Request("https://openlangford.ca/reset-password", {
    headers: cookie ? { Cookie: `other=1; ol_recovery=${cookie}` } : {},
  });
}

describe("recovery grant signing", () => {
  it("round-trips a signed grant", async () => {
    const grant = { uid: "u1", sid: "s1", exp: inAMinute };
    expect(await readGrant(await signGrant(grant, SECRET), SECRET, now)).toEqual(grant);
  });

  it("rejects a tampered payload, a wrong secret and an expired grant", async () => {
    const token = await signGrant({ uid: "u1", sid: "s1", exp: inAMinute }, SECRET);
    const [, sig] = token.split(".");
    const forged = `${btoa(JSON.stringify({ uid: "u2", sid: "s1", exp: inAMinute })).replace(/=+$/, "")}.${sig}`;
    expect(await readGrant(forged, SECRET, now)).toBeNull();
    expect(await readGrant(token, "other-secret", now)).toBeNull();
    expect(await readGrant(token, SECRET, (inAMinute + 1) * 1000)).toBeNull();
    expect(await readGrant("garbage", SECRET, now)).toBeNull();
  });
});

describe("hasRecentRecovery", () => {
  it("needs a recovery entry from the last 15 minutes", () => {
    const at = Math.floor(now / 1000);
    expect(hasRecentRecovery([{ method: "recovery", timestamp: at - 60 }], now)).toBe(true);
    expect(hasRecentRecovery([{ method: "recovery", timestamp: at - 16 * 60 }], now)).toBe(false);
    expect(hasRecentRecovery([{ method: "password", timestamp: at }], now)).toBe(false);
    expect(hasRecentRecovery(["recovery"], now)).toBe(false);
    expect(hasRecentRecovery(undefined, now)).toBe(false);
  });
});

describe("issuing and requiring a grant", () => {
  const at = Math.floor(Date.now() / 1000);

  it("is not issued for a plain password sign-in", async () => {
    const supabase = fakeSupabase({ sub: "u1", session_id: "s1", amr: [{ method: "password", timestamp: at }] });
    expect(await issueRecoveryGrant(supabase, requestWith(), "token")).toBeNull();
  });

  it("accepts the grant only for the same user and session", async () => {
    const recovered = fakeSupabase({ sub: "u1", session_id: "s1", amr: [{ method: "recovery", timestamp: at }] });
    const setCookie = await issueRecoveryGrant(recovered, requestWith(), "token");
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Path=\/reset-password/);
    const value = setCookie!.split(";")[0].split("=").slice(1).join("=");

    expect(await requireRecoveryGrant(recovered, requestWith(value))).toBe("u1");
    expect(await requireRecoveryGrant(fakeSupabase({ sub: "u1", session_id: "s2" }), requestWith(value))).toBeNull();
    expect(await requireRecoveryGrant(fakeSupabase({ sub: "u2", session_id: "s1" }), requestWith(value))).toBeNull();
    expect(await requireRecoveryGrant(fakeSupabase(null), requestWith(value))).toBeNull();
    expect(await requireRecoveryGrant(recovered, requestWith())).toBeNull();
  });

  it("clears the grant cookie", () => {
    expect(clearRecoveryGrant(requestWith())).toMatch(/^ol_recovery=; Path=\/reset-password; Max-Age=0/);
  });
});
