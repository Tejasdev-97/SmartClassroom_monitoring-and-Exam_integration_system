"""
ExamProctor.ai — Classroom Monitoring: Pydantic schemas.

All classroom request/response schemas.  Uses plain dicts and JSON-serialisable
types compatible with SQLite storage.
"""

from __future__ import annotations
from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, field_validator


# ── Shared ─────────────────────────────────────────────────────────────────────

class ClassroomResponseEnvelope(BaseModel):
    data: Any
    success: bool = True


# ── Policies ───────────────────────────────────────────────────────────────────

class PolicyCreate(BaseModel):
    name: str
    description: Optional[str] = None
    blocked_process_names: List[str] = []
    allowed_process_names: List[str] = []
    blocked_domains: List[str] = []
    allowed_domains: List[str] = []
    screen_capture_interval_sec: int = 5
    heartbeat_interval_sec: int = 5
    process_scan_interval_sec: int = 3
    screen_sharing_enabled: bool = True
    webcam_sharing_enabled: bool = True
    enforce_window_focus: bool = True
    block_multiple_monitors: bool = False

    @field_validator("screen_capture_interval_sec", "heartbeat_interval_sec", "process_scan_interval_sec")
    @classmethod
    def positive_interval(cls, v: int) -> int:
        if v < 1:
            raise ValueError("Interval must be at least 1 second")
        return v


class PolicyOut(BaseModel):
    policy_id: str
    name: str
    description: Optional[str]
    blocked_process_names: List[str]
    allowed_process_names: List[str]
    blocked_domains: List[str]
    allowed_domains: List[str]
    screen_capture_interval_sec: int
    heartbeat_interval_sec: int
    process_scan_interval_sec: int
    screen_sharing_enabled: bool
    webcam_sharing_enabled: bool
    enforce_window_focus: bool
    block_multiple_monitors: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Devices ────────────────────────────────────────────────────────────────────

class DeviceRegisterRequest(BaseModel):
    """Sent by the Python agent on first startup."""
    hostname: str
    os_type: str = "windows"
    os_version: Optional[str] = None
    agent_version: str = "0.0.1"
    ip_address: Optional[str] = None

    @field_validator("os_type")
    @classmethod
    def valid_os(cls, v: str) -> str:
        if v not in ("windows", "linux", "macos"):
            raise ValueError("os_type must be windows, linux or macos")
        return v


class DeviceApproveRequest(BaseModel):
    room_name: str
    workstation_label: Optional[str] = None


class DeviceOut(BaseModel):
    device_id: str
    room_name: str
    workstation_label: Optional[str]
    hostname: str
    os_type: str
    os_version: Optional[str]
    agent_version: str
    ip_address: Optional[str]
    enrollment_status: str
    current_status: str
    last_heartbeat_at: Optional[datetime]
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Sessions ────────────────────────────────────────────────────────────────────

class SessionCreate(BaseModel):
    room_name: str
    policy_id: str
    exam_id: Optional[str] = None
    offline_auth_minutes: int = 120


class SessionOut(BaseModel):
    session_id: str
    exam_id: Optional[str]
    instructor_user_id: str
    policy_id: str
    room_name: str
    status: str
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    offline_auth_expires_at: Optional[datetime]
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Session Device Assignment ───────────────────────────────────────────────────

class SessionDeviceAssignment(BaseModel):
    device_id: str
    student_user_id: Optional[str] = None
    student_name: Optional[str] = None
    student_usn: Optional[str] = None
    attempt_id: Optional[str] = None


class SessionDeviceOut(BaseModel):
    assignment_id: str
    session_id: str
    device_id: str
    student_user_id: Optional[str]
    student_name: Optional[str]
    student_usn: Optional[str]
    attempt_id: Optional[str]
    assigned_at: datetime
    status: str

    model_config = {"from_attributes": True}


# ── Grid (Live Dashboard Snapshot) ─────────────────────────────────────────────

