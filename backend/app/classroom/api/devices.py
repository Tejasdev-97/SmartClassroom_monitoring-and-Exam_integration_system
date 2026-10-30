"""
ExamProctor.ai — Classroom Monitoring: Device Enrollment & Management API.

Endpoints:
  POST   /classroom/devices/register        — agent self-registers (returns device_id)
  POST   /classroom/devices/{id}/approve    — professor approves + labels workstation
  POST   /classroom/devices/{id}/revoke     — professor revokes a device
  GET    /classroom/devices                 — list all devices (professor)
  GET    /classroom/devices/{id}            — get single device (professor)
  PUT    /classroom/devices/{id}/heartbeat  — agent posts liveness ping (device auth)
"""

import json
import logging
import secrets
from datetime import datetime, timezone
from typing import List, Optional

import bcrypt
from fastapi import APIRouter, Depends, Path, Query, Request
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.permissions import ProfessorUser
from app.core.errors import NotFoundError, ConflictError, ForbiddenError, BadRequestError
from app.classroom.db import get_classroom_db
from app.classroom.models import ClassroomDevice
from app.classroom.schemas import (
    DeviceRegisterRequest,
    DeviceApproveRequest,
    DeviceOut,
)

logger = logging.getLogger("classroom.devices")
router = APIRouter(prefix="/classroom/devices", tags=["Classroom — Devices"])

# ── Secret derivation helpers ──────────────────────────────────────────────────

def _hash_secret(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(rounds=10)).decode()


