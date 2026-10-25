# Historical decision coverage and bounded catch-up

An ingested meeting, or `motion_source_ingestion.status=source_authoritative`, does
not imply complete decision coverage. Source plans may still contain unparsed
formal occurrences, unbound outcomes, held bodies or unresolved legacy claims.
The source URL/date and exact original file must be bound before additions.

Run from `apps/pipeline` using the normal configured interpreter. Credentials stay
in the existing environment file; never copy them into manifests or receipts.

```sh
python -m pipeline.backfill.history_coverage audit \
  --env-file /existing/config/.env --project-ref PROJECT_REF \
  --meeting-id 262 --archive-root /existing/archive/project-root \
  --cache-dir /tmp/history-source-cache --report /tmp/history-review.json
```

Audit accepts 1–20 explicit meeting IDs. Review each proposed body, outcome,
occurrence key, source hash and held reason against the original public minutes.
A matching summary, title, heading number or model answer is not source authority.
No model is called by this command. Preserve the manifest and printed digest.

```sh
python -m pipeline.backfill.history_coverage apply \
  --env-file /existing/config/.env --project-ref PROJECT_REF \
  --manifest /tmp/history-review.json --reviewed-sha256 PRINTED_DIGEST \
  --archive-root /existing/archive/project-root \
  --cache-dir /tmp/history-source-cache --report /tmp/history-applied.json
```

Apply parses before taking write locks, then rechecks the original file bytes,
people inventory, selected meetings, agenda and complete motion rows under short
locks. A changed source or database snapshot requires a new audit and review.
It adds only unique, explicit canonical decisions, using an existing exact agenda
parent or a neutral `Official recorded motions` container. It never rewrites
existing motions, reconstructs individual votes, guesses matter links, or refreshes
transcripts. Existing unknown outcomes remain unknown and are reported separately.
An unresolved legacy claim blocks new insertions in that meeting; do not remove
it from the inventory to get a batch through.

Atomic `meetings.meta.history_catchup_receipts[MANIFEST_DIGEST]` receipts contain
inserted rows and residual coverage. `source_occurrences_accounted_for` means only
occurrence coverage, not complete votes, existing outcomes, matters, documents or
attendance. Held/unavailable states remain held even in a mixed successful batch.
After applying, rerun audit to see current coverage and retain all original reports.

If commit acknowledgement or report output fails, **do not repeat apply**. Use
`verify` with the same manifest/digest and other arguments. It reads the atomic
receipt and complete inserted parent/actor/body/outcome fields. `already_applied`
confirms the batch; `not_applied` means no receipt; mixed or changed states need
read-only reconciliation. A receipt records the historical batch, not proof that
the publisher has never subsequently corrected the original minutes.

For ongoing checks, audit bounded explicit historical/source-refresh selections
and review the residual categories rather than counting absent receipts as a
backlog. Source-only audits are cheap compared with a model/diarization replay.
Do not automatically replay a meeting because one legacy body is abbreviated.

## Worker activation is separate

The installed `com.viewroyal.langford-archive-worker-{2,3}` LaunchAgents were
observed pointing at `/Users/owen/Projects/viewroyal`, an old pre-rewrite checkout.
Do not reset/rebase that checkout or assume a web deployment updates Python workers.
The finite command above runs the current code explicitly with existing config
and originals; it does not start or reconfigure either worker.

Before moving an existing service: preserve its plist, verify no active job/PID,
select a reviewed current checkout, preserve archive paths and recovery snapshots,
check dependencies and source guard digests, then change only the existing service
entrypoint. Starting a general ingestion worker can claim queued ingestion and
diarization jobs and make configured external model calls; it is not equivalent
to this deterministic audit/apply. Do not use service activation to retry an
external model transmission that was denied separately.

## Reviewed legacy occurrence reservations

An abbreviated legacy motion can represent a real occurrence without being a
complete transcription. Do not label its missing conditions as verified text or
change a NULL outcome simply because the original source carries a result.
The deterministic catch-up command alone can opt into a repo-enrolled review in
`pipeline/backfill/data/legacy-occurrence-reviews/`. Its file hash is pinned in
code. Review requires the exact project/municipality/meeting, complete current
semantic claim inventory, original PDF bytes/URL/date/text/formal inventory,
source occurrence identity, original legacy claim and supporting native pages.
One-to-one ownership and competing exact claims are checked again at execution.

Reservations prevent inserting a duplicate occurrence; they do not emit an
existing-motion write and are reported as
`reviewed_legacy_occurrence_reserved_no_rewrite`. They never certify full text,
stored outcome, actor or individual votes. Ordinary ingestion and ballot
reconstruction do not opt into them. Any source, claim or inventory change makes
that one-time review stale and holds the batch; reenrollment requires a new
source review. This includes changes from a successful catch-up batch. Read its
atomic receipt to verify completed work; do not interpret a stale prior review
as grounds to replay it or mark a meeting complete.

## Scanned originals, source selection and notices

`reviewed_sources.py` is an explicit catch-up-only adapter. Its repo-enrolled
source reviews pin the original file inventory, catalog identity, public URL,
binary hash and review artifact. Distinct Special Council/Public Hearing records
are selected, never concatenated. A corrected header view retains the raw native
header and catalog date; committee scope review does not certify its roster.
Cancelled/postponed notices with no stored decisions receive
`no_decisions_expected_from_notice`, rather than a missing-minutes diagnosis.

Local macOS Vision OCR produces draft text and page bounding boxes only. OCR alone
is not authority to insert a decision. A reviewed scan additionally binds every
original page/render, OCR/helper provenance, exact parsed blocks and the full
independently image-reviewed operative body/result. Unreviewed blocks remain
held. A decision spanning pages requires an independent complete-span review,
contiguous ordered page evidence, matching render/OCR hashes and a pinned full
operative-body digest. A result printed on the next page can certify only that
reviewed occurrence; page breaks never justify dropping conditions or borrowing
another motion's outcome. Printed unit/ordinal corrections are explicit. The source
format stays `original_pdf_reviewed_local_ocr`; it never masquerades as native
PDF text or official HTML. New actors, attendance and individual votes are left
unrecorded, even if OCR suggests names. Ordinary ingestion does not load these
catch-up adapters. Original PDFs/caches are never overwritten with OCR.

Changed source inventories (including an additional candidate original), review
artifacts, renderers, catalog scope or parser outputs require a new audit/review.
Apply rechecks the original inventory under locks. Keep the OCR review artifacts
and receipts so a future correction can be traced to the exact original image.

A native PDF can also omit visible outcome words from its embedded text. The
catch-up-only `reviewed_native_image_corrections` mode binds complete original
page renders, native/layout hashes and unique page-specific reviewed corrections.
Its corrected text and parsed occurrences are pinned. This source view supports
existing legacy-occurrence accounting only: it cannot add motions or certify
stored results, actors, attendance or individual votes, including after a reviewed
header date is applied. Documentary adjournments remain held separately. An audit
with no proposed additions is not a missing import; do not insert duplicates or
manufacture an apply receipt to make its count match the existing motion table.
