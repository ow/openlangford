# Per-meeting application email rollout (not activated)

Approved From: **Open Langford <alerts@openlangford.ca>**. The owner reports domain
setup and `RESEND_API_KEY` deployment complete. The connected Resend account does
not list this domain; its verification cannot independently establish the separate
key-owning account's state. Do not read/paste the deployed key to bridge accounts.
Get the verified domain status from the correct account before the test stage.

This PR implements the per-meeting path and ports PR32's readiness/onboarding fixes.
Public signup stays enabled. All sending/dispatch/readiness switches remain off.
No production migration, secret creation/upload, webhook registration or send was
performed. Auth confirmation/reset SMTP is separate and is unchanged/unverified.

## Consent evidence and catch-up protection

The old UI defaulted digest opt-in off and explicitly offered email after every
meeting. Migration 47-21 preserves only completed profiles with `digest_enabled=true`
and `digest_frequency=each_meeting`, recording `legacy-digest-v1` without inventing
a consent timestamp. Existing weekly choices, unfinished profiles and saved follows
alone are not activated. Existing fields/preferences are not cleared. A read-only,
bounded profile-cohort inspection during development returned zero profile rows;
that is not a claim that Auth has no accounts. Review cohort counts again before
applying the migration, including any operator-created/imported records with unclear
provenance. Do not silently activate such uncertain records.

New consent is explicit and separate from following records. Ordinary profile saves
preserve valid consent evidence. A true opt-out/re-opt-in rotates it. Only confirmed
Auth email addresses are eligible; a different saved notification address is not.
Frequency must be each_meeting. All-meeting digest opt-ins receive each digest;
otherwise active matter/topic/keyword/person/neighbourhood subscriptions must match.
Current numeric profile coordinates and agenda JSON lat/lng are supported.

A mandatory `ALERT_START_DATE` cutoff is independent of consent. Live ingestion
before that meeting date, future/agenda-only meetings and other municipalities are
skipped. Source-only documentary repairs continue to skip the trigger. There is no
backfill job. Settings and onboarding can still save preferences while UI readiness
is off; they cannot create/erase delivery choices through disabled fields.

## Queue and provider behavior

Migration 47-20 defines private email_messages/email_events. 47-21 adds the queue
payload, frozen provider request, unsubscribe capability, lease/retry/deadline fields,
consent evidence and private email_suppressions. Enqueue has a unique meeting/user/
mode key. Dispatch leases with SKIP LOCKED, logs attempts before network I/O, rechecks
current consent/suppression/cutoff and only sends the frozen request. Resend gets a
stable idempotency key. Transient failures retry with backoff (max five attempts);
all ambiguity expires after 23 hours, before the provider's 24-hour key window.
Known acceptance and stronger provider states never downgrade on a late HTTP error.

Templates contain escaped HTML and text, Langford-only links, and one-click opt-out.
GET unsubscribe never mutates; POST uses an opaque per-message capability and emits
no address. Links/HTML/auth-like content are withheld from admin previews. Bearer
opt-out URLs are excluded from app analytics/referrers/canonical links; do not add
them to logs. Full provider payloads remain service-only and are never admin DTOs.
Agree retention for recipient/payload data before production activation.

`email-events` verifies fresh Svix HMAC over exact raw bytes, deduplicates provider
event IDs, correlates only a stored message/recipient, and persists minimal metadata.
Accepted is not delivered. Delivery means the provider reports the recipient mail
server accepted it, not proof it was read or reached the inbox. Bounce/complaint/
provider suppression prevents later sends; explicit resubscribe only clears an
unsubscribe suppression, never bounce/complaint/provider suppression. Auth and
unclassified provider events cannot create application email history.

## Exact staged rollout — requires separate action-time approvals

