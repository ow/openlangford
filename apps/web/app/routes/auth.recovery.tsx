import { redirect } from "react-router";
import type { Session } from "@supabase/supabase-js";
import type { Route } from "./+types/auth.recovery";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { issueRecoveryGrant } from "../lib/recovery-grant.server";

/**
 * Landing page for the password-recovery email link, and nothing else: one
 * fixed URL (no query string of our own) so the Supabase Redirect URLs entry
 * matches exactly. Handles both the PKCE `code` (default; needs the browser
 * that asked for the email) and a `token_hash` link (if the email template is
 * switched to it). On success it issues the recovery grant that
 * `/reset-password` requires (lib/recovery-grant.server.ts).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  const { supabase, headers } = createSupabaseServerClient(request);

  let session: Session | null = null;
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) session = data.session;
  } else if (tokenHash && type === "recovery") {
    const { data, error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
    if (!error) session = data.session;
  }

  const grant = session ? await issueRecoveryGrant(supabase, request, session.access_token) : null;
  if (!grant) return redirect("/forgot-password?expired=1", { headers });

  headers.append("Set-Cookie", grant);
  return redirect("/reset-password", { headers });
}