class DeviceGridCard(BaseModel):
    """Snapshot of a single student workstation for the live classroom grid."""
    assignment_id: str
    device_id: str
    device_hostname: str
    room_name: str
    workstation_label: Optional[str]
    enrollment_status: str
    connection_status: str              # offline | online | monitoring | error
    student_user_id: Optional[str]
    student_name: Optional[str]
    student_usn: Optional[str]
    attempt_id: Optional[str]
    exam_status: Optional[str]         # forwarded from PostgreSQL via app service
    active_process: str
    active_window_title: str
    last_heartbeat_at: Optional[datetime]
    last_event_at: Optional[datetime]
    unresolved_alert_count: int
    alert_summary: Dict[str, int]      # {"prohibited_app": 2, "face_absent": 1, ...}
    weighted_severity_score: float     # for automatic grid sorting
    most_recent_alert_at: Optional[datetime]
    latest_screen_frame: Optional[str] = None
    latest_webcam_frame: Optional[str] = None
    last_screen_at: Optional[datetime] = None
    last_webcam_at: Optional[datetime] = None


# ── Alerts ─────────────────────────────────────────────────────────────────────

class AlertOut(BaseModel):
    alert_id: str
    session_id: str
    device_id: str
    student_user_id: Optional[str]
    alert_type: str
    severity: str
    description: str
    evidence_snapshot_id: Optional[str]
    resolution_status: str
    resolved_by_user_id: Optional[str]
    review_notes: Optional[str]
    detected_at: datetime
    resolved_at: Optional[datetime]

    model_config = {"from_attributes": True}


class AlertReviewRequest(BaseModel):
    resolution_status: str
    review_notes: Optional[str] = None

    @field_validator("resolution_status")
    @classmethod
    def valid_status(cls, v: str) -> str:
        allowed = {"acknowledged", "dismissed", "confirmed_violation", "flagged"}
        if v not in allowed:
            raise ValueError(f"resolution_status must be one of {allowed}")
        return v


# ── Commands ───────────────────────────────────────────────────────────────────

ALLOWED_COMMAND_TYPES = {
    "send_message",
    "broadcast_notice",
    "force_refresh",
    "enforce_focus",
    "flag_student",
    "lock_workstation",
    "unlock_workstation",
}


class CommandCreate(BaseModel):
    """Issued by the professor from the dashboard."""
    target_device_id: Optional[str] = None  # None = broadcast to all
    command_type: str
    payload: Dict[str, Any] = {}

    @field_validator("command_type")
    @classmethod
    def valid_type(cls, v: str) -> str:
        if v not in ALLOWED_COMMAND_TYPES:
            raise ValueError(f"command_type must be one of {sorted(ALLOWED_COMMAND_TYPES)}")
        return v


class CommandOut(BaseModel):
    command_id: str
    session_id: str
    device_id: Optional[str]
    instructor_user_id: str
    command_type: str
    payload: Dict[str, Any]
    delivery_status: str
    execution_result: Optional[str]
    failure_reason: Optional[str]
    created_at: datetime
    delivered_at: Optional[datetime]
    acknowledged_at: Optional[datetime]

    model_config = {"from_attributes": True}


# ── Agent WebSocket protocol messages ──────────────────────────────────────────

class AgentHeartbeat(BaseModel):
    type: str = "heartbeat"
    device_id: str
    session_id: Optional[str]
    cpu_percent: Optional[float]
    ram_percent: Optional[float]
    active_process_name: str = ""
    active_window_title: str = ""
    timestamp: str  # ISO-8601


class AgentWindowEvent(BaseModel):
    type: str = "window_change"
    device_id: str
    session_id: Optional[str]
    process_name: str
    window_title: str
    idempotency_key: str
    timestamp: str


class AgentPolicyViolation(BaseModel):
    type: str = "policy_violation"
    device_id: str
    session_id: Optional[str]
    rule: str           # blocked_app | blocked_domain | ai_tool | prohibited_domain
    process_name: str = ""
    window_title: str = ""
    domain: str = ""
    idempotency_key: str
    timestamp: str
    evidence_image_b64: Optional[str] = None  # small JPEG/WebP thumbnail, base64


class AgentScreenFrame(BaseModel):
    """Metadata envelope for a screen preview frame.
    The actual image bytes arrive as a separate binary WebSocket frame immediately after."""
    type: str = "screen_frame"
    device_id: str
    session_id: Optional[str]
    frame_id: str
    width: int
    height: int
    format: str = "jpeg"  # jpeg | webp
    timestamp: str


class AgentCommandAck(BaseModel):
    type: str = "command_ack"
    command_id: str
    device_id: str
    result: str  # ok | failed
    message: Optional[str] = None
    timestamp: str
