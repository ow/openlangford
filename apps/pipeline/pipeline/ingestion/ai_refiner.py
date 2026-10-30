from typing import List, Optional, Literal

from pydantic import BaseModel, Field, field_validator

from pipeline import ai
from pipeline.ingestion.summary_format import normalize_meeting_summary

# --- Schemas ---


class SpeakerAlias(BaseModel):
    label: str  # e.g. "Speaker_01"
    name: str  # e.g. "Mayor Lee"


class VoteRecord(BaseModel):
    person_name: str
    vote: str
    reason: str | None = None
    source_quote: str | None = Field(None, description="Exact minutes quote explicitly naming this person and choice; never infer from attendance")


class MotionRecord(BaseModel):
    motion_text: str
    motion_source_quote: str | None = Field(None, description="Exact complete verbatim motion from official MINUTES, including all conditions and identifiers. Do not paraphrase. This is distinct from the outcome quote and plain-English summary.")
    plain_english_summary: str | None = Field(
        None,
        description=(
            "One plain-language sentence (max ~15 words) saying what the decision DOES for residents, "
            "starting with the outcome verb, e.g. 'Exempted listed non-profits from property tax for 2027.' "
            "No bylaw/permit numbers, policy codes or formal titles (those are shown separately), "
            "no 'Council' subject, no procedural wording like 'gave readings to'."
        ),
    )
    disposition: str | None = Field(
        None,
        description="Type: 'Substantive', 'Procedural', 'Tabled', 'Referred', 'Amended'",
    )
    mover: Optional[str] = None
    seconder: Optional[str] = None
    result: Optional[str] = Field(
        None,
        description="CARRIED, DEFEATED, WITHDRAWN, or null if the outcome is not stated",
    )
    timestamp: Optional[float] = Field(None, description="Start timestamp in seconds")
    end_timestamp: Optional[float] = Field(
        None, description="End timestamp in seconds (after the vote)"
    )
    votes: List[VoteRecord] = []
    outcome_source_quote: str | None = Field(None, description="Exact minutes quote stating the outcome; null for an unvoted notice or no stated result")
    financial_cost: Optional[float] = None
    funding_source: Optional[str] = None


class KeyQuote(BaseModel):
    text: str
    speaker: str
    timestamp: float | None


class KeyStatement(BaseModel):
    statement_text: str = Field(description="Exact spoken source_quote, copied verbatim; do not turn recorded votes or institutional resolutions into personal speech.")
    evidence_kind: Literal["transcript", "minutes_narrative", "recorded_vote"] = "transcript"
    source_quote: str | None = Field(None, description="Exact verbatim quote from the selected original transcript source indexes. No paraphrase or name correction.")
    source_segment_indexes: list[int] = Field(default_factory=list, description="Contiguous original source_index values containing the quote; never database IDs.")
    transcript_source_sha256: str | None = Field(None, description="Copy TRANSCRIPT_SOURCE_SHA256 from the supplied original transcript header.")
    speaker: str | None = Field(None, description="The person who made the statement. Must be exactly ONE person — never combine names. null only if from correspondence or truly unclear.")
    statement_type: str = Field(
        description="One of: claim, proposal, objection, recommendation, financial, public_input"
    )
    context: str | None = Field(
        None, description="Brief context for the statement (e.g. 'During debate on rezoning')"
    )
    timestamp: float | None = Field(None, description="Approximate start time in seconds")




class TranscriptCorrection(BaseModel):
    original_text: str = Field(
        description="The exact text string in the transcript that is incorrect"
    )
    corrected_text: str = Field(description="The corrected version of the text")
    reason: str | None = Field(
        None, description="Why this correction is needed (e.g. 'Misspelled Name')"
    )


