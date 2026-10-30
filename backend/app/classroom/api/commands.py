"""
ExamProctor.ai — Classroom Monitoring: Instructor Commands API.

Endpoints:
  POST   /classroom/sessions/{id}/commands             — issue a command
  GET    /classroom/sessions/{id}/commands             — list commands
  PUT    /classroom/sessions/{id}/commands/{cmd_id}/ack — agent acknowledges command
  GET    /classroom/devices/{device_id}/commands/pending — agent polls for its commands
"""

import json
import logging
from typing import Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Path, Query, Request
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.permissions import ProfessorUser
from app.core.errors import NotFoundError, BadRequestError, ForbiddenError
from app.classroom.db import get_classroom_db
from app.classroom.models import (
    ClassroomSession,
    ClassroomDevice,
    ClassroomSessionDevice,
    InstructorCommand,
)
from app.classroom.schemas import CommandCreate

logger = logging.getLogger("classroom.commands")

# Two routers — commands are reachable via session scope and device scope
session_router = APIRouter(prefix="/classroom/sessions", tags=["Classroom — Commands"])
device_router  = APIRouter(prefix="/classroom/devices",  tags=["Classroom — Commands"])


def _require_device_auth(request: Request, device: ClassroomDevice) -> None:
    import bcrypt
    secret = request.headers.get("X-Device-Secret", "")
    if not secret:
        raise ForbiddenError("Missing X-Device-Secret header.")
    try:
        ok = bcrypt.checkpw(secret.encode(), device.device_secret_hash.encode())
    except Exception:
        ok = False
    if not ok:
        raise ForbiddenError("Invalid device secret.")


def _cmd_out(c: InstructorCommand) -> dict:
    return {
        "command_id":          c.command_id,
        "session_id":          c.session_id,
        "device_id":           c.device_id,
        "instructor_user_id":  c.instructor_user_id,
        "command_type":        c.command_type,
        "payload":             json.loads(c.payload_json or "{}"),
        "delivery_status":     c.delivery_status,
        "execution_result":    c.execution_result,
        "failure_reason":      c.failure_reason,
        "created_at":          c.created_at.isoformat(),
        "delivered_at":        c.delivered_at.isoformat() if c.delivered_at else None,
        "acknowledged_at":     c.acknowledged_at.isoformat() if c.acknowledged_at else None,
    }


# ── Professor issues a command ─────────────────────────────────────────────────

