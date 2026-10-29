# Per-meeting email alerts: test completed, live delivery off

From: **Open Langford <alerts@openlangford.ca>**. On October 25 the owner-approved
single-recipient test completed: one October 5 meeting402 email, one attempt,
provider acceptance and a signature-verified delivery event. Duplicate enqueue
returned zero new messages. Scanner GET did not unsubscribe; one-click POST did.
The owner test identity is consequently opted out until it explicitly opts in again.
The correct Resend account/domain was verified in the owner's Safari session.
No Auth SMTP changes or Auth-email delivery proof are implied.

PR46 is merged and deployed. Migrations `20261025052302_47_20_application_email_ledger.sql` and
`20261025081711_47_21_per_meeting_email_alerts.sql` are applied. Sender and signed-event functions,
the six-event webhook and their Supabase secrets exist. Public signups remain on;
`EMAIL_ALERTS_AVAILABLE=false`, `EMAIL_ALERT_DISPATCH_ENABLED=false`, and Edge
`ALERT_DELIVERY_MODE=off`. There are no pending/live email records from the test.

## Enqueue path: the Cloudflare Worker cron (October 29)

Migration `20261025160430_47_22_email_enqueue_readiness.sql` is applied in production: the enqueue
RPC raises `Email matching data not ready` (SQLSTATE 55000) while agenda items with
title, summary, debate or matching linked/timed transcript text lack embeddings,
before any subscriber match or email insertion. The deployed `send-alerts` Edge
function reports it (like any RPC failure) as HTTP 503, so callers retry rather
than mistake it for zero. It preserves the original cutoff, consent, municipality,
publication (`has_minutes OR has_transcript`, meeting date not in the future) and
dedup rules. It proves vectors exist, not that pre-existing vectors are fresh after
unrelated content refreshes; that limitation needs separate pipeline work.

Enqueue now runs in the web Worker (`apps/web/workers/email-enqueue.ts`), on the
existing `*/5 * * * *` cron, immediately before `dispatch`. No pipeline worker,
long-running process or persistent local file is needed. The Edge functions are
unchanged; the Worker calls the deployed `enqueue` action as-is.

- **Gates (all required, else nothing runs, no DB read, no HTTP):**
  `EMAIL_ALERT_DISPATCH_ENABLED="true"`, runtime secret `ALERT_WORKER_KEY`, and a
  valid `EMAIL_ALERT_START_DATE` (YYYY-MM-DD, `wrangler.toml [vars]`, empty by
  default). Set it to the same date as Edge `ALERT_START_DATE`.
- **Candidates:** Langford meetings with status `Completed` or `Occurred`,
  `has_minutes OR has_transcript`, meeting date from
  `max(EMAIL_ALERT_START_DATE, today - 14 days)` to today (UTC), and not updated in
  the last 30 minutes (lets an ingestion finish). Never a historical catch-up: the
  14-day window and the start date both bound it. The server still enforces its
  own `ALERT_START_DATE`.
- **Bound:** at most 5 enqueue calls per cron run, 10s per call, 25s total for the
  enqueue step, then dispatch (unchanged, 55s timeout, at most 5 messages).
- **Receipts:** `email_enqueue_receipts` (migration
  `20261029160000_email_enqueue_receipts.sql`; empty, RLS on, service-role only,
  meeting IDs and retry metadata only) records one row per meeting. `{skipped:true}`
  (off/test mode) is terminal, never held for later activation. `queued` >= 0
  (including a deduplicated or cutoff-ineligible zero) is terminal. Readiness/503,
  408, 425, 429, 5xx and transport errors retry with one-minute exponential
  backoff capped at one hour, at most 12 attempts and 23 hours from the first
  attempt, then `expired`. Other 4xx are `failed`. Expired/failed rows are kept for
  inspection; do not reset them.
- **Without the receipts table** the Worker still works: it re-asks for every
  candidate each run (rotating within the 5-call bound) and the server's unique
  meeting/user/mode key dedups. Prefer having the table before go-live: without it a
  subscriber who opts in during the 14-day window could be matched to a meeting
  that had zero matches earlier.

The pipeline's local SQLite outbox (`pipeline/email_outbox.py`) is now off by
default (`PIPELINE_EMAIL_OUTBOX` unset/false): ingestion records no intent, the
embedding pass and idle ops worker drain nothing, and job recovery markers are
ignored. Do not enable it alongside the Worker; there must be one enqueue path.
The pipeline needs no `ALERT_WORKER_KEY` and no `ALERT_OUTBOX_PATH`.

## Consent and no historical catch-up

Existing completed, explicit `digest_enabled=true` / `each_meeting` choices retain
`legacy-digest-v1` without a fabricated timestamp. Weekly, unfinished and follow-
only records were not activated. New opt-ins are explicit; ordinary saves preserve
evidence. Only confirmed Auth addresses (not a different notification address)
are eligible, and all suppression/consent/frequency checks run at enqueue/send.
The read-only post-test assessment found two eligible all-meeting subscribers;
recheck aggregate eligibility immediately before live activation.

