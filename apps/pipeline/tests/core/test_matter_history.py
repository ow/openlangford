"""Missed ownership recovery must not become fuzzy matter merging."""
from copy import deepcopy
from types import SimpleNamespace
from pipeline.ingestion.matter_history import plan_history, reconcile_history
from pipeline.ingestion.matter_matching import is_matter_eligible


def proposal(mid=208, city=1, **extra):
    return {"id": mid, "municipality_id": city, "title": "Proposed Parks DCC Rates", "identifier": None,
            "first_seen": "2026-06-29", "last_seen": "2026-06-29", **extra}


def presentation(iid=1369, **extra):
    return {"id": iid, "meeting_id": 50, "matter_id": None, "title": "Proposed Parks DCC Rates (approx. 30 min)",
            "category": "Parks & Recreation", "plain_english_summary": "Consultant presented draft parks DCC rates.",
            "meetings": {"municipality_id": 1, "meeting_date": "2026-06-29"}, **extra}


class Store:
    """Persisted fixture implements filtering/storage, never resolver decisions."""
    def __init__(self, tables):
        self.tables = deepcopy(tables)
        self.writes = []
    def table(self, name):
        store = self
        class Query:
            def __init__(self): self.filters = []; self.patch = None; self.negate = False
            def select(self, *a): return self
            def order(self, *a): return self
            def range(self, *a): return self
            def eq(self, field, value): self.filters.append((field, value)); return self
            @property
            def not_(self): self.negate = True; return self
            def is_(self, field, value):
                self.filters.append((field, (lambda v: v is not None) if self.negate else None))
                self.negate = False
                return self
            def in_(self, field, values): self.filters.append((field, set(values))); return self
            def gte(self, *a): return self
            def update(self, patch): self.patch = patch; return self
            def execute(self):
                def field(row, key):
                    for part in key.split('.'): row = row.get(part)
                    return row
                rows = [r for r in store.tables.get(name, []) if all(v(field(r, k)) if callable(v) else field(r, k) in v if isinstance(v, set) else field(r, k) == v for k, v in self.filters)]
                if self.patch is not None:
                    for row in rows: row.update(self.patch); store.writes.append(row['id'])
                return SimpleNamespace(data=deepcopy(rows))
        return Query()


def test_rate_presentation_eligible_but_container_and_generic_park_update_are_not():
    assert is_matter_eligible(identifier=None, title=presentation()['title'], category="Parks & Recreation")[0]
    assert not is_matter_eligible(identifier=None, title="PRESENTATIONS", summary="Parks DCC rates")[0]
    assert not is_matter_eligible(identifier=None, title="Park picnic update", summary="Annual picnic")[0]


def test_parks_dry_run_apply_and_rerun_preserve_separate_bylaws():
    db = Store({"matters": [proposal(), proposal(1685, title="Parks Development Cost Charge Bylaw 2291", identifier="Bylaw 2291"),
                             proposal(1126, title="Parks Development Cost Charge Bylaw 2024", identifier="Bylaw 2024")],
                "matter_links": [{"matter_id": 208, "related_matter_id": 1685, "kind": "related_matter", "hidden": False}],
                "agenda_items": [presentation()]})
    plan = reconcile_history(db, focus_ids=[1685])
    assert [(r['agenda_item_id'], r['matter_id']) for r in plan['assignments']] == [(1369, 208)]
    assert db.writes == []
    assert len(reconcile_history(db, focus_ids=[1685], dry_run=False)['applied']) == 1
    assert db.tables['agenda_items'][0]['matter_id'] == 208
    assert reconcile_history(db, focus_ids=[1685], dry_run=False)['assignments'] == []
    assert db.writes == [1369]
    assert len(db.tables['matters']) == 3


def test_scope_ambiguity_dates_and_existing_owners_are_not_overridden():
    assert reconcile_history(Store({}), focus_ids=[], dry_run=False)['applied'] == []
    items = [presentation(), presentation(2, matter_id=999), presentation(3, meetings={"municipality_id": 2, "meeting_date": "2026-06-29"}),
             presentation(4, meetings={"municipality_id": 1, "meeting_date": "2025-06-29"})]
    plan = plan_history([proposal(), proposal(99, city=2)], items, focus_ids={208})
    assert [r['agenda_item_id'] for r in plan['assignments']] == [1369]
    assert [r['agenda_item_id'] for r in plan['review']] == [4]
    assert not plan_history([proposal(), proposal(209)], [presentation()], focus_ids={208})['assignments']
    assert not plan_history([proposal(first_seen=None)], [presentation()])['assignments']
    assert not plan_history([proposal(identifier="DVP 2026-02")], [presentation()])['assignments']


