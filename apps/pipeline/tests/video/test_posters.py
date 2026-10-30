"""video-posters stage: offsets, frame filtering, deterministic pick, meta merge and stage selection."""

import io
import json
from unittest.mock import MagicMock

import pytest
from PIL import Image

from pipeline import stages
from pipeline.stages import StageContext
from pipeline.video import posters


def _jpeg(color=None, noise=False, size=(1920, 1080)):
    img = Image.new("RGB", size, color or (0, 0, 0))
    if noise:
        px = img.load()
        for x in range(0, size[0], 4):
            for y in range(0, size[1], 4):
                v = (x * 7 + y * 13) % 256
                for dx in range(4):
                    for dy in range(4):
                        px[x + dx, y + dy] = (v, v, v)
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


SCENE = _jpeg(noise=True)
BLACK = _jpeg((2, 2, 2))
GREY = _jpeg((128, 128, 128))


class TestOffsets:
    def test_starts_150s_in_then_spreads(self):
        assert posters.candidate_offsets(10_000) == [150, 1500, 3000, 4500, 6000, 7500, 9000]

    def test_clamped_to_short_video(self):
        offs = posters.candidate_offsets(100)
        assert offs and all(0 <= o <= 90 for o in offs)
        assert len(set(offs)) == len(offs)

    def test_unknown_duration_uses_fallbacks(self):
        assert posters.candidate_offsets(None) == list(posters.FALLBACK_OFFSETS_S)


class TestFrames:
    def test_rejects_black_and_uniform(self):
        assert posters.is_usable(SCENE)
        assert not posters.is_usable(BLACK)
        assert not posters.is_usable(GREY)
        assert not posters.is_usable(None)
        assert not posters.is_usable(b"not an image")

    def test_pick_is_deterministic_per_meeting(self):
        offs = [150, 2000, 4000, 6000]
        assert posters.pick(42, offs) == posters.pick(42, list(reversed(offs)))
        assert {posters.pick(m, offs) for m in range(40)} > {150}  # actually varies across meetings

    def test_encode_webp_scales_to_1280(self):
        data, w, h = posters.encode_webp(SCENE)
        assert (w, h) == (1280, 720)
        assert Image.open(io.BytesIO(data)).format == "WEBP"


class TestResolve:
    def test_direct_mp4_passes_through(self):
        assert posters.resolve_media_url("https://video.isilive.ca/langford/x.mp4") == "https://video.isilive.ca/langford/x.mp4"

    def test_isi_player_uses_existing_resolver(self, monkeypatch):
        from pipeline.video.isilive import ISILiveClient

        seen = {}

        def fake(self, data):
            seen["url"] = data["url"]
            seen["base"] = self.base_url
            return "https://video.isilive.ca/langford/2022-01-17.mp4"

        monkeypatch.setattr(ISILiveClient, "_resolve_media_url", fake)
        url = "https://pub-langford.escribemeetings.com/Players/ISIStandAlonePlayer.aspx?Id=abc"
        assert posters.resolve_media_url(url) == "https://video.isilive.ca/langford/2022-01-17.mp4"
        assert seen == {"url": url, "base": "https://pub-langford.escribemeetings.com"}


class TestMakePoster:
    def _run(self, frames, **kw):
        kw.setdefault("classify", None)  # no AI in unit tests unless a fake is passed
        stored = {}

        def store(key, data):
            stored[key] = data
            return f"https://cdn.example/{key}"

        res = posters.make_poster(
            {"id": 7, "video_url": "https://x/p"},
            resolve=lambda u: "https://x/v.mp4", probe=lambda u: 10_000,
            grab=lambda u, o: frames.get(o), store=store, **{"offsets_for": lambda d: sorted(frames), **kw},
        )
        return res, stored

    def test_skips_dark_frames_and_uploads_chosen(self):
        res, stored = self._run({150: BLACK, 2000: SCENE, 4000: GREY, 6000: SCENE, 8000: None})
        assert res.poster["offset_s"] in (2000, 6000)
        assert res.poster["usable"] == 2 and res.poster["candidates"] == 5
        assert res.poster["version"] == posters.POSTER_VERSION
        [key] = stored
        assert key == f"meeting-posters/7/{res.poster['offset_s']}-v{posters.POSTER_VERSION}.webp"
        assert res.poster["url"] == f"https://cdn.example/{key}"

    def test_prefers_room_shots_over_slides(self):
        slide = _jpeg((250, 250, 250))
        frames = {150: slide, 2000: SCENE, 4000: slide}
        res, _ = self._run(frames, usable=lambda f: f is not None, slide=lambda f: f is slide)
        assert res.poster["offset_s"] == 2000 and res.poster["shot"] == "other"
        res, _ = self._run({150: slide}, usable=lambda f: f is not None, slide=lambda f: True)
        assert res.poster["offset_s"] == 150 and res.poster["shot"] == "slide"  # only when nothing else

    def test_council_first_public_podium_last(self):
        frames = {150: SCENE, 2000: SCENE, 4000: SCENE, 6000: SCENE}
        kinds = {150: "podium_public", 2000: "slide", 4000: "council_wide", 6000: "staff"}
        res, _ = self._run(frames, classify=lambda fs: {o: kinds[o] for o in fs}, slide=lambda f: False)
        assert res.poster["offset_s"] == 4000 and res.poster["shot"] == "council_wide"
        assert res.poster["shots"] == kinds

        kinds = {150: "podium_public", 2000: "slide", 4000: "podium_public", 6000: "empty_room"}
        res, _ = self._run(frames, classify=lambda fs: {o: kinds[o] for o in fs}, slide=lambda f: False)
        assert res.poster["offset_s"] == 6000  # empty room beats the public podium

        kinds = {150: "podium_public", 2000: "podium_public", 4000: "podium_public", 6000: "slide"}
        res, _ = self._run(frames, classify=lambda fs: {o: kinds[o] for o in fs}, slide=lambda f: False)
        assert res.poster["offset_s"] == 6000  # even a slide beats the podium

    def test_second_round_when_no_council_shot(self):
        # first round: 150 / 2000 (podium, slide); midpoints 1075 and 6000 get grabbed next
        frames = {150: SCENE, 2000: SCENE, 1075: SCENE, 6000: SCENE}
        kinds = {150: "podium_public", 2000: "slide", 1075: "council_wide", 6000: "podium_public"}
        res, _ = self._run(frames, classify=lambda fs: {o: kinds[o] for o in fs}, slide=lambda f: False,
                           offsets_for=lambda d: [150, 2000])
        assert res.poster["offset_s"] == 1075 and res.poster["candidates"] == 4

    def test_second_round_offsets(self):
        assert posters.second_round_offsets([150, 1500, 3000], 4000) == [825, 2250, 3495]

    def test_ties_within_best_tier_are_seeded_by_meeting(self):
        frames = {150: SCENE, 2000: SCENE, 4000: SCENE}
        both = lambda fs: {150: "council_wide", 2000: "podium_public", 4000: "council_wide"}
        res, _ = self._run(frames, classify=both, slide=lambda f: False)
        assert res.poster["offset_s"] == posters.pick(7, [150, 4000])

    def test_classifier_failures_fall_back_to_other(self, monkeypatch):
        from pipeline import ai
        monkeypatch.setattr(ai, "decide_many", lambda items, workers=4: [RuntimeError("down")] * len(list(items)))
        assert posters.classify_frames({150: SCENE, 300: SCENE}) == {150: "other", 300: "other"}

    def test_slide_detector(self):
        white_slide = Image.new("RGB", (1280, 720), (245, 245, 245))
        white_slide.paste((40, 40, 40), (100, 80, 700, 140))  # a title bar
        buf = io.BytesIO(); white_slide.save(buf, format="JPEG")
        assert posters.looks_like_slide(buf.getvalue())
        assert not posters.looks_like_slide(SCENE)

    def test_all_dark_fails_without_upload(self):
        res, stored = self._run({150: BLACK, 2000: BLACK})
        assert res.poster is None and "dark" in res.error and not stored

    def test_dry_run_does_not_upload(self):
        res, stored = self._run({150: SCENE}, dry_run=True)
        assert res.poster["url"] is None and not stored

    def test_unresolvable(self):
        res = posters.make_poster({"id": 1, "video_url": "x"}, resolve=lambda u: None, store=None)
        assert res.poster is None and "resolve" in res.error


def test_save_poster_merges_only_the_poster_key():
    cur = MagicMock()
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    posters.save_poster(5, {"url": "u", "offset_s": 150}, conn=conn)
    sql, params = cur.execute.call_args.args
    assert "meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(%s::text, %s::jsonb)" in sql
    assert params[0] == "poster" and json.loads(params[1]) == {"url": "u", "offset_s": 150} and params[2] == 5
    conn.commit.assert_called_once()


def test_save_retries_read_only_sessions(monkeypatch):
    from pipeline.ingestion import embed

    class ReadOnlySqlTransaction(Exception):
        pass

    conns = []

    def connect():
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        if len(conns) < 2:
            cur.execute.side_effect = ReadOnlySqlTransaction("read-only")
        conns.append(conn)
        return conn

    monkeypatch.setattr(embed, "get_db_connection", connect)
    monkeypatch.setattr(posters.time, "sleep", lambda s: None)
    posters.save_poster(5, {"url": "u"})
    assert len(conns) == 3 and conns[2].commit.called and all(c.close.called for c in conns)


class TestStage:
    def test_registered_post_ingest_and_versioned(self):
        s = stages.get_stage("video-posters")
        assert s.when == "post_ingest" and s.version == posters.POSTER_VERSION and s.stale is not None

    def _ctx(self, monkeypatch, rows, **kw):
        monkeypatch.setattr(stages, "_poster_rows", lambda ctx, ids=None: [r for r in rows if ids is None or r["id"] in ids])
        return StageContext(supabase=MagicMock(), **kw)

    ROWS = [
        {"id": 1, "video_url": "a", "poster_url": None, "poster_version": None},
        {"id": 2, "video_url": "b", "poster_url": "https://x", "poster_version": posters.POSTER_VERSION},
        {"id": 3, "video_url": "c", "poster_url": "https://x", "poster_version": "0"},
    ]

    def test_backfill_targets_missing_and_stale_targets_old_versions(self, monkeypatch, capsys):
        ctx = self._ctx(monkeypatch, self.ROWS, dry_run=True)
        stages.run_video_posters(ctx)
        assert "1: 1" in capsys.readouterr().out
        ctx = self._ctx(monkeypatch, self.ROWS, stale=True)
        assert stages.stale_video_posters(ctx) == [1, 3]

    def test_post_ingest_makes_and_saves(self, monkeypatch):
        saved = {}
        monkeypatch.setattr(posters, "make_poster",
                            lambda row: posters.PosterResult(row["id"], {"url": "u", "offset_s": 150, "usable": 1, "candidates": 5}))
        monkeypatch.setattr(posters, "save_poster", lambda mid, p: saved.setdefault(mid, p))
        ctx = self._ctx(monkeypatch, self.ROWS, meeting_ids=[1, 2])
        out = stages.run_video_posters(ctx)
        assert out == {"meetings": 1, "made": 1, "failed": []}
        assert list(saved) == [1]
