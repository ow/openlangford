import { createCookie } from "react-router";

// Presentation-only flash, not an authorization or onboarding-completion signal.
export const onboardingNotice = createCookie("onboarding_notice", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 120,
});
