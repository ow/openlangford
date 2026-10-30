"""Social share cards (og:image) for meetings.

A 1200x630 card: the meeting's poster frame full-bleed under a scrim, with the
committee, date, title and up to three plain-language points, rendered from
``templates/meeting_card.html`` in headless Chromium (Playwright) and uploaded
to the same public R2 bucket as the posters. Stored as ``meetings.meta.share_card``
(jsonb merge of that key only); the web app uses it as og:image when present.

Points come from ``meta.highlights.bullets`` (plain-language, written by the
meeting-highlights stage) and fall back to the meeting summary. A card's
``key`` records exactly what it was rendered from (template version, highlights
version or "summary", poster URL), so ``--stale`` re-renders a card whenever
highlights arrive or change, the poster is re-picked, or the template changes.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
from datetime import date
from pathlib import Path
from typing import Any

# Bump when the template or the text selection changes.
CARD_VERSION = "2"  # 2: "Read the meeting summary" instead of "Watch" when there is no video
TEMPLATE_PATH = Path(__file__).parent / "templates" / "meeting_card.html"
R2_PREFIX = "meeting-cards"
MAX_POINTS = 3
JPEG_QUALITY = 88


def _clean_point(p: str, *, strip_tag: bool) -> str:
    p = re.sub(r"^\s*[-*•]\s*", "", p or "").strip()
    if strip_tag:  # summaries end bullets with a topic tag: "... (Bylaw 2255)."
        p = re.sub(r"\s*\([^()]{1,40}\)\.?$", "", p)
    return p.rstrip(".").strip()


def card_points(meeting: dict) -> tuple[list[str], str]:
    """(points, source): plain-language highlights first, else the summary's bullets."""
    hl = ((meeting.get("meta") or {}).get("highlights") or meeting.get("highlights") or {})
    bullets = [b for b in (hl.get("bullets") or []) if isinstance(b, str) and b.strip()]
    if bullets:
        return [_clean_point(b, strip_tag=False) for b in bullets][:MAX_POINTS], f"highlights:{hl.get('version') or '0'}"
    lines = [ln for ln in (meeting.get("summary") or "").split("\n") if ln.strip()]
    return [_clean_point(ln, strip_tag=True) for ln in lines][:MAX_POINTS], "summary"


def _duration(seconds: Any) -> str | None:
    try:
        s = int(seconds or 0)
    except (TypeError, ValueError):
        return None
    if s <= 0:
        return None
    return f"{s // 3600}h {s % 3600 // 60:02d}m" if s >= 3600 else f"{max(1, s // 60)} min"


def _meta(meeting: dict) -> dict:
    return meeting.get("meta") or {}


def card_data(meeting: dict) -> tuple[dict, str]:
    """Template data and the content key it was built from."""
    d = date.fromisoformat(str(meeting["meeting_date"])[:10])
    org = (meeting.get("organization") or {}).get("name") or ""
    points, source = card_points(meeting)
    poster = (_meta(meeting).get("poster") or meeting.get("poster") or {}).get("url")
    data = {
        "title": meeting.get("title") or "Council meeting",
        "eyebrow": org or "Council",
        "date": f"{d:%A}, {d:%B} {d.day}, {d.year}",
        "frame": poster,
        "points": points,
        "duration": _duration(meeting.get("video_duration_seconds")),
        "video": bool(meeting.get("video_url") or poster),
    }
    return data, f"v{CARD_VERSION}|{source}|{poster or 'no-frame'}"


def card_key(meeting: dict) -> str:
    return card_data(meeting)[1]


def fill_template(data: dict, template: str | None = None) -> str:
    template = template if template is not None else TEMPLATE_PATH.read_text()
    payload = json.dumps(data).replace("</", "<\\/")
    return re.sub(r'(<script id="card-data" type="application/json">).*?(</script>)',
                  lambda m: m.group(1) + payload + m.group(2), template, count=1, flags=re.S)