class AgendaItemRecord(BaseModel):
    item_order: str
    title: str = Field(description="The full formal title from the agenda")
    matter_identifier: str | None = Field(
        None,
        description="All referenced identifiers (Application #s AND Bylaw #s) separated by semicolons. e.g. 'REZ 2025-01; Bylaw No. 1160'",
    )
    matter_title: str | None = Field(
        None,
        description="The subject matter, e.g. 'Noise Control Bylaw' or '123 Main St Variance'",
    )
    plain_english_summary: str | None = Field(
        None,
        description="A single sentence summary of what this item IS for a layperson.",
    )
    related_address: list[str] | None = Field(
        None,
        description="Specific physical property addresses mentioned (e.g. ['123 Example Road']). Avoid highways, parks or whole neighbourhoods unless they are the primary specific subject.",
    )
    description: str | None
    category: str = Field(
        description="The category of the item. Use 'Procedural' for routine meeting management (e.g., Approval of Agenda, Adjournment). Use substantive categories like 'Land Use', 'Finance', 'Engineering', 'Public Safety' etc. for items that involve policy decisions or community impact."
    )
    tags: list[str]
    financial_cost: float | None
    funding_source: str | None
    is_controversial: bool
    debate_summary: str | None
    key_quotes: list[KeyQuote]
    key_statements: list[KeyStatement] = []
    discussion_start_time: float | None
    discussion_end_time: float | None
    motions: list[MotionRecord]


class MeetingRefinement(BaseModel):
    scratchpad_speaker_map: str = Field(
        description="Internal monologue: Identify speakers and map to attendees."
    )
    scratchpad_timeline: str = Field(
        description="Internal monologue: Determine start/end timestamps for items."
    )
    summary: str = Field(
        description="3-5 Markdown bullets ('- '), one substantive outcome each, under 20 words, plain language for residents, most important first. No heading, intro, title/date, attendance or procedural filler."
    )
    @field_validator("summary")
    @classmethod
    def normalize_summary(cls, value: str) -> str:
        return normalize_meeting_summary(value)

    meeting_type: str = Field(
        description="The category of meeting, must be one of: 'Inauguration', 'Regular Council', 'Special Council', 'Committee of the Whole', 'Public Hearing', 'Board of Variance', 'Standing Committee', 'Advisory Committee'"
    )
    status: str = Field(
        description="The status of the meeting: 'Planned', 'Completed', or 'Cancelled'"
    )
    chair_person_name: str | None
    attendees: list[str]
    speaker_aliases: list[SpeakerAlias]
    transcript_corrections: list[TranscriptCorrection]
    items: list[AgendaItemRecord]


# --- Prompts ---

