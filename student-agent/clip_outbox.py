"""
ExamProctor.ai — Student Agent: durable outbox for warning video clips.

The exam client (which owns the single camera/screen capture pipeline) finalizes a clip and POSTs it
to the loopback bridge (/clips). The clip is written to disk immediately, then uploaded by the agent
with the device secret using the server's idempotent clip_id. Files are removed only after the server
confirms storage (or permanently rejects the clip), so uploads survive disconnects and restarts.
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger("agent.clip_outbox")

OUTBOX_DIR = Path(os.environ.get("EXAMPROCTOR_AGENT_DATA", Path(__file__).parent)) / "clip_outbox"
MAX_CLIP_BODY_BYTES = int(os.environ.get("CLIP_MAX_BODY_BYTES", str(16 * 1024 * 1024)))
MAX_OUTBOX_BYTES = int(os.environ.get("CLIP_OUTBOX_QUOTA_BYTES", str(200 * 1024 * 1024)))
_ID_RE = re.compile(r"^[0-9a-fA-F-]{8,36}$")
_REQUIRED = ("clip_id", "session_id", "source", "started_at", "ended_at", "data_b64")


def validate(body: dict) -> Optional[str]:
    """Return an error string, or None when the clip request is acceptable."""
    if not isinstance(body, dict):
        return "invalid body"
    for k in _REQUIRED:
        if not body.get(k):
            return f"missing {k}"
    if not _ID_RE.match(str(body["clip_id"])):
        return "invalid clip_id"
    if body["source"] not in ("screen", "webcam"):
        return "source must be screen or webcam"
    if body.get("mime_type", "video/webm") not in ("video/webm", "video/mp4"):
        return "unsupported mime_type"
    return None


def _outbox_size() -> int:
    return sum(p.stat().st_size for p in OUTBOX_DIR.glob("*.json")) if OUTBOX_DIR.exists() else 0


def enqueue(body: dict) -> str:
    """Persist a clip. Returns 'queued' | 'duplicate'. Raises ValueError on quota/validation errors."""
    err = validate(body)
    if err:
        raise ValueError(err)
    OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTBOX_DIR / f"{body['clip_id']}.json"
    if path.exists():
        return "duplicate"
    raw = json.dumps(body)
    if _outbox_size() + len(raw) > MAX_OUTBOX_BYTES:
        raise ValueError("clip outbox quota exceeded")
    tmp = path.with_suffix(".tmp")
    tmp.write_text(raw, encoding="utf-8")
    tmp.replace(path)  # atomic: a crash never leaves a half-written clip
    return "queued"


def pending() -> List[Path]:
    return sorted(OUTBOX_DIR.glob("*.json")) if OUTBOX_DIR.exists() else []


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def remove(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass
