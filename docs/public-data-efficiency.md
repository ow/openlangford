# Public data reuse and transfer limits

The Worker explicitly stores **public JSON computations in Cloudflare's existing Cache API**.
No R2/KV binding, paid service, new credential, precompute job is required for caching. SQL attendance aggregation requires the additive migration below.
This is demand-filled caching, not a build-time export of the whole website.

## What is shared

- Sitemap URL lists: municipality and content section in the key, for one hour. Only
  public path/date/priority projections are stored; XML rendering and municipality
  metadata lookup remain separate. See [the dated audit](egress-audit-2026-10-21.md).

- Home summaries and incoming council: municipality, civic day and relevant metadata in the key.
- Matters list and participant/coverage aggregates: municipality in the key. `computed_cache`
  database rows are no longer read or written for these computations.
- Annual meeting lists/stats and history date bounds: municipality and selected year where relevant.
- Council list: public people and compact attendance totals per term. Raw attendance notes/history
  stay in Postgres for this council summary. The SQL aggregation matches the existing evidence calculation for present, absent, unknown,
  conflicting, verified and legacy-recorded attendance; no evidence is invented or reclassified.
- `/api/meeting-text`: explicit anonymous response caching for full transcript words or bounded
  document-section selectors. Selectors/representations are distinct from page and navigation caches.

The public-data helper caches explicit DTOs, **never whole root/session responses**. Each loader still
renders its own response, with its own user data and headers. Admission rejects Authorization,
Supabase/unknown/consent cookies, conditional/range and explicit cache-bypass headers. Only the exact
configured PostHog cookie is allowed alongside cookie-free requests, as in the existing archive cache.
Auth/bypass requests do not join anonymous in-flight computations. Public home data uses the fixed
anonymous Supabase client; other new cached computations use fixed public projections, no request
session client. No user-dependent computation belongs in `publicData()`.

## Freshness and failure