SYSTEM_INSTRUCTION = f"""
You are a City Council Data Analyst. Your goal is to create a perfect, relational JSON record of a municipal meeting.

**DATA SOURCES**:
1. **AGENDA**: The plan (Titles, Numbering).
2. **MINUTES**: The official record (Votes, Movers, Results).
3. **TRANSCRIPT**: The verbatim discussion (Timestamps, Quotes).

**CORE TASKS**:
1. **Meeting Identification**: Extract type (e.g. 'Regular Council') and status.
2. **Meeting Summary**:
   - Return `summary` as 3-5 Markdown bullets ("- "), one decision or outcome per bullet. No heading, no intro or closing sentence, no JSON.
   - Order bullets by how much they matter to residents (money, land use, housing, taxes, services first).
   - Keep each bullet under 18 words. Start with the outcome verb ("Approved", "Rejected", "Gave first reading to", "Directed staff to", "Deferred").
   - Write for residents, not insiders. Say what the decision does in everyday terms, then at most one short identifier in parentheses at the end, e.g. "Adopted new fees developers pay toward community amenities (Bylaw 2275)." or "Allowed reduced setbacks for the RCMP building expansion on Atkins Ave; Guiry opposed."
   - Leave out amendment numbers, policy codes (e.g. POL-0185-FIN), formal bylaw titles, quotation marks and ALL-CAPS labels like "(ADOPTION)". Spell out acronyms (say "development variance permit", not "DVP").
   - Name the street or neighbourhood when relevant and include dollar amounts.
   - Name the exact bylaw stage (first/second/third reading or adoption); never blur it into "final readings" or "approved".
   - If any council member voted against or the vote was split, say who in the bullet (e.g. "Guiry opposed").
   - Do not repeat the meeting title, type or date — they are shown beside the summary.
   - Skip attendance, chair names, call to order, agenda adoption, consent-agenda housekeeping, closed-session motions and adjournment unless that was the only business (then one bullet saying so).
   - Never present an agenda proposal or discussion as a decision.
3. **Item Extraction**:
   - Use MINUTES as the source of truth for what happened.
   - Use AGENDA for full titles and numbering (e.g. "6.1").
   - Extract physical addresses into `related_address`.
   - **CRITICAL**: Extract ALL numbered agenda items, including procedural/empty ones:
     * Call to Order (item 1)
     * Approval of Agenda
     * Mayor's Report, Chair's Report
     * Consent Agenda items
     * New Business, Question Period (even if empty)
     * Closed Meeting Resolution, Rising Report
     * Adjournment (MUST include the adjournment motion)
   - Categorize items as "Procedural" if they are routine meeting management (e.g., Approval of Agenda, Adjournment). Use "Substantive" or specific categories (e.g., "Land Use", "Finance") for actual policy decisions.
4. **Timestamps (CRITICAL)**:
   - `discussion_start_time`: The EXACT moment the chair *formally introduces* the item (e.g., "Moving on to item 8.1...").
   - `discussion_end_time`: When the item concludes (immediately after the vote or final remark before the next item is called).
   - If an item is part of a Consent Agenda block, use the start of the block discussion for all items in that block, but prioritize individual timestamps if they are discussed separately.
   - Do NOT capture early mentions during Agenda Approval.
   - Use the `scratchpad_timeline` to justify your timestamps by quoting the relevant segment.
5. **Motions & Votes**:
   - Use MINUTES as the source of truth for motion text, mover, seconder, result, and recorded votes. Supply `motion_source_quote` as the full verbatim official motion, not a paraphrase, and keep `motion_text` verbatim too; use `plain_english_summary` for paraphrasing.
   - `plain_english_summary` for each motion: one short sentence a resident understands, describing the effect ("Allowed a six-storey, 60-unit apartment at 703 Station Ave.", "Raised sewer fees to $1.22 per cubic metre."). Never just restate the identifier ("Adopted Bylaw No. 2284."). For bylaw readings, say what the bylaw does and the stage in plain words ("Gave first reading to curbside garbage collection fees.").
   - Use `disposition` to categorize motions: 'Procedural' (e.g. approving agenda, adjournment, adoption of minutes) vs 'Substantive' (e.g. approving a permit, adopting a bylaw, awarding a contract).
   - Votes must be [Yes, No, Abstain, Recused].
   - Extract individual votes whenever the minutes identify them. Phrases like "Mayor X opposed", "Councillor Y opposed", "Councillors A, B and C opposed", "OPPOSED: Name", or "Name voted against" MUST become `No` votes for those people.
   - Opposition-only minutes are a PARTIAL roll call. Record the named No voters; NEVER infer Yes votes from attendance, membership, moving/seconding, or the majority outcome. Attendees may leave or recuse themselves during an item.
   - Preserve "CARRIED UNANIMOUSLY" as the result when explicitly stated. A unanimous outcome alone does not identify the voters present at that exact item: leave individual votes empty unless those people and their choices are explicitly named. Include an exact `source_quote` for each individual vote.
   - For defeated motions, do NOT assume everyone voted No or infer the remaining attendees voted Yes. Only record named No/opposed voters and clearly named Yes/in-favour voters.
   - If a motion "died for lack of a seconder", "was not seconded", or was withdrawn before a vote, set result to `WITHDRAWN` or null as appropriate and leave `votes` empty.
   - Leave `votes` empty when the minutes do not explicitly identify individual choices. Include `outcome_source_quote` for each stated result. A notice of motion is a proposal for a future meeting, not a vote; do not turn notices, call-to-order, public hearing narration, or a chair closing a meeting into formal motions. Extract adjournment only when a formal motion is recorded.
   - Use canonical person names from KNOWN ATTENDEES / active Council members. For example, "Mayor Goodmanson" should be returned as the known attendee/council name, not as a new person.
6. **Speaker Mapping**:
   - Identify every generic label in the transcript (e.g., `Speaker_01`, `Speaker_02`, `Chair`) and map it to a real name from the Known Attendees or Minutes.
   - Example: `Speaker_01` -> `Jordan Lee`.
   - Use the ACTIVE COUNCIL MEMBERS list, when given, for validation.
7. **Enrichment**:
   - `debate_summary`: Summarize arguments (leave NULL for procedural items with no discussion).
   - `key_quotes`: Extract verbatim quotes (leave empty for procedural items).
8. **Key Statements** (CRITICAL for semantic search):
   - For each substantive (non-procedural) item with discussion, extract `key_statements` — typed statements that capture the substance of the debate.
   - Extract at most **6 key statements** per item. Focus on: policy decisions, financial impacts, community concerns, and contentious positions. Skip individual data points, routine statistics, and anecdotal details.
   - Statement types:
     * `claim` — A factual assertion or position stated by a speaker (e.g. "Traffic has increased 40% since 2020")
     * `proposal` — A specific suggestion or plan of action (e.g. "Staff recommends adding a left-turn lane")
     * `objection` — An argument against a proposal or action (e.g. "This will destroy the character of the neighborhood")
     * `recommendation` — A formal recommendation from staff or committee (e.g. "Staff recommends approval with conditions")
     * `financial` — A statement about costs, budget, or funding (e.g. "The project will cost $2.3M from reserves")
     * `public_input` — A statement from a member of the public during a hearing or delegation
   - Extract spoken statements only from the supplied original transcript. A named debate summary, attendance, Chair/Mayor label, recorded dissent or Council resolution is not proof that a person spoke those words. Never invent personal speech from a vote.
   - Each statement must come from ONE raw speaker label. Do not combine voices or use an inferred name as identity proof.
   - Copy the exact source_quote into statement_text. Put optional explanatory paraphrase in context. Include evidence_kind="transcript", transcript_source_sha256 copied from the transcript header and the contiguous source_segment_indexes containing the quote. These indexes are original source positions, not database IDs.
   - If exact source evidence is unavailable, omit the statement; preserve formal decisions in motions/votes instead.
   - Include `context` to explain when/why the statement was made.
   - Use the measured start time of the actual supporting transcript segment for timestamp. Do not invent offsets; persisted source indexes will be validated independently.
   - Skip procedural items. Do NOT extract statements for items with no discussion.
9. **Transcript Corrections (Spelling & Names)**:
   - Scan the TRANSCRIPT for misspellings of proper nouns, locations (street and place names), organization names, and attendee names.
   - Use the AGENDA, MINUTES, and KNOWN ATTENDEES as the source of truth for correct spellings.
   - Example: a misheard street name → the spelling in the agenda; "Mayor" followed by a misheard surname → correct name from attendees.
   - Return `transcript_corrections` with `original_text` (exact snippet) and `corrected_text` (the fix).

**VALIDATION RULES**:
- NO "Unknown" attendees.
- NO "Staff" as a name.
- Council Members ONLY for voting.
- Chronological order for items.
- Every `Speaker_XX` label MUST have a corresponding entry in `speaker_aliases`.
"""


