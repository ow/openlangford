# Account and application-email administration

Routes: `/admin/users`, `/admin/users/:id`, `/admin/emails`, `/admin/emails/:id`.
Every loader and read-only action checks the existing explicit admin email allowlist
before obtaining the server-only Supabase client. Responses, errors, redirects,
SSR documents and React Router data responses use `Cache-Control: private, no-store`.
No new API, browser Supabase access, export, account editing, send button, policy
relaxation, data-cache entry or admin-role assignment is introduced.

## Accounts

Supabase Auth is canonical, joined to saved profiles so pending accounts without
profiles remain visible. Only selected account fields are serialized: no identities,
raw metadata, credentials or street addresses. Auth's SDK supplies 25 accounts per
page; name/email filtering explicitly applies to that page (it has no global-search
argument). At most 25 exact HEAD counts transfer no subscription contents. Details
paginate 25 active subscriptions with topic/matter/person labels, keywords,
neighbourhood/radius and saved digest/contact preferences. Deleted subscriptions
have no history. Auth email confirmation does not verify an alternate notification
address, and a saved preference is not proof of delivery readiness.

## Proposed database migration — not applied

`supabase/migrations/20261025052302_47_20_application_email_ledger.sql` creates only:

- `public.email_messages`: one application alert, recipient/subject/type, unique
  deduplication key, status/provider ID, attempt count, transition timestamps,
  optional safe plaintext excerpt and redacted last error.
- `public.email_events`: append-only attempt/provider timeline, with a unique
  provider event ID for future webhook deduplication.
- Four pagination/filter indexes. Both tables use RLS with no browser-role policies.
  Table privileges are revoked from PUBLIC/anon/authenticated; the existing
  service_role gets message read/write and event read/insert/delete privileges.

Applying it to production requires a separately reviewed database-owner operation
and explicit approval of those new private tables and service-role grants. Existing
Auth/subscription schemas, policies and allowlists are unchanged. App deployment
does not apply the migration. No new secret is required for admin reads: the
existing server `SUPABASE_SECRET_KEY` and project URL are reused after authorization.

Missing tables show "ledger not installed". An installed empty ledger shows no
matching records, never that no emails were sent elsewhere. Unexpected database
errors return generic 503 responses, not a false empty history. This PR does not
connect `send-alerts`, migrate its old `alert_log` contract, read Resend, enable
sending/scheduling or change readiness flags. Auth emails remain outside coverage.

## Future writer contract — outside this PR

Create/claim a logical message before sending. Reuse its stable deduplication key
for retries/provider idempotency, append each attempt and persist the provider ID.
`accepted` means API acceptance; only a verified provider event may establish
`delivered`, bounced or complained. Maintain counts/status/transition timestamps
atomically; late events must not erase a later bounce or suppression state.
Do not store raw provider payloads, Auth confirmation/reset bodies, credentials,
auth codes or token-bearing URLs. Only store deliberately safe plaintext excerpts
and redacted errors. Readers withhold previews with HTML, links, auth-like content
or token-like strings before serialization. They never render HTML or load remote
resources. Do not treat these defensive redactions as permission to store secrets.

Recipient addresses are administrative PII. Agree retention/deletion handling
before connecting a writer; avoid indefinite body storage. Account deletion nulls
the message user ID, but recipient retention needs that separate reviewed process.
Historical Auth/provider messages require an explicitly scoped log integration;
this ledger cannot reconstruct them or guarantee complete past email coverage.

## Validation

Focused route/data-access, service and UI tests; typegen, TypeScript and production
build. Exercise anonymous/ordinary users at each registered route and action,
including direct data requests. Use synthetic fixtures only for screenshots:
no auth bypass, live test accounts or production writes.

Verified for this draft: 73 focused tests passed across admin access, audience
routes, component navigation and existing auth controls; TypeScript and production
build passed. The proposed SQL was also executed in an isolated PGlite PostgreSQL
runtime with synthetic data: RLS was enabled, anon/authenticated read/delete denied,
service-role read/write succeeded, duplicate message keys were rejected, event
updates were denied, and deleting a synthetic Auth user detached its message ID.
This is local migration validation, not a production migration or delivery test.
Independent security review found a short-PIN preview gap; loader-boundary tests
now cover it and the reviewer confirmed the fix with no remaining blocker.

## Synthetic UI proof

These screenshots render the actual route components with `.test` fixture accounts.
They demonstrate presentation only, not live admin authentication or live email
records. Production was not accessed for these screenshots.

- [Users](images/admin-audience/users.jpg)
- [User and subscriptions](images/admin-audience/user-detail.jpg)
- [Application email activity](images/admin-audience/emails.jpg)
- [Email details and safe preview](images/admin-audience/email-detail.jpg)
- [Undeployed ledger state](images/admin-audience/ledger-unavailable.jpg)
