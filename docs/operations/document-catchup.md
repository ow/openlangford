# Additive standalone document coverage

`pipeline.backfill.document_coverage` fills explicitly selected empty standalone
PDF document slots. It makes no model calls, infers no summaries or facts, and
does not replace existing extracted documents, sections, images or non-NULL text.
One existing child with a valid literal page range can be reused unchanged when
it has no sections/images. Source pages inside that range retain its identity;
outside pages have no logical-child or agenda association. Unknown, overlapping
or multiple boundaries remain held. The receipt records unassigned source pages.
It does not run the general extraction worker, whose replacement workflow is a
different operation. Original archives remain read-only.

Each source selection specifies `meeting_id`, `document_id` (or null for a new
registration), `file_path`, `source_url`, and `source_file`. A new registration
also requires `listing_file`: the archived official agenda HTML and its `.url`
sidecar. The PDF has its own matching `.url` sidecar. New identities, filenames
and public URLs must agree with exactly one attachment in that meeting's original
listing. Existing rows require the same meeting, path, URL and binary file hash.
No fuzzy or model-based agenda association is used. A unique literal agenda title
can supply the link. A validated existing whole-document link can be preserved;
inside a reused partial range its existing link is retained only for those pages.
Conflicts remain unassociated. Outside-range pages never inherit the child link.

Run from `apps/pipeline` with the existing configured environment file. Supply
both the read-only original archive root and the isolated downloaded-source root.
Downloaded staging copies are not automatically part of the canonical archive.
Before integration, retain new originals, their `.url` sidecars and the agenda
HTML/sidecar in the writable fresh-checkout archive mirror, preserving the
reviewed relative attachment paths and verifying every copied file hash. Keep
the protected old archive untouched. Update the selection to these retained
paths and audit again; a staging-path manifest must not be reused after moving
sources. Retain the source-copy receipt with the audit and application reports.

```sh
python -m pipeline.backfill.document_coverage audit \
  --env-file /existing/config/.env --project-ref PROJECT_REF \
  --source-root /existing/archive-root --source-root /isolated/source-staging \
  --sources /reviewed/source-selection.json --report /tmp/document-audit.json
```

Audit selects 1–30 sources and records exact PDF/native-page hashes, extraction
version, listing evidence, full existing document-row fingerprints, child
inventories and current meeting/agenda state. Review the literal text and every
held reason before using the printed digest. A separate public URL is not proof
that two identical PDFs are distinct records; same-meeting byte collisions hold.

Native text is copied in page order into `full_text` and source-page sections.
Dense pages are split losslessly below 7,500 characters so later embedding does
not truncate them at its 8,000-character input cap. Whitespace padding does not
count as usable native text. New section containers use type `other`; summary/key
facts are left NULL. Existing containers, summaries and facts stay unchanged. This is searchable
native source text, not interpretation of diagrams, images or legal meaning.
Sparse/image-heavy pages hold extraction for the whole PDF. A new PDF can still
be registered with URL/hash/page count and an explicit extraction hold; it gets
no extracted-document or section rows. An already registered sparse source stays
unchanged. Do not report these holds as completed text extraction.

```sh
python -m pipeline.backfill.document_coverage apply \
  --env-file /existing/config/.env --project-ref PROJECT_REF \
  --source-root /existing/archive-root --source-root /isolated/source-staging \
  --manifest /tmp/document-audit.json --reviewed-sha256 PRINTED_DIGEST \
  --report /tmp/document-applied.json
```

Apply regenerates the reviewed plan before short write locks, then rechecks
sources, listings/URL sidecars, complete current document rows, child absence,
meeting metadata and agenda titles. Any drift requires a new audit. It updates
only NULL `full_text` and NULL `page_count` on matching empty existing sources;
new documents and source-page children are appended in one transaction. It never
deletes a row or overwrites existing embeddings/manual metadata. Source embeddings
and richer semantic extraction remain separate, explicitly scoped work.

Atomic receipts live in `meetings.meta.document_catchup_receipts[MANIFEST_SHA]`.
They retain row IDs/fingerprints, source hashes and held coverage rather than
duplicating full document text in meeting metadata. An idempotent retry checks
these receipts before any parsing or writing. Receipt verification checks the
owned source/parent/body/page fields while permitting a subsequent embedding job.

Use `verify` with the same manifest, digest, environment and source roots after
apply. If commit acknowledgement is uncertain, do not retry apply first: verify
the receipt read-only. `already_applied` confirms persisted source fields;
`not_applied` means no receipt. Mixed receipts or changed source fields require
read-only reconciliation. Retain source files, reviewed manifests and reports.
No new credentials, infrastructure or database migration is required.

For later OCR of held PDFs, use the same explicit retained archive/source roots
and source selection, with a separately reviewed additive OCR workflow. Do not
fall back to an implicit old archive root or run the general replacement
extractor over these meetings: it may delete existing extracted rows before a
provider failure. Registration-only receipts confirm original retention and
metadata registration, not OCR completion or permission to replace good content.
