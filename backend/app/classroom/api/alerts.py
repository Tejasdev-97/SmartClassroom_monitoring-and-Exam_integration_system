"""
ExamProctor.ai — Classroom Monitoring: Alert Management API.

Endpoints:
  GET    /classroom/sessions/{session_id}/alerts         — list alerts
  PUT    /classroom/sessions/{session_id}/alerts/{id}    — review alert
  GET    /classroom/sessions/{session_id}/alerts/summary — counts by type & severity
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.core.permissions import ProfessorUser
from app.core.errors import NotFoundError, ForbiddenError, BadRequestError
from app.classroom.db import get_classroom_db
from app.classroom.models import ClassroomSession, ClassroomAlert
from app.classroom.schemas import AlertReviewRequest

logger = logging.getLogger("classroom.alerts")
router = APIRouter(prefix="/classroom/sessions", tags=["Classroom — Alerts"])


def _alert_out(a: ClassroomAlert) -> dict:
    return {
        "alert_id":              a.alert_id,
        "session_id":            a.session_id,
        "device_id":             a.device_id,
        "student_user_id":       a.student_user_id,
        "alert_type":            a.alert_type,
        "severity":              a.severity,
        "description":           a.description,
        "evidence_snapshot_id":  a.evidence_snapshot_id,
        "metadata":              json.loads(a.metadata_json or "{}"),
        "resolution_status":     a.resolution_status,
        "resolved_by_user_id":   a.resolved_by_user_id,
        "review_notes":          a.review_notes,
        "detected_at":           a.detected_at.isoformat(),
        "resolved_at":           a.resolved_at.isoformat() if a.resolved_at else None,
    }


@router.get("/{session_id}/alerts", summary="List session alerts")
def list_alerts(
    session_id: str = Path(...),
    status: Optional[str] = Query(None, description="Filter by resolution_status"),
    device_id: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")

    q = select(ClassroomAlert).where(ClassroomAlert.session_id == session_id)
    if status:
        q = q.where(ClassroomAlert.resolution_status == status)
    if device_id:
        q = q.where(ClassroomAlert.device_id == device_id)
    if severity:
        q = q.where(ClassroomAlert.severity == severity)

    total = db.execute(
        select(func.count()).select_from(q.subquery())
    ).scalar_one()

    alerts = db.execute(
        q.order_by(ClassroomAlert.detected_at.desc()).offset(offset).limit(limit)
    ).scalars().all()

    return {
        "data": [_alert_out(a) for a in alerts],
        "meta": {"total": total, "limit": limit, "offset": offset},
    }


@router.put("/{session_id}/alerts/{alert_id}", summary="Review / resolve an alert")
def review_alert(
    session_id: str = Path(...),
    alert_id: str = Path(...),
    body: AlertReviewRequest = ...,
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")

    alert = db.get(ClassroomAlert, alert_id)
    if not alert or alert.session_id != session_id:
        raise NotFoundError("Alert")

    from datetime import datetime, timezone
    alert.resolution_status = body.resolution_status
    alert.resolved_by_user_id = prof["sub"]
    alert.review_notes = body.review_notes
    alert.resolved_at = datetime.now(timezone.utc)
    db.flush()

    return {"data": _alert_out(alert)}


@router.get("/{session_id}/alerts/summary", summary="Alert counts by type/severity")
def alerts_summary(
    session_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    s = db.get(ClassroomSession, session_id)
    if not s or s.instructor_user_id != prof["sub"]:
        raise NotFoundError("Session")

    rows = db.execute(
        select(
            ClassroomAlert.alert_type,
            ClassroomAlert.severity,
            ClassroomAlert.resolution_status,
            func.count().label("cnt"),
        )
        .where(ClassroomAlert.session_id == session_id)
        .group_by(
            ClassroomAlert.alert_type,
            ClassroomAlert.severity,
            ClassroomAlert.resolution_status,
        )
    ).all()

    return {
        "data": [
            {
                "alert_type":        r.alert_type,
                "severity":          r.severity,
                "resolution_status": r.resolution_status,
                "count":             r.cnt,
            }
            for r in rows
        ]
    }
