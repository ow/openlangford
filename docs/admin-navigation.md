# Admin navigation and access

## Destinations

The admin directory is `/admin`. It links to:

- `/admin/matters` — matter merge review (separate from pipeline operations).
- `/admin/pipeline` — processing status and job management.
- `/admin/profiles` — councillor profile draft review.
- `/admin/people` — people and membership administration.
- `/speaker-alias` — speaker identity corrections.

A named Admin entry is shown to existing admins on desktop and mobile. Ordinary
signed-in users no longer see the speaker-editing link. Hiding links is discovery,
not authorization: every tool's loader and action independently calls requireAdmin.

The hyphenated `/admin-pipeline` and `/admin-matters` paths now redirect existing
admins to their slash-separated destinations, preserving filters. They authenticate
and authorize before redirecting; non-admin requests are denied and alias POSTs
never execute processing. This change adds no admin identities or permissions.
The root error UI now distinguishes a permission-denied 403 from a missing-page 404.

## Production diagnosis (2026-10-22)

Read-only unauthenticated requests to `/admin/pipeline` and `/admin/matters` returned
302 redirects to login with their original destinations. `/admin-pipeline` returned
404. Canonical routes are registered unconditionally; no production-only route
switch was found. Matter merge review already existed, but its navigation was an
icon on desktop and absent from the mobile menu.

Cloudflare's existing production runtime configuration includes an encrypted
`ADMIN_EMAILS` secret. Its value and individual membership were not revealed or
changed. The runtime has `nodejs_compat` and compatibility date 2026-02-10.
The application checks the email returned by Supabase getUser against the existing
explicit allowlist, and denies access when it is missing. User-supplied role/admin
metadata is not trusted.

No existing signed-in application session was available in the inspected Safari
session: the canonical production URL led to login. Consequently, the owner's
specific authenticated 404 was not reproduced. A canonical URL that still fails
for the owner needs its exact URL/status and an existing authorized session to
separate a route problem from a loader or account issue. No new login grants,
allowlist changes, or bypasses were used to obtain that evidence.

## Validation boundaries

Tests use the actual route registry with mocked Supabase identity. They verify
ordinary users (including forged admin metadata) receive 403 on GET and POST
before any privileged client is acquired, existing allowlisted admins can open
the directory and use compatibility redirects, and navigation differs correctly
for admins and ordinary users. No live pipeline jobs, matter decisions, database
writes, or alert sends are used as QA. Database policy auditing remains separate.
