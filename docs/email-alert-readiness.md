> Current implementation and staged approvals: [Per-meeting rollout](email-alert-rollout.md).
> The owner now reports RESEND_API_KEY/domain setup complete. The dated inspection
> below is historical; no production activation is implied by this PR.

# Application email alert readiness

## Verified state (2026-10-22)

Application alerts are unavailable. Read-only inspection of the Langford Supabase
project (`zxcvifwkaxtdfpanlwtl`) showed no deployed Edge Functions and no custom
Edge Function secrets. `RESEND_API_KEY` is therefore not configured there. No
secret values were read, no provider/account was configured, and no email was sent.

Supabase Auth's built-in mail service sends account-confirmation emails separately.
Receiving a signup email does not establish application alert delivery readiness.

The repository's `supabase/functions/send-alerts/index.ts` implements Resend sending,
but currently hard-codes `ViewRoyal.ai <alerts@updates.viewroyal.ai>` and
`https://viewroyal.ai`. It must not be activated as a Langford sender unchanged.

The pipeline's `_after_meeting_ingested` calls `_trigger_alerts` for normal ingestion,
which POSTs `{meeting_id, mode: "digest"}` to this Edge Function. Documentary-only
repairs skip it. With no deployed function, those attempts cannot send alerts.
`/api/digest` only generates JSON; it does not send email. Cloudflare's cron handles
calendar synchronization, not email alerts. No weekly-digest or pre-meeting sender
schedule was found in the repository. The sender's modes are `digest` and
`pre_meeting`; it does not implement a weekly aggregation job.

## Current UI behavior

`EMAIL_ALERTS_AVAILABLE=false` is an operator-verified UI readiness flag, compiled by
Vite. It defaults to false even when absent. It does not deploy, configure or
start a sender, and is not a sender kill switch.

Signup, onboarding and settings disclose unavailable delivery. Digest controls are
disabled, and both write handlers omit delivery fields while unavailable so saving
other preferences cannot erase an existing digest opt-in or frequency. Topic,
location and following preferences can still be saved. No new digest opt-in is
accepted while delivery is unavailable.

After the completion write succeeds, onboarding redirects home with a short-lived,
HttpOnly, SameSite=Lax flash cookie (Secure on HTTPS). Home consumes it once and
prevents caching that personalized response. Signed-in users see an accessible,
focused “Setup complete” banner with a Settings link and the current delivery state.
React Router form submission now displays action errors instead of swallowing them
inside an independent fetch. Completion and preferences are saved in one checked
profile upsert rather than an unchecked second update.

## Requirements before activation

1. Choose and verify a Langford sender/domain with Resend, then replace the legacy
   sender branding and base URL. Domain authentication and a provider credential
   require a separately approved setup; no credentials are added by this change.
2. Review the Edge Function's authorization, database RPC contracts, consent
   filtering, duplicate/retry handling, and unsubscribe behavior before deployment.
   Save `RESEND_API_KEY` only in the approved Edge Function secret store. Use the
   existing server-side pipeline authorization; do not broaden public invocation.
3. Deploy the reviewed `send-alerts` function to the Langford project and verify
   the existing post-ingestion trigger. Weekly and pre-meeting options need their
   own implemented scheduler/aggregation or must remain unavailable in the UI.
4. Verify delivery using an explicitly approved recipient/test. No such send was
   authorized or performed for this work.
5. Only then set `EMAIL_ALERTS_AVAILABLE=true` and rebuild/deploy the web app,
   checking build-time overrides. The flag alone cannot activate sending.

This PR changes presentation and preference handling only. It does not deploy the
sender, add secrets, change Supabase Auth settings, alter RLS, run pipeline jobs,
or change the existing pipeline alert trigger.
