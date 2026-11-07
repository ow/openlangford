# Writing style

Everything a visitor reads on Open Langford follows this guide: page copy, empty states, data notes typed into the database, and every AI prompt that writes public text (summaries, headlines, descriptions). Prompts should quote the rules that apply rather than restate them loosely.

## Who we write for

A Langford resident on a phone who has never read a council agenda. They want to know what happened and whether it affects them. Assume no knowledge of council procedure, bylaw numbers or city jargon.

## The rules

1. **Say what happened, not what was on the agenda.** "Council approved 47 homes on Latoria Road", not "Consider bringing Bylaw 2278 forward".
2. **Most important first.** Lead with the outcome and who it affects. Dates, counts, sources and caveats go last, if at all.
3. **Everyday words.** Write "garbage" not "solid waste", "passed" not "adopted", "rules" not "regulations". If a term can't be avoided, explain it in a few words the first time.
4. **Explain process instead of naming it.** "Moved the 2026 budget one step from final approval", not "gave first, second and third reading". "Made final", not "adopted at fourth reading". "Postponed to May 9" (or "set aside" when no date is given), not "tabled", for an item put off; "presented", not "tabled", for one brought before Council. Langford's minutes say "table" for putting an item off, while most Canadians read "tabled" as "presented", so the word reads both ways.
5. **No internal codes.** No bylaw, file, permit or policy numbers (Z15-0004, POL-0031-FIN, LGA s.146(2)(b)) in running text. A detail page may show them as labelled metadata.
6. **No database words.** Never "matters", "records", "agenda items", "segments" or "attribution" in public copy. Say "council decisions", "projects", "mentioned in council meetings".
7. **Counts in plain terms, last.** "Mentioned in council meetings 41 times since 2009", not "2 matters since 2021". Any date range must match what the page shows next to it.
8. **Short sentences, active voice.** One idea per sentence. About 20 words at most. Council (or the person) is the subject: "Council rejected…", not "It was resolved that…".
9. **Concrete.** Name the street, the facility, the dollar amount, the number of homes.
10. **Never invent.** If the records don't say how something ended, leave it out or say plainly that it isn't recorded. Don't open with what is missing ("The record does not specify…"); lead with what is known.
11. **People.** Use names as written in the records. Never infer gender: no he/she unless the source states pronouns. Dissent only when it matters to the story, in plain words ("passed 6–1").
12. **Provenance belongs in metadata.** Sources, verification dates, form numbers and "checked on" notes go in `meta` or a linked source, never in visible description text. Visible text says what a resident needs: "These are the official results, confirmed by the City on October 21, 2026."
13. **Write so it stays true.** Avoid "currently", "incoming until", "recently" in stored text; give the date instead.
14. **Canadian spelling**, sentence case for headings and badges, no trailing period on headlines or badges, numerals for 10 and up and for all money and measurements.

## What we call things

The database and the code use one set of nouns; residents see another. Public text (pages, stored summaries, AI prompts that write for residents) uses the right-hand column. Prompts may use the left-hand column when *describing inputs to the model*, never in what the model writes.

| In the code and database | On the site |
|---|---|
| matter | topic (a page: "this topic"), or what it is: "the rezoning", "the project" |
| agenda item | entry (on a topic's timeline), or "what Council discussed" |
| motion | decision (once voted), proposal (before) |
| record | the City's records, the minutes, the meeting video |
| segment, transcript segment | what someone said at the meeting |
| key statement | what someone said |
| attribution, speaker label | who was speaking |
| person, people | council members, mayor and councillors, speakers |
| participant | resident who spoke or wrote to Council |
| organization | Council, the committee (by name) |
| property | address |
| staff_stage, stage | where the bylaw stands ("one step from final approval") |

Council procedure terms (readings, carried, tabled, in camera, variance…) are defined once in `shared/glossary.json`, which renders as the public page `/how-council-works`. Each entry carries how the minutes phrase it (`in_the_record`) and the plain words we write instead (`we_write`). Link to `/how-council-works#<id>` rather than re-explaining a term on a page.

## Two registers

Model-written text comes in two layers, and they follow different rules:

- **Record layer** (the ingest refiner's item and motion summaries, motion summaries): stays close to the minutes so later checks can match it against the record. It names the exact bylaw stage ("gave first reading to", "adopted") and keeps "Council" out of the subject. It feeds the resident layer and the fact checks; residents rarely see it on its own. Prompts here take the glossary's `record` register.
- **Resident layer** (meeting highlights, topic summaries and headlines, property leads, bylaw explanations, Q&A answers, page copy): follows every rule above. It explains the stage instead of naming it, says "passed" not "carried", and never uses a database word. Prompts here take the glossary's `resident` register.

When editing a prompt, decide which layer it is before changing its wording. Moving a record-layer prompt to plain language breaks the checks that read it; copying record-layer wording into a resident-layer prompt breaks the guide.

## Quick check before shipping text

- Would a neighbour understand it without opening another page?
- Does the first sentence say what happened?
- Any codes, jargon or database words left?
- Does every number and date match what the page shows?

## Examples

| Instead of | Write |
|---|---|
| Gave 1st, 2nd and 3rd readings to off-street parking, removing City Centre minimums (Bylaw 2272); Wagner opposed | Moved to drop minimum parking requirements for new City Centre buildings, one step from final approval (passed 6–1) |
| 2 matters since 2021, mostly about active transportation projects on Latoria Road | In 2024 Council backed grant applications for walking and cycling upgrades on Latoria Road. Mentioned in council meetings 76 times since 2009. |
| Official results declared by Chief Election Officer … (Form 14-3, LGA s.146(2)(b)); vote counts per CivicInfo BC … | These are the official results, confirmed by the City on October 21, 2026. |
| Read the meeting summary and available council records for Regular Council | May 19, 2026: Council approved a new 911 dispatch deal and fines for noise and construction. |
