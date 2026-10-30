"""share-cards stage: text selection, re-render keys, template filling, render sanity checks, selection."""

import io
from unittest.mock import MagicMock

from PIL import Image

from pipeline import stages
from pipeline.stages import StageContext
from pipeline.video import share_cards as sc

POSTER = {"url": "https://cdn.example/meeting-posters/7/150-v2.webp"}
BASE = {
    "id": 7, "title": "Regular Council", "meeting_date": "2026-05-19", "video_duration_seconds": 8000,
    "summary": "- Approved E-Comm 911 dispatch agreement (E-Comm).\n- Adopted Community Standards Bylaw (Bylaw 2255).\n"
               "- Adopted rezoning at 897 Walfred Road (Bylaw 2235).\n- Issued a temporary use permit (TUP26-0003).",
    "poster": POSTER, "organization": {"name": "Council"},
}


class TestText:
    def test_prefers_plain_language_highlights(self):
        m = {**BASE, "highlights": {"version": "3", "bullets": ["Council signed on to E-Comm 911.", "  ", "Noise rules got stricter"]}}
        points, source = sc.card_points(m)
        assert points == ["Council signed on to E-Comm 911", "Noise rules got stricter"]
        assert source == "highlights:3"

    def test_falls_back_to_summary_without_topic_tags(self):
        points, source = sc.card_points(BASE)
        assert source == "summary"
        assert points == ["Approved E-Comm 911 dispatch agreement", "Adopted Community Standards Bylaw",
                          "Adopted rezoning at 897 Walfred Road"]

    def test_card_data(self):
        data, key = sc.card_data(BASE)
        assert data["date"] == "Tuesday, May 19, 2026"
        assert data["eyebrow"] == "Council" and data["frame"] == POSTER["url"]
        assert data["duration"] == "2h 13m"
        assert key == f"v{sc.CARD_VERSION}|summary|{POSTER['url']}"
        assert data["video"] is True
        assert sc.card_data({**BASE, "poster": None, "video_url": None})[0]["video"] is False


class TestKey:
    def test_key_changes_when_highlights_or_poster_change(self):
        k0 = sc.card_key(BASE)
        k1 = sc.card_key({**BASE, "highlights": {"version": "1", "bullets": ["x"]}})
        k2 = sc.card_key({**BASE, "highlights": {"version": "2", "bullets": ["x"]}})
        k3 = sc.card_key({**BASE, "poster": {"url": "https://cdn.example/other.webp"}})
        assert len({k0, k1, k2, k3}) == 4
        assert sc.r2_key(7, k1).startswith("meeting-cards/7/") and sc.r2_key(7, k1) != sc.r2_key(7, k2)

    def test_no_frame_key(self):
        assert sc.card_key({**BASE, "poster": None}).endswith("|no-frame")


def test_fill_template_embeds_escaped_json():
    out = sc.fill_template({"title": "A </script><b>", "points": []}, '<script id="card-data" type="application/json">{}</script>')
    assert "</script><b>" not in out and "<\\/script>" in out


class TestChecks:
    def test_dom_problems(self):
        data = {"title": "Regular Council", "date": "x", "eyebrow": "Council", "frame": "u"}
        good = {"ready": "ok", "title": "Regular Council", "date": "x", "eyebrow": "Council", "frame": 1280, "inter": True}
        assert sc.check_dom(data, good) == []
        assert sc.check_dom(data, {**good, "title": ""}) == ["title not rendered"]
        assert "eyebrow not rendered" in sc.check_dom(data, {**good, "eyebrow": ""})
        assert any("frame" in p for p in sc.check_dom(data, {**good, "ready": "error", "frame": 0}))
        assert sc.check_dom({**data, "frame": None}, {**good, "ready": "none", "frame": 0}) == []

    def test_blank_output_is_rejected(self):
        buf = io.BytesIO(); Image.new("RGB", (1200, 630), (10, 18, 20)).save(buf, format="PNG")
        assert "output is near-uniform" in sc.check_pixels(buf.getvalue(), framed=True)


