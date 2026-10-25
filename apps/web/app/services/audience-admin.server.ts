import type { SupabaseClient, User } from "@supabase/supabase-js";

export const AUDIENCE_PAGE_SIZE = 25;
const profileColumns =
  "id, display_name, notification_email, neighborhood, digest_enabled, digest_frequency, onboarding_completed";

function account(user: User, profile: any) {
  return {
    id: user.id,
    email: user.email ?? null,
    name:
      typeof profile?.display_name === "string"
        ? profile.display_name.slice(0, 200)
        : typeof user.user_metadata?.display_name === "string"
          ? user.user_metadata.display_name.slice(0, 200)
          : null,
    confirmedAt: user.email_confirmed_at ?? null,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
    onboardingCompleted: profile?.onboarding_completed ?? false,
    hasProfile: Boolean(profile),
  };
}

export async function getAudiencePage(
  client: SupabaseClient,
  page: number,
  query: string,
) {
  // Auth is canonical: confirmation-pending accounts may not have a profile yet.
  const { data, error } = await client.auth.admin.listUsers({
    page,
    perPage: AUDIENCE_PAGE_SIZE,
  });
  if (error) throw error;
  const ids = data.users.map((user) => user.id);
  if (!ids.length)
    return { users: [], hasMore: false, total: data.total ?? null };
  const { data: profiles, error: profileError } = await client
    .from("user_profiles")
    .select(profileColumns)
    .in("id", ids);
  if (profileError) throw profileError;
  const byId = new Map(
    (profiles ?? []).map((profile) => [profile.id, profile]),
  );
  // Exact HEAD counts transfer no subscription contents and are bounded to 25 users.
  const users = await Promise.all(
    data.users.map(async (user) => {
      const { count, error } = await client
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("is_active", true);
      if (error) throw error;
      return {
        ...account(user, byId.get(user.id)),
        subscriptionCount: count ?? 0,
      };
    }),
  );
  const needle = query.toLocaleLowerCase();
  return {
    users: users.filter(
      (user) =>
        !needle ||
        `${user.email ?? ""} ${user.name ?? ""}`
          .toLocaleLowerCase()
          .includes(needle),
    ),
    hasMore: Boolean(data.nextPage) || page < (data.lastPage ?? page),
    total: data.total ?? null,
  };
}

export async function getAudienceUser(
  client: SupabaseClient,
  id: string,
  page: number,
) {
  const { data, error } = await client.auth.admin.getUserById(id);
  if (error) {
    if (error.status === 404 || error.code === "user_not_found")
      throw new Response("Account not found.", { status: 404 });
    throw error;
  }
  if (!data.user) throw new Response("Account not found.", { status: 404 });
  const [profileResult, subscriptionResult] = await Promise.all([
    client
      .from("user_profiles")
      .select(profileColumns)
      .eq("id", id)
      .maybeSingle(),
    client
      .from("subscriptions")
      .select(
        "id, type, neighborhood, proximity_radius_m, keyword, created_at, matter:matters(id, slug, title), topic:topics(id, name), person:people(id, name)",
        { count: "exact" },
      )
      .eq("user_id", id)
      .eq("is_active", true)
      .order("id", { ascending: true })
      .range((page - 1) * AUDIENCE_PAGE_SIZE, page * AUDIENCE_PAGE_SIZE - 1),
  ]);
  if (profileResult.error) throw profileResult.error;
  if (subscriptionResult.error) throw subscriptionResult.error;
  const profile = profileResult.data;
  const subscriptions = (subscriptionResult.data ?? []).map((sub: any) => ({
    id: sub.id,
    type: sub.type,
    label:
      sub.matter?.title ??
      sub.topic?.name ??
      sub.person?.name ??
      sub.keyword ??
      sub.neighborhood ??
      (sub.type === "digest"
        ? "Council meeting digest"
        : sub.type === "neighborhood"
          ? "Near saved location"
          : sub.type),
    radius: sub.type === "neighborhood" ? sub.proximity_radius_m : null,
    createdAt: sub.created_at,
  }));
  return {
    user: account(data.user, profile),
    preferences: profile
      ? {
          notificationEmail: profile.notification_email,
          neighborhood: profile.neighborhood,
          digestEnabled: profile.digest_enabled,
          digestFrequency: profile.digest_frequency,
        }
      : null,
    subscriptions,
    subscriptionCount: subscriptionResult.count ?? 0,
    hasMore: (subscriptionResult.count ?? 0) > page * AUDIENCE_PAGE_SIZE,
  };
}
