/**
 * Onboarding wizard — post-signup flow for setting up subscriptions.
 * Steps: pick topics -> set address/neighbourhood -> opt into digest.
 */

import { emailAlertsAvailable } from "../lib/features.server";
import { onboardingNotice } from "../lib/onboarding-notice.server";
import { EmailAlertsNotice } from "../components/email-alerts-notice";
import { NEIGHBORHOODS } from "../lib/site-config";
import { useState } from "react";
import { PlacePicker, type PlaceChoice } from "../components/place-picker";
import { readPlaceUpdate, readRadius, savePlace } from "../services/saved-place.server";
import { redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/onboarding";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { getTopics } from "../services/topics";
import {
  getUserProfile,
  upsertUserProfile,
  addSubscription,
} from "../services/subscriptions";
import { embedQuery } from "../services/ai/index.server";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { NativeSelect } from "../components/ui/native-select";
import { Check, X } from "lucide-react";
import { cn } from "../lib/utils";
import { siteName } from "../lib/site-name";
import type { Topic } from "../lib/types";

// ── Neighbourhood list (keep in sync with settings.tsx) ──



// ── Loader ──

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw redirect("/login", { headers });
  }

  const [profile, topics] = await Promise.all([
    getUserProfile(supabase, user.id),
    getTopics(supabase),
  ]);

  // Already completed onboarding — go home
  if (profile?.onboarding_completed) {
    throw redirect("/", { headers });
  }

  return { user, profile, topics, emailAlertsAvailable: emailAlertsAvailable() };
}

// ── Action ──

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw redirect("/login", { headers });
  }

  if (emailAlertsAvailable() && request.headers.get("Origin") !== new URL(request.url).origin) {
    return { error: "Submit email preferences from this site." };
  }
  const formData = await request.formData();
  const topicIds = formData.getAll("topic_id").map(Number).filter(Boolean);
  const keywords = formData.getAll("keyword").map(String).filter(Boolean);
  const neighborhood = (formData.get("neighborhood") as string) || "";
  const proximityRadius = Number(formData.get("proximity_radius") || 1000);
  const alertsAvailable = emailAlertsAvailable();
  const digestEnabled = alertsAvailable && formData.get("digest_enabled") === "true";

  try {
    // 1. Subscribe to selected topic categories
    for (const topicId of topicIds) {
      await addSubscription(supabase, user.id, "topic", { topic_id: topicId });
    }

    // 2. Subscribe to keywords with embeddings
    for (const kw of keywords) {
      const embedding = await embedQuery(kw);
      if (embedding) {
        await addSubscription(supabase, user.id, "topic", {
          keyword: kw,
          keyword_embedding: embedding,
        });
      }
    }

    // 3. Place for nearby alerts: only a rounded point and the street name are kept.
    const profileUpdate: Record<string, unknown> = {};
    const place = await readPlaceUpdate(formData);
    if (place.kind === "not_found") {
      return { error: "We couldn't find that address. Go back to Location and try a nearby intersection, or skip it." };
    }
    if (place.kind === "set") await savePlace(supabase, user.id, place, readRadius(formData) ?? proximityRadius);

    if (neighborhood) {
      profileUpdate.neighborhood = neighborhood;
      // Without a place, alert on the neighbourhood by name.
      if (place.kind !== "set") {
        await addSubscription(supabase, user.id, "neighborhood", {
          neighborhood,
          proximity_radius_m: proximityRadius,
        });
      }
    }

    // 4. Handle digest opt-in
    if (digestEnabled) {
      await addSubscription(supabase, user.id, "digest", {});
    }

    // 5. ALWAYS set onboarding_completed = true (even if user skipped everything)
    await upsertUserProfile(supabase, user.id, {
      ...profileUpdate,
      // Disabled form controls are omitted. Do not erase an existing opt-in/frequency.
      ...(alertsAvailable ? { digest_enabled: digestEnabled, ...(digestEnabled ? { digest_frequency: "each_meeting" as const } : {}) } : {}),
      onboarding_completed: !alertsAvailable,
    });

    if (alertsAvailable) {
      const { error } = await supabase.rpc("set_email_alert_consent", { p_enabled: digestEnabled, p_complete_onboarding: true });
      if (error) throw new Error("Unable to save email consent. Confirm your sign-in email and try again.");
    }
    headers.append("Set-Cookie", await onboardingNotice.serialize("complete", {
      secure: new URL(request.url).protocol === "https:",
    }));
    return redirect("/", { headers });
  } catch (err) {
    console.error("Onboarding action error:", err);
    return { error: err instanceof Error ? err.message : "Something went wrong" };
  }
}

// ── Step indicators ──

