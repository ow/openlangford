"""Tests for pipeline.video.providers -- the video provider registry."""
from types import SimpleNamespace

import pytest

from pipeline.video import providers
from pipeline.video.isilive import ISILiveClient
from pipeline.video.vimeo import VimeoClient

ISI = "https://pub-langford.escribemeetings.com/Players/ISIStandAlonePlayer.aspx?Id=abc"
VIMEO = "https://vimeo.com/123456"
LANGFORD = {
    "type": "escribe",
    "base_url": "https://pub-langford.escribemeetings.com",
    "verify_ssl": False,
    "meeting_types": ["Council Meeting"],
    "video_source": {"type": "isilive", "client_id": "langford"},
}


def test_configured_provider_reads_pipeline_names():
    assert providers.configured_provider_id(LANGFORD) == "escribe-isi"
    assert providers.configured_provider_id({"video_source": {"type": "vimeo"}}) == "vimeo"
    assert providers.configured_provider_id({}) is None
    assert providers.configured_provider_id({}, default="vimeo") == "vimeo"
    with pytest.raises(ValueError):
        providers.configured_provider_id({"video_source": {"type": "rumble"}})


def test_select_provider_prefers_config_then_url_host():
    assert providers.select_provider(ISI, LANGFORD).id == "escribe-isi"
    assert providers.select_provider(VIMEO, LANGFORD).id == "vimeo"
    assert providers.select_provider(ISI).id == "escribe-isi"
    assert providers.select_provider("https://evil.tld/vimeo.com/1") is None


def test_get_video_client_builds_configured_client():
    client = providers.get_video_client(SimpleNamespace(source_config=LANGFORD))
    assert isinstance(client, ISILiveClient)
    assert client.client_id == "langford"
    assert client.session.verify is False


def test_get_video_client_defaults_to_vimeo(monkeypatch):
    monkeypatch.setattr(VimeoClient, "__init__", lambda self, **kw: setattr(self, "kw", kw))
    assert isinstance(providers.get_video_client(SimpleNamespace(source_config={})), VimeoClient)
    with pytest.raises(ValueError, match="No video client registered"):
        providers.get_video_client(SimpleNamespace(source_config={"video_source": {"type": "rumble"}}))


def test_uses_provider_matches_old_vimeo_check():
    assert providers.uses_provider({}, "vimeo") is True
    assert providers.uses_provider(LANGFORD, "vimeo") is False
    assert providers.uses_provider({"video_source": {"type": "rumble"}}, "vimeo") is False


def test_resolve_media_url_routes_by_provider(monkeypatch):
    calls = []
    monkeypatch.setattr(providers, "_resolve_ytdlp", lambda url: calls.append(url) or "https://cdn/x.mp4")
    monkeypatch.setattr(ISILiveClient, "_resolve_media_url", lambda self, d: "https://video.isilive.ca/langford/a.mp4")
    assert providers.resolve_media_url(ISI, LANGFORD) == "https://video.isilive.ca/langford/a.mp4"
    assert providers.resolve_media_url(VIMEO, LANGFORD) == "https://cdn/x.mp4"
    assert providers.resolve_media_url("https://video.isilive.ca/langford/a.mp4") == "https://video.isilive.ca/langford/a.mp4"
    assert calls == [VIMEO]