@session_router.post("/{session_id}/commands", summary="Issue instructor command")
async def issue_command(
    session_id: str = Path(...),
    body: CommandCreate = ...,
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    from app.classroom.hub import classroom_hub

    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")
    if s.status not in ("active", "paused"):
        raise BadRequestError("Commands can only be issued to active or paused sessions.")

    # Validate target device (if not broadcast)
    if body.target_device_id:
        device = db.get(ClassroomDevice, body.target_device_id)
        if not device:
            raise NotFoundError(f"Device {body.target_device_id}")
        # Confirm device is in this session
        assignment = db.execute(
            select(ClassroomSessionDevice).where(
                ClassroomSessionDevice.session_id == session_id,
                ClassroomSessionDevice.device_id == body.target_device_id,
                ClassroomSessionDevice.status == "active",
            )
        ).scalar_one_or_none()
        if not assignment:
            raise BadRequestError("Device is not assigned to this session.")

    cmd = InstructorCommand(
        session_id=session_id,
        device_id=body.target_device_id,   # None = broadcast
        instructor_user_id=prof["sub"],
        command_type=body.command_type,
        payload_json=json.dumps(body.payload),
    )
    db.add(cmd)
    db.flush()

    # Deliver immediately over WebSocket if target device(s) are connected
    now = datetime.now(timezone.utc)
    cmd_data = _cmd_out(cmd)
    if body.target_device_id:
        delivered = await classroom_hub.send_command_to_device(body.target_device_id, cmd_data)
        if delivered:
            cmd.delivery_status = "delivered"
            cmd.delivered_at = now
            db.flush()
    else:
        # Broadcast to all active devices in session
        assignments = db.execute(
            select(ClassroomSessionDevice).where(
                ClassroomSessionDevice.session_id == session_id,
                ClassroomSessionDevice.status == "active",
            )
        ).scalars().all()
        any_delivered = False
        for a in assignments:
            if await classroom_hub.send_command_to_device(a.device_id, cmd_data):
                any_delivered = True
        if any_delivered:
            cmd.delivery_status = "delivered"
            cmd.delivered_at = now
            db.flush()

    logger.info(
        "Command issued: %s type=%s target=%s session=%s delivered=%s",
        cmd.command_id, body.command_type, body.target_device_id or "BROADCAST", session_id, cmd.delivery_status,
    )
    return {"data": _cmd_out(cmd)}


@session_router.get("/{session_id}/commands", summary="List commands for a session")
def list_commands(
    session_id: str = Path(...),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")

    q = select(InstructorCommand).where(InstructorCommand.session_id == session_id)
    if status:
        q = q.where(InstructorCommand.delivery_status == status)

    cmds = db.execute(
        q.order_by(InstructorCommand.created_at.desc()).limit(limit)
    ).scalars().all()

    return {"data": [_cmd_out(c) for c in cmds]}


# ── Agent picks up pending commands ───────────────────────────────────────────

@device_router.get("/{device_id}/commands/pending", summary="Agent polls for commands")
def get_pending_commands(
    device_id: str = Path(...),
    session_id: Optional[str] = Query(None),
    request: Request = ...,
    db: Session = Depends(get_classroom_db),
):
    """
    Called by the Python student agent (every heartbeat interval).
    Returns commands that are 'queued' and targeted at this device or broadcast.
    Marks them as 'delivered' immediately.
    Authenticated via X-Device-Secret header.
    """
    device = db.get(ClassroomDevice, device_id)
    if not device:
        raise NotFoundError("Device")
    _require_device_auth(request, device)

    q = select(InstructorCommand).where(
        InstructorCommand.delivery_status == "queued",
        (InstructorCommand.device_id == device_id)
        | (InstructorCommand.device_id.is_(None)),   # broadcast
    )
    if session_id:
        q = q.where(InstructorCommand.session_id == session_id)

    cmds = db.execute(q.order_by(InstructorCommand.created_at)).scalars().all()

    now = datetime.now(timezone.utc)
    for c in cmds:
        c.delivery_status = "delivered"
        c.delivered_at = now

    db.flush()
    return {"data": [_cmd_out(c) for c in cmds]}


# ── Agent acknowledges command execution ───────────────────────────────────────

@session_router.put(
    "/{session_id}/commands/{command_id}/ack",
    summary="Agent acknowledges command execution",
)
def ack_command(
    session_id: str = Path(...),
    command_id: str = Path(...),
    request: Request = ...,
    db: Session = Depends(get_classroom_db),
):
    """
    Called by the Python agent after executing a command.
    The agent must supply its X-Device-Secret and the result body:
      {"result": "ok"|"failed", "message": "..."}
    """
    body = {}
    import asyncio

    cmd = db.get(InstructorCommand, command_id)
    if not cmd or cmd.session_id != session_id:
        raise NotFoundError("Command")

    # Validate the device that owns this command
    if cmd.device_id:
        device = db.get(ClassroomDevice, cmd.device_id)
        if not device:
            raise NotFoundError("Device")
        _require_device_auth(request, device)

    result = request.headers.get("X-Command-Result", "ok")
    message = request.headers.get("X-Command-Message", "")

    cmd.delivery_status = "acknowledged"
    cmd.execution_result = result
    cmd.failure_reason = message if result != "ok" else None
    cmd.acknowledged_at = datetime.now(timezone.utc)
    db.flush()

    return {"data": _cmd_out(cmd)}