const STEPS = [
  { label: "Topics" },
  { label: "Location" },
  { label: "Digest" },
] as const;

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <ol className="mb-6 flex items-center justify-center gap-2" aria-label="Setup progress">
      {STEPS.map((step, i) => {
        const isComplete = i < currentStep;
        const isCurrent = i === currentStep;
        return (
          <li key={step.label} className="flex items-center gap-2">
            <span
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 text-sm font-medium",
                isCurrent && "text-zinc-900",
                isComplete && "text-brand-700",
                !isComplete && !isCurrent && "text-zinc-400",
              )}
            >
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
                  isCurrent && "bg-brand-600 text-white",
                  isComplete && "bg-brand-50 text-brand-700 ring-1 ring-brand-200",
                  !isComplete && !isCurrent && "bg-zinc-100 text-zinc-500",
                )}
              >
                {isComplete ? (
                  <Check className="h-3.5 w-3.5" aria-label="Done" />
                ) : (
                  i + 1
                )}
              </span>
              {step.label}
            </span>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px w-6 sm:w-10",
                  i < currentStep ? "bg-brand-300" : "bg-zinc-200",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ── Step 1: Topics ──

function TopicStep({
  topics,
  selectedTopics,
  setSelectedTopics,
  keywords,
  setKeywords,
}: {
  topics: Topic[];
  selectedTopics: Set<number>;
  setSelectedTopics: (s: Set<number>) => void;
  keywords: string[];
  setKeywords: (k: string[]) => void;
}) {
  const [keywordInput, setKeywordInput] = useState("");

  function toggleTopic(id: number) {
    const next = new Set(selectedTopics);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedTopics(next);
  }

  function addKeyword() {
    const kw = keywordInput.trim().toLowerCase();
    if (kw && !keywords.includes(kw)) {
      setKeywords([...keywords, kw]);
    }
    setKeywordInput("");
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-zinc-900 mb-1">
          What topics interest you?
        </h2>
        <p className="text-sm text-zinc-500">
          Save the council topics you care about. You can change these preferences later.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {topics.map((topic) => {
          const selected = selectedTopics.has(topic.id);
          return (
            <button
              key={topic.id}
              type="button"
              onClick={() => toggleTopic(topic.id)}
              aria-pressed={selected}
              className={cn(
                "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
                selected
                  ? "border-brand-500 bg-brand-50"
                  : "border-zinc-200 bg-surface hover:border-zinc-300",
              )}
            >
              <div
                aria-hidden="true"
                className={cn(
                  "w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors",
                  selected
                    ? "border-brand-500 bg-brand-500"
                    : "border-zinc-300 bg-surface",
                )}
              >
                {selected && <Check className="h-3 w-3 text-white" />}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zinc-900 truncate">
                  {topic.name}
                </div>
                {topic.description && (
                  <div className="text-xs text-zinc-500 truncate">
                    {topic.description}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 mb-1">
            Custom keywords
          </h3>
          <p className="text-xs text-zinc-500">
            Add specific terms to match when similar topics are
            discussed.
          </p>
        </div>

        <div className="flex gap-2">
          <Input
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            placeholder='e.g. "housing", "bike lanes", "property tax"'
            aria-label="New keyword"
            className="h-10 bg-surface"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addKeyword();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={addKeyword}
            disabled={!keywordInput.trim()}
            className="h-10 flex-shrink-0"
          >
            Add
          </Button>
        </div>

        {keywords.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {keywords.map((kw) => (
              <Badge key={kw} variant="muted" asChild>
                <button
                  type="button"
                  onClick={() => setKeywords(keywords.filter((k) => k !== kw))}
                  aria-label={`Remove keyword ${kw}`}
                  className="cursor-pointer py-1 pl-2.5 pr-1.5 hover:bg-zinc-200"
                >
                  {kw}
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 2: Location ──

function LocationStep({
  placeChoice,
  setPlaceChoice,
  neighborhood,
  setNeighborhood,
}: {
  placeChoice: PlaceChoice;
  setPlaceChoice: (choice: PlaceChoice) => void;
  neighborhood: string;
  setNeighborhood: (n: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-zinc-900 mb-1">
          Where in Langford?
        </h2>
        <p className="text-sm text-zinc-500">
          Save a place to hear about decisions and developments near it.
        </p>
      </div>

      {/* Remembers the choice when someone steps back to this page. */}
      <PlacePicker
        initial={placeChoice.place}
        initialRadius={placeChoice.radius}
        idPrefix="onboarding"
        onChange={setPlaceChoice}
      />

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-zinc-200" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-surface px-3 text-zinc-500">or</span>
        </div>
      </div>

      <div className="space-y-3">
        <label htmlFor="onboarding-neighborhood" className="text-sm font-medium text-zinc-700">
          Pick a neighbourhood
        </label>
        <NativeSelect
          id="onboarding-neighborhood"
          value={neighborhood}
          onChange={(e) => setNeighborhood(e.target.value)}
        >
          <option value="">Select neighbourhood</option>
          {NEIGHBORHOODS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}

// ── Step 3: Digest ──

function DigestStep({
  digestEnabled,
  setDigestEnabled,
  alertsAvailable,
}: {
  alertsAvailable: boolean;
  digestEnabled: boolean;
  setDigestEnabled: (e: boolean) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-zinc-900 mb-1">
          Stay in the loop
        </h2>
        <p className="text-sm text-zinc-500">
          {alertsAvailable
            ? "A short email after each council meeting, so you can keep up without watching hours of video."
            : "Email digests are not available yet. You can finish setup without turning them on."}
        </p>
      </div>

      <button
        type="button"
        disabled={!alertsAvailable}
        onClick={() => setDigestEnabled(!digestEnabled)}
        aria-pressed={digestEnabled}
        className={cn(
          "w-full flex items-start gap-4 p-5 rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
          digestEnabled
            ? "border-brand-500 bg-brand-50"
            : "border-zinc-200 bg-surface hover:border-zinc-300",
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            "w-5 h-5 mt-0.5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors",
            digestEnabled
              ? "border-brand-500 bg-brand-500"
              : "border-zinc-300 bg-surface",
          )}
        >
          {digestEnabled && <Check className="h-3 w-3 text-white" />}
        </div>
        <div className="space-y-2">
          <div className="font-semibold text-zinc-900">Meeting digest</div>
          <p className="text-sm text-zinc-600 leading-relaxed">
            {alertsAvailable
              ? "Email me a summary after each council meeting once minutes or a transcript are available. I can unsubscribe at any time."
              : "Unavailable. Any existing digest preference is kept; email delivery is not active."}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {["Key decisions", "Vote results", "Your neighbourhood", "Divided votes"].map((tag) => (
              <Badge key={tag} variant="outline" className="bg-surface text-zinc-600">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      </button>
    </div>
  );
}

// ── Main Component ──

export default function Onboarding({ loaderData, actionData }: Route.ComponentProps) {
  const { topics, profile, emailAlertsAvailable: alertsAvailable } = loaderData;
  const submit = useSubmit();
  const submitting = useNavigation().state !== "idle";

  const [step, setStep] = useState(0);
  const [selectedTopics, setSelectedTopics] = useState<Set<number>>(new Set());
  const [keywords, setKeywords] = useState<string[]>([]);
  const [placeChoice, setPlaceChoice] = useState<PlaceChoice>({ place: null, lookup: "", radius: 1000, cleared: false });
  const [neighborhood, setNeighborhood] = useState("");
  const [digestEnabled, setDigestEnabled] = useState(profile?.digest_enabled ?? false);

  function handleSubmit() {
    const form = new FormData();

    // Topics
    for (const id of selectedTopics) {
      form.append("topic_id", String(id));
    }
    for (const kw of keywords) {
      form.append("keyword", kw);
    }

    // Location
    if (placeChoice.place) {
      form.set("place_lat", String(placeChoice.place.lat));
      form.set("place_lng", String(placeChoice.place.lng));
      form.set("place_label", placeChoice.place.label);
    } else if (placeChoice.lookup.trim()) {
      form.set("place_lookup", placeChoice.lookup.trim());
    }
    if (neighborhood) form.set("neighborhood", neighborhood);
    form.set("proximity_radius", String(placeChoice.radius));

    // Digest
    form.set("digest_enabled", digestEnabled ? "true" : "false");

    submit(form, { method: "post" });
  }

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-6 text-center">
          <p className="text-sm font-medium text-brand-700">
            Welcome to {siteName()}
          </p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-zinc-900">
            Save your preferences
          </h1>
          <p className="mt-2 text-sm text-zinc-600">
            Choose the council topics and places you care about. It takes about a
            minute, and you can change it later in Settings.
          </p>
        </div>

        {!alertsAvailable && <div className="mb-6"><EmailAlertsNotice /></div>}

        {/* Step indicator */}
        <StepIndicator currentStep={step} />

        {/* Step content */}
        <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm sm:p-6">
          {step === 0 && (
            <TopicStep
              topics={topics}
              selectedTopics={selectedTopics}
              setSelectedTopics={setSelectedTopics}
              keywords={keywords}
              setKeywords={setKeywords}
            />
          )}

          {step === 1 && (
            <LocationStep
              placeChoice={placeChoice}
              setPlaceChoice={setPlaceChoice}
              neighborhood={neighborhood}
              setNeighborhood={setNeighborhood}
            />
          )}

          {step === 2 && (
            <DigestStep
              digestEnabled={digestEnabled}
              setDigestEnabled={setDigestEnabled}
              alertsAvailable={alertsAvailable}
            />
          )}

          {/* Error display */}
          {actionData && "error" in actionData && (
            <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {actionData.error}
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-zinc-100">
            <div>
              {step > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep(step - 1)}
                >
                  Back
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {step === 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep(2)}
                  className="text-zinc-500"
                >
                  Skip
                </Button>
              )}

              {step < 2 ? (
                <Button
                  type="button"
                  onClick={() => setStep(step + 1)}
                  className="bg-brand-600 text-white hover:bg-brand-700"
                >
                  Next
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="bg-brand-600 text-white hover:bg-brand-700"
                >
                  {submitting ? "Saving…" : "Finish setup"}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Skip onboarding entirely */}
        <div className="text-center mt-4">
          <button
            type="button"
            onClick={() => {
              const form = new FormData();
              form.set("digest_enabled", "false");
              submit(form, { method: "post" });
            }}
            className="text-sm text-zinc-500 underline-offset-4 transition-colors hover:text-zinc-700 hover:underline"
            disabled={submitting}
          >
            Skip for now, I'll set this up later
          </button>
        </div>
      </div>
    </div>
  );
}
