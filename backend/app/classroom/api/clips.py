"""
ExamProctor.ai — Classroom Monitoring: warning video clip evidence + WebRTC ICE config.

Endpoints (under /api/v1):
  POST /classroom/agent/clips                  — device-authenticated, idempotent upload (clip_id)
  GET  /classroom/sessions/{session_id}/clips  — professor: list clip metadata
  GET  /classroom/clips/{clip_id}/download     — professor: stream clip (authorized)
  GET  /classroom/webrtc/config                — ICE servers from environment (STUN/TURN)

Existing screenshot evidence endpoints are NOT touched by this module.
"""
import base64
import hashlib
import json
import logging
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import BadRequestError, ForbiddenError, NotFoundError
from app.core.permissions import ProfessorUser
from app.classroom.api.agent_events import _get_authed_device
from app.classroom.db import get_classroom_db
from app.classroom.models import VideoEvidenceClip
from app.classroom.services import clip_storage

logger = logging.getLogger("classroom.clips")
router = APIRouter(prefix="/classroom", tags=["Classroom — Evidence Clips"])


def _clip_out(c: VideoEvidenceClip) -> dict:
    return {
        "clip_id": c.clip_id,
        "session_id": c.session_id,
        "device_id": c.device_id,
        "student_user_id": c.student_user_id,
        "exam_id": c.exam_id,
        "attempt_id": c.attempt_id,
        "source": c.source,
        "event_ids": json.loads(c.event_ids_json or "[]"),
        "started_at": c.started_at,
        "ended_at": c.ended_at,
        "pre_roll_ms": c.pre_roll_ms,
        "post_roll_ms": c.post_roll_ms,
        "mime_type": c.mime_type,
        "size_bytes": c.size_bytes,
        "status": c.status,
        "failure_reason": c.failure_reason,
    }


def _parse_dt(v) -> datetime:
    try:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        raise BadRequestError("Invalid timestamp.")
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@router.post("/agent/clips", summary="Upload a finalized warning clip (idempotent)")
async def upload_clip(request: Request, db: Session = Depends(get_classroom_db)):
    """JSON body: device_id, clip_id, session_id, source, event_ids[], started_at, ended_at,
    mime_type, data_b64, optional sha256/student_user_id/exam_id/attempt_id."""
    try:
        body = json.loads(await request.body())
    except Exception:
        raise BadRequestError("Invalid JSON body.")

    device_id = body.get("device_id", "")
    device = _get_authed_device(request, device_id, db)  # secret + approval check

    clip_id = body.get("clip_id")
    source = body.get("source")
    mime = body.get("mime_type", "video/webm")
    if not clip_id or len(clip_id) > 36 or not clip_id.replace("-", "").isalnum():
        raise BadRequestError("A valid clip_id is required.")
    if source not in ("screen", "webcam"):
        raise BadRequestError("source must be 'screen' or 'webcam'.")
    if mime not in clip_storage.ALLOWED_MIME:
        raise BadRequestError("Unsupported clip mime type.")

    existing = db.get(VideoEvidenceClip, clip_id)
    if existing:
        if existing.device_id != device.device_id:
            raise ForbiddenError("Clip belongs to another device.")
        return {"data": {**_clip_out(existing), "duplicate": True}}

    try:
        data = base64.b64decode(body.get("data_b64", ""), validate=True)
    except Exception:
        raise BadRequestError("Invalid base64 clip data.")
    if not data:
        raise BadRequestError("Empty clip.")
    if len(data) > clip_storage.max_clip_bytes():
        raise BadRequestError("Clip exceeds maximum permitted size.")
    digest = hashlib.sha256(data).hexdigest()
    if body.get("sha256") and body["sha256"].lower() != digest:
        raise BadRequestError("Clip checksum mismatch.")

    session_id = body.get("session_id")
    if not session_id:
        raise BadRequestError("session_id is required.")

    clip = VideoEvidenceClip(
        clip_id=clip_id,
        session_id=session_id,
        device_id=device.device_id,
        student_user_id=body.get("student_user_id"),
        exam_id=body.get("exam_id"),
        attempt_id=body.get("attempt_id"),
        source=source,
        event_ids_json=json.dumps([str(e) for e in (body.get("event_ids") or [])][:50]),
        started_at=_parse_dt(body.get("started_at")),
        ended_at=_parse_dt(body.get("ended_at")),
        pre_roll_ms=int(body.get("pre_roll_ms", 2000)),
        post_roll_ms=int(body.get("post_roll_ms", 2000)),
        mime_type=mime,
        size_bytes=len(data),
        sha256=digest,
        retention_until=datetime.now(timezone.utc) + timedelta(days=clip_storage.retention_days()),
    )
    try:
        ext = "mp4" if mime == "video/mp4" else "webm"
        backend, key = clip_storage.put(f"{session_id}/{device.device_id}/{clip_id}.{ext}", data, mime)
        clip.storage_backend, clip.storage_key, clip.status = backend, key, "uploaded"
    except Exception as e:  # report the real failure; the agent retries with the same clip_id
        logger.error("Clip storage failed clip=%s: %s", clip_id, e)
        clip.status, clip.failure_reason = "failed", str(e)[:300]
        db.add(clip)
        db.commit()
        raise BadRequestError("Clip storage failed; retry later.")
    db.add(clip)
    db.commit()
    return {"data": {**_clip_out(clip), "duplicate": False}}


@router.get("/sessions/{session_id}/clips", summary="List warning clips for a session")
async def list_clips(session_id: str, user: ProfessorUser, db: Session = Depends(get_classroom_db)):
    rows = db.execute(
        select(VideoEvidenceClip)
        .where(VideoEvidenceClip.session_id == session_id)
        .order_by(VideoEvidenceClip.started_at.desc())
    ).scalars().all()
    return {"data": [_clip_out(c) for c in rows]}


@router.get("/clips/{clip_id}/download", summary="Download a warning clip")
async def download_clip(clip_id: str, user: ProfessorUser, db: Session = Depends(get_classroom_db)):
    clip = db.get(VideoEvidenceClip, clip_id)
    if not clip or clip.status != "uploaded" or not clip.storage_key:
        raise NotFoundError("Clip")
    try:
        data = clip_storage.get(clip.storage_backend, clip.storage_key)
    except Exception:
        raise NotFoundError("Clip file")
    return Response(content=data, media_type=clip.mime_type,
                    headers={"Cache-Control": "private, no-store"})


@router.get("/webrtc/config", summary="ICE server configuration (STUN/TURN)")
async def webrtc_config():
    """Provider-independent: STUN_SERVER_URL, TURN_SERVER_URL (comma separated, may include
    turns: on 443), TURN_USERNAME, TURN_CREDENTIAL."""
    stun = os.environ.get("STUN_SERVER_URL", "stun:stun.l.google.com:19302")
    ice = [{"urls": [u.strip() for u in stun.split(",") if u.strip()]}]
    turn = os.environ.get("TURN_SERVER_URL")
    if turn:
        entry = {"urls": [u.strip() for u in turn.split(",") if u.strip()]}
        if os.environ.get("TURN_USERNAME"):
            entry["username"] = os.environ["TURN_USERNAME"]
        if os.environ.get("TURN_CREDENTIAL"):
            entry["credential"] = os.environ["TURN_CREDENTIAL"]
        ice.append(entry)
    return {"ok": True, "data": {"iceServers": ice, "iceTransportPolicy": "all",
                                 "turn_configured": bool(turn)}}
