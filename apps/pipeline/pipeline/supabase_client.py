"""The one place the pipeline builds Supabase clients, with finite network timeouts.

supabase-py's defaults (120 s PostgREST, 20 s storage) are finite but are *inter-byte* httpx
timeouts with a single value for every phase. A backfill hung for hours in an SSL read, so we
set explicit connect/read/write/pool phases and a longer storage timeout. A timeout raises
(``httpx.TimeoutException``); nothing here retries, so callers' error handling records it.

Override with ``SUPABASE_CONNECT_TIMEOUT``, ``SUPABASE_READ_TIMEOUT`` and
``SUPABASE_STORAGE_TIMEOUT`` (seconds).
"""
from __future__ import annotations

import os

import httpx
from supabase import Client, ClientOptions
from supabase import create_client as _create_client

DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_READ_TIMEOUT = 120.0
DEFAULT_WRITE_TIMEOUT = 60.0
DEFAULT_POOL_TIMEOUT = 30.0
DEFAULT_STORAGE_TIMEOUT = 300  # uploads of large PDFs


def _float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, ""))
        return value if value > 0 else default
    except ValueError:
        return default


def postgrest_timeout() -> httpx.Timeout:
    return httpx.Timeout(
        connect=_float_env("SUPABASE_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT),
        read=_float_env("SUPABASE_READ_TIMEOUT", DEFAULT_READ_TIMEOUT),
        write=DEFAULT_WRITE_TIMEOUT,
        pool=DEFAULT_POOL_TIMEOUT,
    )


def client_options() -> ClientOptions:
    return ClientOptions(
        postgrest_client_timeout=postgrest_timeout(),
        storage_client_timeout=int(_float_env("SUPABASE_STORAGE_TIMEOUT", DEFAULT_STORAGE_TIMEOUT)),
    )


def create_client(url: str, key: str) -> Client:
    """Drop-in for ``supabase.create_client`` with bounded timeouts."""
    return _create_client(url, key, options=client_options())
