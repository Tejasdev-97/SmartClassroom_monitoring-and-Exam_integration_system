"""
ExamProctor.ai — Classroom Monitoring: Live Grid Service.

Assembles the DeviceGridCard payload for the instructor dashboard.
Queries the classroom SQLite DB for live device/activity state
and merges unresolved alert counts into per-card summaries.
"""

from __future__ import annotations

import json
from typing import Dict, List, Optional
from datetime import datetime, timezone, timedelta

from sqlalchemy.orm import Session
from sqlalchemy import select, func, case

from app.classroom.models import (
    ClassroomDevice,
    ClassroomSession,
    ClassroomSessionDevice,
    DesktopActivityEvent,
    ClassroomAlert,
)
from app.classroom.schemas import DeviceGridCard
from app.classroom.hub import classroom_hub

# A device is considered STALE (offline) if no heartbeat in this window
STALE_THRESHOLD_SEC = 15


def _severity_to_weight(severity: str) -> float:
    weights = {"low": 1.0, "medium": 2.0, "high": 3.0, "critical": 5.0}
    return weights.get(severity, 1.0)


def build_grid(db: Session, session_id: str) -> List[DeviceGridCard]:
    """
    Return the live classroom grid for a given session.

    Each entry corresponds to one enrolled workstation that has been
    assigned to the session.  The result is sorted by descending
    weighted_severity_score so the most critical students appear first.
    """

    # ── 1. Fetch all device assignments for the session ───────────────────────
    assignments_rows = db.execute(
        select(ClassroomSessionDevice, ClassroomDevice)
        .join(ClassroomDevice, ClassroomSessionDevice.device_id == ClassroomDevice.device_id)
        .where(
            ClassroomSessionDevice.session_id == session_id,
            ClassroomSessionDevice.status == "active",
        )
    ).all()

    if not assignments_rows:
        return []

    device_ids = [d.device_id for _, d in assignments_rows]
    stale_cutoff = datetime.now(timezone.utc) - timedelta(seconds=STALE_THRESHOLD_SEC)

    # ── 2. Latest desktop activity event per device ───────────────────────────
    subq = (
        select(
            DesktopActivityEvent.device_id,
            func.max(DesktopActivityEvent.server_timestamp).label("latest_ts"),
        )
        .where(
            DesktopActivityEvent.device_id.in_(device_ids),
            DesktopActivityEvent.session_id == session_id,
        )
        .group_by(DesktopActivityEvent.device_id)
        .subquery()
    )

    latest_events: Dict[str, DesktopActivityEvent] = {}
    latest_event_rows = db.execute(
        select(DesktopActivityEvent).join(
            subq,
            (DesktopActivityEvent.device_id == subq.c.device_id)
            & (DesktopActivityEvent.server_timestamp == subq.c.latest_ts),
        )
    ).scalars().all()

    for evt in latest_event_rows:
        latest_events[evt.device_id] = evt

    # ── 3. Unresolved alert aggregation per device ────────────────────────────
    alert_rows = db.execute(
        select(
            ClassroomAlert.device_id,
            ClassroomAlert.alert_type,
            ClassroomAlert.severity,
            ClassroomAlert.detected_at,
        )
        .where(
            ClassroomAlert.session_id == session_id,
            ClassroomAlert.device_id.in_(device_ids),
            ClassroomAlert.resolution_status == "unreviewed",
        )
    ).all()

    # Per-device: {device_id -> {alert_type -> count}}, severity_score, most_recent_at
    alert_summary: Dict[str, Dict[str, int]] = {}
    alert_scores: Dict[str, float] = {}
    alert_recent_at: Dict[str, Optional[datetime]] = {}

    for row in alert_rows:
        did = row.device_id
        alert_summary.setdefault(did, {})
        alert_summary[did][row.alert_type] = alert_summary[did].get(row.alert_type, 0) + 1
        alert_scores[did] = alert_scores.get(did, 0.0) + _severity_to_weight(row.severity)
        if alert_recent_at.get(did) is None or row.detected_at > alert_recent_at[did]:
            alert_recent_at[did] = row.detected_at

    # ── 4. Assemble cards ─────────────────────────────────────────────────────
    cards: List[DeviceGridCard] = []

    for assignment, device in assignments_rows:
        did = device.device_id
        latest = latest_events.get(did)

        # Determine live connection status
        if device.current_status == "offline":
            conn = "offline"
        elif device.last_heartbeat_at and device.last_heartbeat_at >= stale_cutoff:
            conn = device.current_status  # online | monitoring
        else:
            conn = "offline"

        summary = alert_summary.get(did, {})
        unresolved = sum(summary.values())
        scr = classroom_hub.get_latest_screen_frame(did)
        cam = classroom_hub.get_latest_webcam_frame(did)

        card = DeviceGridCard(
            assignment_id=assignment.assignment_id,
            device_id=did,
            device_hostname=device.hostname,
            room_name=device.room_name,
            workstation_label=device.workstation_label,
            enrollment_status=device.enrollment_status,
            connection_status=conn,
            student_user_id=assignment.student_user_id,
            student_name=assignment.student_name,
            student_usn=assignment.student_usn,
            attempt_id=assignment.attempt_id,
            exam_status=None,          # Optionally enriched by caller from PostgreSQL
            active_process=latest.active_process_name if latest else "",
            active_window_title=latest.active_window_title if latest else "",
            last_heartbeat_at=device.last_heartbeat_at,
            last_event_at=latest.server_timestamp if latest else None,
            unresolved_alert_count=unresolved,
            alert_summary=summary,
            weighted_severity_score=alert_scores.get(did, 0.0),
            most_recent_alert_at=alert_recent_at.get(did),
            latest_screen_frame=scr.get("image_b64") if scr else None,
            latest_webcam_frame=cam.get("image_b64") if cam else None,
            last_screen_at=scr.get("timestamp") if scr else None,
            last_webcam_at=cam.get("timestamp") if cam else None,
        )
        cards.append(card)

    # Highest severity score first, then most recent heartbeat
    cards.sort(
        key=lambda c: (-c.weighted_severity_score, c.last_heartbeat_at or datetime.min),
        reverse=False,
    )

    return cards