class TestStage:
    def test_registered_after_posters(self):
        order = [s.name for s in stages.STAGES]
        assert order.index("video-posters") < order.index("share-cards")
        assert stages.get_stage("share-cards").stale is not None

    def test_stale_and_missing_selection(self, monkeypatch, capsys):
        fresh = {**BASE, "id": 1, "highlights": {"version": "1", "bullets": ["x"]}}
        fresh["card_key"] = sc.card_key(fresh)
        old = {**fresh, "id": 2, "highlights": {"version": "2", "bullets": ["y"]}}  # highlights changed since render
        new = {**BASE, "id": 3, "highlights": {"version": "1", "bullets": ["z"]}, "card_key": None}
        monkeypatch.setattr(stages, "_card_rows", lambda ctx, ids=None, highlights_only=True: [fresh, old, new])
        assert stages.stale_share_cards(StageContext(supabase=MagicMock())) == [2, 3]
        stages.run_share_cards(StageContext(supabase=MagicMock(), dry_run=True))
        assert "share cards for: 1: 3" in capsys.readouterr().out

    def test_card_failure_is_logged_and_skipped(self, monkeypatch):
        row = {**BASE, "id": 4, "highlights": {"version": "1", "bullets": ["x"]}, "card_key": None}
        monkeypatch.setattr(stages, "_card_rows", lambda ctx, ids=None, highlights_only=True: [row])

        class R:
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def boom(m, r):
            raise sc.CardError("title not rendered")

        saved = []
        monkeypatch.setattr(sc, "CardRenderer", R)
        monkeypatch.setattr(sc, "make_card", boom)
        from pipeline.video import posters
        monkeypatch.setattr(posters, "save_meta_key", lambda *a: saved.append(a))
        out = stages.run_share_cards(StageContext(supabase=MagicMock(), meeting_ids=[4]))
        assert out == {"meetings": 1, "made": 0, "failed": [4]} and not saved


class TestTitleCards:
    def test_data_matches_player_overlay(self):
        data, key = sc.title_card_data(BASE)
        assert data == {"title": "Regular Council", "eyebrow": "Council", "date": "May 19, 2026", "frame": POSTER["url"]}
        assert "points" not in data
        assert key.startswith(f"t{sc.TITLE_CARD_VERSION}|{POSTER['url']}|")
        same = {**BASE, "organization": {"name": "Regular Council"}}
        assert sc.title_card_data(same)[0]["eyebrow"] is None  # label hidden when it repeats the title

    def test_needs_a_poster(self):
        assert sc.title_card_data({**BASE, "poster": None}) is None
        assert sc.title_card_key({**BASE, "poster": None}) is None

    def test_key_tracks_poster_and_title(self):
        k = sc.title_card_key(BASE)
        assert k != sc.title_card_key({**BASE, "poster": {"url": "https://cdn.example/new.webp"}})
        assert k != sc.title_card_key({**BASE, "title": "Special Council"})
        assert k == sc.title_card_key({**BASE, "summary": "changed"})  # text below the title doesn't matter

    def test_make_title_card_uploads_jpeg_at_16_9(self):
        class R:
            def render(self, data):
                assert data["title"] and data["date"] and data["frame"]
                return b"jpg"

        stored = {}
        card = sc.make_title_card({**BASE}, R(), store=lambda k, d, t: stored.setdefault(k, (d, t)) and f"https://cdn/{k}")
        [(key, (data, ctype))] = stored.items()
        assert key.startswith("meeting-title-cards/7/") and ctype == "image/jpeg"
        assert card["url"] == f"https://cdn/{key}" and (card["width"], card["height"]) == (1280, 720)
        assert card["version"] == sc.TITLE_CARD_VERSION

    def test_stage_selects_changed_and_saves(self, monkeypatch):
        fresh = {**BASE, "id": 1}
        fresh["title_key"] = sc.title_card_key(fresh)
        moved = {**BASE, "id": 2, "title_key": "t0|old"}
        monkeypatch.setattr(stages, "_title_card_rows", lambda ctx, ids=None: [r for r in (fresh, moved) if ids is None or r["id"] in ids])
        assert stages.stale_title_cards(StageContext(supabase=MagicMock())) == [2]

        class R:
            def __enter__(self): return self
            def __exit__(self, *a): return False

        saved = []
        from pipeline.video import posters
        monkeypatch.setattr(sc, "title_renderer", lambda: R())
        monkeypatch.setattr(sc, "make_title_card", lambda row, r: {"url": "u", "version": "1"})
        monkeypatch.setattr(posters, "save_meta_key", lambda mid, k, v: saved.append((mid, k)))
        out = stages.run_title_cards(StageContext(supabase=MagicMock(), meeting_ids=[1, 2]))
        assert out == {"meetings": 1, "made": 1, "failed": []} and saved == [(2, "title_card")]