class CardRenderer:
    """One headless Chromium page reused for every card."""

    def __enter__(self):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch()
        self._page = self._browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
        self._template = TEMPLATE_PATH.read_text()
        return self

    def __exit__(self, *exc):
        self._browser.close()
        self._pw.stop()

    def render(self, data: dict, attempts: int = 2) -> bytes:
        """JPEG bytes of the 1200x630 card; retries on a fresh page, raises CardError if still bad."""
        if not data.get("title") or not data.get("date"):
            raise CardError("missing title or date")
        last: Exception | None = None
        for attempt in range(attempts):
            if attempt:
                self._page.close()
                self._page = self._browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
            try:
                return self._render_once(data)
            except Exception as e:  # noqa: BLE001 - retried, then surfaced
                last = e
        raise CardError(str(last)) from last

    def _render_once(self, data: dict) -> bytes:
        page = self._page
        page.goto("about:blank")  # a fresh document each time, never document.write over the last card
        page.set_content(fill_template(data, self._template), wait_until="load")
        page.wait_for_function("document.body.dataset.ready", timeout=30_000)
        dom = page.evaluate("""() => {
            const t = (id) => (document.getElementById(id)?.textContent || '').trim();
            const img = document.getElementById('frame');
            return {ready: document.body.dataset.ready, title: t('title'), date: t('date'), eyebrow: t('eyebrow'),
                    frame: img ? img.naturalWidth : 0, inter: document.fonts.check('850 60px Inter')};
        }""")
        problems = check_dom(data, dom)
        if problems:
            raise CardError("; ".join(problems))
        png = page.screenshot(clip={"x": 0, "y": 0, "width": 1200, "height": 630})
        problems = check_pixels(png, framed=bool(data.get("frame")))
        if problems:
            raise CardError("; ".join(problems))
        from PIL import Image

        buf = io.BytesIO()
        Image.open(io.BytesIO(png)).convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        return buf.getvalue()


class CardError(RuntimeError):
    pass


def check_dom(data: dict, dom: dict) -> list[str]:
    """What's wrong with the rendered page, judged from the DOM (empty list when it's fine)."""
    problems = []
    if dom.get("title") != data.get("title"):
        problems.append("title not rendered")
    if not dom.get("date"):
        problems.append("date not rendered")
    if data.get("eyebrow") and not dom.get("eyebrow"):
        problems.append("eyebrow not rendered")
    if data.get("frame") and (dom.get("ready") != "ok" or not dom.get("frame")):
        problems.append(f"frame did not load ({data.get('frame')})")
    if not dom.get("inter"):
        problems.append("Inter font not loaded")
    return problems


def check_pixels(png: bytes, *, framed: bool) -> list[str]:
    """Catch blank output: a card is never near-uniform, and a framed one has image detail on the right."""
    from PIL import Image, ImageStat

    img = Image.open(io.BytesIO(png)).convert("L")
    problems = []
    if ImageStat.Stat(img).stddev[0] < 12:
        problems.append("output is near-uniform")
    if framed and ImageStat.Stat(img.crop((850, 0, 1200, 630))).stddev[0] < 8:
        problems.append("frame area is blank")
    return problems


def r2_key(meeting_id: int, key: str) -> str:
    return f"{R2_PREFIX}/{meeting_id}/{hashlib.sha1(key.encode()).hexdigest()[:12]}.jpg"


def make_card(meeting: dict, renderer: CardRenderer, *, store=None) -> dict:
    """Render + upload one card; returns the meta.share_card value (not yet saved)."""
    from pipeline.video import posters

    store = store or posters.upload
    data, key = card_data(meeting)
    jpg = renderer.render(data)
    url = store(r2_key(meeting["id"], key), jpg, "image/jpeg")
    return {"url": url, "key": key, "version": CARD_VERSION, "source": key.split("|")[1],
            "width": 1200, "height": 630, "bytes": len(jpg)}
