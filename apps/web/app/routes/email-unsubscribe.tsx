import { Form, useActionData, data as routeData } from "react-router";
import type { Route } from "./+types/email-unsubscribe";
import { getSupabaseAdminClient } from "../lib/supabase.server";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const headers = () => ({
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
});
export const meta = () => [
  { title: "Unsubscribe | Open Langford" },
  { name: "referrer", content: "no-referrer" },
];
// GET never changes preferences: mail scanners can safely follow the link.
export function loader({ params }: Route.LoaderArgs) {
  if (!uuid.test(params.token ?? ""))
    throw new Response("Invalid link", { status: 400, headers: headers() });
  return routeData(null, { headers: headers() });
}
export async function action({ params, request }: Route.ActionArgs) {
  if (request.method !== "POST")
    throw new Response("POST required", {
      status: 405,
      headers: { ...headers(), Allow: "POST" },
    });
  if (!uuid.test(params.token ?? ""))
    throw new Response("Invalid link", { status: 400, headers: headers() });
  const { data, error } = await getSupabaseAdminClient().rpc(
    "unsubscribe_email_alerts",
    { p_token: params.token },
  );
  if (error)
    throw new Response("Unable to save unsubscribe. Please try again.", {
      status: 503,
      headers: headers(),
    });
  if (
    request.headers
      .get("content-type")
      ?.includes("application/x-www-form-urlencoded")
  ) {
    const body = await request.text();
    if (body === "List-Unsubscribe=One-Click")
      return new Response(null, { status: 200, headers: headers() });
  }
  return routeData({ unsubscribed: data === true }, { headers: headers() });
}
export default function Unsubscribe() {
  const result = useActionData<typeof action>();
  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <h1 className="text-2xl font-bold">
        {result
          ? result.unsubscribed
            ? "You are unsubscribed"
            : "This link is no longer available"
          : "Unsubscribe from council alerts"}
      </h1>
      <p className="my-5 text-sm text-zinc-600">
        {result
          ? result.unsubscribed
            ? "No further application alert emails will be sent to this address. Account confirmation and password-reset emails are separate."
            : "Sign in to Settings to manage your email preferences."
          : "Stop all Open Langford council alert emails sent using this link. This does not change your account or saved interests."}
      </p>
      {!result && (
        <Form method="post">
          <button className="rounded-lg bg-brand-700 px-5 py-3 font-semibold text-white">
            Unsubscribe from all alerts
          </button>
        </Form>
      )}
    </main>
  );
}