Sitemap URL lists expire after **one hour**. Other public DTO entries expire after **300 seconds**, except annual meeting data whose
entire year ended at least 30 days ago: those entries expire after **24 hours**.
Current/upcoming years and the previous year during January retain five minutes.
Council roster/stat summaries include current facts and retain five minutes.
Every entry includes Worker and public-content versions; see
[the explicit owner correction refresh procedure](public-meeting-cache.md#owner-procedure-publish-a-correction-refresh).
Admin changes, imports and direct SQL do **not** automatically refresh caches.
Without that manual deployment, historical corrections may remain stale for up to
24 hours. Nested municipality/council-term metadata can add up to 60 seconds to
the five-minute policy; fresh Worker deployment also resets those isolate caches.

Cache API entries are local to the Cloudflare data center and can be evicted. Misses still query
Supabase. Concurrent summary fills coalesce within one isolate. No cross-region hit or free-quota
fit is promised. Thrown errors, incomplete home summaries and failed meeting-stat computations
are not stored. Cache failures fall through to origin; no stale partial result is invented.

`X-Public-Data-Cache` reports the distinct HIT/MISS/BYPASS states of public DTO lookups in that
request. `X-Public-Meeting-Cache` still reports the guarded archive/text **response** cache.
Delivery uses private/no-store to avoid downstream reuse of a page after a session change.
Private/session responses are not themselves placed in a shared response cache.

## Text demand and query scope

Summary-only meeting visits do not request transcript words. Opening the full transcript,
following a transcript hash, selecting the video transcript sidebar or enabling/seeking playback
loads the text, preserving transcript search and captions. The full text is still fetched once
needed; playback-window chunking is not part of this pass. Meeting content remounts on meeting ID
changes so an earlier meeting's playback cannot trigger later summary-only downloads. Failed full
transcript requests offer retry in the transcript drawer.

Document sections fetch only on expansion, in batches of at most 200 unique IDs. Reopening fetches
again through the edge cache instead of retaining an indefinite browser Map. Failures offer retry.
Empty/missing text API results are not cached.

The council list calls `council_attendance_summaries(municipality, civic_day)`:
Postgres validates source evidence and aggregates expected meetings, membership
intervals, conflicts, unknown and legacy-recorded attendance across all terms.
Only counts/rates cross the Supabase-to-Worker boundary, alongside public roster
metadata. There is no materialized view or refresh job. The same complete public DTO now supplies comparison all-service stats and
individual profile all-service/selected-term totals. Profiles still retrieve their
20-row evidence page, preserving notes/source links, counts and membership/period
filters. Other profile analytics, root/session and municipality work can still read
the database. This is not proof of zero database reads site-wide.
Meeting-stat reads filter the **existing RPC output** to shown meeting IDs in bounded batches.
This reduces transferred rows; SQL aggregate CPU savings have not been measured.

## Verification and practical limits

Regression tests exercise DOM demand/navigation/retry, real Supabase-client HTTP selectors,
attendance pagination beyond 1,000 rows, compact evidence-equivalent summaries, origin-call reuse,
municipality/year/deployment separation, auth/cookie bypass, concurrent fills and expiry/corrections.
Fixture transfer savings are not production egress/billing measurements. Organization/project/service
usage attribution still requires the Supabase usage dashboard. Search, admin, root auth and other routes have not been broadly cached by this change.

## Database prerequisite (approval required before application)

Apply `supabase/migrations/20261021041012_47_17_council_attendance_summaries.sql` to the existing
production Supabase project **before merging/deploying its Worker caller**.
It transactionally defines three evidence helpers and one read-only aggregate RPC,
revokes public/anon/authenticated execution, grants execution only to the existing
`service_role`, and notifies PostgREST to reload its schema. No records or tables
are changed. It uses invoker security and existing service-role table access.
Production application is a separate explicitly approved action; merge authority
alone does not authorize it. A missing/error/partial RPC fails the summary rather
than inventing zero attendance. Local PostgreSQL tests verify semantic parity,
read-only behavior and grants; production verification is recorded below.

## Coverage audit and release sequence

| Surface | Cold attendance path after this change | Warm shared hit |
| --- | --- | --- |
| Council list `/people` and term switch | Organization ID, public roster/memberships, compact SQL RPC and term metadata; **no attendance/history transfer** | Zero calls from this summary computation; municipality/root work is separate |
| Compare `/compare` | Same compact public DTO; existing all-service stats and roster order | Reuses the council DTO without extra attendance reads |
| Individual council profile | Same all-service/selected-term SQL totals plus the displayed 20-row evidence page; no bulk attendance/meeting metadata for totals | Reuses the council DTO; still reads displayed evidence and other profile analytics |
| Historical meeting/document route-only navigation and text | Existing loader/text queries on a miss | Entire admitted response avoids loader queries for up to 24h |
| Historical annual meeting list | Existing selected-year queries on a miss | Cached public DTO avoids list/stat queries for up to 24h; other loader/root calls can remain |

The public DTO validates all required member/term/all-service pairs before caching;
a partial or invalid RPC result is never retained. Council, comparison and profile
counts share one key, avoiding stacked TTLs. Profile details are not replaced by
totals, and session/private root data never enter this DTO.

Remaining raw-history fallback: the legacy generic `getPeopleWithStats` and
`getPersonProfile` calls exposed by `hooks/use-api.ts` retain their existing behavior
when no compact summary is supplied. No current route calls that hook. The active
comparison/profile routes explicitly use compact summaries. The unused raw council
helper was removed after its last real route caller switched to the aggregate RPC.

Activation:

1. Obtain explicit owner approval for the production SQL/grants; until then, leave
   the PR unmerged with auto-merge disabled.
2. Apply the migration transaction to project `zxcvifwkaxtdfpanlwtl` via existing
   authorized database access. Confirm commit and PostgREST schema reload.
3. Read the RPC with existing service-role access for municipality 1 and the same
   civic day as the previous calculation. Compare all member-term outputs and
   measure actual response bytes; verify anon/authenticated execution is denied.
   If any check fails, do not merge the caller. No new credentials are required.
4. Merge only after the prerequisite succeeds. Wait for the existing automatic
   production build, record the Worker version, then verify council cold/warm
   queries, historical text/navigation HITs, auth/unknown-cookie bypass, and manual
   content-version refresh behavior. Local tests do not substitute for these checks.

Rollback:

- If migration application fails, the explicit transaction rolls back; the existing
  application remains active and the dependent PR stays unmerged. Check the actual
  transaction outcome before retrying an uncertain failure.
- If SQL verification fails after commit, keep the existing application and leave
  the additive, unused functions installed while diagnosing; no data rollback is
  needed because this migration does not change records.
- If the new application fails after release, revert its code through a new normal
  commit/build with a fresh public-content version. Verify that deployment before
  considering removal of the unused functions. Do not activate an old cached Worker
  namespace after content corrections.
- Function removal is optional and requires separately authorized SQL: drop
  `council_attendance_summaries(bigint,date)` first, then
  `_council_attendance_state(text,text,bigint,bigint,date)`, then
  `_council_attendance_js_text(json)` and `_council_attendance_trim(text)`, followed
  by a PostgREST schema reload. Never drop them while the new caller is active.

## Production prerequisite verification for this release

The separately approved migration was applied successfully to project
`zxcvifwkaxtdfpanlwtl`; no records were changed. All four functions use invoker
security, deny `anon`/`authenticated` execution and permit the existing
`service_role`. Actual read-only role execution confirmed both denials and a
72-row service-role result.

For civic day **2026-10-20**, all **72** current production member/term/all-service
outputs exactly matched the previous JavaScript calculation. The RPC returned
**8,755 bytes** on each of three HTTP reads, with **722/261/266 ms HTTP wall time**.
The prior scoped attendance history required five response pages totaling
**933,763 bytes** (4,489 attendance rows), plus meeting/roster metadata. These are
actual uncompressed HTTP response-body byte counts, not wire-compression, CPU-time,
organization egress attribution or billing measurements. This verifies the database
prerequisite; application deployment and live route/cache checks are separate steps.
