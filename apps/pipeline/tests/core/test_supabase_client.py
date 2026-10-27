from unittest.mock import patch

import httpx

from pipeline import supabase_client


def test_create_client_passes_finite_timeouts():
    with patch.object(supabase_client, "_create_client") as create:
        supabase_client.create_client("https://x.supabase.co", "key")
    options = create.call_args.kwargs["options"]
    timeout = options.postgrest_client_timeout
    assert isinstance(timeout, httpx.Timeout)
    assert (timeout.connect, timeout.read) == (10.0, 120.0)
    assert timeout.write and timeout.pool
    assert options.storage_client_timeout == 300


def test_timeouts_overridable_by_env(monkeypatch):
    monkeypatch.setenv("SUPABASE_READ_TIMEOUT", "45")
    monkeypatch.setenv("SUPABASE_CONNECT_TIMEOUT", "bogus")
    timeout = supabase_client.postgrest_timeout()
    assert (timeout.connect, timeout.read) == (10.0, 45.0)


def test_real_client_has_the_timeouts():
    client = supabase_client.create_client("https://x.supabase.co", "a" * 40 + "." + "b" * 40 + "." + "c" * 10)
    assert client.postgrest.session.timeout.read == 120.0
    assert client.postgrest.session.timeout.connect == 10.0


def test_r2_client_has_timeouts(monkeypatch):
    from pipeline.ingestion import image_extractor

    monkeypatch.setattr(image_extractor, "_r2_client", None)
    for k, v in (("R2_ACCESS_KEY_ID", "a"), ("R2_SECRET_ACCESS_KEY", "b"), ("R2_ENDPOINT_URL", "https://r2.example.com")):
        monkeypatch.setenv(k, v)
    client = image_extractor.get_r2_client()
    cfg = client.meta.config
    assert (cfg.connect_timeout, cfg.read_timeout) == (10, 120)
    monkeypatch.setattr(image_extractor, "_r2_client", None)
