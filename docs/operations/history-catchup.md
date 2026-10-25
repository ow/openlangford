# Historical decision coverage and bounded catch-up

An ingested meeting, or `motion_source_ingestion.status=source_authoritative`, does
not imply complete decision coverage. Source plans may still contain unparsed
formal occurrences, unbound outcomes, held bodies or unresolved legacy claims.
The source URL/date and exact original file must be bound before additions.

Run from `apps/pipeline` using the normal configured interpreter. Credentials stay
in the existing environment file; never copy them into manifests or receipts.

An explicit standalone clerk sentence such as “The vote was taken on the Main
Motion as amended and declared CARRIED.” is a coverage lead when no parsed
outcome accounts for that exact result span. It remains
`explicit_clerk_main_motion_result_lead` with `coverage_diagnostic_only`
authority in `unparsed_formal_occurrence_leads`; the report stays partial and
requires review. A preceding amendment's post-result context cannot account for
it. This diagnostic adds no resumed header, amended body, motion, outcome row or
votes and changes no existing source identities. Only separate source review can
resolve the missing main-motion body/outcome association.

A structurally anchored SECONDED or explicit resumed-main introduction with
further text but no own printed outcome before the next formal anchor is retained
as `unresulted_formal_introduction_lead` with `coverage_diagnostic_only` authority
and reason `no_separately_recorded_outcome`. Its exact interval/source hashes are
review evidence, not a newly reconstructed operative body or decision. The next
separately moved or resumed motion keeps its own outcome; it cannot lend that
outcome to earlier wording. Existing result-bearing envelope proofs remain on
their original path without duplicate leads, and original formal inventories,
parsed blocks, text, ordinals and source keys stay unchanged.

A lead count is **not a missing-decision count**. Superseded or unvoted wording
(such as a base proposal later amended) can legitimately have no separate result.
Multiple lead fragments can describe the same proceeding: an earlier unresulted
main introduction and a later explicit clerk-result sentence do not establish
two missing decisions or authorize joining the body/result. Review may resolve a
lead as expected source wording. These diagnostics create no motion/result row,
actor/vote inference or source key, and never fill an existing unknown outcome.
For meeting99, the page24WestShoreappointment remains uncertain even though the
next Library appointment has CARRIED onpage25; the 35 reviewed insertions stay
unchanged.

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

### Reviewed documentary preservation

A legacy row may instead quote a printed documentary passage with no formal
motion envelope or outcome. The same enrolled review can contain a separate
`documentary_preservations` list. Each entry requires `authority` equal to
`documentary_preservation_only` and `result_policy` equal to `preserve_unknown`.
Its `motion_id`, `legacy_text`, `claim_sha256` (semantic projection) and
`claim_row_sha256` (`full_row_fingerprint` of the complete current row, including manual metadata and native DB timestamp/decimal values) must
match exactly. Build the latter from the command's full current row, not a census
projection. `printed_body` must equal the complete legacy body; only whitespace
may differ in the source/native text, with case and punctuation preserved.

The entry pins `page`, `native_text_sha256`, `render_sha256`, `native_passage`
and its exact `native_passage_start`, plus `source_passage` and its exact
`source_passage_start` in the reviewed source text. The review also pins
`render_scale` and `pymupdf_version`. Execution reopens the original PDF and
reproduces page text and pixels. The complete body must occur once across the
original PDF and once across the source text, occupy complete printed lines,
and overlap neither an original formal envelope nor a parsed motion through its
outcome. Competing claims, source keys, existing formal/ballot proof, non-NULL
outcomes or actor IDs reject preservation. A paraphrase is unsupported and must
remain held for separate review; this path cannot certify it as literal text.

Accepted IDs remain in `documentary_preserved_legacy_ids` and the explicit
`reviewed_documentary_claim_preserved_no_rewrite` held category, without a formal
source key. They are accounted only to remove a false duplicate-owner blocker
for other independently verified formal additions. Their text, NULL result,
metadata and all other fields are untouched; they do not count as formal motions
or gain ballot authority. Ordinary ingestion does not opt in. All existing
source/inventory drift checks still apply; a successful batch stales the review.

The separate `type=reviewed_adjournment_narration_preservation` accepts only a
generic legacy “That [the] meeting be adjourned.” claim and a complete reviewed
“The Chair adjourned the meeting at H:MMam/pm.” or “Mayor Young adjourned the
meeting at H:MMam/pm.” narrative (also explicit “a.m.”/“p.m.” spelling). Mayor
narration permits only “Mayor” followed by one proper surname, with no actor ID
assignment. Chair and Mayor narrations are counted together: multiple closing
events or different times remain held, even when each wording is unique. This is explicit
reviewed documentary correspondence, never literal transcription equivalence or
a formal motion/result. It retains the original/page/render/full-row guards,
rejects actual formal adjournment owners, other generic adjournment claims,
conditionals, negation and multiple adjournment events. Accepted IDs remain in
`adjournment_narration_preserved_legacy_ids` and
`reviewed_adjournment_narration_preserved_no_rewrite` holds. Unknown types and
other paraphrases fail closed; the literal type's equality rule is unchanged.

Signature glyphs can interrupt the raw native narration even when its complete
printed words are image-verified. Only this typed adjournment path may use an
explicit `native_correction`. That correction must also be enrolled in the
separately byte-pinned source review's `documentary_native_corrections`, with the
same page, exact `native_quote`, `printed_quote`, page text/render hashes and
`independent_review_sha256`. Its authority must be
`reviewed_documentary_native_witness_correction_only`. Execution checks the real
source-review STORE/ENROLLED file gate, scope and current source proof digest;
the correction's independent hash must equal that source image review's hash.
Exactly one original before quote is replaced for uniqueness validation only.
It must yield the complete whitelisted printed narration. Raw bytes, source
text, other text counts and legacy rows are never modified by this validation.
Unchecked, duplicated, drifting or mismatched corrections fail closed; literal
preservation cannot use this capability.

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

`reviewed_native_image_decisions` is a separate, explicit admission mode when
original images establish a complete operative body/result that damaged native
text cannot supply. It keeps the same exact correction and image/hash guards,
and enrolls each accepted occurrence with its raw-block hash, full body digest,
ordered page evidence and independent-review digest. Ordinary native views may
still match existing claims, but the catch-up writer rejects every new occurrence
outside the explicit image-reviewed key list. New actor names/IDs and individual
votes remain unrecorded. The correction-only mode above remains unable to add
facts. Neither mode is loaded by ordinary ingestion or ballot reconstruction.

Catch-up may also account for an existing claim when its complete operative
body differs only by leading `That Council`/`That Committee` framing or a first
list marker. This is exact full-remainder equality, never a substring or fuzzy
match. It requires a complete current claim inventory, matching source date,
one formal source occurrence and no competing claim, including a raw body that
still contains excluded page headers. Different explicit roles, missing clauses,
identifiers or quantities remain held. Derived evidence is labelled separately
from manual reviews; old text, unknown outcomes and ballots remain unchanged.
