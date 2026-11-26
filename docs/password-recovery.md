# Password recovery

Flow: `/login` ("Forgot password?") → `/forgot-password` (email form) → Supabase
emails a recovery link that returns to `/auth/recovery?code=…` → the callback
exchanges the code for a session (PKCE, `exchangeCodeForSession`; `token_hash`
links with `type=recovery` also work via `verifyOtp`) and issues a recovery
grant → `/reset-password` checks the grant, calls
`auth.updateUser({ password })`, clears the grant → `/settings`.

- The form answers the same whether or not the email has an account, so it
  can't be used to discover accounts. Same-origin check and the
  `SIGNUP_RATE_LIMITER` binding (key `recover:<ip>`, fails closed) guard it.
- Being signed in is not enough to use `/reset-password`. The callback mints a
  grant only when the new session's verified token lists a `recovery` sign-in
  from the last 15 minutes; the grant is an HttpOnly cookie (`ol_recovery`,
  scoped to `/reset-password`) signed with a server secret and naming the user
  id, the Supabase session id and an expiry. The page and its action require a
  grant matching the current user and session, and the action deletes it once
  the password has changed (`app/lib/recovery-grant.server.ts`).
- PKCE stores its verifier in a cookie, so the link must be opened in the
  browser that asked for it. A link opened elsewhere lands on
  `/forgot-password?expired=1`. To lift that limit, change the Supabase
  "Reset password" email template link to
  `{{ .SiteURL }}/auth/recovery?token_hash={{ .TokenHash }}&type=recovery`.
- Password rules match signup (6 to 1024 characters).

## Supabase settings (dashboard, not migrations)

The app always sends `redirectTo` = `<origin>/auth/recovery`: one fixed path
with no query string of its own (Supabase adds `?code=…` when it redirects).

In Supabase Authentication → URL Configuration, confirm the Site URL is the
canonical production origin and add `https://openlangford.ca/auth/recovery` to
**Redirect URLs**. For each preview or other origin, add its exact recovery URL
(for example, `https://preview.example.com/auth/recovery`); without it Supabase
falls back to the Site URL and the link won't reach the callback. The local
Supabase config (`scripts/local-db/supabase/config.toml`) already allows the
localhost and 127.0.0.1 recovery URLs.
