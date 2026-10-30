"""Poster frames for meeting videos.

The web player shows ``meetings.meta.poster.url`` behind the play button instead
of a black box. For each meeting with a ``video_url`` we resolve the direct
media URL (eSCRIBE ISI player page -> video.isilive.ca mp4; anything else via
yt-dlp), grab a handful of candidate frames straight from the stream with
ffmpeg (``-ss`` before ``-i``, so only a few range requests, no download), drop
near-black or uniform frames (title cards, dead air), and classify the rest with
the Decisions API (one cheap image question per frame): council at the dais
first, then other room shots, then slides, and a member of the public at the
podium only when nothing else is usable. Within the best group the frame is
picked at random, seeded by the meeting id so the choice is stable across runs. The chosen frame
is scaled to 1280 wide, encoded as WebP and uploaded to the public R2 bucket
the document images already use.

Only the ``poster`` key of ``meetings.meta`` is written, with a jsonb merge, so
concurrent writers of other meta keys are never clobbered.
"""
from __future__ import annotations

import io
import json
import os
import random
import subprocess
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlparse

# Bump when frame selection or encoding changes; stamped in meetings.meta.poster.version.
POSTER_VERSION = "3"  # 2: prefer room shots over slides; 3: classify shots, prefer council, avoid the public podium

FIRST_OFFSET_S = 150          # meeting has started, past any title card / black lead-in
SPREAD_FRACTIONS = (0.15, 0.3, 0.45, 0.6, 0.75, 0.9)
FALLBACK_OFFSETS_S = (150, 600, 1200, 1800, 2400, 3600, 4800)  # when the duration is unknown
END_MARGIN_S = 10
WIDTH = 1280
WEBP_QUALITY = 70
FFMPEG_TIMEOUT_S = 90

# Frame quality: mean luma (0-255) and its standard deviation.
MIN_MEAN, MAX_MEAN, MIN_STDDEV = 20, 240, 14
# Shared-screen slides: mostly near-white, or mostly perfectly flat pixels (chamber shots are
# ~0.15-0.38 bright and ~0.50-0.59 flat). Usable, but only picked when no room shot is.
SLIDE_BRIGHT_FRACTION, SLIDE_FLAT_FRACTION = 0.45, 0.65

R2_PREFIX = "meeting-posters"

# Shot kinds, best first. A member of the public at the podium is never the face of a
# meeting while any other usable frame exists.
SHOT_ORDER = ("council_wide", "council_member", "staff", "other", "empty_room", "slide", "podium_public")
CLASSIFY_WIDTH = 640


def shot_question() -> dict:
    from pipeline import ai

    return ai.choice(
        "shot",
        "This is a still frame from a recorded City of Langford council or committee meeting video. "
        "What does the frame mainly show?",
        [
            ("council_wide", "A wide or medium shot of the council or committee members seated at the curved dais "
                             "or meeting table (several members visible)."),
            ("council_member", "A close-up of one or two council or committee members, or the chair, seated at the "
                               "dais or table."),
            ("podium_public", "A person standing or seated at the public podium or lectern facing council: a "
                              "delegation, presenter or member of the public speaking."),
            ("staff", "City staff seated at a staff table or presenting from it."),
            ("slide", "A shared screen, slide presentation, document, map or video conference grid filling most "
                      "of the frame."),
            ("empty_room", "An empty or nearly empty room, wall or chairs with no meeting participants clearly "
                           "visible."),
            ("other", "Anything else (title card, test pattern, blurry or unclear)."),
        ],
    )


def _small_jpeg(jpeg: bytes) -> bytes:
    from PIL import Image

    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    img.thumbnail((CLASSIFY_WIDTH, CLASSIFY_WIDTH))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def classify_frames(frames: dict[int, bytes]) -> dict[int, str]:
    """Shot kind per offset via the Decisions API; frames that fail to classify come back "other"."""
    from pipeline import ai

    offsets = list(frames)
    if not offsets:
        return {}
    q = shot_question()
    items = [("Classify this meeting video frame.", [q], [{"data": _small_jpeg(frames[o]), "mime_type": "image/jpeg"}])
             for o in offsets]
    out: dict[int, str] = {}
    for o, res in zip(offsets, ai.decide_many(items, workers=4)):
        ans = None if isinstance(res, Exception) else res.get("shot")
        kind = getattr(ans, "choice", None)
        out[o] = kind if kind in SHOT_ORDER else "other"
    return out


