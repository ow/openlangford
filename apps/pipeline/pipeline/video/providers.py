"""Video providers: where a municipality's meeting recordings come from.

Mirrors the web app's ``app/services/video/`` registry. A municipality picks its
provider with ``source_config.video_source.type`` (``isilive`` for eSCRIBE/ISI
Live, ``vimeo``, ``youtube``). When a meeting's ``video_url`` belongs to a
different provider than the configured one (or nothing is configured), the
provider is detected from the URL host.

Each provider knows:
- which URLs it owns (``matches_url``),
- how to turn a stored ``video_url`` into a direct, ffmpeg-readable media URL
  (``resolve_media_url``, used for transcription audio and poster frames),
- how to build the client that lists and downloads recordings (``make_client``).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlparse

DIRECT_MEDIA_EXTENSIONS = (".mp4", ".m4v", ".mov", ".m3u8")

# Setting values accepted in source_config.video_source.type -> provider id.
PROVIDER_ALIASES = {
    "vimeo": "vimeo",
    "isilive": "escribe-isi",
    "escribe-isi": "escribe-isi",
    "escribe": "escribe-isi",
    "youtube": "youtube",
}


class YouTubeClient:
    """Stub for YouTube video source. To be implemented for municipalities
    that publish meeting recordings on YouTube (e.g. RDOS).

    Expected source_config.video_source:
        {"type": "youtube", "channel": "RDOS"}
    """

    def __init__(self, channel: str = ""):
        self.channel = channel

    def get_video_map(self, limit=None):
        print(f"  [YouTube] Video sync not yet implemented (channel: {self.channel})")
        return {}

    def download_video(self, video_data, output_folder, **kwargs):
        print("  [YouTube] Video download not yet implemented")
        return None


@dataclass(frozen=True)
class VideoProvider:
    id: str
    matches_url: Callable[[str], bool]
    resolve_media_url: Callable[[str], str | None]
    make_client: Callable[[dict], Any]


def _https_host(url: str) -> str | None:
    try:
        p = urlparse(url)
    except ValueError:
        return None
    return (p.hostname or "").lower() if p.scheme == "https" else None


def _host_is(url: str, domain: str) -> bool:
    host = _https_host(url)
    return bool(host) and (host == domain or host.endswith("." + domain))


# ── eSCRIBE / ISI Live ───────────────────────────────────────────────────


def is_isi_player(url: str) -> bool:
    p = urlparse(url)
    return "escribemeetings.com" in p.netloc and "isistandaloneplayer" in p.path.lower()


def _resolve_isi(video_url: str) -> str | None:
    """ISI stand-alone player page -> video.isilive.ca mp4 (client id read from the page)."""
    if not is_isi_player(video_url):
        return None
    from pipeline.video.isilive import ISILiveClient

    p = urlparse(video_url)
    client = ISILiveClient(base_url=f"{p.scheme}://{p.netloc}", client_id="")
    url = client._resolve_media_url({"url": video_url})
    # Without a client id the resolver yields ".../ /file"; treat as unresolved.
    return url if url and "isilive.ca//" not in url else None


def _isi_client(source_config: dict):
    from pipeline.video.isilive import ISILiveClient

    video_config = source_config.get("video_source") or {}
    base_url = video_config.get("base_url") or source_config.get("base_url")
    client_id = video_config.get("client_id")
    if not base_url or not client_id:
        raise ValueError("ISI Live video source requires base_url and client_id")
    return ISILiveClient(
        base_url=base_url,
        client_id=client_id,
        meeting_types=source_config.get("meeting_types"),
        verify_ssl=source_config.get("verify_ssl", True),
    )


# ── Vimeo (and anything else yt-dlp can read) ───────────────────────────


def _resolve_ytdlp(video_url: str) -> str | None:
    try:
        import yt_dlp

        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "format": "best[vcodec!=none]/best"}) as ydl:
            info = ydl.extract_info(video_url, download=False)
        return info.get("url") or None
    except Exception:
        return None


def _vimeo_client(source_config: dict):
    from pipeline.video.vimeo import VimeoClient

    video_config = source_config.get("video_source") or {}
    return VimeoClient(vimeo_user=video_config.get("user", "viewroyal"))


PROVIDERS: dict[str, VideoProvider] = {
    "escribe-isi": VideoProvider(
        id="escribe-isi",
        matches_url=lambda url: _host_is(url, "escribemeetings.com"),
        resolve_media_url=_resolve_isi,
        make_client=_isi_client,
    ),
    "vimeo": VideoProvider(
        id="vimeo",
        matches_url=lambda url: _host_is(url, "vimeo.com"),
        resolve_media_url=lambda url: _resolve_ytdlp(url),
        make_client=_vimeo_client,
    ),
    "youtube": VideoProvider(
        id="youtube",
        matches_url=lambda url: _host_is(url, "youtube.com") or _host_is(url, "youtu.be"),
        resolve_media_url=lambda url: _resolve_ytdlp(url),
        make_client=lambda cfg: YouTubeClient(channel=(cfg.get("video_source") or {}).get("channel", "")),
    ),
}


# ── selection ────────────────────────────────────────────────────────────


def configured_provider_id(source_config: dict | None, default: str | None = None) -> str | None:
    """Provider id from source_config.video_source.type, or ``default`` when unset.

    Raises ValueError for a type no provider is registered for.
    """
    video_config = (source_config or {}).get("video_source") or {}
    raw = video_config.get("type")
    if raw is None:
        return default
    provider_id = PROVIDER_ALIASES.get(str(raw).strip().lower())
    if provider_id is None:
        raise ValueError(f"No video client registered for source type: {raw}")
    return provider_id


def provider_for_url(url: str | None) -> VideoProvider | None:
    if not url:
        return None
    return next((p for p in PROVIDERS.values() if p.matches_url(url)), None)


def select_provider(url: str | None, source_config: dict | None = None) -> VideoProvider | None:
    """The configured provider when it owns the URL, otherwise the one the URL host belongs to."""
    try:
        configured = configured_provider_id(source_config)
    except ValueError:
        configured = None
    preferred = PROVIDERS.get(configured) if configured else None
    if url and preferred and preferred.matches_url(url):
        return preferred
    return provider_for_url(url)


def resolve_media_url(video_url: str, source_config: dict | None = None) -> str | None:
    """Direct, ffmpeg-readable media URL for a meeting's ``video_url``."""
    if not video_url:
        return None
    path = urlparse(video_url).path.lower()
    if path.endswith(DIRECT_MEDIA_EXTENSIONS):
        return video_url
    if is_isi_player(video_url):  # matched loosely, as before
        return _resolve_isi(video_url)
    provider = select_provider(video_url, source_config)
    if provider is not None:
        return provider.resolve_media_url(video_url)
    return _resolve_ytdlp(video_url)  # unknown hosts: let yt-dlp try


def get_video_client(municipality=None):
    """Create a video client from municipality.source_config.video_source (Vimeo when unset)."""
    if municipality is None:
        from pipeline.video.vimeo import VimeoClient

        return VimeoClient()
    source_config = municipality.source_config or {}
    provider_id = configured_provider_id(source_config, default="vimeo")
    return PROVIDERS[provider_id].make_client(source_config)


def uses_provider(source_config: dict | None, provider_id: str, default: str = "vimeo") -> bool:
    """True when the municipality's configured provider is ``provider_id`` (unset counts as ``default``)."""
    try:
        return configured_provider_id(source_config, default=default) == provider_id
    except ValueError:
        return False
