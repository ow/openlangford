# Council terms and election transitions

Elections, council terms, and service memberships represent different events.
An election result identifies a winner; the person starts serving on their
membership start date. Re-elected or returning people keep their existing person
ID and receive a separate membership for each term. Votes/transcripts stay linked
to the original person and meeting date.

`council_terms` records verified tenure dates and links a municipality to its
election. Memberships optionally link to that term and retain their actual start
and departure dates. Dates are inclusive; a term ending November 1 and another
starting November 2 do not overlap. Unknown future end dates remain null.

The shared rules in `app/lib/council-terms.ts` use the America/Vancouver civil
date. A future membership is upcoming, not current. Resignations and gaps between
separate periods of service must not be merged into continuous tenure.

## Langford 2026 transition

Migration `20261019011039_46_01_council_terms_and_langford_2026_election.sql` records:

- 2022 term: November 7, 2022 through November 1, 2026.
- Incoming term: scheduled to begin November 2, 2026; end date unknown.
- October 17, 2026 election: 18 candidates, seven preliminary winners.
- Existing person IDs reused for returning candidates; earlier departures kept.

The city election page and city-linked CivicInfo results are cited in the SQL.
The official 2022 inaugural minutes establish the historical start date. The
2022 election has term metadata only; candidate results have not been imported.

When certified results are published, compare them with the preliminary snapshot,
update any differences, and mark the election `official` with its declaration
source URL. Verify the actual inauguration occurs as scheduled. This is a reviewed
data-maintenance step, not an automatic inference from the calendar or an AI
transcript. The preliminary seed deliberately does not overwrite certified results.

## UI and search

The council page defaults to the council serving today. Its selector includes
incoming and recorded past terms. People with no meetings still appear in the
roster; incoming members do not receive zero-percent attendance grades.
Profiles keep a service timeline; meeting roles use the membership on the meeting
date. Voting alignment and comparisons use verified tenure dates and actual
membership intervals, including service gaps.

Keyword search optionally filters by a verified term and intersects existing time
filters. AI policy answers still retrieve across all terms, explicitly labeled
when a keyword term filter is selected. Questions about officeholders receive
dated roster context; a recorded incoming winner must not be called the current
officeholder before taking office. This does not replace the separate evidence,
quality, caching, and spending-control work identified in the search review.

### Names and portraits

Council records display full public names on the existing person IDs; meeting
initials still resolve through the ingestion name matcher. Migration `46-02`
normalizes these names without merging or replacing people.

Portraits are served from `/images/council/`, with the original public image URL,
source page and retrieval date recorded in `sources.json`. Use official council
headshots or clearly identified candidate portraits. Do not fill missing images
with event scenes, group crops, campaign graphics or uncertain matches. Wendy
Hobbs, Jennifer Dunnett and Brandy Gordon remain without a portrait pending a
suitable source. The existing icon is the intentional fallback.

### Grouped service periods

Council cards show completed service periods, and profiles group consecutive
appointments in the same council office. The display merges only overlapping or
adjacent dates in the same role and organization. It preserves service gaps and
role changes, and keeps an incoming appointment separate until it begins.
Underlying memberships and term-specific statistics are unchanged.

Older history with only verified years belongs in `people.meta.council_service_history`
as `{ organization_id, role, start_year, end_year, source_url }`. The UI queries
only this metadata field, retains year precision, and links the source from the
profile. It does not invent appointment dates or statistical coverage. Migration
`46-03` adds Stew Young's verified 1993–2022 mayoral tenure from his biography:
https://stewyoung.com/about. The 2026 return remains a separate period.
