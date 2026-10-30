"""
ExamProctor.ai — Classroom Monitoring: Agent Event Ingestion API.

Endpoints (called by the Python Student Agent, not by the professor browser):
  POST  /classroom/agent/events/desktop   — desktop activity events (batch)
  POST  /classroom/agent/events/browser   — browser activity events (batch)
  POST  /classroom/agent/screen-frame     — receive screen thumbnail

All agent endpoints require X-Device-Secret authentication.
"""

import base64
import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.errors import NotFoundError, ForbiddenError, ConflictError, BadRequestError
from app.classroom.db import get_classroom_db
from app.classroom.models import (
    ClassroomDevice,
    DesktopActivityEvent,
    BrowserActivityEvent,
    ClassroomSyncLog,
    ClassroomSession,
)
from app.classroom.services.alert_service import create_alert

logger = logging.getLogger("classroom.agent")
router = APIRouter(prefix="/classroom/agent", tags=["Classroom — Agent Events"])

# Thumbnail storage directory (configurable)
THUMBNAIL_DIR = Path(
    os.environ.get("CLASSROOM_THUMBNAIL_DIR", "./storage/classroom_thumbnails")
).resolve()
THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)


# ── Auth helper ───────────────────────────────────────────────────────────────

def _get_authed_device(request: Request, device_id: str, db: Session) -> ClassroomDevice:
    import bcrypt
    device = db.get(ClassroomDevice, device_id)
    if not device:
        raise NotFoundError("Device")
    if device.enrollment_status != "approved":
        raise ForbiddenError("Device is not approved.")
    secret = request.headers.get("X-Device-Secret", "")
    if not secret:
        raise ForbiddenError("Missing X-Device-Secret header.")
    try:
        ok = bcrypt.checkpw(secret.encode(), device.device_secret_hash.encode())
    except Exception:
        ok = False
    if not ok:
        raise ForbiddenError("Invalid device secret.")
    return device


# ── Idempotency helper ────────────────────────────────────────────────────────

def _is_duplicate(db: Session, idempotency_key: str) -> bool:
    existing = db.execute(
        select(ClassroomSyncLog).where(
            ClassroomSyncLog.idempotency_key == idempotency_key
        )
    ).scalar_one_or_none()
    return existing is not None


def _record_sync(db: Session, device_id: str, event_type: str, key: str, payload: dict) -> None:
    payload_hash = hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()
    log = ClassroomSyncLog(
        device_id=device_id,
        event_type=event_type,
        idempotency_key=key,
        payload_hash=payload_hash,
        status="accepted",
    )
    db.add(log)


# ── Desktop Activity Event Batch ──────────────────────────────────────────────

@router.post("/events/desktop", summary="Ingest desktop activity events (batch)")
def ingest_desktop_events(
    request: Request,
    db: Session = Depends(get_classroom_db),
):
    """
    Accepts a JSON body:
    {
      "device_id": "...",
      "session_id": "...",
      "events": [
        {
          "event_type": "heartbeat|window_change|process_alert|prohibited_app",
          "active_process_name": "chrome.exe",
          "active_window_title": "Google - Chrome",
          "additional_metadata": {...},
          "client_timestamp": "2026-10-30T10:00:00Z",
          "idempotency_key": "uuid"
        }, ...
      ]
    }
    """
    import asyncio

    # Parse body synchronously (FastAPI sync route reads body via ASGI)
    body_bytes = request.state._body if hasattr(request.state, "_body") else b"{}"
    # We need to read the body — use a workaround for sync route
    return _process_desktop_batch(request, db)


def _process_desktop_batch(request: Request, db: Session) -> dict:
    # Body is pre-read by middleware; fall back to empty body gracefully
    raw = getattr(request.state, "_body", None)
    if raw is None:
        raise BadRequestError("Request body is required.")

    try:
        body = json.loads(raw)
    except Exception:
        raise BadRequestError("Invalid JSON body.")

    device_id = body.get("device_id", "")
    session_id = body.get("session_id")
    events = body.get("events", [])

    device = _get_authed_device(request, device_id, db)

    accepted = 0
    duplicates = 0
    policy_violations = []

    # Determine if a session is active for this device
    active_session_id = session_id

    for ev in events:
        key = ev.get("idempotency_key", "")
        if not key:
            continue
        if _is_duplicate(db, key):
            duplicates += 1
            continue

        event_type = ev.get("event_type", "heartbeat")
        process_name = ev.get("active_process_name", "")
        window_title = ev.get("active_window_title", "")
        meta = ev.get("additional_metadata", {})

        # Parse client timestamp
        try:
            client_ts = datetime.fromisoformat(ev["client_timestamp"].replace("Z", "+00:00"))
        except Exception:
            client_ts = datetime.now(timezone.utc)

        desktop_event = DesktopActivityEvent(
            device_id=device_id,
            session_id=active_session_id,
            event_type=event_type,
            active_process_name=process_name,
            active_window_title=window_title,
            additional_metadata=json.dumps(meta),
            client_timestamp=client_ts,
            idempotency_key=key,
        )
        db.add(desktop_event)

        _record_sync(db, device_id, event_type, key, ev)

        # Raise alert for policy violations
        if event_type in ("prohibited_app", "process_alert") and active_session_id:
            create_alert(
                db=db,
                session_id=active_session_id,
                device_id=device_id,
                alert_type="prohibited_app",
                description=f"Prohibited application detected: {process_name} — {window_title}",
                severity="high",
                metadata={"process_name": process_name, "window_title": window_title},
                cooldown_sec=30,
            )
            policy_violations.append({"process": process_name, "key": key})

        accepted += 1

    # Update device heartbeat
    device.last_heartbeat_at = datetime.now(timezone.utc)
    if device.current_status == "offline":
        device.current_status = "online"

    db.flush()

    return {
        "data": {
            "accepted":   accepted,
            "duplicates": duplicates,
            "violations": len(policy_violations),
        }
    }