`ALERT_START_DATE` is mandatory and applies to the **meeting date**, separately
from consent or ingestion date. For activation on October 25 propose October 26;
if activating later, agree a new forward-only date. Do not enqueue old meetings,
rerun the test as live, reset enqueue receipts/ledger keys, or run broad catch-up commands.
Source-only documentary repairs still do not create an alert intent. Weekly and
pre-meeting emails remain deferred.

## Remaining production approvals / activation order

1. Merge the Worker enqueue change. It is inert in production while the gates are
   off. Merging also applies `20261029160000_email_enqueue_receipts.sql` through the
   migrations Action (empty service-only table; safe while delivery is off). Confirm
   the table exists before step 4. Nothing else needs applying; 47-22 is in place.
   Keep all gates off.
2. Rotate `ALERT_WORKER_KEY` (at least 32 random characters) while Edge mode is off,
   storing the same value only in Supabase Edge secrets and Cloudflare
   `langford-intelligence` runtime secrets (not the pipeline). The test key's
   temporary copy was removed and Supabase does not reveal stored values. Do not
   create broad Cloudflare/API credentials just for this: the owner has dashboard
   access. Never inline this key through Vite/build variables. Reuse the deployed
   `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and platform backend keys; no new
   Resend key or webhook is needed.
3. Obtain explicit live subscriber-send approval and the exact forward cutoff
   (the go-live meeting date). Recheck consent, suppression, pending queues,
   retention policy and build overrides.
4. Edge first: remove `ALERT_TEST_RECIPIENT`; set `ALERT_START_DATE` to the agreed
   date and `ALERT_DELIVERY_MODE=live`. Do this before step 5: while Edge mode is
   off, a gated-on Worker would record `skipped` (terminal) receipts.
5. Worker: in `apps/web/wrangler.toml` set `EMAIL_ALERT_START_DATE` to the same date,
   `EMAIL_ALERT_DISPATCH_ENABLED="true"` and `EMAIL_ALERTS_AVAILABLE="true"`; merge
   and deploy. Within five minutes the cron enqueues eligible meetings dated on/after
   the cutoff (at most five calls per run), then dispatches at most five messages
   per run to `/functions/v1/send-alerts`.
6. Owner may explicitly opt back in through Settings after public readiness is on;
   clear only its unsubscribe suppression via the existing authenticated consent RPC.
   Never clear another user's choices or a bounce/complaint/provider suppression.

The approved backend transport is unchanged: sender gateway JWT checking is off,
replaced by constant-time `X-Alert-Worker-Key`; webhook gateway JWT checking is off,
replaced by fresh raw-body Svix HMAC. Webhook events are
email.sent/delivered/failed/bounced/complained/suppressed, deduplicated by event ID;
only matching application records persist provider IDs/status/timestamps.
Provider acceptance and mail-server delivery remain distinct; neither proves read
or inbox placement. Admin previews omit raw payloads, HTML and opt-out capabilities.

## Rollback and retained cleanup

First set Edge `ALERT_DELIVERY_MODE=off`, then disable Worker dispatch and public
readiness and rebuild (which also stops Worker enqueue). Off-mode `skipped` enqueue
receipts are terminal in `email_enqueue_receipts`.
Keep private ledger, suppression and deduplication history; do not reset accepted
messages or retry deadlines. A provider request already in flight may finish.

An accidentally named `end-alerts` endpoint remains JWT-protected, with no configured
caller/schedule; its only observed request was the rejected authentication probe.
Delete only that unused endpoint after the separate owner approval. It is not used
by this implementation, the Cloudflare cron, or the Resend webhook.

## Follow-up verification

Worker enqueue (October 29): vitest covers gating (nothing read or sent with any gate
off or before the start date), candidate window/start date/status/publication/settle
filters, skipped/queued/not-ready/permanent/transport handling, backoff, 23-hour and
12-attempt expiry, the five-call bound and the missing-receipts fallback. Pipeline
tests cover the outbox being a no-op with its flag off. No production enqueue or
send was performed; the deploy is inert with the gates off.

Earlier pipeline-outbox follow-up (now superseded by the Worker path):

The keyword regression failed on the original enqueue RPC (it returned terminal
zero before vectors existed); the pipeline ordering regression failed because
HTTP ran before embedding. Both pass with this fix. SQL cases cover title,
summary, debate and linked/timed transcript inputs. Real SQLite cases cover
restart/backoff, lost receipts, duplicate intent, concurrent/stale leases,
expiry/attempt caps, disabled/permanent rejection, idle worker recovery, first
storage failure plus cached/forced job retries, and immutable recovery deadlines.

Validation on main 54f0a13: 621 web tests passed / 4 skipped, 53 focused pipeline
and stage tests passed, typegen/TypeScript and production build passed. A broader
legacy orchestrator fixture has 25 setup errors patching a removed VimeoClient;
the same 25 errors were reproduced with untouched origin/main's orchestrator.
Independent review's readiness and recovery-window findings were repaired and
re-reviewed with no remaining blocker in these fixes. No production actions or
provider sends were performed for this follow-up.
