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

## Reliability follow-up (proposed, not rolled out)

The old pipeline enqueued at ingestion, before embedding generation, and lost an
enqueue if its HTTP call failed. The pipeline now records only that explicit
meeting's intent in a local SQLite outbox before any HTTP call. The embedding pass
drains it after embedding generation; the existing pipeline worker also drains
one due intent each polling loop, including when no pipeline job is queued.
SQL migration `20261025160430_47_22_email_enqueue_readiness.sql` replaces only the existing
service-only enqueue RPC. It raises a retryable readiness error while agenda items with title, summary,
debate or matching linked/timed transcript text lack embeddings, before any
subscriber match/email insertion.
Embedding failures are therefore deferred rather than mistaken for zero matches.
It preserves the original cutoff, consent, municipality, publication and dedup rules.
No new table, broader access, RLS policy or consent transition is added by 47-22;
it explicitly reasserts the existing service-only execute ACL. This guard proves
missing vectors are available; it does not establish freshness of pre-existing
non-null vectors after unrelated content refreshes. That pre-existing embedding
invalidation limitation requires separate pipeline work, not a historical re-embed
or backfill in this fix.

Intents contain meeting IDs and retry metadata only, never recipients, content or
credentials. Default location is `$XDG_STATE_HOME/openlangford/email-enqueue.sqlite3`
(or `~/.local/state/openlangford/email-enqueue.sqlite3`); `ALERT_OUTBOX_PATH` can
select another persistent local path. Share the same durable file across pipeline
processes/deploys on this host. Keep it on persistent storage, not a disposable
checkout/container filesystem. The file is private (0600), with SQLite transactions
and two-minute leases so concurrent processes cannot claim the same attempt. Late
responses cannot overwrite a newer lease's receipt.

Transient HTTP/transport/invalid-receipt failures retry with one-minute exponential
backoff capped at one hour, at most 12 requests and 23 hours from the original
intent. Repeated ingestion does not reset identity, attempts or deadline. The
server's unique meeting/user/mode key handles a lost HTTP receipt after insertion.
Permanent HTTP errors stop. Off/test-mode skips are terminal locally, never held
for later activation. A successful zero (including cutoff rejection) is terminal.
Expired/failed rows are retained for operator inspection; there is no automatic
historical scan, backfill, deadline reset or resend. An idle continuously running
pipeline worker is required for automatic retries after a standalone CLI exits.
If the local outbox cannot persist a new intent, a typed failure carries its exact
meeting ID and original creation/expiry times. The ops worker atomically stores a
versioned recovery marker in the existing failed job args before best-effort logs.
Admin job retry already copies those args. Recovery validates the canonical archive
meeting and municipality and restores the original clock before ingestion, so
cached skips and repeated forced attempts cannot drop or extend the intent. Expired
or mismatched markers are rejected. No marker means no cached/source-only replay.
Bulk/CLI ingestion propagates the typed storage failure rather than silently
continuing; operators must repair storage and preserve the reported exact meeting
and original deadline for scoped recovery, never scan old meetings or reset its
clock. Subsequent retry-read failures log a generic warning and preserve rows.

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
rerun the test as live, reset outbox/ledger keys, or run broad catch-up commands.
Source-only documentary repairs still do not create an alert intent. Weekly and
pre-meeting emails remain deferred.

## Remaining production approvals / activation order

1. Review/merge this reliability fix and separately approve applying only migration
   47-22 to `zxcvifwkaxtdfpanlwtl`; deploy it before any live enqueue. Keep all gates off.
   Ensure the actual pipeline runtime uses the merged code and a persistent shared
   outbox path. Process restart is a separate approved operation.
2. Rotate `ALERT_WORKER_KEY` (at least 32 random characters) while Edge mode is off,
   storing the same value only in Supabase Edge secrets, Cloudflare
   `langford-intelligence` runtime secrets, and the running pipeline environment.
   The test key's temporary copy was removed and Supabase does not reveal stored
   values. Do not create broad Cloudflare/API credentials just for this: the owner
   has dashboard access. Never inline this key through Vite/build variables. Reuse
   the deployed `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and platform backend keys;
   no new Resend key or webhook is needed.
3. Obtain explicit live subscriber-send approval and the exact forward cutoff.
   Recheck consent, suppression, pending queues, retention policy and build overrides.
   Remove `ALERT_TEST_RECIPIENT`; set Edge mode `live` and `ALERT_START_DATE` to the
   agreed date. Enable tracked Worker dispatch and UI readiness flags and rebuild.
   The existing `*/5 * * * *` trigger dispatches at most five messages per run to
   `/functions/v1/send-alerts`; the pipeline enqueues only explicitly ingested meetings.
4. Owner may explicitly opt back in through Settings after public readiness is on;
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
readiness and rebuild. Off-mode enqueue receipts are terminal in the local outbox.
Keep private ledger, suppression and deduplication history; do not reset accepted
messages or retry deadlines. A provider request already in flight may finish.

An accidentally named `end-alerts` endpoint remains JWT-protected, with no configured
caller/schedule; its only observed request was the rejected authentication probe.
Delete only that unused endpoint after the separate owner approval. It is not used
by this implementation, the Cloudflare cron, or the Resend webhook.

## Follow-up verification

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