1. **Database approval:** apply 47-20 then 47-21 to the Langford project, after
   reviewing current schema and the explicit legacy cohort. New private tables:
   email_messages, email_events, email_suppressions; four original indexes plus
   unsubscribe/pending indexes. RLS is enabled, browser-role privileges revoked;
   only service_role has queue access. Existing profile RLS/admin allowlist is
   unchanged. New SECURITY DEFINER functions have fixed search paths and service-
   role-only execute grants except set_email_alert_consent, granted only to
   authenticated and constrained to auth.uid(). No public RPC execute grant.
   47-21 copies the narrow legacy choice cohort and adds columns to user_profiles
   and email_messages. These are new privileged objects/grants and a reviewed
   data transition: app deploy does not apply them automatically.
2. **Credential/deployment approval:** create one scoped random `ALERT_WORKER_KEY`
   (at least 32 characters), stored only as a runtime secret in Supabase Edge
   Functions, the Cloudflare `langford-intelligence` Worker, and pipeline runtime.
   Never inline it via Vite/build variables or commit it. No broad Supabase admin
   key is transmitted by the trigger. Deploy send-alerts with gateway JWT checking
   disabled ONLY after approving its replacement constant-time shared-key check;
   without this exact key the function rejects before database/provider work.
   Deploy email-events with gateway JWT checking disabled ONLY after approving its
   signature-only public webhook transport. This is an action-time security choice,
   not blanket approval implied by this implementation PR.
3. **Webhook approval:** register the endpoint
   `https://zxcvifwkaxtdfpanlwtl.supabase.co/functions/v1/email-events` in the correct
   Resend account for email.sent/delivered/failed/bounced/complained/suppressed.
   Store its signing secret as `RESEND_WEBHOOK_SECRET` in Supabase only. The existing
   `RESEND_API_KEY` stays in Supabase. SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are
   platform Edge variables; do not copy them into the frontend or new callers.
4. **Approved single-recipient test:** keep web EMAIL_ALERTS_AVAILABLE=false and
   EMAIL_ALERT_DISPATCH_ENABLED=false. Set Edge `ALERT_DELIVERY_MODE=test`, a valid
   `ALERT_START_DATE`, and an explicitly approved `ALERT_TEST_RECIPIENT`. That Auth
   account must have a confirmed email and explicit per-meeting consent (do not
   create an account or force consent without approval). POST `{action:"test",
   meeting_id:<approved existing Langford meeting with minutes/transcript>}` using
   the worker key. This bypasses cutoff only for that configured test identity;
   normal pipeline enqueue is skipped. POST `{action:"dispatch"}` with the same
   key. Verify one email, approved From/text/HTML/links, provider ID and accepted
   then signed delivered status, and unsubscribe behavior. Repeating the same
   enqueue must not send a second logical email. Offline tests do not prove this.
5. **Separate live-send approval:** choose the exact forward-looking meeting cutoff
   and confirm consent cohorts, retention, verified domain and recipient test.
   Remove the test-recipient setting; set Edge mode live plus ALERT_START_DATE.
   Explicitly enable Worker EMAIL_ALERT_DISPATCH_ENABLED=true (five-message batches
   every five minutes), provision the pipeline key if not already done, then set
   UI EMAIL_ALERTS_AVAILABLE=true and rebuild after checking build overrides. Only
   this step enables subscriber sends. Weekly/pre-meeting paths remain absent.
6. **Rollback:** first set Edge ALERT_DELIVERY_MODE=off. Then disable Worker dispatch
   and UI readiness and rebuild. Keep ledger/suppression history; do not clear
   deduplication keys or reset accepted messages to resend. A request already in
   flight can be accepted before an opt-out/kill takes effect; it is recorded, and
   no subsequent delivery attempt is permitted after rechecking current state.

## Verification

Use isolated PGlite/PostgreSQL fixtures and mocked provider transport. Verify real
SQL consent/matching/leases/deduplication/suppression/event ordering and role grants;
verify Edge authorization, exact test-recipient fences, provider payload stability,
timeouts/retry classification, signatures and no provider-body logging. Run web
route/DOM/auth/admin tests, typecheck/build, Deno check, and focused pipeline tests.
Production confirmations, inbox delivery, DNS and webhook configuration are separate
proof. The admin pages from PR40 show only this ledger; they do not import old emails.
