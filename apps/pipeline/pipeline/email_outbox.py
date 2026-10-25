"""Durable, bounded meeting-enqueue intent. Contains no recipients or credentials.

Only explicit ingestion records an intent; retries never discover/backfill meetings.
The server rechecks cutoff, consent and embedding readiness before creating emails.
"""
from __future__ import annotations

import os
import math
from contextlib import contextmanager
import sqlite3
import time
from pathlib import Path

import requests

from pipeline import config

MAX_ATTEMPTS = 12
DELIVERY_WINDOW = 23 * 60 * 60
LEASE_SECONDS = 120


class EmailEnqueuePersistenceError(RuntimeError):
    def __init__(self, meeting_id: int, created_at: float):
        self.receipt = {'version': 1, 'meeting_id': meeting_id,
                        'created_at': created_at, 'expires_at': created_at + DELIVERY_WINDOW}
        super().__init__(f"Email enqueue intent for meeting {meeting_id} could not be persisted; "
                         f"recover only this meeting before Unix deadline {created_at + DELIVERY_WINDOW:.0f}; "
                         "ordinary cached ingestion alone will not restore it")


class EmailEnqueueOutbox:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(path, 0o600)
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS email_enqueue_intents (
                meeting_id INTEGER PRIMARY KEY CHECK(meeting_id > 0),
                state TEXT NOT NULL DEFAULT 'pending',
                created_at REAL NOT NULL, expires_at REAL NOT NULL,
                next_attempt_at REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                lease_until REAL, last_error TEXT
            )""")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def record(self, meeting_id: int, created_at: float | None = None):
        now = time.time() if created_at is None else created_at
        with self.connect() as db:
            db.execute("""INSERT INTO email_enqueue_intents
                (meeting_id,created_at,expires_at,next_attempt_at) VALUES(?,?,?,?) ON CONFLICT(meeting_id) DO NOTHING""",
                (meeting_id, now, now + DELIVERY_WINDOW, now))

    def claim(self):
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("""UPDATE email_enqueue_intents SET state='expired',last_error='Retry window expired'
                WHERE state IN ('pending','leased') AND
                (expires_at<=? OR (attempts>=? AND coalesce(lease_until,0)<=?))""",
                (now, MAX_ATTEMPTS, now))
            row = db.execute("""SELECT * FROM email_enqueue_intents
                WHERE (state='pending' OR (state='leased' AND lease_until<=?))
                AND next_attempt_at<=? AND expires_at>? AND attempts<?
                ORDER BY created_at,meeting_id LIMIT 1""",
                (now, now, now, MAX_ATTEMPTS)).fetchone()
            if row is None:
                return None
            db.execute("""UPDATE email_enqueue_intents SET state='leased',attempts=attempts+1,
                lease_until=? WHERE meeting_id=?""", (now + LEASE_SECONDS, row['meeting_id']))
            return dict(db.execute("SELECT * FROM email_enqueue_intents WHERE meeting_id=?",
                                   (row['meeting_id'],)).fetchone())

    def finish(self, row, state: str, error: str | None = None):
        now = time.time()
        if state == 'pending' and (row['attempts'] >= MAX_ATTEMPTS or now >= row['expires_at']):
            state = 'expired'
        delay = min(3600, 60 * 2 ** (row['attempts'] - 1))
        with self.connect() as db:
            # An expired lease cannot overwrite a newer process's receipt.
            db.execute("""UPDATE email_enqueue_intents SET state=?,last_error=?,next_attempt_at=?,lease_until=NULL
                WHERE meeting_id=? AND state='leased' AND attempts=? AND lease_until=?""",
                (state, error, now + delay, row['meeting_id'], row['attempts'], row['lease_until']))

    def drain(self, limit: int = 5):
        processed = 0
        for _ in range(limit):
            row = self.claim()
            if row is None:
                break
            state, error = 'pending', None
            try:
                response = requests.post(
                    f"{config.SUPABASE_URL}/functions/v1/send-alerts",
                    headers={'X-Alert-Worker-Key': config.ALERT_WORKER_KEY, 'Content-Type': 'application/json'},
                    json={'action': 'enqueue', 'meeting_id': row['meeting_id']}, timeout=10, allow_redirects=False,
                )
                if 200 <= response.status_code < 300:
                    result = response.json()
                    queued = result.get('queued')
                    if result.get('skipped') is True:
                        state = 'skipped'  # off/test mode must never become a later catch-up
                    elif type(queued) is int and queued >= 0:
                        state = 'done'  # includes a deduplicated or cutoff-ineligible zero
                    else:
                        error = 'Invalid enqueue receipt'
                elif response.status_code in (408, 425, 429) or response.status_code >= 500:
                    error = f'HTTP {response.status_code}'
                else:
                    state, error = 'failed', f'HTTP {response.status_code}'
            except (requests.RequestException, ValueError, TypeError, AttributeError):
                error = 'Enqueue transport or receipt unavailable'
            self.finish(row, state, error)
            processed += 1
        return processed


def record_email_enqueue(meeting_id: int, created_at: float | None = None):
    if not config.SUPABASE_URL or not config.ALERT_WORKER_KEY:
        print('  [i] Email alert enqueue not configured; skipped')
        return False
    created_at = time.time() if created_at is None else created_at
    if not math.isfinite(created_at) or created_at > time.time():
        raise ValueError('Invalid original enqueue timestamp')
    try:
        EmailEnqueueOutbox(config.ALERT_OUTBOX_PATH).record(meeting_id, created_at)
    except (OSError, sqlite3.Error) as exc:
        raise EmailEnqueuePersistenceError(meeting_id, created_at) from exc
    return True


def retry_email_enqueues(limit: int = 5):
    if not config.SUPABASE_URL or not config.ALERT_WORKER_KEY:
        return 0
    # Idle polling must not create an outbox or discover historical work.
    if not Path(config.ALERT_OUTBOX_PATH).exists():
        return 0
    try:
        return EmailEnqueueOutbox(config.ALERT_OUTBOX_PATH).drain(limit)
    except (OSError, sqlite3.Error):
        print('  [!] Email outbox unavailable; retry intent retained; operator check required')
        return 0
