import type { StaffRole } from "./auth.server";

/** "jane.doe@example.com" → "jan…@example.com": enough for a moderator to tell accounts apart, not the address.
 * Never shows the whole part before the @, even when it's three characters or fewer. */
export function redactEmail(email: string | null | undefined): string | null {
  if (!email) return email ?? null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return "…";
  const local = email.slice(0, at);
  return `${local.slice(0, Math.min(3, local.length - 1))}…${email.slice(at)}`;
}

/** Admins see account addresses; moderators see them redacted. */
export function accountEmailFor(role: StaffRole) {
  return role === "admin" ? (email: string | null | undefined) => email ?? null : redactEmail;
}
