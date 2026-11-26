import { data as routeData, Form, Link, useActionData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/forgot-password";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";

export const meta: Route.MetaFunction = () => [
  { title: "Reset your password | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function action({ request, context }: Route.ActionArgs) {
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) {
    return { error: "Please submit the form from this site." };
  }

  // Each request sends an email, so fail closed when the limiter is missing.
  const limiter = context.cloudflare?.env.SIGNUP_RATE_LIMITER;
  try {
    const key = `recover:${request.headers.get("CF-Connecting-IP") || "unknown"}`;
    if (!limiter || !(await limiter.limit({ key })).success) {
      return { error: "Too many attempts. Please try again in a minute." };
    }
  } catch {
    return { error: "Password reset is temporarily unavailable. Please try again later." };
  }

  let email = "";
  try {
    const value = (await request.formData()).get("email");
    email = typeof value === "string" ? value.trim() : "";
  } catch {
    return { error: "Please enter your email address." };
  }
  if (email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }

  const { supabase, headers } = createSupabaseServerClient(request);
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    // One fixed URL, no query string, so it matches the Redirect URLs allowlist exactly.
    redirectTo: `${url.origin}/auth/recovery`,
  });
  // Log provider failures, but answer the same either way so this form can't be
  // used to find out which emails have accounts.
  if (error) console.error("resetPasswordForEmail failed:", error.message);

  return routeData({ sent: true }, { headers });
}

export default function ForgotPassword() {
  const actionData = useActionData<{ sent?: boolean; error?: string }>();
  const submitting = useNavigation().state === "submitting";
  const expired = useSearchParams()[0].get("expired") === "1";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-md px-4 py-16">
        <div className="rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm sm:p-8">
          {actionData?.sent ? (
            <div role="status" className="space-y-3">
              <h1 className="text-2xl font-extrabold tracking-tight text-zinc-900">
                Check your email
              </h1>
              <p className="text-sm leading-relaxed text-zinc-600">
                If an account exists for that address, we sent a link to choose
                a new password. Open it in this same browser. The link expires
                after a while.
              </p>
              <p className="text-sm text-zinc-500">
                Nothing after a few minutes? Check your spam folder.
              </p>
              <Link
                to="/login"
                className="inline-block pt-2 text-sm font-semibold text-brand-700 hover:text-brand-800 hover:underline"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-6 space-y-2">
                <h1 className="text-2xl font-extrabold tracking-tight text-zinc-900">
                  Reset your password
                </h1>
                <p className="text-sm leading-relaxed text-zinc-600">
                  Enter your account email and we'll send you a link to choose a
                  new password.
                </p>
              </div>
              {expired && (
                <p role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  That reset link has expired or was already used. Request a new one below.
                </p>
              )}
              <Form method="post" className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="email" className="text-sm font-medium text-zinc-700">
                    Email
                  </label>
                  <Input
                    id="email"
                    type="email"
                    name="email"
                    autoComplete="email"
                    required
                    autoFocus
                    className="h-10 bg-surface"
                  />
                </div>
                {actionData?.error && (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700"
                  >
                    {actionData.error}
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={submitting}
                  className="h-10 w-full bg-brand-600 text-white hover:bg-brand-700"
                >
                  {submitting ? "Sending…" : "Send reset link"}
                </Button>
              </Form>
              <p className="mt-6 border-t border-zinc-100 pt-4 text-center text-sm text-zinc-500">
                <Link to="/login" className="font-semibold text-brand-700 hover:underline">
                  Back to sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
