# Page review fixes: what runs where

Staff review public pages with the admin review bar. When a page is marked "needs work", the fix agent plans and
carries out fixes for the flags staff agreed with. This page explains where each step runs and why.

## The flow

1. **The bar posts the request.** It posts to `/api/page-review` (`app/routes/api.page-review.ts`), which sets the
   page to "fixing" and waits for `fixPage` (`app/services/page-fix.server.ts`).
2. **The agent plans the fix.** It reads the page's records and plans actions from a fixed menu, using one AI call
   on the `review` stage.
3. **Everything is carried out in the same request, on the site.** That covers:
   - **Small edits:** removing and unlinking entries, rewriting entry lines and headings, hiding duplicates, moving
     documents and accepting search suggestions.
   - **Moves and merges:** moving an agenda item to a named topic, and merging duplicate topics through the
     `merge_matters()` database function. The code is in `app/services/topic-moves.server.ts`.
   - **Status:** refreshing the status of the topics at each affected meeting, using the same rules as the
     pipeline's `matter_lifecycle.py`.
   - **The summary rewrite:** rewriting the summary of every topic whose timeline changed. The writer drafts the
     text, checks it against the records, and rewrites once if the check finds problems. The code is in
     `app/services/topic-summaries.server.ts`.
   - **Checking staff instructions:** each summary instruction staff approved is checked against the new text. If
     it wasn't followed, the topic is rewritten once more with what was missed, and then edited directly as a
     last resort.
4. **The page is left "fixed" or "needs work".** It gets a note of what changed and what needs a person.

A fix finishes in one pass: the request returns when the page is done.

## The one step left to the pipeline

When no listed topic fits, the agent can ask for a moved item to be re-filed the way ingest files a new item. In
the plan, that is `move_item` with no target. Re-filing can find the topic for the item's permit, bylaw or address,
or create a new topic.

That step uses the ingest matcher: `topic_regroup.refile`, then `topic_tidy._Filer`, then `MatterMatcher` and
`MeetingIngester.get_or_create_matter`. That code is about 1,200 lines and is shared with ingest, so it was not
ported.

When a plan includes a re-file:
- everything else is done first, in the request;
- then a `fix_page` job is queued for the quick worker with only the re-file moves;
- the page note says "Still to do, on the pipeline worker: re-file…" and the page stays "fixing";
- the worker (`pipeline/ingestion/staff_fixes.py` `run_fix_page`) re-files the items, rewrites the summaries of the
  topics they left and joined, and finishes the page with both reports.

This is rare: 3 re-filed items in the 30 days to 2026-11-05, out of 125 fixes.

## One summary writer, two runtimes

The pipeline writes every topic's summary during ingest (`pipeline/ingestion/matter_summaries.py`). The site
rewrites a topic's summary straight after a fix. They are meant to behave identically:

- **Prompts:** `shared/prompts/topic-summaries.json` holds everything both sides send to the model, and both read
  that one file:
  - the system prompt and the check prompt;
  - the topics and statuses;
  - the schema field descriptions;
  - the prompts' version.

  Change prompts there, never by editing a copy in code.
- **Version:** bump `version` in that file when a prompt or schema changes. Both writers stamp it in
  `matters.meta.summary_version`, and `main.py --stage matter-summaries --stale` rewrites topics with an older
  stamp.
- **Record rules:** `RECORD_RULE` and `CHECK_RULE` (`pipeline/ingestion/record_sources.py`) are written into the
  shared prompts. A pytest (`tests/ingestion/test_topic_summary_prompts.py`) fails if they drift apart.
- **Inputs:** `loadTopicContext` in `topic-summaries.server.ts` is a step-for-step port of `_load_context`, including
  `_same_site` and the video transcripts. If you change what the pipeline gathers for the writer, change both. To
  confirm they still match, dump both for a handful of real topics and compare the JSON. On 2026-11-05 they were
  identical for 9 topics.
- **Model:** the site's `writing` AI stage (`WRITING_AI_MODEL` in `wrangler.toml`) matches the pipeline's writing
  model. The check runs on the `review` stage, as in the pipeline.

## Timing (2026-11-05)

Before this change, the site handed every fix that changed anything to the Mac's quick worker. That is 124 jobs in
14 days, of which about 83% only rewrote a summary.

| Fix | Steps until the page is done |
|---|---|
| Before | The site's part, then about 6 s in the queue, then a 19 s worker run on average (114 s at most), then the bar polling. You then came back for a second pass. |
| Now | The site's part, then the rewrite in the same request. On one real topic, the rewrite took 7.7 s: two writing calls and one check. |