def build_refinement_prompt(
    agenda_text,
    minutes_text,
    transcript_text,
    attendees_context=None,
    canonical_names_context=None,
    glossary_context=None,
    fingerprint_aliases=None,
    active_council_members=None,
):
    # Condense context to save tokens
    context_section = ""
    if attendees_context:
        context_section += f"\n**KNOWN ATTENDEES**:\n{attendees_context}\n"

    # Add pre-identified speakers from voice fingerprints
    if fingerprint_aliases:
        fp_lines = []
        for alias in fingerprint_aliases:
            conf = alias.get("confidence", 0)
            conf_pct = f"{conf * 100:.0f}%" if conf else "?"
            fp_lines.append(
                f"  - {alias['label']} = {alias['name']} (voice match: {conf_pct})"
            )
        context_section += (
            f"\n**PRE-IDENTIFIED SPEAKERS (from voice fingerprints)**:\n"
            + "\n".join(fp_lines)
            + "\n"
        )
        context_section += "NOTE: These speaker identifications are based on voice matching and should be trusted unless transcript context clearly contradicts them.\n"

    # Active Council Members (Strict Validation)
    if active_council_members:
        council_str = ", ".join(active_council_members)
        context_section += (
            f"\n**ACTIVE COUNCIL MEMBERS (VALIDATION)**:\n{council_str}\n"
        )
        context_section += "CRITICAL: Only these individuals are active Council members for this meeting. Any other 'Councillor' or 'Mayor' in the text is likely a hallucination or a former member speaking as public.\n"
    # No date-specific council list: say nothing rather than guess a roster.

    # Check if transcript is present
    has_transcript = transcript_text and len(transcript_text.strip()) > 0

    if has_transcript:
        task_instructions = """
    **INSTRUCTIONS**:
    1. Fill `scratchpad_speaker_map`: Analyze the transcript. List every unique Speaker label (e.g. `Speaker_01`, `Speaker_02`, `Chair`) and identify who they are based on context clues (e.g. "Thank you, Councillor Lee").
    2. Fill `speaker_aliases`: Based on your analysis in step 1, create a list of mapping objects.
    3. Fill `scratchpad_timeline`: Scan the transcript for "Item [X] is now before us" or similar transitions. List the start/end times for each item.
    4. Fill `transcript_corrections`: Scan the transcript for misspelled names, places, and terms. Compare against AGENDA/MINUTES for correct spellings.
    5. Generate the final `items` array based on the scratchpad reasoning.
        """
        # We provide the full transcript text here; the extraction model has a large context window.
        transcript_section = f"**SOURCE 3: TRANSCRIPT**\n    {transcript_text}"
    else:
        task_instructions = """
    **INSTRUCTIONS (NO TRANSCRIPT AVAILABLE)**:
    1. Leave `scratchpad_speaker_map` EMPTY.
    2. Leave `speaker_aliases` EMPTY.
    3. Leave `scratchpad_timeline` EMPTY.
    4. Leave `transcript_corrections` EMPTY.
    5. Generate the final `items` array using ONLY the Agenda and Minutes.
    6. CRITICAL: Since there is no transcript, you MUST leave `discussion_start_time`, `discussion_end_time`, `key_quotes`, and `debate_summary` EMPTY or NULL. Do NOT invent them.
        """
        transcript_section = "**SOURCE 3: TRANSCRIPT**\n    (Not Available)"

    return f"""
    {context_section}

    **SOURCE 1: AGENDA**
    {agenda_text}

    **SOURCE 2: MINUTES**
    {minutes_text}

    {transcript_section}

    {task_instructions}
    """


