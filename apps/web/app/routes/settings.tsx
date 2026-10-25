import { emailAlertsAvailable } from "../lib/features.server";
import { EmailAlertsNotice } from "../components/email-alerts-notice";
import { NEIGHBORHOODS } from "../lib/site-config";
import { useState } from "react";
import { Form, redirect, useActionData, Link } from "react-router";
import type { Route } from "./+types/settings";
import { createSupabaseServerClient } from "../lib/supabase.server";
import {
  getUserProfile,
  upsertUserProfile,
  getSubscriptions,
  removeSubscription,
} from "../services/subscriptions";
import { getTopics } from "../services/topics";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/ui/page-header";
import { SectionHeading } from "../components/ui/section-heading";
import { NativeSelect } from "../components/ui/native-select";
import { Trash2, Check, X, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import { displayTitle } from "../lib/display-text";
import { siteName } from "../lib/site-name";
import type {
  UserProfile,
  Subscription,
  Topic,
} from "../lib/types";

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw redirect("/login?redirectTo=/settings", { headers });
  }

  const [profile, subscriptions, topics] = await Promise.all([
    getUserProfile(supabase, user.id),
    getSubscriptions(supabase, user.id),
    getTopics(supabase),
  ]);

  return { user, profile, subscriptions, topics, emailAlertsAvailable: emailAlertsAvailable() };
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw redirect("/login?redirectTo=/settings", { headers });
  }

  if (emailAlertsAvailable() && request.headers.get("Origin") !== new URL(request.url).origin) {
    return { error: "Submit email preferences from this site." };
  }
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update_profile") {
    const display_name = (formData.get("display_name") as string) || undefined;
    const address = (formData.get("address") as string) || undefined;
    const neighborhood = (formData.get("neighborhood") as string) || undefined;
    const notification_email =
      (formData.get("notification_email") as string) || undefined;
    const digest_enabled = formData.get("digest_enabled") === "on";
    const lat = formData.get("lat") ? parseFloat(formData.get("lat") as string) : null;
    const lng = formData.get("lng") ? parseFloat(formData.get("lng") as string) : null;

    await upsertUserProfile(supabase, user.id, {
      display_name,
      address,
      neighborhood,
      notification_email,
      ...(emailAlertsAvailable() ? {
        ...(formData.get("digest_frequency") === "each_meeting" ? { digest_frequency: "each_meeting" as const } : {}),
        digest_enabled,
      } : {}),
    });

    if (emailAlertsAvailable()) {
      const { error } = await supabase.rpc("set_email_alert_consent", { p_enabled: formData.get("email_alerts_enabled") === "on" });
      if (error) return { error: "Unable to save email consent. Confirm your sign-in email and try again." };
    }

    // Alert radius lives on the user's neighbourhood subscription.
    const radius = Number(formData.get("proximity_radius"));
    if (Number.isFinite(radius) && radius > 0) {
      await supabase
        .from("subscriptions")
        .update({ proximity_radius_m: radius })
        .eq("user_id", user.id)
        .eq("type", "neighborhood");
    }

    // If geocoded coordinates are provided, update geography via RPC
    if (lat != null && lng != null) {
      await supabase.rpc("update_user_location", {
        target_user_id: user.id,
        lng,
        lat,
      });
    }

    return { success: true, message: "Profile updated." };
  }

  if (intent === "remove_subscription") {
    const subscriptionId = Number(formData.get("subscription_id"));
    if (subscriptionId) {
      await removeSubscription(supabase, user.id, subscriptionId);
    }
    return { success: true, message: "Subscription removed." };
  }

  return { error: "Unknown action." };
}


const PROXIMITY_OPTIONS = [
  { value: 500, label: "500 m" },
  { value: 1000, label: "1 km" },
  { value: 2000, label: "2 km" },
  { value: 3000, label: "3 km" },
];

const subscriptionTypeLabel: Record<string, string> = {
  matter: "Matter",
  topic: "Topic",
  person: "Councillor",
  neighborhood: "Location",
  digest: "Meeting digest",
};

const subscriptionTypeTone: Record<
  string,
  "muted" | "brand" | "success" | "warning" | "danger"
> = {
  matter: "muted",
  topic: "brand",
  person: "muted",
  neighborhood: "success",
  digest: "brand",
};

