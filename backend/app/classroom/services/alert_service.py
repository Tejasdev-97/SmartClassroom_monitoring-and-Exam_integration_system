"""
ExamProctor.ai — Classroom Monitoring: Alert service.

Handles de-duplicated alert creation with configurable cooldown windows.
"""

import json
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy.orm import Session
from sqlalchemy import select

from app.classroom.models import ClassroomAlert, ClassroomPolicy


# Default cooldown — don't create a duplicate alert for the same
# (device, alert_type) within this many seconds.
DEFAULT_COOLDOWN_SEC = 30


def create_alert(
    db: Session,
    session_id: str,
    device_id: str,
    alert_type: str,
    description: str,
    severity: str = "medium",
    student_user_id: Optional[str] = None,
    evidence_snapshot_id: Optional[str] = None,
    metadata: Optional[dict] = None,
    cooldown_sec: int = DEFAULT_COOLDOWN_SEC,
) -> Optional[ClassroomAlert]:
    """
    Insert a new ClassroomAlert unless a recent identical alert exists.

    Returns the created alert or None if deduplicated / suppressed.
    """
    cooldown_group = f"{device_id}:{alert_type}"
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=cooldown_sec)

    existing = db.execute(
        select(ClassroomAlert)
        .where(
            ClassroomAlert.session_id == session_id,
            ClassroomAlert.cooldown_group == cooldown_group,
            ClassroomAlert.detected_at >= cutoff,
        )
        .limit(1)
    ).scalar_one_or_none()

    if existing:
        return None  # Deduplicated

    alert = ClassroomAlert(
        session_id=session_id,
        device_id=device_id,
        student_user_id=student_user_id,
        alert_type=alert_type,
        severity=severity,
        description=description,
        evidence_snapshot_id=evidence_snapshot_id,
        metadata_json=json.dumps(metadata or {}),
        cooldown_group=cooldown_group,
    )
    db.add(alert)
    db.flush()
    return alert
