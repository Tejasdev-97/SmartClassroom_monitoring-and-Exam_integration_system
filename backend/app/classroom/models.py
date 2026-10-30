"""
ExamProctor.ai — Classroom Monitoring: SQLite ORM Models.

These models map exclusively to the local classroom.db SQLite database.
They are registered against ClassroomBase (NOT app.db.session.Base).

Tables:
  classroom_policies       — configurable monitoring rules
  classroom_devices        — enrolled student workstations
  classroom_sessions       — lab proctoring sessions
  classroom_session_devices — device-student assignments per session
  desktop_activity_events  — process/window events from agents
  browser_activity_events  — domain events from browser extension
  classroom_alerts         — de-duplicated incidents for professor review
  instructor_commands      — authenticated control messages + audit log
  classroom_sync_log       — idempotent sync journal for events
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer,
    String, Text, Float, UniqueConstraint, CheckConstraint,
)
from sqlalchemy.orm import relationship

from app.classroom.db import ClassroomBase


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Classroom Policies ────────────────────────────────────────────────────────

class ClassroomPolicy(ClassroomBase):
    __tablename__ = "classroom_policies"

    policy_id = Column(String(36), primary_key=True, default=_uuid)
    name = Column(String(150), nullable=False)
    description = Column(Text, nullable=True)

    # Serialised as JSON strings (SQLite-compatible; no JSONB available)
    blocked_process_names = Column(Text, nullable=False, default="[]")
    allowed_process_names = Column(Text, nullable=False, default="[]")
    blocked_domains = Column(Text, nullable=False, default="[]")
    allowed_domains = Column(Text, nullable=False, default="[]")

    # Intervals (seconds / milliseconds)
    screen_capture_interval_sec = Column(Integer, nullable=False, default=5)
    heartbeat_interval_sec = Column(Integer, nullable=False, default=5)
    process_scan_interval_sec = Column(Integer, nullable=False, default=3)

    # Feature toggles
    screen_sharing_enabled = Column(Boolean, nullable=False, default=True)
    webcam_sharing_enabled = Column(Boolean, nullable=False, default=True)
    enforce_window_focus = Column(Boolean, nullable=False, default=True)
    block_multiple_monitors = Column(Boolean, nullable=False, default=False)

    # Alert severity weights (stored as comma-separated "low,medium,high,critical")
    # e.g. "1,2,3,4"  →  low=1, medium=2, high=3, critical=4
    severity_weights = Column(String(50), nullable=False, default="1,2,3,4")

    created_at = Column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)

    sessions = relationship("ClassroomSession", back_populates="policy")


# ── Classroom Devices (Enrolled Workstations) ─────────────────────────────────

class ClassroomDevice(ClassroomBase):
    __tablename__ = "classroom_devices"

    device_id = Column(String(36), primary_key=True, default=_uuid)
    room_name = Column(String(100), nullable=False, default="")
    workstation_label = Column(String(50), nullable=True)

    # Descriptive metadata (never used for authentication)
    hostname = Column(String(255), nullable=False)
    os_type = Column(String(20), nullable=False, default="windows")  # windows | linux
    os_version = Column(String(100), nullable=True)
    agent_version = Column(String(50), nullable=False, default="0.0.1")
    ip_address = Column(String(45), nullable=True)

    # Authentication — HMAC key stored as a bcrypt hash; plaintext never persisted
    device_secret_hash = Column(Text, nullable=False, default="")

    # Status
    enrollment_status = Column(
        String(30), nullable=False, default="pending"
    )  # pending | approved | revoked
    current_status = Column(
        String(30), nullable=False, default="offline"
    )  # offline | online | monitoring | error
    last_heartbeat_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)

    __table_args__ = (
        CheckConstraint(
            "enrollment_status IN ('pending','approved','revoked')",
            name="ck_devices_enrollment_status",
        ),
        CheckConstraint(
            "current_status IN ('offline','online','monitoring','error')",
            name="ck_devices_current_status",
        ),
    )

    session_assignments = relationship(
        "ClassroomSessionDevice", back_populates="device"
    )
    desktop_events = relationship("DesktopActivityEvent", back_populates="device")
    browser_events = relationship("BrowserActivityEvent", back_populates="device")
    alerts = relationship("ClassroomAlert", back_populates="device")
    commands = relationship("InstructorCommand", back_populates="device")


# ── Classroom Sessions ────────────────────────────────────────────────────────

class ClassroomSession(ClassroomBase):
    __tablename__ = "classroom_sessions"

    session_id = Column(String(36), primary_key=True, default=_uuid)

    # Optional link to an existing exam — stored as a validated string ID
    # No cross-DB foreign key; validated via the PostgreSQL app service.
    exam_id = Column(String(36), nullable=True)

    # Instructor — validated user UUID from the PostgreSQL app DB
    instructor_user_id = Column(String(36), nullable=False)

    policy_id = Column(
        String(36), ForeignKey("classroom_policies.policy_id"), nullable=False
    )
    room_name = Column(String(100), nullable=False)

    status = Column(
        String(30), nullable=False, default="pending"
    )  # pending | active | paused | ended

    offline_auth_expires_at = Column(DateTime(timezone=True), nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    ended_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','active','paused','ended')",
            name="ck_sessions_status",
        ),
    )

    policy = relationship("ClassroomPolicy", back_populates="sessions")
    device_assignments = relationship(
        "ClassroomSessionDevice", back_populates="session"
    )
    alerts = relationship("ClassroomAlert", back_populates="session")
    commands = relationship("InstructorCommand", back_populates="session")


# ── Session ↔ Device Assignment ───────────────────────────────────────────────

class ClassroomSessionDevice(ClassroomBase):
    __tablename__ = "classroom_session_devices"

    assignment_id = Column(String(36), primary_key=True, default=_uuid)
    session_id = Column(
        String(36), ForeignKey("classroom_sessions.session_id"), nullable=False
    )
    device_id = Column(
        String(36), ForeignKey("classroom_devices.device_id"), nullable=False
    )

    # Student identity — validated UUID from the PostgreSQL users table
    student_user_id = Column(String(36), nullable=True)
    student_name = Column(String(200), nullable=True)
    student_usn = Column(String(50), nullable=True)

    # Attempt identity — validated UUID from the PostgreSQL exam_attempts table
    attempt_id = Column(String(36), nullable=True)

    assigned_at = Column(DateTime(timezone=True), nullable=False, default=_now)
    unassigned_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(
        String(30), nullable=False, default="active"
    )  # active | ended | dropped

    __table_args__ = (
        UniqueConstraint(
            "session_id", "device_id", name="uq_session_device"
        ),
    )

    session = relationship("ClassroomSession", back_populates="device_assignments")
    device = relationship("ClassroomDevice", back_populates="session_assignments")


# ── Desktop Activity Events ───────────────────────────────────────────────────

class DesktopActivityEvent(ClassroomBase):
    __tablename__ = "desktop_activity_events"

    event_id = Column(String(36), primary_key=True, default=_uuid)
    device_id = Column(
        String(36), ForeignKey("classroom_devices.device_id"), nullable=False
    )
    session_id = Column(
        String(36), ForeignKey("classroom_sessions.session_id"), nullable=True
    )

    event_type = Column(
        String(50), nullable=False
    )  # heartbeat | window_change | process_alert | prohibited_app | agent_disconnect

    # Application info (empty string rather than NULL for indexed lookups)
    active_process_name = Column(String(255), nullable=False, default="")
    active_window_title = Column(String(500), nullable=False, default="")
    additional_metadata = Column(Text, nullable=False, default="{}")

    # Timestamps
    client_timestamp = Column(DateTime(timezone=True), nullable=False)
    server_timestamp = Column(DateTime(timezone=True), nullable=False, default=_now)

    # Idempotency
    idempotency_key = Column(String(36), nullable=False, unique=True, default=_uuid)

    device = relationship("ClassroomDevice", back_populates="desktop_events")


# ── Browser Activity Events ───────────────────────────────────────────────────

class BrowserActivityEvent(ClassroomBase):
    __tablename__ = "browser_activity_events"

    event_id = Column(String(36), primary_key=True, default=_uuid)
    device_id = Column(
        String(36), ForeignKey("classroom_devices.device_id"), nullable=False
    )
    session_id = Column(
        String(36), ForeignKey("classroom_sessions.session_id"), nullable=True
    )

    browser_name = Column(String(50), nullable=False, default="unknown")
    domain = Column(String(255), nullable=False, default="")
    event_type = Column(
        String(50), nullable=False
    )  # tab_activated | navigation | tab_closed | prohibited_domain

    policy_classification = Column(
        String(30), nullable=False, default="neutral"
    )  # neutral | allowed | blocked | ai_tool

    client_timestamp = Column(DateTime(timezone=True), nullable=False)
    server_timestamp = Column(DateTime(timezone=True), nullable=False, default=_now)
    idempotency_key = Column(String(36), nullable=False, unique=True, default=_uuid)

    device = relationship("ClassroomDevice", back_populates="browser_events")


# ── Classroom Alerts ──────────────────────────────────────────────────────────

class ClassroomAlert(ClassroomBase):
    __tablename__ = "classroom_alerts"

    alert_id = Column(String(36), primary_key=True, default=_uuid)
    session_id = Column(
        String(36), ForeignKey("classroom_sessions.session_id"), nullable=False
    )
    device_id = Column(
        String(36), ForeignKey("classroom_devices.device_id"), nullable=False
    )

    # Student reference (validated from PostgreSQL; not a FK)
    student_user_id = Column(String(36), nullable=True)

    alert_type = Column(
        String(60), nullable=False
    )  # prohibited_app | ai_domain | face_absent | multiple_faces | phone_detected |
       # looking_away | focus_loss | agent_disconnect | browser_prohibited | custom

    severity = Column(
        String(20), nullable=False, default="medium"
    )  # low | medium | high | critical

    description = Column(Text, nullable=False, default="")

    # Reference to a snapshot in the PostgreSQL snapshots table (optional)
    evidence_snapshot_id = Column(String(36), nullable=True)

    # Additional context JSON
    metadata_json = Column(Text, nullable=False, default="{}")

    resolution_status = Column(
        String(30), nullable=False, default="unreviewed"
    )  # unreviewed | acknowledged | dismissed | confirmed_violation | flagged

    # Reviewer (validated from PostgreSQL users table)
    resolved_by_user_id = Column(String(36), nullable=True)
    review_notes = Column(Text, nullable=True)

    detected_at = Column(DateTime(timezone=True), nullable=False, default=_now)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_now)

    # Deduplication cooldown — don't create a new alert for the same condition
    # if one already exists within this window
    cooldown_group = Column(String(100), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "severity IN ('low','medium','high','critical')",
            name="ck_alerts_severity",
        ),
        CheckConstraint(
            "resolution_status IN ('unreviewed','acknowledged','dismissed','confirmed_violation','flagged')",
            name="ck_alerts_resolution_status",
        ),
    )

    session = relationship("ClassroomSession", back_populates="alerts")
    device = relationship("ClassroomDevice", back_populates="alerts")


# ── Instructor Commands ───────────────────────────────────────────────────────

class InstructorCommand(ClassroomBase):
    __tablename__ = "instructor_commands"

    command_id = Column(String(36), primary_key=True, default=_uuid)
    session_id = Column(
        String(36), ForeignKey("classroom_sessions.session_id"), nullable=False
    )

    # NULL device_id = broadcast to all devices in the session
    device_id = Column(
        String(36), ForeignKey("classroom_devices.device_id"), nullable=True
    )

    # Instructor validated from PostgreSQL users table
    instructor_user_id = Column(String(36), nullable=False)

    command_type = Column(
        String(60), nullable=False
    )  # send_message | broadcast_notice | force_refresh | enforce_focus | flag_student | lock_workstation | unlock_workstation

    payload_json = Column(Text, nullable=False, default="{}")

    delivery_status = Column(
        String(30), nullable=False, default="queued"
    )  # queued | delivered | acknowledged | failed | expired

    execution_result = Column(Text, nullable=True)
    failure_reason = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, default=_now)
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    acknowledged_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "delivery_status IN ('queued','delivered','acknowledged','failed','expired')",
            name="ck_commands_delivery_status",
        ),
    )

    session = relationship("ClassroomSession", back_populates="commands")
    device = relationship("ClassroomDevice", back_populates="commands")


# ── Classroom Sync Log (Idempotent event journal for reconnection) ─────────────

class ClassroomSyncLog(ClassroomBase):
    __tablename__ = "classroom_sync_log"

    log_id = Column(String(36), primary_key=True, default=_uuid)
    device_id = Column(String(36), nullable=False)
    event_type = Column(String(50), nullable=False)
    idempotency_key = Column(String(36), nullable=False, unique=True)
    payload_hash = Column(String(64), nullable=False)
    received_at = Column(DateTime(timezone=True), nullable=False, default=_now)
    status = Column(String(20), nullable=False, default="accepted")  # accepted | rejected | duplicate