def test_apply_does_not_assign_after_a_concurrent_title_correction(monkeypatch):
    from pipeline.ingestion import matter_history
    db = Store({"matters": [proposal()], "agenda_items": [presentation()]})
    real = matter_history.plan_history
    def concurrent(*args, **kwargs):
        plan = real(*args, **kwargs)
        db.tables['agenda_items'][0]['title'] = 'Corrected to a different initiative'
        return plan
    monkeypatch.setattr(matter_history, 'plan_history', concurrent)
    result = reconcile_history(db, dry_run=False)
    assert result['assignments'] and result['applied'] == []
    assert db.tables['agenda_items'][0]['matter_id'] is None


def test_new_matter_revisits_earlier_mentions_only_for_affected_city_and_matter(monkeypatch):
    from pipeline.ingestion import matter_links as links
    matters = [proposal(1685, first_seen="2026-07-20", last_seen="2026-10-05", meta={}, plain_english_summary="Parks charges bylaw"),
               proposal(208, meta={}, plain_english_summary="Earlier parks rates"),
               proposal(999, city=2, meta={}, plain_english_summary="Other city parks rates")]
    db = Store({"agenda_items": [presentation(1368, title="PRESENTATIONS", meta={}),
                                 presentation(9000, title="PRESENTATIONS", meta={}, meetings={"municipality_id": 2, "meeting_date": "2026-06-29"})]})
    monkeypatch.setattr(links, "load_matters", lambda *a: matters)
    monkeypatch.setattr(links, "link_related", lambda *a, **k: [])
    monkeypatch.setattr(links.ai, "embed", lambda texts: [[1.0, 0.0] for text in texts])
    monkeypatch.setattr(links.ai, "decide_many", lambda jobs: [{q["name"]: SimpleNamespace(probability=0.99) for q in questions} for text, questions in jobs])
    result = links.build_links(db, focus_matter_ids=[1685], meeting_ids=[394], since="2022-10-01", dry_run=True)
    assert [(row['matter_id'], row['agenda_item_id']) for row in result['mentions']] == [(1685, 1368)]
    assert db.writes == []
    # Later updates to an established matter need no repeated city-history scan.
    unchanged = links.build_links(db, focus_matter_ids=[1685], meeting_ids=[394], since="2022-10-01", dry_run=True, new_matter_dates={"2026-10-05"})
    assert unchanged['mentions'] == []


def test_summary_context_keeps_mentions_out_of_owned_decisions_and_status(monkeypatch):
    from pipeline.ingestion import matter_summaries as summaries
    db = Store({"matters": [{**proposal(), "meta": {}, "status": "Active", "category": "Parks & Recreation"}],
                "agenda_items": [presentation(1368, title="PRESENTATIONS")],
                "matter_links": [{"matter_id": 208, "kind": "mention", "hidden": False, "agenda_item_id": 1368}]})
    seen = []
    def summarize(batch):
        seen.extend(batch)
        return {208: {"summary": "A consultant presented draft park charges.", "status": "Adopted", "status_line": "Presentation June 29.",
                      "timeline": [{"item": 1368, "headline": "Wrongly claim adoption"}]}}
    monkeypatch.setattr(summaries, "_summarize", summarize)
    result = summaries.refresh_matter_summaries(db, [208], dry_run=True)
    assert seen[0]['history'] == []
    assert seen[-1]['mentions'] == [{"item": 1368, "date": "2026-06-29", "agenda_item": "PRESENTATIONS", "notes": {"summary": "Consultant presented draft parks DCC rates."}, "source": "accepted mention"}]
    assert 'status' not in result[208]
    assert not result[208]['meta'].get('timeline_headlines')
    assert db.writes == []


def test_older_mentions_do_not_freeze_a_later_owned_approval(monkeypatch):
    from pipeline.ingestion import matter_summaries as summaries
    owned = presentation(200, matter_id=208, title="Approval of parkland acquisition")
    db = Store({"matters": [{**proposal(), "meta": {}, "status": "Active"}], "agenda_items": [owned, presentation(1368, title="PRESENTATIONS")],
                "matter_links": [{"matter_id": 208, "kind": "mention", "hidden": False, "agenda_item_id": 1368}]})
    def summarize(batch):
        return {m['id']: {"summary": "Public comment adds context." if m['mentions'] else "Owned acquisition approved.",
                          "status": "Adopted" if m['mentions'] else "Approved", "status_line": "Acquisition approved June 29.",
                          "timeline": [{"item": 200, "headline": "Acquisition approved"}]} for m in batch}
    monkeypatch.setattr(summaries, "_summarize", summarize)
    result = summaries.refresh_matter_summaries(db, [208], dry_run=True)[208]
    assert result['status'] == 'Approved'
    assert result['plain_english_summary'] == 'Public comment adds context.'
    assert result['meta']['timeline_headlines'] == {'200': 'Acquisition approved'}
    context = summaries.refresh_matter_summaries(db, [208], dry_run=True, context_only=True)[208]
    assert 'status' not in context
    assert 'status_line' not in context['meta']


