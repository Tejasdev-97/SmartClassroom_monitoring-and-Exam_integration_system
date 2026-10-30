"""
ExamProctor.ai — Signed offline authorization leases for the Student Agent.

  GET /classroom/agent/lease?device_id=&session_id=   (X-Device-Secret)  -> signed lease
  GET /classroom/agent/lease-key                                         -> Ed25519 public key (base64)

The lease payload is signed with Ed25519 so the agent can verify it OFFLINE and cannot extend it
locally. Key material: LEASE_SIGNING_KEY (base64 32-byte seed, server-side only). If it is unset a
key is generated and stored under ./storage/lease_signing_key (development only; set the env var
in production so leases survive redeploys and multi-instance deployments).
"""
import base64
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ForbiddenError, NotFoundError
from app.classroom.api.agent_events import _get_authed_device
from app.classroom.db import get_classroom_db
from app.classroom.models import ClassroomSession, ClassroomSessionDevice

router = APIRouter(prefix="/classroom/agent", tags=["Classroom — Authorization Lease"])

CAPABILITIES = ["screen", "webcam_relay", "process_monitor", "browser_events"]


def _private_key() -> Ed25519PrivateKey:
    env = os.environ.get("LEASE_SIGNING_KEY", "").strip()
    if env:
        return Ed25519PrivateKey.from_private_bytes(base64.b64decode(env))
    path = Path(os.environ.get("LEASE_KEY_FILE", "./storage/lease_signing_key")).resolve()
    if path.exists():
        return Ed25519PrivateKey.from_private_bytes(base64.b64decode(path.read_text().strip()))
    key = Ed25519PrivateKey.generate()
    raw = key.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(base64.b64encode(raw).decode())
    return key


def public_key_b64() -> str:
    pub = _private_key().public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return base64.b64encode(pub).decode()


def canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def issue_lease(payload: dict) -> dict:
    sig = _private_key().sign(canonical(payload))
    return {"payload": payload, "signature": base64.b64encode(sig).decode()}


def max_lease_minutes() -> int:
    return int(os.environ.get("LEASE_MAX_MINUTES", "240"))


@router.get("/lease-key", summary="Public key for verifying leases")
async def lease_key():
    return {"data": {"alg": "Ed25519", "public_key": public_key_b64()}}


@router.get("/lease", summary="Issue a signed monitoring authorization lease")
async def get_lease(
    request: Request,
    device_id: str = Query(...),
    session_id: str = Query(...),
    db: Session = Depends(get_classroom_db),
):
    device = _get_authed_device(request, device_id, db)  # rejects revoked/unapproved devices
    session = db.get(ClassroomSession, session_id)
    if not session:
        raise NotFoundError("Session")
    if session.status == "ended":
        raise ForbiddenError("Session has ended; monitoring is no longer authorized.")
    assignment = db.execute(
        select(ClassroomSessionDevice).where(
            ClassroomSessionDevice.session_id == session_id,
            ClassroomSessionDevice.device_id == device.device_id,
            ClassroomSessionDevice.status == "active",
        )
    ).scalar_one_or_none()
    if not assignment:
        raise ForbiddenError("Device is not assigned to this session.")

    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=max_lease_minutes())
    if session.offline_auth_expires_at:
        s_exp = session.offline_auth_expires_at
        if s_exp.tzinfo is None:
            s_exp = s_exp.replace(tzinfo=timezone.utc)
        expires = min(expires, s_exp)
    if expires <= now:
        raise ForbiddenError("Authorization window has expired.")

    payload = {
        "device_id": device.device_id,
        "session_id": session_id,
        "student_user_id": assignment.student_user_id,
        "attempt_id": assignment.attempt_id,
        "capabilities": CAPABILITIES,
        "issued_at": now.isoformat(),
        "expires_at": expires.isoformat(),
    }
    return {"data": issue_lease(payload)}