def build_agenda_only_prompt(
    agenda_text,
    attendees_context=None,
    canonical_names_context=None,
    glossary_context=None,
):
    return f"""
    I have only the AGENDA for an UPCOMING or INCOMPLETE meeting.
    Goal: Extract a structured plan of what is scheduled.

    SOURCE: AGENDA TEXT
    {agenda_text}

    INSTRUCTIONS:
    1. Set status to 'Planned'.
    2. Extract all scheduled items with titles and numbering.
    3. Leave motions, timestamps, and quotes EMPTY.
    """


def refine_meeting_data(
    agenda_text,
    minutes_text,
    transcript_text,
    attendees_context=None,
    canonical_names_context=None,
    glossary_context=None,
    meeting_date=None,
    fingerprint_aliases=None,
    active_council_members=None,
):
    """
    Extract a structured MeetingRefinement from agenda, minutes and transcript.

    Returns None (after logging why) when the model call fails, so ingestion
    can continue with a partial record.

    Args:
        fingerprint_aliases: Optional list of pre-matched speaker aliases from voice fingerprints.
                           Format: [{"label": "SPEAKER_01", "name": "John Smith", "confidence": 0.92}, ...]
        active_council_members: Optional list of strings ["Name 1", "Name 2"] valid for this meeting date.
    """
    has_minutes = minutes_text and len(minutes_text.strip()) > 100
    has_transcript = transcript_text and len(transcript_text.strip()) > 0

    if not has_minutes and not has_transcript:
        print("  [i] Agenda Only detected. Using strict 'Planned' extraction.")
        prompt = build_agenda_only_prompt(
            agenda_text, attendees_context, canonical_names_context, glossary_context
        )
    else:
        prompt = build_refinement_prompt(
            agenda_text,
            minutes_text,
            transcript_text,
            attendees_context,
            canonical_names_context,
            glossary_context,
            fingerprint_aliases=fingerprint_aliases,
            active_council_members=active_council_members,
        )

    try:
        return ai.json(prompt, stage="extraction", schema=MeetingRefinement, system=SYSTEM_INSTRUCTION)
    except ai.AIError as exc:
        print(f"  [!] AI refinement failed: {exc}")
        return None
