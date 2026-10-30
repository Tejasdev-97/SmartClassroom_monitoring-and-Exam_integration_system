"""
ExamProctor.ai — Student Agent: Offline Event Queue with Disk Persistence.

Stores events in a local SQLite file when the server is unreachable.
On reconnection, flushes the queue in insertion order (FIFO) with
idempotency keys so the server can deduplicate repeated submissions.

The queue survives agent restarts — events are only removed from the file
after the server confirms acceptance (HTTP 200) or definitively rejects
them (HTTP 400/422, i.e. malformed; not 503/network errors).
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("agent.offline_queue")

_DB_PATH = Path(__file__).parent / "offline_events.db"
_LOCK = threading.Lock()


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("""
        CREATE TABLE IF NOT EXISTS offline_events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id     TEXT    NOT NULL UNIQUE,
            event_type   TEXT    NOT NULL DEFAULT 'desktop',
            payload      TEXT    NOT NULL,
            created_at   TEXT    NOT NULL,
            attempts     INTEGER NOT NULL DEFAULT 0,
            last_error   TEXT
        )
    """)
    c.commit()
    return c


class OfflineQueue:
    """
    Thread-safe persistent queue for classroom monitoring events.

    Usage:
        q = OfflineQueue()
        q.push("desktop", {"device_id": ..., "events": [...]})
        batch = q.peek(50)
        q.acknowledge([ev["event_id"] for ev in batch])
    """

    def __init__(self, db_path: Path = _DB_PATH):
        self._db_path = db_path
        self._lock = threading.Lock()
        self._init()

    def _init(self) -> None:
        with sqlite3.connect(self._db_path, check_same_thread=False) as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("""
                CREATE TABLE IF NOT EXISTS offline_events (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id     TEXT    NOT NULL UNIQUE,
                    event_type   TEXT    NOT NULL DEFAULT 'desktop',
                    payload      TEXT    NOT NULL,
                    created_at   TEXT    NOT NULL,
                    attempts     INTEGER NOT NULL DEFAULT 0,
                    last_error   TEXT
                )
            """)
            c.commit()

    def push(self, event_type: str, payload: Dict[str, Any]) -> str:
        """Enqueue a payload. Returns the event_id."""
        event_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            with sqlite3.connect(self._db_path, check_same_thread=False) as c:
                c.execute(
                    "INSERT OR IGNORE INTO offline_events "
                    "(event_id, event_type, payload, created_at) VALUES (?,?,?,?)",
                    (event_id, event_type, json.dumps(payload), now),
                )
                c.commit()
        return event_id

    def peek(self, limit: int = 50, event_type: Optional[str] = None,
             exclude_type: Optional[str] = None) -> List[Dict[str, Any]]:
        """Return up to `limit` oldest unacknowledged events (optionally filtered by kind)."""
        where, params = "", []
        if event_type:
            where, params = "WHERE event_type = ?", [event_type]
        elif exclude_type:
            where, params = "WHERE event_type != ?", [exclude_type]
        with self._lock:
            with sqlite3.connect(self._db_path, check_same_thread=False) as c:
                rows = c.execute(
                    "SELECT event_id, event_type, payload, created_at, attempts "
                    f"FROM offline_events {where} ORDER BY id ASC LIMIT ?",
                    (*params, limit),
                ).fetchall()
        return [
            {
                "event_id":   r[0],
                "event_type": r[1],
                "payload":    json.loads(r[2]),
                "created_at": r[3],
                "attempts":   r[4],
            }
            for r in rows
        ]

    def acknowledge(self, event_ids: List[str]) -> int:
        """Remove successfully delivered events. Returns removed count."""
        if not event_ids:
            return 0
        placeholders = ",".join("?" * len(event_ids))
        with self._lock:
            with sqlite3.connect(self._db_path, check_same_thread=False) as c:
                c.execute(
                    f"DELETE FROM offline_events WHERE event_id IN ({placeholders})",
                    event_ids,
                )
                c.commit()
                return c.total_changes

    def record_failure(self, event_id: str, error: str) -> None:
        """Increment attempt counter and record last error message."""
        with self._lock:
            with sqlite3.connect(self._db_path, check_same_thread=False) as c:
                c.execute(
                    "UPDATE offline_events SET attempts = attempts + 1, last_error = ? "
                    "WHERE event_id = ?",
                    (error[:500], event_id),
                )
                c.commit()

    def drop_permanently_failed(self, max_attempts: int = 10) -> int:
        """Drop events that have exceeded the retry limit (malformed etc.)."""
        with self._lock:
            with sqlite3.connect(self._db_path, check_same_thread=False) as c:
                c.execute(
                    "DELETE FROM offline_events WHERE attempts >= ?",
                    (max_attempts,),
                )
                c.commit()
                return c.total_changes

    def size(self) -> int:
        with self._lock:
            with sqlite3.connect(self._db_path, check_same_thread=False) as c:
                return c.execute("SELECT COUNT(*) FROM offline_events").fetchone()[0]

    def clear(self) -> None:
        """Remove all queued events (use only on explicit session end)."""
        with self._lock:
            with sqlite3.connect(self._db_path, check_same_thread=False) as c:
                c.execute("DELETE FROM offline_events")
                c.commit()


# Module-level singleton
offline_queue = OfflineQueue()
