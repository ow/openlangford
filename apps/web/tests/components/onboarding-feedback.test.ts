// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnboardingCompleteNotice } from "~/components/onboarding-complete-notice";
import Onboarding from "~/routes/onboarding";

vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: vi.fn(),
}));
vi.mock("~/services/ai/index.server", () => ({ embedQuery: vi.fn() }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("announces completion, focuses the persistent notice, and links to saved preferences without promising email delivery", async () => {
  await act(async () =>
    root.render(
      h(
        MemoryRouter,
        null,
        h(OnboardingCompleteNotice, { alertsAvailable: false }),
      ),
    ),
  );
  const notice = host.querySelector('[role="status"]')!;
  expect(document.activeElement).toBe(notice);
  expect(notice.getAttribute("aria-live")).toBe("polite");
  expect(notice.textContent).toContain("Setup complete");
  expect(notice.textContent).toContain("no alert emails will be sent");
  expect(notice.querySelector("a")?.getAttribute("href")).toBe("/settings");
});

it("marks delivery unavailable and disables digest opt-in while allowing onboarding to finish", async () => {
  const router = createMemoryRouter(
    [
      {
        path: "/onboarding",
        element: h(Onboarding, {
          loaderData: {
            topics: [],
            user: { id: "reader" },
            profile: { digest_enabled: true },
            emailAlertsAvailable: false,
          },
        } as any),
      },
    ],
    { initialEntries: ["/onboarding"] },
  );
  await act(async () => root.render(h(RouterProvider, { router })));
  expect(host.textContent).toContain("Email alerts are not available yet");
  for (let i = 0; i < 2; i++) {
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Next")!
        .click(),
    );
  }
  const digest = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Meeting digest"),
  )!;
  expect(digest.disabled).toBe(true);
  expect(digest.getAttribute("aria-pressed")).toBe("true");
  expect(
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Finish setup",
    )?.disabled,
  ).toBe(false);
});
