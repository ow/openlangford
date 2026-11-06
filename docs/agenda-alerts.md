# Before-meeting agenda alerts

Residents who follow a topic, place or project get an email **before** a meeting whose agenda touches it, so they can write to council or speak at a public hearing while it still matters. The post-meeting digest (decisions and votes) is unchanged.

## What triggers one

The 5-minute Worker cron (`apps/web/workers/email-enqueue.ts`, `enqueueAgendaAlerts`) looks at Langford meetings dated tomorrow to 14 days ahead that have `has_agenda = true`, are not cancelled and have not changed for 30 minutes. For each it calls the `send-alerts` Edge function with `{"action": "enqueue", "meeting_id": N, "mode": "agenda"}`, which runs `enqueue_agenda_alert_emails(meeting, ALERT_START_DATE, test_recipient)`.

That function refuses (returns 0) unless the meeting is after today, has an agenda, is not cancelled and, for live sends, is on or after `ALERT_START_DATE`. If any agenda item with text has no embedding yet it raises "Email matching data not ready" (the Worker retries with backoff), so keyword matches are never silently missed.

Receipts live in `email_enqueue_receipts` with `kind = 'agenda'` (post-meeting digests are `kind = 'digest'`). The Worker asks again whenever the meeting's `updated_at` moves past its last receipt, so a late addition to the agenda can still be sent.

## Who gets it

Everyone `find_meeting_subscribers(meeting)` returns (confirmed sign-in email, email alerts on with consent, not suppressed, each-meeting frequency) **and** with `user_profiles.agenda_alerts_enabled` (default true; the "Before meetings" toggle in Settings and onboarding).

The items listed come from `build_agenda_preview(meeting, user)`:

- items matching the person's follows through `alert_subscription_matches(meeting)`: topic (by category), saved search (embedding similarity above 0.45), project, neighbourhood or distance from their saved place. This is the same rule post-meeting digests use; `find_meeting_subscribers` now calls it too.
- people who chose a digest of every meeting (`digest_enabled`) get every substantive item.
- procedural items (call to order, minutes, adjournment) and the generic public participation slot are left out; at most 20 items.
- each item carries why it matched, its plain-English summary, and whether it is a public hearing (meeting type, the item's category, or its own or its section's title says "public hearing", not "prior to public hearing").

If nothing matches, no email is queued.

## Dedup

- First preview: `agenda/<meeting>/user/<uid>/live`.
- If a later call finds a matching item the first preview did not list, one update goes out under `agenda/<meeting>/user/<uid>/update/live` (it says the agenda changed). Further changes, removals or reworded summaries never send again. At most two per person per meeting.
- Test sends use `/test` in place of `/live`.

At delivery `email_alert_eligible` checks again: still subscribed with the toggle on, meeting today or later, still has an agenda, not cancelled. Post-meeting digests still require minutes or a transcript.

## The email

`providerBody` in `supabase/functions/_shared/alerts.ts` renders `payload.kind = 'agenda_preview'`: "Coming up at council", the meeting date and start time (`meta.calendar.start_time`), the place (City Hall council chambers unless the meeting says otherwise), then each item with a "why you're getting this" line, its summary and a **Have your say** box. The participation wording and addresses come from the City's notices and meetings page; the sources are cited above `haveYourSay`. Recheck them if the City changes how it takes submissions.

The footer keeps the one-click unsubscribe from all council alert emails, and says how to turn off only the before-meeting ones (Settings, "Before meetings").

## Testing with a test recipient

With the Edge function in test mode (`ALERT_DELIVERY_MODE=test`, `ALERT_TEST_RECIPIENT` set to your own confirmed sign-in email, which must be a subscriber with the toggle on):

```bash
curl -X POST "$SUPABASE_URL/functions/v1/send-alerts" \
  -H "X-Alert-Worker-Key: $ALERT_WORKER_KEY" -H "Content-Type: application/json" \
  -d '{"action":"test","meeting_id":<upcoming meeting id>,"mode":"agenda"}'
```

This queues only that recipient's preview with `is_test = true` and key `.../test`; the date cutoff is skipped for the test address only. The next dispatch run sends it. Admin > Emails shows the rendered preview.

SQL tests: `apps/web/tests/services/postgres-agenda-alerts.test.ts` (needs a disposable container with pgvector, see the file header). Renderer and handler: `tests/services/email-delivery.test.ts`; Worker: `tests/services/email-enqueue.test.ts`.

## Deploying

The migration applies on merge. The Edge function is not deployed by CI: redeploy `send-alerts` (`supabase functions deploy send-alerts`) so it accepts `mode: "agenda"`. Until then agenda enqueue calls get HTTP 400 and the Worker records `failed`; it asks again the next time the meeting changes.
