# Page review fixes: what runs where

Staff review public pages with the admin review bar. When a page is marked "needs work", the fix agent plans and
carries out fixes for the flags staff agreed with. This page explains where each step runs and why.

## The flow

1. **The bar posts the request.** It posts to `/api/page-review` (`app/routes/api.page-review.ts`), which sets the
   page to "fixing" and waits for `fixPage` (`app/services/page-fix.server.ts`).
2. **The agent looks into each problem.** For every flag staff agreed with, and their note, it searches and reads the
   City's records itself (`app/services/fix-investigation.server.ts`, using `research()` from
   `record-research.server.ts`). The question fits the problem:
   - a step of the topic: what was proposed, and what Council decided (it reads that meeting's minutes first);
   - a linked record: how it relates to this topic;
   - a related topic: whether it is the same project;
   - a statement of fact: what the record actually says.

   The investigations run at the same time, each capped at 4 turns, all within 40 s and the fix's deadline. A flag
   the page check already researched keeps that finding. Each finding (the record's words and its ref) goes into the
   plan beside its flag. The note lists them under "Evidence behind the changes, from the City's records": each bullet is the record a change above rests on, named by the entry's date, not work left undone.
3. **The agent plans the fix.** It reads the page's records and its findings and plans actions from a fixed menu,
   using one AI call on the `review` stage. The records include:
   - each item's motions, reports and minutes. An item without a motion of its own also gets its meeting's
     unattached minutes that name its subject, even when its report is attached: the minutes are where the decision
     is.
   - the records of every topic listed under Related topics or holding an entry staff accepted for this page.

   The plan prompt's rules:
   - it may write that a record doesn't say what Council decided only when that meeting's minutes are in its records
     and say nothing;
   - an entry whose title or records name the topic is explained with a line, not removed, unless the records show it
     is about something else;
   - `cannot_fix` names the record it needs;
   - anything a resident reads follows `docs/writing-style.md`.
4. **Filing here an item another topic holds.** The agent compares the two topics' records (`judgeTopics` in
   `page-check.server.ts`, the same judgement the page check makes of Related topics). If they are one project, it
   merges that topic into this page. If not, the entry stays a mention and the flag is answered with the reason.
5. **Everything is carried out in the same request, on the site.** That covers:
   - **Small edits:** removing and unlinking entries, rewriting entry lines and headings, hiding duplicates, moving
     documents and accepting search suggestions.
   - **Decisions and stages:** `add_motion` adds a decision the minutes record but the entry lacks, often a motion
     ingest held back because a scanned copy filed its "CARRIED" under the item before
     (`agenda_items.meta.unverified_motion_proposals`; only the planner sees those, never the page check). The
     agent's quote must appear word for word in a section of that meeting's minutes or reports, and must itself hold
     the motion and its outcome (`app/services/motion-add.server.ts`). If the same motion is already under another
     item of that meeting, it isn't added twice. `set_stage` picks an entry's stage from the fixed list
     (`STAGE_LABELS` in `components/matter/timeline-step.tsx`) when the guess from its wording is wrong. It is kept on
     the item (`agenda_items.meta.staff_stage`) so it follows the item when it moves.
   - **Moves and merges:** moving an agenda item to a named topic, and merging duplicate topics through the
     `merge_matters()` database function. The code is in `app/services/topic-moves.server.ts`.
   - **Status:** refreshing the status of the topics at each affected meeting, using the same rules as the
     pipeline's `matter_lifecycle.py`.
   - **The summary rewrite:** rewriting the summary of every topic whose timeline changed. One write (staff's
     instructions are already in the topic's editor notes, so the writer follows them), then one check that judges
     the facts and each instruction together. If it finds anything, there is no second rewrite: the agent edits the
     text directly and checks once more. The code is in `app/services/topic-summaries.server.ts`
     (`rewriteSummaries`).

   - **Checking the fix:** one call on the `review` stage re-reads only what the fix wrote (the new summary and status,
     rewritten lines, and the statements behind each fixed flag) against the records, the findings and the whole records they rest on (so it reads what the agent read).
     A fix that doesn't hold is reopened and the note says so; each flag keeps `recheck {holds, checked, reason}`
     (`lib/page-recheck.ts`). The note ends with "Checked: 3 of 3 fixes hold." The bar's Check button still runs the
     full page check.
   - **A time limit:** all model calls in one fix share a 90 s deadline (`FIX_BUDGET_MS`). Past it the agent stops
     and the note says what is left. Review and writing calls time out after 30 s and retry once.

6. **The page is left "fixed" or "needs work".** It gets a note of what changed and what needs a person.

A fix finishes in one pass: the request returns when the page is done.

## The one step left to the pipeline

When no listed topic fits, the agent can ask for a moved item to be re-filed the way ingest files a new item. In
the plan, that is `move_item` with no target. Re-filing can find the topic for the item's permit, bylaw or address,
or create a new topic.

That step uses the ingest matcher: `topic_regroup.refile`, then `topic_tidy._Filer`, then `MatterMatcher` and
`MeetingIngester.get_or_create_matter`. That code is about 1,200 lines and is shared with ingest, so it was not
ported.

Jobs a person is waiting on (find missing, re-file, link participants) are queued at priority 10; the worker claims
the highest priority first (`claim_next_pipeline_job`), so they jump bulk batches.

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
| Now | The site's part, then the rewrite in the same request. On one real topic, the rewrite took 7.7 s: two writing calls and one check (before the summary ladder was flattened; see below). |

## The investigation's cost (2026-11-06)

A review-stage call takes about 2 s plus 12 ms per output token; the input size barely matters (`ai_usage`, web
`review` stage, 14 days). A research turn writes about 150 to 250 tokens, so it takes 3 to 5 s.

The fix of `/matters/public-hearing-policy-pol-0155-admin` was replayed read-only, with its two flags:
- **Investigation:** 7 turns took 14 to 16 s, because the flags run at the same time. It cost about $0.04 on
  `gpt-6.1-terra` ($1 per million tokens in, $5 out).
- **Comparing two topics:** this runs only when an item another topic holds is filed here. It took 6 to 8 s and cost
  about $0.01.

The fix before this change made 5 calls, about 26 s and $0.02: the plan, two writing calls, the summary check and
the re-check. A typical two-flag fix now takes about 40 to 50 s and costs about $0.07. A four-flag fix investigates
in about the same time, since the flags run in parallel and stop at 40 s. It costs about $0.10 to $0.12. Both fit
within the 90 s deadline.

## Signed bylaws as a record

A topic tied to a bylaw (its `bylaw_id`, or a bylaw number in its title or identifier) gives the check, the fix agent's
plan and investigations, and the re-check a `SIGNED BYLAW bylaw:<id>` line with the reading and adoption dates printed on
the certified copy (`services/bylaw-records.server.ts`). Research can search and read `bylaw:<id>` too. The signed bylaw
outranks a motion's wording in the minutes: the May 2, 2016 minutes say "give Bylaw No. 1628 First Reading" under an
"(ADOPTION)" heading, and the signed bylaw says adopted that day.