const CARD = "rounded-2xl border border-zinc-200 bg-white shadow-sm";
const LABEL = "text-sm font-medium text-zinc-700";
const HINT = "text-xs text-zinc-500";

function SubscriptionRow({ sub }: { sub: Subscription }) {
  const label = subscriptionTypeLabel[sub.type] || sub.type;

  let title = label;
  if (sub.type === "matter" && sub.matter) {
    title = displayTitle(sub.matter.title);
  } else if (sub.type === "topic" && sub.keyword) {
    title = `"${sub.keyword}"`;
  } else if (sub.type === "topic" && sub.topic) {
    title = sub.topic.name;
  } else if (sub.type === "person" && sub.person) {
    title = sub.person.name;
  } else if (sub.type === "neighborhood" && sub.neighborhood) {
    title = sub.neighborhood;
  } else if (sub.type === "neighborhood") {
    title = `Within ${
      sub.proximity_radius_m >= 1000
        ? `${sub.proximity_radius_m / 1000} km`
        : `${sub.proximity_radius_m} m`
    } of your address`;
  } else if (sub.type === "digest") {
    title = "Meeting digest";
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-900">
          {title}
        </div>
      </div>
      <Badge variant={subscriptionTypeTone[sub.type] || "muted"}>
        {sub.keyword ? "Keyword" : label}
      </Badge>
      {sub.type !== "digest" && (
        <Form method="post">
          <input type="hidden" name="intent" value="remove_subscription" />
          <input type="hidden" name="subscription_id" value={sub.id} />
          <button
            type="submit"
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            aria-label={`Unsubscribe from ${title}`}
            title="Unsubscribe"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </Form>
      )}
    </li>
  );
}

// ── Topic Category Toggles ──

