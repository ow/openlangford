import type { TypedSupabaseClient } from "./supabase";

/**
 * A password-recovery grant: proof that this browser's current session came
 * through a recovery link, for this user, recently. `/auth/recovery` mints it
 * after the link is verified; `/reset-password` requires it and clears it once
 * the password is changed. A plain sign-in session (or someone else's cookie)
 * can't change the password through that page.
 *
 * The cookie holds `<payload>.<hmac>`, where the payload names the user id, the
 * Supabase session id and an expiry, signed with a server-only secret.
 */
export const RECOVERY_GRANT_COOKIE = "ol_recovery";
export const RECOVERY_GRANT_TTL_SECONDS = 15 * 60;

type Grant = { uid: string; sid: string; exp: number };
type Claims = { sub: string; session_id: string; amr?: unknown };

const encoder = new TextEncoder();

function grantSecret(): string {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("Missing SUPABASE_SECRET_KEY for recovery grants");
  return secret;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string) {
  // Domain-separated so this key can't be confused with any other use of the secret.
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`openlangford:recovery-grant:v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signGrant(grant: Grant, secret = grantSecret()): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(grant)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(sig))}`;
}

/** The grant if the value is well formed, correctly signed and unexpired; otherwise null. */
export async function readGrant(value: string | undefined, secret = grantSecret(), now = Date.now()): Promise<Grant | null> {
  if (!value) return null;
  const [payload, sig, extra] = value.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromBase64url(sig),
      encoder.encode(payload),
    );
    if (!ok) return null;
    const grant = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Grant;
    if (typeof grant.uid !== "string" || typeof grant.sid !== "string" || typeof grant.exp !== "number") return null;
    if (grant.exp * 1000 <= now) return null;
    return grant;
  } catch {
    return null;
  }
}

/** True when the token's methods include a recovery sign-in no older than the grant lifetime. */
export function hasRecentRecovery(amr: unknown, now = Date.now()): boolean {
  if (!Array.isArray(amr)) return false;
  return amr.some(
    (entry) =>
      entry && typeof entry === "object" &&
      (entry as { method?: unknown }).method === "recovery" &&
      typeof (entry as { timestamp?: unknown }).timestamp === "number" &&
      now - (entry as { timestamp: number }).timestamp * 1000 <= RECOVERY_GRANT_TTL_SECONDS * 1000,
  );
}

/** Verified claims of the given token (default: the session in the request's cookies), or null. */
async function sessionClaims(supabase: TypedSupabaseClient, accessToken?: string): Promise<Claims | null> {
  const { data, error } = await supabase.auth.getClaims(accessToken);
  const claims = data?.claims as Partial<Claims> | undefined;
  if (error || !claims?.sub || !claims.session_id) return null;
  return claims as Claims;
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function cookieHeader(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${RECOVERY_GRANT_COOKIE}=${value}; Path=/reset-password; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * Called right after a recovery link is verified: mints a grant for the new
 * session, but only if its token says it came from a recent recovery.
 * Returns the Set-Cookie header, or null when the session doesn't qualify.
 */
export async function issueRecoveryGrant(
  supabase: TypedSupabaseClient,
  request: Request,
  accessToken: string,
): Promise<string | null> {
  const claims = await sessionClaims(supabase, accessToken);
  if (!claims || !hasRecentRecovery(claims.amr)) return null;
  const exp = Math.floor(Date.now() / 1000) + RECOVERY_GRANT_TTL_SECONDS;
  const value = await signGrant({ uid: claims.sub, sid: claims.session_id, exp });
  return cookieHeader(request, value, RECOVERY_GRANT_TTL_SECONDS);
}

/** The signed-in user id if the request carries a valid grant for its own user and session; otherwise null. */
export async function requireRecoveryGrant(supabase: TypedSupabaseClient, request: Request): Promise<string | null> {
  const grant = await readGrant(readCookie(request, RECOVERY_GRANT_COOKIE));
  if (!grant) return null;
  const claims = await sessionClaims(supabase);
  if (!claims || claims.sub !== grant.uid || claims.session_id !== grant.sid) return null;
  return claims.sub;
}

/** Set-Cookie header that removes the grant. */
export function clearRecoveryGrant(request: Request): string {
  return cookieHeader(request, "", 0);
}
