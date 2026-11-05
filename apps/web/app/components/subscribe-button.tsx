import { useState, useEffect } from "react";
import { useRouteLoaderData, Link } from "react-router";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import type { SubscriptionType } from "../lib/types";
import { trackEvent } from "../lib/analytics";
import { useSiteFlags } from "../lib/use-site-flags";

interface SubscribeButtonProps {
  type: SubscriptionType;
  targetId: number;
  label?: string;
  className?: string;
  compact?: boolean;
  /** A bell before the label. */
  icon?: boolean;
  /** A quiet text button (beside a topic's status), instead of the brand pill. */
  quiet?: boolean;
}

const QUIET = "rounded-md px-2 py-1 text-sm font-medium";

export function SubscribeButton({
  type,
  targetId,
  label,
  className,
  compact = false,
  icon = false,
  quiet = false,
}: SubscribeButtonProps) {
  const rootData = useRouteLoaderData("root") as { user: any } | undefined;
  const user = rootData?.user;
  const { signupsEnabled } = useSiteFlags();

  const [subscribed, setSubscribed] = useState(false);
  const [subscriptionId, setSubscriptionId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);

  // Check subscription status on mount
  useEffect(() => {
    if (!user) return;

    const checkStatus = async () => {
      try {
        const res = await fetch(`/api/subscribe?type=${type}&target_id=${targetId}`);
        if (!res.ok) { setChecked(true); return; }
        const data = (await res.json()) as { subscribed: boolean; subscription_id: number | null };
        setSubscribed(data.subscribed);
        setSubscriptionId(data.subscription_id);
      } catch {
        // ignore
      } finally {
        setChecked(true);
      }
    };
    checkStatus();
  }, [user, type, targetId]);

  if (!user) {
    // Signed-out visitors are sent to sign up; hide when sign-ups are closed.
    if (!signupsEnabled) return null;
    return (
      <Link
        to={`/signup?redirectTo=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/")}`}
        className={cn(
          "inline-flex items-center gap-1.5 transition-colors",
          quiet ? cn(QUIET, "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900")
            : cn("rounded-full text-sm font-semibold bg-brand-50 text-brand-600 hover:bg-brand-100", compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5"),
          className,
        )}
      >
        {icon && <Bell className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />}
        {label || "Follow"}
      </Link>
    );
  }

  if (!checked) {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-1.5",
          quiet ? cn(QUIET, "text-zinc-300") : cn("rounded-full text-sm bg-zinc-100 text-zinc-400", compact ? "px-2.5 py-1" : "px-3 py-1.5"),
          className,
        )}
      >
        <Loader2 className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5", "animate-spin")} />
      </div>
    );
  }

  const handleToggle = async () => {
    setLoading(true);
    try {
      if (subscribed && subscriptionId) {
        const res = await fetch("/api/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription_id: subscriptionId }),
        });
        if (!res.ok) { console.error("Unsubscribe failed:", res.status); return; }
        trackEvent("subscribe toggled", {
          action: "unsubscribe",
          type,
          target_id: targetId,
        });
        setSubscribed(false);
        setSubscriptionId(null);
      } else {
        const column =
          type === "matter"
            ? "matter_id"
            : type === "person"
              ? "person_id"
              : type === "topic"
                ? "topic_id"
                : null;

        const body: Record<string, any> = { type };
        if (column) body[column] = targetId;

        const res = await fetch("/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) { console.error("Subscribe failed:", res.status); return; }
        const data = (await res.json()) as { subscription?: { id: number } };
        trackEvent("subscribe toggled", {
          action: "subscribe",
          type,
          target_id: targetId,
        });
        setSubscribed(true);
        setSubscriptionId(data.subscription?.id || null);
      }
    } catch (err) {
      console.error("Subscription error:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      className={cn(
        "inline-flex items-center gap-1.5 transition-all",
        quiet
          ? cn(QUIET, subscribed
            ? "text-brand-700 hover:bg-red-50 hover:text-red-700"
            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900")
          : cn("rounded-full text-sm font-semibold", compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5", subscribed
            ? "bg-brand-600 text-white hover:bg-red-500"
            : "bg-brand-50 text-brand-600 hover:bg-brand-100"),
        loading && "opacity-50 cursor-wait",
        className,
      )}
      title={subscribed ? "Unsubscribe" : "Subscribe to alerts"}
    >
      {loading && (
        <Loader2 className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5", "animate-spin")} />
      )}
      {!loading && icon && <Bell className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5", subscribed && "fill-current")} />}
      {subscribed ? "Following" : label || "Follow"}
    </button>
  );
}