function TopicCategoryGrid({
  topics,
  subscriptions,
}: {
  topics: Topic[];
  subscriptions: Subscription[];
}) {
  const [loading, setLoading] = useState<number | null>(null);

  // Find which topics the user is subscribed to
  const subscribedTopicIds = new Set(
    subscriptions
      .filter((s) => s.type === "topic" && s.topic_id && !s.keyword)
      .map((s) => s.topic_id!),
  );

  // Map topic_id -> subscription_id for unsubscribing
  const topicSubMap: Record<number, number> = {};
  for (const s of subscriptions) {
    if (s.type === "topic" && s.topic_id && !s.keyword) {
      topicSubMap[s.topic_id] = s.id;
    }
  }

  async function toggleTopic(topicId: number) {
    setLoading(topicId);
    try {
      if (subscribedTopicIds.has(topicId)) {
        const subId = topicSubMap[topicId];
        if (subId) {
          await fetch("/api/subscribe", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subscription_id: subId }),
          });
        }
      } else {
        await fetch("/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "topic", topic_id: topicId }),
        });
      }
      // Reload to reflect changes
      window.location.reload();
    } catch (err) {
      console.error("Topic toggle error:", err);
    } finally {
      setLoading(null);
    }
  }

  if (topics.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-5 text-sm text-zinc-500">
        Topic categories haven't been set up yet.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {topics.map((topic) => {
        const subscribed = subscribedTopicIds.has(topic.id);
        const isLoading = loading === topic.id;
        return (
          <button
            key={topic.id}
            type="button"
            onClick={() => toggleTopic(topic.id)}
            disabled={isLoading}
            aria-pressed={subscribed}
            className={cn(
              "flex items-center gap-2.5 rounded-lg border p-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
              subscribed
                ? "border-brand-500 bg-brand-50"
                : "border-zinc-200 bg-white hover:border-zinc-300",
              isLoading && "opacity-50",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border-2 transition-colors",
                subscribed
                  ? "border-brand-600 bg-brand-600"
                  : "border-zinc-300 bg-white",
              )}
            >
              {isLoading ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin text-white" />
              ) : (
                subscribed && <Check className="h-2.5 w-2.5 text-white" />
              )}
            </span>
            <span
              className={cn(
                "truncate font-medium",
                subscribed ? "text-brand-800" : "text-zinc-700",
              )}
            >
              {topic.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Keyword Management ──

function KeywordManager({
  subscriptions,
}: {
  subscriptions: Subscription[];
}) {
  const [keywordInput, setKeywordInput] = useState("");
  const [adding, setAdding] = useState(false);

  const keywordSubs = subscriptions.filter(
    (s) => s.type === "topic" && s.keyword,
  );

  async function addKeyword() {
    const kw = keywordInput.trim().toLowerCase();
    if (!kw) return;
    setAdding(true);
    try {
      await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "topic", keyword: kw }),
      });
      setKeywordInput("");
      window.location.reload();
    } catch (err) {
      console.error("Add keyword error:", err);
    } finally {
      setAdding(false);
    }
  }

  async function removeKeyword(subId: number) {
    try {
      await fetch("/api/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_id: subId }),
      });
      window.location.reload();
    } catch (err) {
      console.error("Remove keyword error:", err);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          placeholder='e.g. "housing", "bike lanes"'
          aria-label="New keyword"
          className="h-10 bg-white"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addKeyword();
            }
          }}
          disabled={adding}
        />
        <Button
          type="button"
          variant="outline"
          onClick={addKeyword}
          disabled={!keywordInput.trim() || adding}
          className="h-10 flex-shrink-0"
        >
          {adding ? "Adding…" : "Add"}
        </Button>
      </div>

      {keywordSubs.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {keywordSubs.map((sub) => (
            <Badge key={sub.id} variant="muted" asChild>
              <button
                type="button"
                onClick={() => removeKeyword(sub.id)}
                aria-label={`Remove keyword ${sub.keyword}`}
                className="cursor-pointer py-1 pl-2.5 pr-1.5 hover:bg-zinc-200"
              >
                {sub.keyword}
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Address with Geocoding ──

function AddressField({
  defaultAddress,
  defaultNeighborhood,
}: {
  defaultAddress: string;
  defaultNeighborhood: string;
}) {
  const [address, setAddress] = useState(defaultAddress);
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeResult, setGeocodeResult] = useState<{
    lat: number;
    lng: number;
    display_name: string;
  } | null>(null);
  const [geocodeError, setGeocodeError] = useState("");

  async function handleGeocode() {
    if (!address.trim()) return;
    setGeocoding(true);
    setGeocodeError("");
    setGeocodeResult(null);

    try {
      const res = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address.trim() }),
      });
      const data = (await res.json()) as {
        lat?: number;
        lng?: number;
        display_name?: string;
        error?: string;
      };
      if (res.ok && data.lat && data.lng) {
        setGeocodeResult({
          lat: data.lat,
          lng: data.lng,
          display_name: data.display_name || address,
        });
      } else {
        setGeocodeError(
          data.error ||
            "Could not find that address. Try adding more detail.",
        );
      }
    } catch {
      setGeocodeError("Couldn't look up that address. Please try again.");
    } finally {
      setGeocoding(false);
    }
  }

  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor="address" className={LABEL}>
          Street address
        </label>
        <div className="flex gap-2">
          <Input
            id="address"
            name="address"
            value={address}
            autoComplete="street-address"
            className="h-10 bg-white"
            onChange={(e) => {
              setAddress(e.target.value);
              setGeocodeResult(null);
              setGeocodeError("");
            }}
            placeholder="e.g. 877 Goldstream Ave"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleGeocode}
            disabled={geocoding || !address.trim()}
            className="h-10 flex-shrink-0"
          >
            {geocoding ? "Locating…" : "Locate"}
          </Button>
        </div>

        {geocodeResult && (
          <p
            role="status"
            className="truncate rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-800"
          >
            Found: {geocodeResult.display_name}
          </p>
        )}

        {geocodeError && (
          <p
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800"
          >
            {geocodeError}
          </p>
        )}

        <p className={HINT}>
          Press Locate to confirm your address for nearby alerts.
        </p>
      </div>

      {/* Hidden fields for geocoded coordinates */}
      {geocodeResult && (
        <>
          <input type="hidden" name="lat" value={geocodeResult.lat} />
          <input type="hidden" name="lng" value={geocodeResult.lng} />
        </>
      )}
    </>
  );
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { user, profile, subscriptions, topics, emailAlertsAvailable: alertsAvailable } = loaderData;
  const actionData = useActionData<typeof action>();

  // Determine the existing proximity radius from neighbourhood subscription
  const neighborhoodSub = subscriptions.find(
    (s) => s.type === "neighborhood",
  );

  // Non-topic/keyword/digest subscriptions for the "Active Subscriptions" section
  const otherSubscriptions = subscriptions.filter(
    (s) => !((s.type === "topic" && !s.keyword) || s.type === "digest"),
  );

  // Keep a saved neighbourhood selectable even if it isn't in the list
  // (e.g. values saved before the list changed).
  const savedNeighborhood = profile?.neighborhood || "";
  const neighborhoodOptions =
    savedNeighborhood && !NEIGHBORHOODS.includes(savedNeighborhood)
      ? [savedNeighborhood, ...NEIGHBORHOODS]
      : NEIGHBORHOODS;

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-2xl px-4 py-12">
        <PageHeader
          title="Settings"
          description="Your profile, saved preferences and the things you follow."
        />

        {actionData && "success" in actionData && (
          <div
            role="status"
            className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800"
          >
            {actionData.message}
          </div>
        )}

        {actionData && "error" in actionData && (
          <div
            role="alert"
            className="mb-6 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700"
          >
            {actionData.error}
          </div>
        )}

        <div className="space-y-10">
          {!alertsAvailable && <div className="mb-6"><EmailAlertsNotice /></div>}

          {/* Profile Section */}
          <section>
            <SectionHeading
              title="Profile and delivery"
              description="Your saved contact details and what counts as near you."
            />
            <Form method="post" className={cn(CARD, "space-y-5 p-5 sm:p-6")}>
              <input type="hidden" name="intent" value="update_profile" />

              <div className="space-y-1.5">
                <label htmlFor="display_name" className={LABEL}>
                  Display name
                </label>
                <Input
                  id="display_name"
                  name="display_name"
                  autoComplete="name"
                  className="h-10 bg-white"
                  defaultValue={profile?.display_name || ""}
                  placeholder="How you'd like to be addressed"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="notification_email" className={LABEL}>
                  Notification email
                </label>
                <Input
                  id="notification_email"
                  type="email"
                  name="notification_email"
                  autoComplete="email"
                  className="h-10 bg-white"
                  defaultValue={profile?.notification_email || user.email || ""}
                  placeholder="Where to send alerts"
                />
                <p className={HINT}>
                  Defaults to your sign-in email if left blank.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <AddressField
                  defaultAddress={profile?.address || ""}
                  defaultNeighborhood={profile?.neighborhood || ""}
                />

                <div className="space-y-1.5">
                  <label htmlFor="neighborhood" className={LABEL}>
                    Neighbourhood
                  </label>
                  <NativeSelect
                    id="neighborhood"
                    name="neighborhood"
                    defaultValue={savedNeighborhood}
                  >
                    <option value="">Select neighbourhood</option>
                    {neighborhoodOptions.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </NativeSelect>
                  <p className={HINT}>Use this if you'd rather not share an address.</p>
                </div>
              </div>

              {/* Proximity radius — stored on the neighbourhood subscription */}
              {neighborhoodSub && (
                <fieldset className="space-y-2">
                  <legend className={LABEL}>Alert radius</legend>
                  <div className="grid grid-cols-4 gap-2">
                    {PROXIMITY_OPTIONS.map((opt) => {
                      const currentRadius =
                        neighborhoodSub?.proximity_radius_m || 1000;
                      return (
                        <label
                          key={opt.value}
                          className="cursor-pointer rounded-lg border border-zinc-200 bg-white px-2 py-2 text-center text-sm font-medium tabular-nums text-zinc-600 transition-colors hover:border-zinc-300 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-800 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40"
                        >
                          <input
                            type="radio"
                            name="proximity_radius"
                            value={opt.value}
                            defaultChecked={currentRadius === opt.value}
                            className="sr-only"
                          />
                          {opt.label}
                        </label>
                      );
                    })}
                  </div>
                  <p className={HINT}>
                    How far from your location we look for relevant decisions.
                  </p>
                </fieldset>
              )}

              <div className="space-y-3 border-t border-zinc-100 pt-5">
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" name="email_alerts_enabled" disabled={!alertsAvailable} defaultChecked={profile?.email_alerts_enabled ?? false} />
                  <span>Email me per-meeting council updates for my saved interests. I can unsubscribe at any time.</span>
                </label>
                <p className={HINT}>Alerts use your confirmed sign-in email. A different saved notification address is not eligible. Weekly and pre-meeting emails are not available.</p>
                <h3 className="text-sm font-semibold text-zinc-900">
                  Meeting digest
                </h3>

                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    name="digest_enabled"
                    disabled={!alertsAvailable}
                    defaultChecked={profile?.digest_enabled ?? false}
                    className="mt-0.5 h-4 w-4 rounded border-zinc-300 accent-brand-600"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-sm text-zinc-800">
                      {alertsAvailable ? "Also include a digest after every council meeting" : "Meeting digest — unavailable"}
                    </span>
                    <span className={cn(HINT, "block")}>
                      {alertsAvailable
                        ? "Key decisions and vote results, once minutes or a transcript are available."
                        : "Your saved choice is kept, but email delivery is not active."}
                    </span>
                  </span>
                </label>

                <div className="space-y-1.5 pl-7">
                  <label htmlFor="digest_frequency" className={LABEL}>
                    How often
                  </label>
                  <NativeSelect
                    id="digest_frequency"
                    disabled={!alertsAvailable}
                    name="digest_frequency"
                    defaultValue={profile?.digest_frequency || "each_meeting"}
                    className="sm:max-w-xs"
                  >
                    <option value="each_meeting">After each meeting</option>
                    <option value="weekly" disabled>Weekly summary — not available</option>
                  </NativeSelect>
                </div>
              </div>

              <div className="border-t border-zinc-100 pt-5">
                <Button
                  type="submit"
                  className="h-10 w-full bg-brand-600 text-white hover:bg-brand-700 sm:w-auto"
                >
                  Save changes
                </Button>
              </div>
            </Form>
          </section>

          {/* Topic Subscriptions Section */}
          <section>
            <SectionHeading
              title="Topics"
              description="Save topics you care about. Changes save straight away."
            />

            <div className={cn(CARD, "space-y-6 p-5 sm:p-6")}>
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-900">
                  Categories
                </h3>
                <TopicCategoryGrid
                  topics={topics}
                  subscriptions={subscriptions}
                />
              </div>

              <div className="space-y-3 border-t border-zinc-100 pt-5">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">
                    Keywords
                  </h3>
                  <p className={cn(HINT, "mt-0.5")}>
                    Your own terms. We match them by meaning, not just exact
                    words.
                  </p>
                </div>
                <KeywordManager subscriptions={subscriptions} />
              </div>
            </div>
          </section>

          {/* Active Subscriptions Section */}
          <section>
            <SectionHeading
              title="Following"
              description="Your saved matters, councillors, keywords and locations."
            />

            {otherSubscriptions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-5 text-sm text-zinc-500">
                You're not following anything yet. Open a{" "}
                <Link to="/matters" className="font-medium text-brand-700 hover:underline">
                  matter
                </Link>
                ,{" "}
                <Link to="/people" className="font-medium text-brand-700 hover:underline">
                  council member
                </Link>{" "}
                or{" "}
                <Link to="/meetings" className="font-medium text-brand-700 hover:underline">
                  meeting
                </Link>{" "}
                and use its subscribe button.
              </div>
            ) : (
              <ul className={cn(CARD, "divide-y divide-zinc-100")}>
                {otherSubscriptions.map((sub) => (
                  <SubscriptionRow key={sub.id} sub={sub} />
                ))}
              </ul>
            )}

            <div className={cn(CARD, "mt-4 p-5")}>
              <h3 className="text-sm font-semibold text-zinc-900">
                {alertsAvailable ? "How alerts work" : "Planned alerts — delivery unavailable"}
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-zinc-600 marker:text-zinc-300">
                <li>
                  Meeting digests are intended to cover meetings with minutes or a transcript.
                </li>
                <li>
                  Matter preferences identify business you follow on an agenda.
                </li>
                <li>
                  Topic and keyword preferences match related discussions by meaning.
                </li>
                <li>
                  Location preferences identify decisions affecting your neighbourhood.
                </li>
              </ul>
            </div>
          </section>

          {/* Developer */}
          <section>
            <SectionHeading title="Developer access" />
            <div
              className={cn(
                CARD,
                "flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between",
              )}
            >
              <p className="text-sm text-zinc-600">
                Create API keys to query {siteName()} data from your own tools.
              </p>
              <Button asChild variant="outline" className="h-10 flex-shrink-0">
                <Link to="/settings/api-keys">Manage API keys</Link>
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