def test_early_instruments_generalize_beyond_dcc_without_accepting_bare_headings():
    positives = ["Draft Climate Action Plan (Approx. 45 min)", "Draft Housing Strategy (Approx. 45 min)",
                 "Arts & Culture Strategy", "Economic Development Strategy", "Parks and Trails Master Plan - Adoption Consideration",
                 "Transportation Master Plan/ Active Transportation Plan Strategy", "Proposed Parks DCC Rates (approx. 30 min)"]
    for title in positives:
        eligible, reason = is_matter_eligible(identifier=None, title=title, category="Planning")
        assert eligible, title
        assert reason == "qualified_policy_instrument", title
    for title in ["PRESENTATIONS", "PUBLIC PARTICIPATION", "Draft Plan", "Program Update", "Proposed Rates", "2026 Annual Report", "Park picnic update", "Design Guidelines"]:
        assert not is_matter_eligible(identifier=None, title=title, category="Planning")[0], title
    assert not is_matter_eligible(identifier=None, title="PUBLIC PARTICIPATION", summary="Draft Climate Action Plan adoption")[0]
    assert not is_matter_eligible(identifier=None, title="General update", summary="Draft Housing Strategy")[0]


def test_policy_history_recovers_stage_names_and_reports_uncreated_proceedings():
    housing = proposal(90, title='Draft Housing Strategy (Approx. 45 min)',
                       first_seen='2026-08-17', last_seen='2026-09-21')
    adoption = presentation(6603, title='Adoption of the Housing Strategy',
                            meetings={'municipality_id': 1, 'meeting_date': '2026-09-21'})
    climate = presentation(6651, title='Draft Climate Action Plan (Approx. 45 min)',
                           meetings={'municipality_id': 1, 'meeting_date': '2026-08-17'})
    plan = plan_history([housing], [adoption, climate])
    assert [(row['agenda_item_id'], row['matter_id']) for row in plan['assignments']] == [(6603, 90)]
    assert plan['new_proceedings'] == [{'municipality_id': 1, 'year': '2026',
                                       'policy_subject': 'climate action plan',
                                       'agenda_item_ids': [6651], 'reason': 'no_existing_policy_proceeding'}]
    earlier_target = {**housing, 'first_seen': '2026-08-17', 'last_seen': '2026-08-17'}
    held = plan_history([earlier_target], [adoption])
    assert held['assignments'] == []
    assert held['review'][0]['candidate_matter_ids'] == [90]
    assert held['review'][0]['reason'] == 'policy_date_or_identifier_requires_review'


def test_current_meeting_with_no_owned_matters_still_reports_missing_proceeding():
    orphan = presentation(6651, title='Draft Climate Action Plan (Approx. 45 min)')
    unrelated = presentation(42, meeting_id=99, title='Draft Housing Strategy')
    db = Store({'matters': [], 'agenda_items': [orphan, unrelated]})
    plan = reconcile_history(db, municipality_ids=[1], focus_ids=[], meeting_ids=[50])
    assert plan['new_proceedings'][0]['agenda_item_ids'] == [6651]
    assert plan['assignments'] == [] and db.writes == []


def test_adoption_outcome_gap_review_preserves_unknowns_and_meeting_scope():
    from pipeline.ingestion.matter_history import review_missing_decisions
    rows = [presentation(3567, matter_id=1126, title='BYLAW NOS. 1960 & 2024 (ADOPTION)'),
            presentation(2, title='Housing Strategy Adoption'),
            presentation(3, title='Climate Action Plan Adoption'),
            presentation(4, title='Adoption of Minutes'),
            presentation(5, meeting_id=99, title='Arts Strategy Adoption')]
    db = Store({'agenda_items': rows,
                'motions': [{'id': 10, 'meeting_id': 50, 'agenda_item_id': 2, 'result': 'DEFEATED'},
                            {'id': 11, 'meeting_id': 50, 'agenda_item_id': 3, 'result': None}]})
    review = review_missing_decisions(db, [50])
    assert [(r['agenda_item_id'], r['motion_ids']) for r in review] == [(3567, []), (3, [11])]
    assert all(r['reason'] == 'adoption_item_without_recorded_outcome' for r in review)
    assert db.writes == []
