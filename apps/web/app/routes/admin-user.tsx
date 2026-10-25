import type { Route } from "./+types/admin-user";
import { Link } from "react-router";
import {
  adminRead,
  adminReadOnlyAction,
  boundedPage,
  privateAdminHeaders,
  requireUuid,
} from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getAudienceUser } from "../services/audience-admin.server";
import {
  AdminAudienceLayout,
  AdminPagination,
  adminCard,
  adminDate,
  adminLink,
} from "../components/admin/audience-layout";

export const meta = () => [
  { title: "User details | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;
export const action = adminReadOnlyAction;
export async function loader({ request, params }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const id = requireUuid(params.id),
      page = boundedPage(new URL(request.url).searchParams.get("page"));
    return {
      ...(await getAudienceUser(getSupabaseAdminClient(), id, page)),
      page,
    };
  });
}
export default function AdminUser({ loaderData }: Route.ComponentProps) {
  const { user, preferences, subscriptions, subscriptionCount, page, hasMore } =
    loaderData;
  const details = [
    ["Account email", user.email || "No email"],
    [
      "Email confirmation",
      user.confirmedAt ? `Confirmed ${adminDate(user.confirmedAt)}` : "Pending",
    ],
    ["Joined", adminDate(user.createdAt)],
    [
      "Last sign-in",
      user.lastSignInAt ? adminDate(user.lastSignInAt) : "Never signed in",
    ],
    [
      "Onboarding",
      !user.hasProfile
        ? "No profile yet"
        : user.onboardingCompleted
          ? "Complete"
          : "Incomplete",
    ],
    [
      "Notification address",
      preferences?.notificationEmail || "Account email (default)",
    ],
    ["Neighbourhood", preferences?.neighborhood || "Not set"],
    [
      "Digest preference",
      preferences
        ? preferences.digestEnabled
          ? "Opted in"
          : "Off"
        : "Not set",
    ],
    [
      "Digest frequency",
      preferences?.digestFrequency === "weekly"
        ? "Weekly (saved preference; scheduling not verified)"
        : preferences
          ? "Each meeting"
          : "Not set",
    ],
  ];
  return (
    <AdminAudienceLayout
      title={user.name || "User details"}
      description="Read-only account and subscription details."
    >
      <div className="mb-5 flex flex-wrap gap-5 text-sm">
        <Link to="/admin/users" className={adminLink}>
          ← All users
        </Link>
        <Link to={`/admin/emails?user=${user.id}`} className={adminLink}>
          View application email activity →
        </Link>
      </div>
      {!user.hasProfile && (
        <p className="mb-5 rounded-xl border border-zinc-200 bg-white p-4 text-sm">
          This Auth account has no saved profile yet. It is still included in
          the user directory.
        </p>
      )}
      <section className={`${adminCard} mb-6`} aria-label="Account preferences">
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium text-zinc-500">{label}</dt>
              <dd className="mt-1 break-words text-sm text-zinc-900">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 text-xs text-zinc-500">
          Saved choices are not proof of delivery readiness. An account’s
          confirmed email does not verify a different notification address.
        </p>
      </section>
      <section className={adminCard}>
        <h2 className="text-lg font-bold">
          Active subscriptions{" "}
          <span className="font-normal text-zinc-500">
            ({subscriptionCount})
          </span>
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Current saved subscriptions only. Removed subscriptions are not
          retained as history.
        </p>
        <ul className="mt-4 divide-y divide-zinc-100">
          {subscriptions.map((sub) => (
            <li
              key={sub.id}
              className="flex flex-wrap justify-between gap-2 py-3 text-sm"
            >
              <div>
                <p className="font-medium">{sub.label}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {sub.type}
                  {sub.radius ? ` · ${sub.radius} m radius` : ""}
                </p>
              </div>
              <time className="text-xs text-zinc-500">
                {adminDate(sub.createdAt)}
              </time>
            </li>
          ))}
        </ul>
        {!subscriptions.length && (
          <p className="py-6 text-sm text-zinc-500">
            No active subscriptions on this page.
          </p>
        )}
        <AdminPagination
          page={page}
          hasMore={hasMore}
          label="Subscription pages"
        />
      </section>
    </AdminAudienceLayout>
  );
}
