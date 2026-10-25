# Public signup

The shareable URL is `https://openlangford.ca/signup`. Signup is public:
visitors can reach it from the navbar, homepage, sign-in page and subscription
buttons. Anyone can submit the form.
The route adds `noindex, nofollow` and remains excluded by robots.txt and sitemaps.

## Deployment configuration

Build and deploy the web code with these tracked Worker vars:

- `ENABLE_SIGNUPS = "true"` accepts signup on `/signup`.
- `PUBLIC_SIGNUP_LINKS = "true"` shows signup/alerts entry points in the
  navbar, homepage, sign-in page and anonymous subscription buttons. Set it to
  `false` to hide discovery while continuing to accept direct-link signup.
- The new `SIGNUP_RATE_LIMITER` binding uses namespace `1002`, five attempts per
  IP per 60 seconds. Missing or unavailable binding prevents signup.

The flags are compiled by Vite. Existing Cloudflare Build Configuration or `.env`
overrides take precedence over wrangler.toml; ensure they do not retain
`ENABLE_SIGNUPS=false` or `PUBLIC_SIGNUP_LINKS=false`. Rebuild after changing
flags. To close signup entirely, set `ENABLE_SIGNUPS=false` and rebuild.
No Supabase changes, new secrets, account privileges, or migrations are required.

Supabase's signup restrictions, confirmation policy and provider rate limits
remain authoritative. The application uses the anonymous-key request client,
never the service-role client. Confirmation-required signup retains cookies and
asks the person to confirm by email, then sign in to `/onboarding`. It does not
silently sign them in or implement an email callback. A `redirectTo` local path
is used when signup returns an immediate session; unsafe destinations fall back
to `/onboarding` (`/` for login).

## Abuse and authorization

The form requires a same-origin Origin header, validates fields on the server,
includes a honeypot, and disables repeat clicks while submitting. Cloudflare's
IP limiter is per-location best-effort protection, not a global account/email
quota. Supabase's existing protections still apply to direct provider requests.
No CAPTCHA or Supabase security setting is changed.

Account creation accepts only email, password and display name. It does not
accept roles or set admin permissions. Admin access requires the existing
explicit email allowlist; a missing allowlist now denies access in every
environment, including development and previews.

## Verification (2026-10-22)

A fresh clone of `ow/openlangford` started at main commit
`2f9a9b14b40a8af3598762f6765b6f2792d797ad`. The live `/signup` page displayed
“Sign-ups are closed for now”. A read-only request to the public Supabase auth
settings reported `disable_signup=false`, email enabled, and
`mailer_autoconfirm=false`. These capabilities do not prove email delivery;
no account was created and no verification email was sent.

Read-only GET checks of `/`, `/meetings`, `/matters`, `/people`, `/search`,
`/about`, `/contact`, `/login`, and `/signup` all returned HTTP 200. This is a
navigation/auth spot check, not an exhaustive crawl of record-specific links.

Focused action tests cover hidden signup, the kill switch, unsafe return URLs,
origin/field/honeypot/rate-limit rejection, provider refusal, confirmation cookie
preservation, ignored privilege fields, and ordinary-user admin denial.

## Public rollout (2026-10-25)

Public discovery is enabled in the tracked Worker configuration. This changes
only the existing signup navigation flag; the registration action, admin
allowlist, Supabase policies, OAuth and abuse controls are unchanged. No auth
redirect setting changes are included, preserving the configured production
Site URL. Route checks and mocked auth tests do not prove confirmation email
delivery or alert delivery. Verify those separately with an approved test
identity before claiming end-to-end email delivery.

Validation: all 22 focused auth tests, TypeScript checking and the production
build passed. Read-only live auth settings confirmed `disable_signup=false`,
email enabled and `mailer_autoconfirm=false`. No account was created. The signup
action supplies no email redirect override, so this change cannot introduce a
localhost confirmation URL; the actual email link still needs separate proof.
