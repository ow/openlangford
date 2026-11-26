import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/reset-password";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { clearRecoveryGrant, requireRecoveryGrant } from "../lib/recovery-grant.server";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";

export const meta: Route.MetaFunction = () => [
  { title: "Choose a new password | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];

// Being signed in isn't enough: the session must have come through a recovery
// link, which leaves a grant tied to this user and session (auth.recovery.tsx).
export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  if (!(await requireRecoveryGrant(supabase, request))) {
    return redirect("/forgot-password?expired=1", { headers });
  }
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) {
    return { error: "Please submit the form from this site." };
  }
  const form = await request.formData();
  const password = typeof form.get("password") === "string" ? (form.get("password") as string) : "";
  const confirm = typeof form.get("confirm") === "string" ? (form.get("confirm") as string) : "";
  if (password.length < 6 || password.length > 1024) {
    return { error: "Choose a password of at least 6 characters." };
  }
  if (password !== confirm) return { error: "The two passwords don't match." };

  const { supabase, headers } = createSupabaseServerClient(request);
  if (!(await requireRecoveryGrant(supabase, request))) {
    return redirect("/forgot-password?expired=1", { headers });
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };

  // One use: the grant goes as soon as the password has changed.
  headers.append("Set-Cookie", clearRecoveryGrant(request));
  return redirect("/settings", { headers });
}

export default function ResetPassword() {
  const actionData = useActionData<typeof action>();
  const submitting = useNavigation().state === "submitting";
  const error = actionData && "error" in actionData ? actionData.error : null;
  const labelClass = "text-sm font-medium text-zinc-700";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-md px-4 py-16">
        <div className="rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm sm:p-8">
          <div className="mb-6 space-y-2">
            <h1 className="text-2xl font-extrabold tracking-tight text-zinc-900">
              Choose a new password
            </h1>
            <p className="text-sm leading-relaxed text-zinc-600">
              Use at least 6 characters.
            </p>
          </div>
          <Form method="post" className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="password" className={labelClass}>New password</label>
              <Input id="password" type="password" name="password" autoComplete="new-password"
                required minLength={6} autoFocus className="h-10 bg-surface" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="confirm" className={labelClass}>Confirm new password</label>
              <Input id="confirm" type="password" name="confirm" autoComplete="new-password"
                required minLength={6} className="h-10 bg-surface" />
            </div>
            {error && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
                {error}
              </p>
            )}
            <Button type="submit" disabled={submitting}
              className="h-10 w-full bg-brand-600 text-white hover:bg-brand-700">
              {submitting ? "Saving…" : "Save new password"}
            </Button>
          </Form>
          <p className="mt-6 border-t border-zinc-100 pt-4 text-center text-sm text-zinc-500">
            <Link to="/login" className="font-semibold text-brand-700 hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
