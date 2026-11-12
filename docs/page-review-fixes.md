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

   The investigations run at the same time, each capped at 6 turns, all within 40 s and the fix's deadline. Each
   session knows the deadline and gives its finding from what it has read when 15 s are left, rather than being cut
   off with nothing. A flag the page check already researched keeps that finding. Flags the plan can judge from the
   records it already holds are not researched (`needsInvestigation`): a related topic (the plan reads that topic's
   own records), a duplicate, and a page-level problem such as a cut-off sentence. Each finding (the record's words and its ref) goes into the
   plan beside its flag. The note lists them under "Evidence, from the City's records": each bullet is the record a
   change above rests on, named by the entry's date, not work left undone.

   Each research session starts with a turn run for it, without the model (`prefetch` in
   `record-research.server.ts`): searches from the question's own words (a street address, a file number, a bylaw
   number, the topic's title), a search by meaning over report and minutes sections and motions, and the most
   promising sections, motions and signed bylaws read in full (at most 6, and 80,000 characters). The model's first
   call then often answers outright; otherwise it searches on as before. A record already in front of it (read this
   session, or the entry's own records) isn't fetched again.

   The note's "Changed" bullets say what changed and why in a sentence each: the new text of a rewritten line, the
   reason for a removal or a summary rewrite. The record quotes the changes rest on are stored with the change
   (`entry_lines[key].source`, a stage's `source`, a motion's quote), not repeated in the note.
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
     item of that meeting, it isn't added twice. `move_motion` moves a decision the history catch-up recorded at the meeting but filed under its
     "Official recorded motions" container (it couldn't tell which item the motion decided) onto the entry it is
     about. The planner sees those container motions by id; `moveMotion` (`motion-add.server.ts`) moves only within
     the meeting, only out of the container, and only when the motion names the item (a number from the title, or two
     of its distinctive words). It is a move, never a copy; the motion keeps a `placed_by` note saying where it came
     from. `set_stage` picks an entry's stage from the fixed list
     (`STAGE_LABELS` in `components/matter/timeline-step.tsx`) when the guess from its wording is wrong. It is kept on
     the item (`agenda_items.meta.staff_stage`) so it follows the item when it moves. `rewrite_decision` rewords
     the plain "Decision:" line under an entry (`motions.plain_english_summary`, never the motion's own wording),
     for a slip the minutes made that the rest of the record corrects. It is marked as a person's
     (`motions.meta.manual.summary`), so a re-ingest or a motion-summary run keeps it and stores its own as `auto`.
   - **Addresses:** `unlink_address` takes an address off the topic (a misspelled street, a lot named in passing)
     by hiding its `property_links` rows for that topic; the properties stage keeps hidden links. It never takes
     off the topic's last address. Both actions live in `services/fix-ops.server.ts`.
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

6. **Property pages have their own small agent** (`services/property-fix.server.ts`), like meeting pages. A
   property page's own text is its lead (`properties.meta.summary`, written by the pipeline's property-summaries
   stage); the rest is the topics and meeting items the pipeline linked to the address, each keyed on the page
   (`matter-<id>`, `item-<id>`) so the check can flag one. The agent can unlink an entry that is about a different
   address (hiding its `property_links` row, which the pipeline keeps hidden) or rewrite the lead from the records;
   a lead it writes is locked (`meta.summary_locked`) so the stage keeps it, and the closing "Mentioned in council
   meetings…" count line is kept from the old lead rather than guessed.

   It can also correct a source on the page (`edit_source`: headline, quote, staff note or date label, through
   `updateSource`; a quote must be the source text's own words) and rewrite one row's line (`rewrite_entry`). A topic's
   step gets the same `timeline_headlines` / `staff_headlines` pair the topic agent writes; a linked meeting item gets
   `properties.meta.staff_entry_lines`, which the timeline prefers over the lead stage's `entry_lines` and the stage
   never touches. Its records list each topic's steps (`step-<id>`, with the line the page shows now) and the page's
   sources (`source-<id>`), so a flag on either can be answered. Every change needs the record's exact words in
   `source`, and is logged as `agent:edit_source` / `agent:rewrite_property_entry`.
   A topic's own text is rewritten with `rewrite_summary` (key `matter-<id>`): the instruction joins the topic's
   `editor_notes` and goes through the same `rewriteSummaries` write, check and direct edit the topic agent uses, so
   an instruction the result doesn't follow is reported as needing a person.

   The review bar's pencil edits an address's summary by hand, as it edits a topic's fields (`services/property-edit.server.ts`).
   A saved edit locks the lead (`meta.summary_locked`, with `hand: true`, the lead it replaced as `auto`, and the ids of the
   address's links at that moment), so the pipeline's stage keeps it; the panel shows how many links came in since, and
   "Reset to automatic" puts `auto` back. The closing "Mentioned in council meetings…" line is kept, not edited. The agent
   is told when a lead was written by hand and changes it only as far as a flag or note asks.

   Pressing Check on a property page also searches the records for the address (`services/property-search.server.ts`:
   item titles, motions, attached reports and minutes, topic titles, and lines spoken at meetings, each tied to the
   entry whose discussion window holds it; plain text matching, no model) and lists what
   isn't linked yet under "Possibly missing"; a 👍 links it to the address at once (a `property_links` row with
   source `admin`, which the properties stage keeps), a 👎 keeps it off. Decisions live in `properties.meta.suggestions`.
   The same press asks the pipeline's quick worker for the lot's lead (`property_lead` job) when it has none, or when a
   link or source was added after it was written; the lead and the plain line per entry (`meta.entry_lines`) arrive when
   the worker has run.

**Shared actions.** The three agents each keep their own menu (a page only offers what its records can back), but an
   action more than one page needs lives once in `services/fix-ops.server.ts`: its plan fields and prompt wording, its
   checks, its writes. Today that is `edit_source` (`editSourceOnPage`), summary instructions (`summaryInstruction`,
   `saveEditorNotes`, `unfollowedLine`, run through `rewriteSummaries`), topic entry text (`writeEntryText`) and the
   quote check (`quoteInRecords`). Add a new shared action there and to each agent's menu; don't copy it into an agent.
   If a flag says "needs a person" for something another page's agent can do, the fix is to add the shared action to
   this agent's menu, not to write it again.

   What each page's text is, and what changes it:

   | Text on the page | Topic page | Property page | Meeting page |
   |---|---|---|---|
   | Topic summary and "where it stands" | `rewrite_summary` | `rewrite_summary` | not shown |
   | A topic step's line | `rewrite_entry` | `rewrite_entry` (`step-<id>`) | n/a |
   | A linked mention's line or heading | `rewrite_entry` / `rewrite_heading` | `rewrite_entry` (`item-<id>`, kept in `staff_entry_lines`) | n/a |
   | An annual report row | `rewrite_entry` | `rewrite_entry` (`report-<id>`) | n/a |
   | A source (headline, quote, note, date) | `edit_source` | `edit_source` | not shown |
   | The page's lead | n/a | `rewrite_lead` | n/a |
   | An item's summary, highlights, description | n/a | n/a | `rewrite_item_summary`, `rewrite_highlight`, `rewrite_description` |
   | Take an entry off the page | `remove_entry`, `unlink_related`, `move_item` | `unlink_entry` | n/a |

   A topic's title, summary or "where it stands" line that staff edited by hand (the pencil, `meta.manual`) is never
   overwritten by a rewrite: the writer's version is stored as that field's `auto` instead. `rewriteSummaries` reports
   those fields (`heldByHand`), and an agent run that asked for a change to one says so in its note ("wasn't changed: it
   was edited by hand, so that version was kept…") and leaves the flag open, rather than claiming a rewrite. Reset to
   automatic in the pencil panel puts the agent's version on the page.

   Not editable on any page, because the page generates them from the record: the closed-meeting row on a property
   timeline, motions and votes, and titles. A flag on one of these is answered with `no_change` or `cannot_fix`.

7. **The page is left "fixed" or "needs work".** It gets a note of what changed and what needs a person.

A fix finishes in one pass: the request returns when the page is done. While it runs, the page's status is `fixing`
and the agent note says what the agent is doing ("Searching the City's records for 2 problems…", "Planning the
fix…", "Making 3 changes…", "Rewriting the summary…", "Checking that the fixes hold…"); the bar polls every 3 s and
shows it. The plan's `source` quotes behind rewrites and stages are capped at 250 characters (an add_motion's
passage is not: it must run from the motion through its outcome), because a review-model call costs about 1.7 s
plus 12 ms per output token and 0.07 ms per input token (`ai_usage`, 7 days to 2026-11-08): the plan's time is in
what it writes, and the quotes were most of it.

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

Measured again on 2026-11-08 (`/matters/building-bylaw-violation-notice`, two flags: an unrelated related topic and
a cut-off description): the fix took 65 s, of which the investigation 41 s. It ran to its 40 s cap because the
turns carried everything read so far (72,000 to 76,000 tokens by the fifth turn, 7 to 13 s a call) and the last turn
was cancelled by the deadline, unanswered. Neither flag needed the records searched: the plan held both topics'
records already. Hence the skip rule above, the deadline-aware finish, and a reading budget of 400,000 characters
per session instead of 1.5 million. The summary check and the re-check stay in sequence: the re-check reads the
summary as the check left it.

The same 10 research questions (agreed flags on 5 topic pages), run read-only before and after the prefetch, on
`gpt-6.1-terra`: 36 model calls and 14.2 s a question before; 28 calls and 12.7 s after, with the same verdict on
all 10. The floor is the model: a turn is 3 to 7 s whatever it holds, and most questions still take two. The trace
also showed the model sometimes putting a sentence of plain text before its JSON object, which the client rejected
and retried at 4 to 8 s a time; `parseJsonReply` now takes the object from such a reply.

## Meeting pages

The fix agent covers meeting pages too (`services/meeting-fix.server.ts`; `fixPage` hands a `/meetings/<slug>` path
to it). A meeting page's own text is the highlights (`meetings.meta.highlights`: bullets with item links, and the
description search results show) and each item's summary (`agenda_items.plain_english_summary`); titles, motions,
votes and attendance are the record itself and are never edited. So the menu is: rewrite_item_summary,
rewrite_highlight, remove_highlight, rewrite_description, set_item_start, no_change, cannot_fix (a wrong seconder or
vote count, a document under the wrong item: a person's job, named exactly). set_item_start fixes a wrong "Watch
discussion" time: the agent quotes the words spoken when the item begins, from a TIMED TRANSCRIPT block the plan
gets (the flagged items' windows and ten minutes either side); the code finds that line in `transcript_segments`
and takes its time, so the agent never types a number. The item starts there and the item before it ends there;
a move that would put items out of order is refused. The times are marked `meta.manual.discussion_start_time` /
`discussion_end_time`, which a re-ingest keeps (the alignment stage only ever fills empty times). Same flow as a topic page: investigate the agreed
flags (keys `item-<id>`, or null for the page), plan in one call over the flagged items' records (every linked item's
for a page-level problem), apply only rewrites whose quote is in those records, re-check each rewrite, write the note.

Text it writes is marked as a person's, the convention topic pages use (`meta.manual`): `agenda_items.meta.manual.summary`
and `meetings.meta.manual.highlights`, each with `by`, `at` and the writer's own version as `auto`. The pipeline keeps
them: a re-ingest goes through `keep_manual_text` (`ingester.py`) and the highlights stage through
`keep_manual_highlights` (`meeting_highlights.write_highlights`), both in `pipeline/ingestion/manual_edits.py`.
There is no "reset to automatic" for these yet; clearing the `manual` key by hand lets the next run write again.

## Signed bylaws as a record

A topic tied to a bylaw (its `bylaw_id`, or a bylaw number in its title or identifier) gives the check, the fix agent's
plan and investigations, and the re-check a `SIGNED BYLAW bylaw:<id>` line with the reading and adoption dates printed on
the certified copy (`services/bylaw-records.server.ts`). Research can search and read `bylaw:<id>` too. The signed bylaw
outranks a motion's wording in the minutes: the May 2, 2016 minutes say "give Bylaw No. 1628 First Reading" under an
"(ADOPTION)" heading, and the signed bylaw says adopted that day.

## Sources outside the record

Land purchases, settlements and hires happen in closed meetings (Community Charter s.90), and Langford rarely reports
them out, so the open record often shows only the aftermath: 3680 Trans-Canada Highway appears as a permit, a budget
line and a plan recommending a sale, never as "the City bought it". A **source** (`sources`, linked to topics and
addresses through `source_links`) is a dated statement from somewhere else: a City news release or notice (origin
`city`), a news report (`press`), another document (`other`). It carries who said it, the words it says (`quote`), a
one-line headline in the resident register, the date it happened and a link.

Staff add one from the review bar's newspaper button on a topic or address page (`components/admin/source-card.tsx`):
paste the link (and, if they like, the words and the date), the draft reads the page and proposes the line
(`services/sources.server.ts` `draftSource`, the writing model), staff change what they want and add it. The same link
added to a second page reuses the row. Removing one hides its link to that page.

A source can carry pictures (`meta.images`, shown on an address's timeline as thumbnails). A picture may preview a
document: `file_key` is the PDF's key in the same R2 bucket, so the thumbnail opens the PDF (marked "PDF") and
`caption` replaces the default line under the pictures. Put the PDF and a page-1 preview under fresh keys, since the
CDN caches a key for a year. Before publishing a document someone sent, read all of it for personal details (the City's
FOI letters carry the requester's personal email, and a hidden link behind it) and redact in the file itself, not with
a box laid over the text; then check page text, every object and stream, links and metadata for what was removed.

Where it shows and how it is weighed:

- **Timelines.** A topic's timeline and a lot's chronology (`components/property/property-timeline.tsx`) show it as a
  dashed card dated the day it happened, labelled "City news release" or "Reported by Victoria News" (`lib/sources.ts`
  `sourceLabel`), with the quote and the link.
- **Writers.** The topic summary (both runtimes) and the property lead get `sources` as their own block: a City
  publication may be stated attributed to the City; a press report only with the publisher named ("Victoria News
  reported the City paid about $2.2M"); never as Council's own decision. The record register never sees them.
- **Checks.** The fact check, the fix agent's plan and the re-check get `SOURCE` lines, which support only a statement
  carrying that attribution; the same fact stated as Council's own doing is `not_in_record`.

Links rot (the 2019 Victoria News story on the purchase is gone from vicnews.com; only the Wayback Machine has it), so
adding a source keeps two more things. The page's readable text goes on the row (`content_text`, capped at 60k
characters, never shown to residents): research can search it and read it as `source:<id>`, like a signed bylaw. And
the Wayback Machine is asked for a public copy (`archive_url`): an existing snapshot is taken at once through the
availability API; otherwise a save is requested after the response (it can take a minute), and a row still without a
copy asks again each time the bar loads it. The timeline shows "Archived copy" beside the live link. A link that is
already a Wayback address is its own copy.

`public_reports` stays what it was: the City's own page-indexed documents (annual reports), read by the pipeline. The
split is by who said it and how it was read, not by format.

## Scoring the check against staff's decisions

`npx tsx scripts/gold-checks.ts [--days 14] [--limit 20] [--runs 2] [--paths …]` re-runs the check, read-only, on pages
whose flags staff rated and scores it: recall on agreed flags still open, agreed-and-fixed flags raised again (the fix
didn't hold, or the check is wrong), rejected flags raised again (false alarms), new flags on unrated entries (rate
them and they join the set), and with `--runs 2` the run-to-run agreement. `tests/gold/page-checks.json` adds hand
cases (`expect`: must raise; `reject`: must not raise) for gaps found by hand, each with the lesson and when to retire
it. Every rating in the review bar grows the set, so the score is the measure of the check over time; run it after a
change to the check, the records it reads or the prompts.
