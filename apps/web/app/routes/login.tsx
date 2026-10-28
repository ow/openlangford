import { safeRedirect } from "../lib/safe-redirect";
import { pageMeta } from "../lib/page-meta";
import { Form, Link, redirect, useActionData } from "react-router";
import type { Route } from "./+types/login";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { useSiteFlags } from "../lib/use-site-flags";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";

export const meta: Route.MetaFunction = () => [
  ...pageMeta("Log in", "Log in to your Open Langford account.", "/login"),
  { name: "robots", content: "noindex, follow" },
];

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const url = new URL(request.url);
  const redirectTo = safeRedirect(url.searchParams.get("redirectTo"), "/");

  // Create client that handles cookies
  const { supabase, headers } = createSupabaseServerClient(request);

  // Sign in
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return {
      error: error.message,
      hint:
        error.message === "Invalid login credentials"
          ? "Check your email and password. If you just signed up, open the confirmation link we emailed you first."
          : null,
    };
  }

  // Redirect on success with Set-Cookie headers
  return redirect(redirectTo, { headers });
}

const fieldClass = "h-10 bg-surface";
const labelClass = "text-sm font-medium text-zinc-700";

export default function Login() {
  const actionData = useActionData<typeof action>();
  const { signupsEnabled } = useSiteFlags();

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-md px-4 py-16">
        <div className="rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm sm:p-8">
          <div className="mb-6 space-y-2">
            <h1 className="text-2xl font-extrabold tracking-tight text-zinc-900">
              Sign in
            </h1>
            <p className="text-sm leading-relaxed text-zinc-600">
              {signupsEnabled
                ? "Manage your council alerts, followed matters and meeting digests."
                : "Sign in with your existing account."}
            </p>
          </div>

          <Form method="post" className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="email" className={labelClass}>
                Email
              </label>
              <Input
                id="email"
                type="email"
                name="email"
                autoComplete="email"
                required
                autoFocus
                aria-invalid={actionData?.error ? true : undefined}
                className={fieldClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className={labelClass}>
                Password
              </label>
              <Input
                id="password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                aria-invalid={actionData?.error ? true : undefined}
                className={fieldClass}
              />
            </div>

            {actionData?.error && (
              <div
                role="alert"
                className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
              >
                <p className="font-medium">{actionData.error}</p>
                {actionData.hint && (
                  <p className="text-red-600">{actionData.hint}</p>
                )}
              </div>
            )}

            <Button
              type="submit"
              className="h-10 w-full bg-brand-600 text-white hover:bg-brand-700"
            >
              Sign in
            </Button>
          </Form>

          {signupsEnabled && (
          <p className="mt-6 border-t border-zinc-100 pt-4 text-center text-sm text-zinc-500">
            New here?{" "}
            <Link
              to="/signup"
              className="font-semibold text-brand-700 hover:text-brand-800 hover:underline"
            >
              Create an account
            </Link>{" "}
            to get council alerts.
          </p>
          )}
        </div>
      </div>
    </div>
  );
}
