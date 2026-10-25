import {
  data as routeData, Form, Link, redirect,
  useActionData, useLoaderData, useNavigation,
} from "react-router";
import { EmailAlertsNotice } from "../components/email-alerts-notice";
import { useSiteFlags } from "../lib/use-site-flags";
import type { Route } from "./+types/signup";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { safeRedirect } from "../lib/safe-redirect";
import { signupsEnabled } from "../lib/features.server";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";

export const meta: Route.MetaFunction = () => [
  { title: "Create an account | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader(_: Route.LoaderArgs) {
  return { signupsEnabled: signupsEnabled() };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (!signupsEnabled()) {
    return { error: "Sign-ups are closed for now." };
  }

  const url = new URL(request.url);
  // Browser forms send Origin. Reject cross-site and opaque origins before auth work.
  if (request.headers.get("Origin") !== url.origin) {
    return { error: "Please submit the form from this site." };
  }

  // Cloudflare supplies this IP header. Do not trust a client-provided forwarded-for.
  // Fail closed if the binding is missing/unavailable; never fall back to unbounded signup.
  const limiter = context.cloudflare?.env.SIGNUP_RATE_LIMITER;
  try {
    const key = `signup:${request.headers.get("CF-Connecting-IP") || "unknown"}`;
    if (!limiter || !(await limiter.limit({ key })).success) {
      return { error: "Too many signup attempts. Please try again in a minute." };
    }
  } catch {
    return { error: "Signup is temporarily unavailable. Please try again later." };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { error: "Please submit a valid signup form." };
  }
  const field = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  if (field("website").trim()) return { error: "Unable to create account." };
  const email = field("email").trim();
  const password = field("password");
  const displayName = field("displayName").trim();
  if (
    email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
    password.length < 6 || password.length > 1024 || displayName.length > 200
  ) {
    return { error: "Enter a valid email, a password of at least 6 characters, and a name under 200 characters." };
  }
  const redirectTo = safeRedirect(url.searchParams.get("redirectTo"), "/onboarding");

  const { supabase, headers } = createSupabaseServerClient(request);

  // Sign up
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
    },
  });

  if (error) {
    return { error: error.message };
  }

  // Only an authenticated session can create its profile under existing RLS.
  if (data.user && data.session) {
    const { error: profileError } = await supabase
      .from("user_profiles")
      .insert({
        id: data.user.id,
        display_name: displayName || null,
        notification_email: email,
      });

    if (profileError) {
      console.error("Error creating user profile:", profileError);
    }
  }

  // If email confirmation is required, tell the user
  if (data.user && !data.session) {
    return routeData({ success: true, confirmEmail: true }, { headers });
  }

  return redirect(redirectTo, { headers });
}

const fieldClass = "h-10 bg-white";
const labelClass = "text-sm font-medium text-zinc-700";

export default function Signup() {
  const { signupsEnabled } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { emailAlertsAvailable: alertsAvailable } = useSiteFlags();
  const submitting = useNavigation().state === "submitting";
  const error =
    actionData && "error" in actionData ? actionData.error : null;

  if (actionData && "success" in actionData && actionData.confirmEmail) {
    return (
      <div className="min-h-screen bg-zinc-50">
        <div className="container mx-auto max-w-md px-4 py-16">
          <div
            role="status"
            className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8"
          >
            <h1 className="text-2xl font-extrabold tracking-tight text-zinc-900">
              Check your email
            </h1>
            <p className="text-sm leading-relaxed text-zinc-600">
              We sent you a confirmation link. Open it to activate your account,
              then sign in to save your preferences.
            </p>
            <p className="text-sm text-zinc-500">
              Nothing arrived after a few minutes? Check your spam folder.
            </p>
            <div className="pt-2">
              <Link
                to="/login?redirectTo=%2Fonboarding"
                className="text-sm font-semibold text-brand-700 hover:text-brand-800 hover:underline"
              >
                Go to sign in
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!signupsEnabled) {
    return (
      <div className="min-h-screen bg-zinc-50">
        <div className="container mx-auto max-w-md px-4 py-16">
          <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
            <h1 className="text-2xl font-extrabold tracking-tight text-zinc-900">
              Sign-ups are closed for now
            </h1>
            <p className="text-sm leading-relaxed text-zinc-600">
              We're not creating new accounts at the moment, so email alerts
              aren't available yet. Everything else is open to everyone, no
              account needed: browse meetings, read up on matters and search what
              council has discussed.
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2 pt-2 text-sm">
              <Link
                to="/meetings"
                className="font-semibold text-brand-700 hover:text-brand-800 hover:underline"
              >
                Browse meetings
              </Link>
              <Link
                to="/login"
                className="font-medium text-zinc-500 hover:text-zinc-800 hover:underline"
              >
                Already have an account? Sign in
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-md px-4 py-16">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6 space-y-2">
            <h1 className="text-2xl font-extrabold tracking-tight text-zinc-900">
              Create an account
            </h1>
            <p className="text-sm leading-relaxed text-zinc-600">
              Save the council topics, matters and places you care about.
              You choose what to follow, and you can change it any time.
            </p>
          </div>

          {!alertsAvailable && <div className="mb-6"><EmailAlertsNotice /></div>}

          <Form method="post" className="space-y-4">
            <div aria-hidden="true" className="absolute -left-[9999px]">
              <label htmlFor="website">Website</label>
              <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="displayName" className={labelClass}>
                Name <span className="font-normal text-zinc-400">(optional)</span>
              </label>
              <Input
                id="displayName"
                type="text"
                name="displayName"
                autoComplete="name"
                maxLength={200}
                className={fieldClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="email" className={labelClass}>
                Email
              </label>
              <Input
                id="email"
                type="email"
                name="email"
                autoComplete="email"
                maxLength={320}
                required
                autoFocus
                aria-invalid={error ? true : undefined}
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
                autoComplete="new-password"
                required
                minLength={6}
                maxLength={1024}
                aria-describedby="password-hint"
                className={fieldClass}
              />
              <p id="password-hint" className="text-xs text-zinc-500">
                At least 6 characters.
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={submitting}
              className="h-10 w-full bg-brand-600 text-white hover:bg-brand-700"
            >
              Create account
            </Button>
          </Form>

          <p className="mt-6 border-t border-zinc-100 pt-4 text-center text-sm text-zinc-500">
            Already have an account?{" "}
            <Link
              to="/login"
              className="font-semibold text-brand-700 hover:text-brand-800 hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
        <p className="mt-4 text-center text-xs text-zinc-500">
          Your email is used for account confirmation. Alert delivery is separate.
        </p>
      </div>
    </div>
  );
}
