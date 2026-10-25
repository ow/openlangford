"""Who-spoke from minutes: grounding, privacy and shape."""
from pipeline.ingestion.participation_minutes import admit_speakers, build_participation, minutes_text, summarize_from_minutes

MINUTES = """The Mayor called a first time for presentations.
Representative for the applicant, Dale Douglas - McElhanney - Dale Douglas gave a history of the project.
Resident on Wendey Drive - Conditionally approves of this development, if there is a covenant to protect
the green space. Requested that portions of the green space be preserved as parkland.
Resident on 123 Whimfield Terrace - Pleased that the school is going ahead. Expressed concern that bike lanes
and sidewalks on Latoria Avenue are intermittent and treacherous.
Director of Planning Matthew Baldwin responded that the Park review will not be complete in time."""

STREETS = {"streets": ["Wendey Drive", "Whimfield Terrace", "Latoria Avenue"]}


def raw(**over):
    return {"label": "Resident on Wendey Drive", "position": "supports", "topic": "Green space covenant",
            "point": "Supports the development if a covenant protects the green space.",
            "support_quote": "Requested that portions of the green space be preserved as parkland.", **over}


def test_admits_grounded_speaker_with_minutes_label():
    speakers, proofs, dropped = admit_speakers([raw()], MINUTES, STREETS)
    assert speakers == [{"who": "Resident on Wendey Drive", "position": "supports", "topic": "Green space covenant",
                         "point": "Supports the development if a covenant protects the green space."}]
    assert proofs == [{"quote": "Requested that portions of the green space be preserved as parkland."}] and not dropped


def test_quote_may_span_a_line_break_and_ignores_case_and_punctuation():
    quote = "conditionally approves of this development if there is a covenant to protect the green space"
    assert admit_speakers([raw(support_quote=quote)], MINUTES, STREETS)[0]


def test_drops_speakers_whose_quote_is_not_in_the_minutes():
    speakers, _, dropped = admit_speakers([raw(support_quote="Demanded that the city buy the whole property.")], MINUTES, STREETS)
    assert speakers == [] and "quote not in minutes" in dropped[0]


def test_drops_invented_labels():
    speakers, _, dropped = admit_speakers([raw(label="Jane Smith, Resident on Elm Street")], MINUTES, STREETS)
    assert speakers == [] and "label not in minutes" in dropped[0]


def test_drops_too_short_quotes():
    assert admit_speakers([raw(support_quote="green space")], MINUTES, STREETS)[0] == []


def test_house_numbers_and_pronouns_never_appear():
    [speaker], _, _ = admit_speakers([raw(label="Resident on 123 Whimfield Terrace",
                                          point="She is pleased the school is going ahead at 55 Latoria Avenue.",
                                          support_quote="Pleased that the school is going ahead.")], MINUTES, STREETS)
    assert speaker["who"] == "Resident on Whimfield Terrace"
    assert "55" not in speaker["point"] and "123" not in str(speaker)
    assert not any(w in speaker["point"].lower().split() for w in ("she", "he", "her", "his"))


def test_applicant_representative_keeps_named_label_and_duplicates_collapse():
    entry = raw(label="Representative for the applicant, Dale Douglas", position="other", topic="Project history",
                point="Describes the history of the project.", support_quote="Dale Douglas gave a history of the project.")
    speakers, _, _ = admit_speakers([entry, dict(entry)], MINUTES, STREETS)
    assert [s["who"] for s in speakers] == ["Representative for the applicant, Dale Douglas"]


def test_participation_shape_matches_transcript_stage():
    speakers, proofs, _ = admit_speakers([raw()], MINUTES, STREETS)
    result = build_participation(speakers, proofs, [189])
    assert result["source"] == "minutes" and result["overview"] and set(result["speakers"][0]) == {"who", "position", "point", "topic"}
    assert result["validation"]["document_ids"] == [189]


def test_minutes_text_uses_only_minutes_documents():
    text, ids = minutes_text([{"id": 2, "category": "Agenda", "full_text": "agenda"}, {"id": 1, "category": "Minutes", "full_text": "m1"}])
    assert (text, ids) == ("m1", [1])


class Result:
    def __init__(self, data, count=None):
        self.data, self.count = data, count


class Table:
    def __init__(self, rows):
        self.rows, self.filters, self.payload, self.one = rows, {}, None, False

    def select(self, *_, **__):
        return self

    def eq(self, key, value):
        self.filters[key] = value
        return self

    def is_(self, key, value):  # guarded_update's "no written_rev yet" filter
        return self

    def ilike(self, *_):
        return self

    def limit(self, *_):
        return self

    def single(self):
        self.one = True
        return self

    def update(self, payload):
        self.payload = payload
        return self

    def execute(self):
        rows = [r for r in self.rows if all(r.get(k) == v for k, v in self.filters.items())]
        if self.payload is not None:
            for r in rows:
                r.update(self.payload)
            return Result(rows)
        return Result(rows[0] if self.one else rows, len(rows))


class FakeDb:
    def __init__(self, segments=0, meta=None):
        self.data = {"agenda_items": [{"id": 1, "meeting_id": 9, "title": "PUBLIC HEARING - Bylaw 1760", "meta": meta}],
                     "documents": [{"id": 5, "meeting_id": 9, "category": "Minutes", "full_text": MINUTES}],
                     "transcript_segments": [{"id": i, "meeting_id": 9} for i in range(segments)]}

    def table(self, name):
        return Table(self.data[name])


def test_writes_participation_and_stamp_through_guarded_update():
    db = FakeDb()
    result = summarize_from_minutes(db, 1, draft=lambda *_: [raw()])
    meta = db.data["agenda_items"][0]["meta"]
    assert result["source"] == "minutes" and meta["participation"] == result
    assert meta["participation_minutes_version"] and meta["participation_minutes_input"]


def test_dry_run_writes_nothing_and_no_speakers_only_stamps():
    db = FakeDb()
    assert summarize_from_minutes(db, 1, dry_run=True, draft=lambda *_: [raw()])["speakers"]
    assert db.data["agenda_items"][0]["meta"] is None
    assert summarize_from_minutes(db, 1, draft=lambda *_: []) is None
    meta = db.data["agenda_items"][0]["meta"]
    assert "participation" not in meta and meta["participation_minutes_version"]


def test_skips_meetings_with_a_transcript_and_transcript_summaries():
    def boom(*_):
        raise AssertionError("must not call the model")
    assert summarize_from_minutes(FakeDb(segments=3), 1, draft=boom) is None
    transcript = {"participation": {"speakers": [{"who": "A resident"}], "overview": "x"}}
    assert summarize_from_minutes(FakeDb(meta=transcript), 1, draft=boom) is None