def _verify_secret(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False


def _require_device_auth(request: Request, device: ClassroomDevice) -> None:
    """Validate the device secret from the X-Device-Secret header."""
    secret = request.headers.get("X-Device-Secret", "")
    if not secret or not _verify_secret(secret, device.device_secret_hash):
        raise ForbiddenError("Invalid or missing device secret.")


# ── Serialisation helper ───────────────────────────────────────────────────────

def _device_out(d: ClassroomDevice) -> dict:
    return {
        "device_id":          d.device_id,
        "room_name":          d.room_name,
        "workstation_label":  d.workstation_label,
        "hostname":           d.hostname,
        "os_type":            d.os_type,
        "os_version":         d.os_version,
        "agent_version":      d.agent_version,
        "ip_address":         d.ip_address,
        "enrollment_status":  d.enrollment_status,
        "current_status":     d.current_status,
        "last_heartbeat_at":  d.last_heartbeat_at.isoformat() if d.last_heartbeat_at else None,
        "created_at":         d.created_at.isoformat(),
    }


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/register", summary="Agent self-registration")
def register_device(
    body: DeviceRegisterRequest,
    request: Request,
    db: Session = Depends(get_classroom_db),
):
    """
    Called by the Python Student Agent on first launch.
    Generates a one-time device_secret (returned ONCE, never stored in plaintext).
    The device is created in 'pending' state — professor must approve it.
    """
    # Allow re-registration only if currently 'revoked' or a brand-new hostname
    existing = db.execute(
        select(ClassroomDevice).where(ClassroomDevice.hostname == body.hostname)
    ).scalar_one_or_none()

    if existing and existing.enrollment_status == "approved":
        raise ConflictError(
            f"Device '{body.hostname}' is already enrolled and approved. "
            "Revoke the existing entry before re-registering."
        )

    # Generate a high-entropy secret — returned once to the agent
    plain_secret = secrets.token_urlsafe(32)
    hashed_secret = _hash_secret(plain_secret)

    ip = request.client.host if request.client else None

    if existing and existing.enrollment_status in ("pending", "revoked"):
        # Update instead of insert — overwrite stale registration
        existing.os_type = body.os_type
        existing.os_version = body.os_version
        existing.agent_version = body.agent_version
        existing.ip_address = ip or body.ip_address
        existing.device_secret_hash = hashed_secret
        existing.enrollment_status = "pending"
        existing.current_status = "offline"
        db.flush()
        device_id = existing.device_id
    else:
        device = ClassroomDevice(
            hostname=body.hostname,
            os_type=body.os_type,
            os_version=body.os_version,
            agent_version=body.agent_version,
            ip_address=ip or body.ip_address,
            device_secret_hash=hashed_secret,
        )
        db.add(device)
        db.flush()
        device_id = device.device_id

    logger.info("Device registered: %s (hostname=%s)", device_id, body.hostname)

    return {
        "data": {
            "device_id":     device_id,
            "device_secret": plain_secret,   # Return ONCE to the agent
            "status":        "pending",
            "message":       "Device registered. Ask the instructor to approve it.",
        }
    }


@router.post("/{device_id}/approve", summary="Professor approves a device")
def approve_device(
    device_id: str = Path(...),
    body: DeviceApproveRequest = ...,
    _prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    device = db.get(ClassroomDevice, device_id)
    if not device:
        raise NotFoundError("Device")
    if device.enrollment_status == "revoked":
        raise BadRequestError("Device is revoked. Re-register it first.")

    device.enrollment_status = "approved"
    device.room_name = body.room_name
    device.workstation_label = body.workstation_label
    db.flush()

    logger.info("Device approved: %s -> room=%s", device_id, body.room_name)
    return {"data": _device_out(device)}


@router.post("/{device_id}/revoke", summary="Professor revokes a device")
async def revoke_device(
    device_id: str = Path(...),
    _prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    from app.classroom.hub import classroom_hub

    device = db.get(ClassroomDevice, device_id)
    if not device:
        raise NotFoundError("Device")
    device.enrollment_status = "revoked"
    device.current_status = "offline"
    db.flush()

    # Terminate active websocket streaming immediately
    await classroom_hub.disconnect_agent(device_id, "Device revoked by instructor")

    return {"data": {"device_id": device_id, "enrollment_status": "revoked"}}


@router.get("", summary="List all devices (professor)")
def list_devices(
    status: Optional[str] = Query(None, description="Filter by enrollment_status"),
    _prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    q = select(ClassroomDevice)
    if status:
        q = q.where(ClassroomDevice.enrollment_status == status)
    devices = db.execute(q.order_by(ClassroomDevice.created_at.desc())).scalars().all()
    return {"data": [_device_out(d) for d in devices]}


@router.get("/{device_id}", summary="Get a single device (professor)")
def get_device(
    device_id: str = Path(...),
    _prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    device = db.get(ClassroomDevice, device_id)
    if not device:
        raise NotFoundError("Device")
    return {"data": _device_out(device)}


@router.put("/{device_id}/heartbeat", summary="Agent liveness ping")
def device_heartbeat(
    device_id: str = Path(...),
    request: Request = ...,
    db: Session = Depends(get_classroom_db),
):
    """
    Lightweight ping from the Python agent (every 5 s).
    Authenticated by X-Device-Secret header.
    """
    device = db.get(ClassroomDevice, device_id)
    if not device:
        raise NotFoundError("Device")
    if device.enrollment_status != "approved":
        raise ForbiddenError("Device not yet approved by instructor.")
    _require_device_auth(request, device)

    device.last_heartbeat_at = datetime.now(timezone.utc)
    if device.current_status in ("offline", "error"):
        device.current_status = "online"
    db.flush()

    return {"data": {"status": "ok", "server_time": datetime.now(timezone.utc).isoformat()}}


@router.get("/{device_id}/screen-frame", summary="Get latest screen frame for workstation")
def get_device_screen_frame(
    device_id: str = Path(...),
    _prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    from fastapi.responses import FileResponse, Response
    from app.classroom.api.agent_events import THUMBNAIL_DIR
    from app.classroom.hub import classroom_hub
    import base64

    # 1. Check in-memory cache
    cached = classroom_hub.get_latest_screen_frame(device_id)
    if cached and cached.get("image_b64"):
        raw = base64.b64decode(cached["image_b64"])
        return Response(content=raw, media_type="image/jpeg")

    # 2. Check disk
    latest = THUMBNAIL_DIR / device_id / "latest.jpg"
    if latest.is_file():
        return FileResponse(str(latest), media_type="image/jpeg")

    raise NotFoundError("Screen frame")


@router.get("/{device_id}/webcam-frame", summary="Get latest webcam frame for workstation")
def get_device_webcam_frame(
    device_id: str = Path(...),
    _prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    from fastapi.responses import FileResponse, Response
    from app.classroom.api.agent_events import THUMBNAIL_DIR
    from app.classroom.hub import classroom_hub
    import base64

    # 1. Check in-memory cache
    cached = classroom_hub.get_latest_webcam_frame(device_id)
    if cached and cached.get("image_b64"):
        raw = base64.b64decode(cached["image_b64"])
        return Response(content=raw, media_type="image/jpeg")

    # 2. Check disk
    latest = THUMBNAIL_DIR / device_id / "webcam_latest.jpg"
    if latest.is_file():
        return FileResponse(str(latest), media_type="image/jpeg")

    raise NotFoundError("Webcam frame")

