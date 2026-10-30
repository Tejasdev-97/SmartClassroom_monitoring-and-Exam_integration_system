"""
ExamProctor.ai — Classroom Monitoring: Session Management API.

Endpoints:
  POST   /classroom/sessions                         — create session (professor)
  GET    /classroom/sessions                         — list sessions (professor)
  GET    /classroom/sessions/{id}                    — get session detail
  POST   /classroom/sessions/{id}/start              — start monitoring
  POST   /classroom/sessions/{id}/pause              — pause monitoring
  POST   /classroom/sessions/{id}/end                — end session
  POST   /classroom/sessions/{id}/devices            — assign device(s) to session
  DELETE /classroom/sessions/{id}/devices/{dev_id}   — remove device assignment
  GET    /classroom/sessions/{id}/grid               — live grid (REST fallback)
  GET    /classroom/sessions/{id}/policies           — get effective policy
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.permissions import ProfessorUser
from app.core.errors import NotFoundError, ConflictError, BadRequestError
from app.classroom.db import get_classroom_db
from app.classroom.models import (
    ClassroomSession,
    ClassroomPolicy,
    ClassroomDevice,
    ClassroomSessionDevice,
)
from app.classroom.schemas import (
    SessionCreate,
    SessionDeviceAssignment,
)
from app.classroom.services.grid_service import build_grid

logger = logging.getLogger("classroom.sessions")
router = APIRouter(prefix="/classroom/sessions", tags=["Classroom — Sessions"])


# ── Serialisation helpers ──────────────────────────────────────────────────────

def _session_out(s: ClassroomSession) -> dict:
    return {
        "session_id":               s.session_id,
        "exam_id":                  s.exam_id,
        "instructor_user_id":       s.instructor_user_id,
        "policy_id":                s.policy_id,
        "room_name":                s.room_name,
        "status":                   s.status,
        "started_at":               s.started_at.isoformat() if s.started_at else None,
        "ended_at":                 s.ended_at.isoformat() if s.ended_at else None,
        "offline_auth_expires_at":  (
            s.offline_auth_expires_at.isoformat() if s.offline_auth_expires_at else None
        ),
        "created_at":               s.created_at.isoformat(),
    }


def _assignment_out(a: ClassroomSessionDevice) -> dict:
    return {
        "assignment_id":    a.assignment_id,
        "session_id":       a.session_id,
        "device_id":        a.device_id,
        "student_user_id":  a.student_user_id,
        "student_name":     a.student_name,
        "student_usn":      a.student_usn,
        "attempt_id":       a.attempt_id,
        "assigned_at":      a.assigned_at.isoformat(),
        "status":           a.status,
    }


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("", summary="Create a monitoring session")
def create_session(
    body: SessionCreate,
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    # Validate policy exists
    policy = db.get(ClassroomPolicy, body.policy_id)
    if not policy:
        raise NotFoundError("Policy")

    now = datetime.now(timezone.utc)
    session = ClassroomSession(
        exam_id=body.exam_id,
        instructor_user_id=prof["sub"],
        policy_id=body.policy_id,
        room_name=body.room_name,
        status="pending",
        offline_auth_expires_at=now + timedelta(minutes=body.offline_auth_minutes),
    )
    db.add(session)
    db.flush()
    logger.info("Session created: %s by instructor=%s", session.session_id, prof["sub"])
    return {"data": _session_out(session)}


@router.get("", summary="List sessions (professor)")
def list_sessions(
    status: Optional[str] = Query(None),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    q = select(ClassroomSession).where(
        ClassroomSession.instructor_user_id == prof["sub"]
    )
    if status:
        q = q.where(ClassroomSession.status == status)
    sessions = db.execute(q.order_by(ClassroomSession.created_at.desc())).scalars().all()
    return {"data": [_session_out(s) for s in sessions]}


@router.get("/{session_id}", summary="Get session detail")
def get_session(
    session_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")
    return {"data": _session_out(s)}


@router.post("/{session_id}/start", summary="Start monitoring")
def start_session(
    session_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")
    if s.status == "active":
        raise ConflictError("Session is already active.")
    if s.status == "ended":
        raise BadRequestError("Cannot restart an ended session.")
    s.status = "active"
    s.started_at = datetime.now(timezone.utc)
    db.flush()
    return {"data": _session_out(s)}


@router.post("/{session_id}/pause", summary="Pause monitoring")
def pause_session(
    session_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")
    if s.status != "active":
        raise ConflictError("Only active sessions can be paused.")
    s.status = "paused"
    db.flush()
    return {"data": _session_out(s)}


@router.post("/{session_id}/end", summary="End session")
def end_session(
    session_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")
    if s.status == "ended":
        return {"data": _session_out(s)}  # idempotent
    s.status = "ended"
    s.ended_at = datetime.now(timezone.utc)
    # Mark all active device assignments as ended
    assignments = db.execute(
        select(ClassroomSessionDevice).where(
            ClassroomSessionDevice.session_id == session_id,
            ClassroomSessionDevice.status == "active",
        )
    ).scalars().all()
    for a in assignments:
        a.status = "ended"
    db.flush()
    logger.info("Session ended: %s", session_id)
    return {"data": _session_out(s)}


# ── Device assignment ──────────────────────────────────────────────────────────

@router.post("/{session_id}/devices", summary="Assign device(s) to session")
def assign_devices(
    body: List[SessionDeviceAssignment],
    session_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")
    if s.status == "ended":
        raise BadRequestError("Cannot add devices to an ended session.")

    created = []
    for assignment in body:
        # Validate device exists and is approved
        device = db.get(ClassroomDevice, assignment.device_id)
        if not device:
            raise NotFoundError(f"Device {assignment.device_id}")
        if device.enrollment_status != "approved":
            raise BadRequestError(
                f"Device {assignment.device_id} ({device.hostname}) is not approved."
            )

        # Check for existing active assignment
        existing = db.execute(
            select(ClassroomSessionDevice).where(
                ClassroomSessionDevice.session_id == session_id,
                ClassroomSessionDevice.device_id == assignment.device_id,
                ClassroomSessionDevice.status == "active",
            )
        ).scalar_one_or_none()

        if existing:
            # Update student info idempotently
            existing.student_user_id = assignment.student_user_id or existing.student_user_id
            existing.student_name = assignment.student_name or existing.student_name
            existing.student_usn = assignment.student_usn or existing.student_usn
            existing.attempt_id = assignment.attempt_id or existing.attempt_id
            db.flush()
            created.append(_assignment_out(existing))
        else:
            a = ClassroomSessionDevice(
                session_id=session_id,
                device_id=assignment.device_id,
                student_user_id=assignment.student_user_id,
                student_name=assignment.student_name,
                student_usn=assignment.student_usn,
                attempt_id=assignment.attempt_id,
            )
            db.add(a)
            db.flush()
            created.append(_assignment_out(a))

    return {"data": created}


@router.delete(
    "/{session_id}/devices/{device_id}",
    summary="Remove device from session",
)
def unassign_device(
    session_id: str = Path(...),
    device_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")

    assignment = db.execute(
        select(ClassroomSessionDevice).where(
            ClassroomSessionDevice.session_id == session_id,
            ClassroomSessionDevice.device_id == device_id,
            ClassroomSessionDevice.status == "active",
        )
    ).scalar_one_or_none()

    if not assignment:
        raise NotFoundError("Device assignment")

    assignment.status = "dropped"
    assignment.unassigned_at = datetime.now(timezone.utc)
    db.flush()
    return {"data": {"removed": True, "assignment_id": assignment.assignment_id}}


# ── Live Grid (REST fallback) ──────────────────────────────────────────────────

@router.get("/{session_id}/grid", summary="Get live classroom grid (REST)")
def get_grid(
    session_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")

    cards = build_grid(db, session_id)
    return {"data": [c.model_dump() for c in cards]}


# ── Effective policy ────────────────────────────────────────────────────────────

@router.get("/{session_id}/policy", summary="Get effective monitoring policy")
def get_session_policy(
    session_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")
    policy = db.get(ClassroomPolicy, s.policy_id)
    if not policy:
        raise NotFoundError("Policy")

    return {
        "data": {
            "policy_id":                    policy.policy_id,
            "name":                         policy.name,
            "blocked_process_names":        json.loads(policy.blocked_process_names),
            "allowed_process_names":        json.loads(policy.allowed_process_names),
            "blocked_domains":              json.loads(policy.blocked_domains),
            "allowed_domains":              json.loads(policy.allowed_domains),
            "screen_capture_interval_sec":  policy.screen_capture_interval_sec,
            "heartbeat_interval_sec":       policy.heartbeat_interval_sec,
            "process_scan_interval_sec":    policy.process_scan_interval_sec,
            "screen_sharing_enabled":       policy.screen_sharing_enabled,
            "webcam_sharing_enabled":       policy.webcam_sharing_enabled,
            "enforce_window_focus":         policy.enforce_window_focus,
            "block_multiple_monitors":      policy.block_multiple_monitors,
        }
    }


# ── Session Export Report ──────────────────────────────────────────────────────

@router.get("/{session_id}/report", summary="Generate comprehensive classroom session report")
def get_session_report(
    session_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    from app.classroom.models import ClassroomAlert, InstructorCommand
    from sqlalchemy import select

    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")

    # Devices
    assignments = db.execute(
        select(ClassroomSessionDevice).where(ClassroomSessionDevice.session_id == session_id)
    ).scalars().all()

    # Alerts
    alerts = db.execute(
        select(ClassroomAlert).where(ClassroomAlert.session_id == session_id).order_by(ClassroomAlert.detected_at.desc())
    ).scalars().all()

    # Commands
    commands = db.execute(
        select(InstructorCommand).where(InstructorCommand.session_id == session_id).order_by(InstructorCommand.created_at.desc())
    ).scalars().all()

    alert_summary = {}
    severity_summary = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    confirmed_violations = 0
    for a in alerts:
        alert_summary[a.alert_type] = alert_summary.get(a.alert_type, 0) + 1
        if a.severity in severity_summary:
            severity_summary[a.severity] += 1
        if a.resolution_status == "confirmed_violation":
            confirmed_violations += 1

    duration_sec = 0
    if s.started_at:
        end_time = s.ended_at or datetime.now(timezone.utc)
        duration_sec = int((end_time - s.started_at).total_seconds())

    report = {
        "session": _session_out(s),
        "duration_seconds": duration_sec,
        "total_enrolled_devices": len(assignments),
        "total_alerts": len(alerts),
        "confirmed_violations": confirmed_violations,
        "severity_summary": severity_summary,
        "alert_type_summary": alert_summary,
        "enrolled_students": [_assignment_out(a) for a in assignments],
        "alerts": [
            {
                "alert_id": a.alert_id,
                "device_id": a.device_id,
                "student_user_id": a.student_user_id,
                "alert_type": a.alert_type,
                "severity": a.severity,
                "description": a.description,
                "resolution_status": a.resolution_status,
                "detected_at": a.detected_at.isoformat(),
            }
            for a in alerts
        ],
        "commands_issued": [
            {
                "command_id": c.command_id,
                "command_type": c.command_type,
                "target_device_id": c.device_id,
                "delivery_status": c.delivery_status,
                "execution_result": c.execution_result,
                "created_at": c.created_at.isoformat(),
            }
            for c in commands
        ],
    }
    return {"data": report}


@router.get("/{session_id}/report/download", summary="Download session report as JSON or CSV")
def download_session_report(
    session_id: str = Path(...),
    format: str = Query("json", regex="^(json|csv)$"),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    from fastapi.responses import Response
    import io
    import csv

    rep_data = get_session_report(session_id, prof, db)["data"]

    if format == "json":
        content = json.dumps(rep_data, indent=2, default=str)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="classroom_session_{session_id[:8]}_report.json"'},
        )
    else:
        # CSV Export
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["Classroom Session Report", session_id])
        writer.writerow(["Room Name", rep_data["session"]["room_name"]])
        writer.writerow(["Status", rep_data["session"]["status"]])
        writer.writerow(["Started At", rep_data["session"]["started_at"]])
        writer.writerow(["Ended At", rep_data["session"]["ended_at"]])
        writer.writerow(["Duration (seconds)", rep_data["duration_seconds"]])
        writer.writerow([])
        writer.writerow(["ENROLLED STUDENTS"])
        writer.writerow(["Assignment ID", "Device ID", "Student Name", "Student USN", "Attempt ID", "Status"])
        for st in rep_data["enrolled_students"]:
            writer.writerow([st["assignment_id"], st["device_id"], st["student_name"], st["student_usn"], st["attempt_id"], st["status"]])
        writer.writerow([])
        writer.writerow(["SESSION ALERTS"])
        writer.writerow(["Alert ID", "Device ID", "Alert Type", "Severity", "Resolution", "Detected At", "Description"])
        for al in rep_data["alerts"]:
            writer.writerow([al["alert_id"], al["device_id"], al["alert_type"], al["severity"], al["resolution_status"], al["detected_at"], al["description"]])
        writer.writerow([])
        writer.writerow(["INSTRUCTOR COMMANDS"])
        writer.writerow(["Command ID", "Command Type", "Target Device", "Delivery Status", "Result", "Created At"])
        for cmd in rep_data["commands_issued"]:
            writer.writerow([cmd["command_id"], cmd["command_type"], cmd["target_device_id"], cmd["delivery_status"], cmd["execution_result"], cmd["created_at"]])

        return Response(
            content=output.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="classroom_session_{session_id[:8]}_report.csv"'},
        )
