import { useEffect, useRef } from "react";
import { Link } from "react-router";

export function OnboardingCompleteNotice({
  alertsAvailable,
}: {
  alertsAvailable: boolean;
}) {
  const notice = useRef<HTMLElement>(null);
  useEffect(() => {
    notice.current?.focus();
  }, []);
  return (
    <section
      ref={notice}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="container mx-auto max-w-6xl px-4 pt-6 focus:outline-none"
    >
      <div className="rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-950">
        <h2 className="font-semibold">Setup complete</h2>
        <p className="mt-1">
          Your preferences are saved. You can change them any time in{" "}
          <Link to="/settings" className="font-semibold underline">
            Settings
          </Link>
          .
          {!alertsAvailable &&
            " Email alerts are not available yet; no alert emails will be sent."}
        </p>
      </div>
    </section>
  );
}
