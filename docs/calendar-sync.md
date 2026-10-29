# Official calendar import

The Cloudflare Worker runs metadata-only calendar sync at **00:17 and 12:17 UTC**
(`17 */12 * * *`). It reuses the existing server-side Supabase client. No new
credentials, AI calls, media processing, Mac scheduler, Queue or paid product is
required. Existing non-calendar scheduled-handler behavior is preserved.

## Sources and limits

- eSCRIBE `MeetingsCalendarView.aspx/GetCalendarMeetings`, fixed public host,
  supplies event GUIDs and local calendar timestamps. Only known Langford council
  and committee categories are allowed. Initial publication is today through
  180 days ahead, using America/Vancouver civil dates.
- The eSCRIBE response currently omits the remaining annual schedule. The
  reviewed `apps/web/app/data/langford-schedule-2026.json` contains six remaining
  dates from the City's official colour-coded annual PDF. Its SHA-256 must match
  the freshly downloaded PDF before those entries are used. This is **not
  automatic PDF parsing**. Changed bytes are held for human review. Review and
  update the manifest/hash when the City publishes changes or a new year.
- There are at most 64 proposed events, 500 input records, 2 MB per response,
  three fetch attempts per source and 10-second request timeouts. Failed fetches
  never replace good schedule data with an empty/cancelled calendar.

## Publication and identity

Only the trusted import RPC creates documentless public records. They have
`status=Planned`, a `calendar_source_id`, and public source/freshness metadata.
Historical empty archive folders still fail the ordinary ingestion content gate.
Calendar records do not fabricate attendance, a summary, documents or actual
occurrence. Unknown inauguration time remains unknown. Past dates without content
are labelled occurrence-unconfirmed, rather than processing/completed. The public
list/detail/Markdown/API readiness filter accepts verified calendar identities.

`source_meetings` retains its unique municipality/source-type/source-ID key and
points to the public record with `ingested_meeting_id`. A five-minute database
lease prevents overlapping writes, and a replaced lease token cannot commit.
Retries preserve IDs and slugs. A single exact date/type/organization/time match
can bind an annual-schedule placeholder to an eSCRIBE GUID; multiple matches or
possible nearby reschedules without an established identity are held for review.
Once established, the GUID wins over annual fallback dates. Distinct published
GUIDs may share a date. Only explicit cancellation changes status; disappearance
from a feed never cancels or deletes an event.

Python discovery later assigns the archive path to that same source identity.
Document ingestion resolves the source pointer before considering legacy
placeholders; it no longer picks the first unscoped date/type match. It preserves
calendar provenance and attaches content to the same public record. Heavy document
analysis/transcription remains separate and is not queued by calendar Cron.

## Operator verification

Apply migrations `20261020161233_47_15_calendar_sync.sql` and `20261020162205_47_16_calendar_document_reconciliation.sql` before deploying calendar import/reconciliation.
Run a dry run from `apps/web`:

```sh
node scripts/calendar-sync.mjs --output /tmp/calendar-review.json
```

Review the exact source-linked rows. With the existing backend environment loaded,
run the explicitly authorized initial import:

```sh
node scripts/calendar-sync.mjs --apply --reviewed /tmp/calendar-review.json
```

The command re-fetches and rejects changed rows before applying. Repeating it must
report zero created records. `calendar_sync_state` records lease, timestamps,
manual/Cron trigger, counts, held items, warnings and errors. Only the service role
can invoke import functions; this state table has RLS and no public policies.

Verify the deployed Cloudflare Cron list and public homepage/calendar afterwards.
An initial **manual** receipt does not prove a recurring execution. Confirm a later
`last_trigger=cron` receipt after a scheduled boundary before claiming Cron ran.