@dataclass
class PosterResult:
    meeting_id: int
    poster: dict | None
    error: str | None = None
    candidates: int = 0
    usable: int = 0


# ── media URL ────────────────────────────────────────────────────────────


def is_isi_player(url: str) -> bool:
    p = urlparse(url)
    return "escribemeetings.com" in p.netloc and "isistandaloneplayer" in p.path.lower()


def resolve_media_url(video_url: str) -> str | None:
    """Direct, ffmpeg-readable media URL for a meeting's ``video_url``."""
    if not video_url:
        return None
    path = urlparse(video_url).path.lower()
    if path.endswith((".mp4", ".m4v", ".mov", ".m3u8")):
        return video_url
    if is_isi_player(video_url):
        from pipeline.video.isilive import ISILiveClient

        p = urlparse(video_url)
        client = ISILiveClient(base_url=f"{p.scheme}://{p.netloc}", client_id="")
        url = client._resolve_media_url({"url": video_url})
        # Without a client id the resolver yields ".../ /file"; treat as unresolved.
        return url if url and "isilive.ca//" not in url else None
    try:  # Vimeo and friends
        import yt_dlp

        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "format": "best[vcodec!=none]/best"}) as ydl:
            info = ydl.extract_info(video_url, download=False)
        return info.get("url") or None
    except Exception:
        return None


# ── frames ───────────────────────────────────────────────────────────────


def probe_duration(media_url: str) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", media_url],
            capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_S, check=True,
        ).stdout
        d = float(json.loads(out)["format"]["duration"])
        return d if d > 0 else None
    except Exception:
        return None


def candidate_offsets(duration: float | None) -> list[int]:
    """~150 s in, then spread through the meeting; all clamped inside the video."""
    if not duration:
        return list(FALLBACK_OFFSETS_S)
    last = max(0, int(duration) - END_MARGIN_S)
    raw = [FIRST_OFFSET_S] + [int(duration * f) for f in SPREAD_FRACTIONS]
    out: list[int] = []
    for o in raw:
        o = min(o, last)
        if all(abs(o - x) >= 5 for x in out):
            out.append(o)
    return out