# ── Browser Activity Event Batch ──────────────────────────────────────────────

@router.post("/events/browser", summary="Ingest browser activity events (batch)")
async def ingest_browser_events(
    request: Request,
    db: Session = Depends(get_classroom_db),
):
    """
    Accepts a JSON body analogous to the desktop endpoint.
    """
    raw = await request.body()
    try:
        body = json.loads(raw)
    except Exception:
        raise BadRequestError("Invalid JSON body.")

    device_id = body.get("device_id", "")
    session_id = body.get("session_id")
    events = body.get("events", [])

    device = _get_authed_device(request, device_id, db)

    accepted = 0
    duplicates = 0

    for ev in events:
        key = ev.get("idempotency_key", "")
        if not key:
            continue
        if _is_duplicate(db, key):
            duplicates += 1
            continue

        event_type = ev.get("event_type", "navigation")
        domain = ev.get("domain", "")
        classification = ev.get("policy_classification", "neutral")

        try:
            client_ts = datetime.fromisoformat(ev.get("client_timestamp", "").replace("Z", "+00:00"))
        except Exception:
            client_ts = datetime.now(timezone.utc)

        browser_event = BrowserActivityEvent(
            device_id=device_id,
            session_id=session_id,
            browser_name=ev.get("browser_name", "unknown"),
            domain=domain,
            event_type=event_type,
            policy_classification=classification,
            client_timestamp=client_ts,
            idempotency_key=key,
        )
        db.add(browser_event)
        _record_sync(db, device_id, event_type, key, ev)

        # Alert on blocked domain
        if classification == "blocked" and session_id:
            create_alert(
                db=db,
                session_id=session_id,
                device_id=device_id,
                alert_type="browser_prohibited",
                description=f"Prohibited domain visited: {domain}",
                severity="high",
                metadata={"domain": domain, "event_type": event_type},
                cooldown_sec=60,
            )
        elif classification == "ai_tool" and session_id:
            create_alert(
                db=db,
                session_id=session_id,
                device_id=device_id,
                alert_type="ai_domain",
                description=f"AI tool accessed: {domain}",
                severity="critical",
                metadata={"domain": domain},
                cooldown_sec=120,
            )

        accepted += 1

    db.flush()
    return {"data": {"accepted": accepted, "duplicates": duplicates}}


# ── Screen Thumbnail ──────────────────────────────────────────────────────────

@router.post("/screen-frame", summary="Receive screen thumbnail from agent")
async def receive_screen_frame(
    request: Request,
    db: Session = Depends(get_classroom_db),
):
    """
    Body: multipart/form-data or JSON with:
      device_id, session_id, frame_id, timestamp, image_b64 (JPEG/WebP base64)
    Saves thumbnail to disk and returns the frame_id + stored path.
    """
    raw = await request.body()
    try:
        body = json.loads(raw)
    except Exception:
        raise BadRequestError("Invalid JSON body.")

    device_id  = body.get("device_id", "")
    session_id = body.get("session_id")
    frame_id   = body.get("frame_id", "")
    image_b64  = body.get("image_b64", "")

    _get_authed_device(request, device_id, db)

    if not image_b64 or not frame_id:
        raise BadRequestError("image_b64 and frame_id are required.")

    try:
        image_bytes = base64.b64decode(image_b64)
    except Exception:
        raise BadRequestError("Invalid base64 image data.")

    # Max 1 MB per thumbnail
    if len(image_bytes) > 1_048_576:
        raise BadRequestError("Thumbnail exceeds maximum size of 1 MB.")

    # Store: thumbnails/{device_id}/{frame_id}.jpg
    dev_dir = THUMBNAIL_DIR / device_id
    dev_dir.mkdir(parents=True, exist_ok=True)
    file_path = dev_dir / f"{frame_id}.jpg"
    file_path.write_bytes(image_bytes)

    return {
        "data": {
            "frame_id":   frame_id,
            "device_id":  device_id,
            "session_id": session_id,
            "stored":     True,
            "path":       str(file_path),
            "size_bytes": len(image_bytes),
        }
    }