def grab_frame(media_url: str, offset_s: int) -> bytes | None:
    """One JPEG frame at ``offset_s`` read straight from the stream (input seeking)."""
    try:
        res = subprocess.run(
            ["ffmpeg", "-v", "error", "-nostdin", "-ss", str(offset_s), "-i", media_url,
             "-frames:v", "1", "-vf", f"scale={WIDTH}:-2", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "2", "-"],
            capture_output=True, timeout=FFMPEG_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return None
    return res.stdout or None


def frame_stats(jpeg: bytes) -> tuple[float, float]:
    from PIL import Image, ImageStat

    img = Image.open(io.BytesIO(jpeg)).convert("L")
    img.thumbnail((320, 320))
    st = ImageStat.Stat(img)
    return st.mean[0], st.stddev[0]


def looks_like_slide(jpeg: bytes) -> bool:
    """A presentation filling the frame rather than the room (flat backgrounds, mostly white)."""
    from PIL import Image, ImageChops

    try:
        img = Image.open(io.BytesIO(jpeg)).convert("L")
    except Exception:
        return False
    img.thumbnail((320, 320))
    w, h = img.size
    diff = ImageChops.difference(img.crop((1, 0, w, h)), img.crop((0, 0, w - 1, h))).histogram()
    flat = sum(diff[:2]) / max(1, sum(diff))
    bright = sum(img.histogram()[215:]) / max(1, w * h)
    return bright >= SLIDE_BRIGHT_FRACTION or flat >= SLIDE_FLAT_FRACTION


def is_usable(jpeg: bytes | None) -> bool:
    if not jpeg:
        return False
    try:
        mean, sd = frame_stats(jpeg)
    except Exception:
        return False
    return MIN_MEAN <= mean <= MAX_MEAN and sd >= MIN_STDDEV


def pick(meeting_id: int, offsets: list[int]) -> int:
    """Deterministic 'random' choice per meeting, so the poster doesn't change between runs."""
    return random.Random(f"poster:{meeting_id}").choice(sorted(offsets))


def encode_webp(jpeg: bytes) -> tuple[bytes, int, int]:
    from PIL import Image

    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    if img.width != WIDTH:
        img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue(), img.width, img.height


# ── storage + DB ─────────────────────────────────────────────────────────


def public_base() -> str:
    from pipeline.ingestion.matter_images import IMAGE_BASE

    return (os.environ.get("DOCUMENT_IMAGE_PUBLIC_BASE_URL") or IMAGE_BASE).rstrip("/")


def r2_key(meeting_id: int, offset_s: int) -> str:
    return f"{R2_PREFIX}/{meeting_id}/{offset_s}-v{POSTER_VERSION}.webp"


def upload(key: str, data: bytes, content_type: str = "image/webp") -> str:
    from pipeline.ingestion.image_extractor import get_r2_client

    client = get_r2_client()
    if client is None:
        raise RuntimeError("R2 is not configured (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT_URL)")
    client.put_object(
        Bucket=os.environ.get("R2_BUCKET_NAME", "viewroyal-document-images"),
        Key=key, Body=data, ContentType=content_type,
        CacheControl="public, max-age=31536000, immutable",
    )
    return f"{public_base()}/{key}"


MERGE_SQL = (
    "update meetings set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(%s::text, %s::jsonb) "
    "where id = %s"
)


def save_meta_key(meeting_id: int, key: str, value: dict, conn: Any = None) -> None:
    """Merge one top-level key into meetings.meta without touching any other key."""
    own = conn is None
    if own:
        from pipeline.ingestion.embed import get_db_connection

        conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(MERGE_SQL, (key, json.dumps(value), meeting_id))
        conn.commit()
    finally:
        if own:
            conn.close()


def save_poster(meeting_id: int, poster: dict, conn: Any = None) -> None:
    save_meta_key(meeting_id, "poster", poster, conn)


# ── one meeting ──────────────────────────────────────────────────────────


def make_poster(
    meeting: dict,
    *,
    resolve: Callable[[str], str | None] = resolve_media_url,
    probe: Callable[[str], float | None] = probe_duration,
    grab: Callable[[str, int], bytes | None] = grab_frame,
    usable: Callable[[bytes | None], bool] = is_usable,
    slide: Callable[[bytes], bool] = looks_like_slide,
    classify: Callable[[dict[int, bytes]], dict[int, str]] | None = classify_frames,
    offsets_for: Callable[[float | None], list[int]] = candidate_offsets,
    store: Callable[[str, bytes], str] | None = upload,
    dry_run: bool = False,
) -> PosterResult:
    """Pick and upload a poster frame for one meeting; returns the meta.poster value (not yet saved)."""
    mid = meeting["id"]
    media = resolve(meeting.get("video_url") or "")
    if not media:
        return PosterResult(mid, None, "could not resolve media URL")
    duration = probe(media) or meeting.get("video_duration_seconds") or None
    offsets = offsets_for(duration)
    frames = {o: grab(media, o) for o in offsets}
    good = [o for o, f in frames.items() if usable(f)]
    if not good:
        got = sum(1 for f in frames.values() if f)
        return PosterResult(mid, None, f"no usable frame ({got}/{len(offsets)} grabbed, all dark/uniform)" if got
                            else "no frames grabbed", candidates=len(offsets))
    kinds = (classify or (lambda fs: {o: "other" for o in fs}))({o: frames[o] for o in good})
    for o in good:  # the pixel heuristic backs up the classifier on obvious slides
        if kinds.get(o, "other") in ("other", "empty_room") and slide(frames[o]):
            kinds[o] = "slide"
    best = min(SHOT_ORDER.index(kinds.get(o, "other")) for o in good)
    tier = [o for o in good if SHOT_ORDER.index(kinds.get(o, "other")) == best]
    chosen = pick(mid, tier)
    webp, w, h = encode_webp(frames[chosen])
    poster = {"offset_s": chosen, "version": POSTER_VERSION, "width": w, "height": h,
              "bytes": len(webp), "candidates": len(offsets), "usable": len(good), "shot": kinds.get(chosen, "other"),
              "shots": {o: kinds.get(o, "other") for o in good}}
    if dry_run or store is None:
        poster["url"] = None
    else:
        poster["url"] = store(r2_key(mid, chosen), webp)
    return PosterResult(mid, poster, candidates=len(offsets), usable=len(good))
