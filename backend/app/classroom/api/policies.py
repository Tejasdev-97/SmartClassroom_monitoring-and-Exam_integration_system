"""
ExamProctor.ai — Classroom Monitoring: Policy Management API.

Endpoints:
  POST  /classroom/policies           — create a policy
  GET   /classroom/policies           — list all policies
  GET   /classroom/policies/{id}      — get policy detail
  PUT   /classroom/policies/{id}      — update a policy
  DELETE /classroom/policies/{id}     — delete policy (if not in use)
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Path
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.core.permissions import ProfessorUser
from app.core.errors import NotFoundError, ConflictError
from app.classroom.db import get_classroom_db
from app.classroom.models import ClassroomPolicy, ClassroomSession
from app.classroom.schemas import PolicyCreate

logger = logging.getLogger("classroom.policies")
router = APIRouter(prefix="/classroom/policies", tags=["Classroom — Policies"])


def _policy_out(p: ClassroomPolicy) -> dict:
    return {
        "policy_id":                    p.policy_id,
        "name":                         p.name,
        "description":                  p.description,
        "blocked_process_names":        json.loads(p.blocked_process_names),
        "allowed_process_names":        json.loads(p.allowed_process_names),
        "blocked_domains":              json.loads(p.blocked_domains),
        "allowed_domains":              json.loads(p.allowed_domains),
        "screen_capture_interval_sec":  p.screen_capture_interval_sec,
        "heartbeat_interval_sec":       p.heartbeat_interval_sec,
        "process_scan_interval_sec":    p.process_scan_interval_sec,
        "screen_sharing_enabled":       p.screen_sharing_enabled,
        "webcam_sharing_enabled":       p.webcam_sharing_enabled,
        "enforce_window_focus":         p.enforce_window_focus,
        "block_multiple_monitors":      p.block_multiple_monitors,
        "created_at":                   p.created_at.isoformat(),
        "updated_at":                   p.updated_at.isoformat(),
    }


@router.post("", summary="Create a monitoring policy")
def create_policy(
    body: PolicyCreate,
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    policy = ClassroomPolicy(
        name=body.name,
        description=body.description,
        blocked_process_names=json.dumps(body.blocked_process_names),
        allowed_process_names=json.dumps(body.allowed_process_names),
        blocked_domains=json.dumps(body.blocked_domains),
        allowed_domains=json.dumps(body.allowed_domains),
        screen_capture_interval_sec=body.screen_capture_interval_sec,
        heartbeat_interval_sec=body.heartbeat_interval_sec,
        process_scan_interval_sec=body.process_scan_interval_sec,
        screen_sharing_enabled=body.screen_sharing_enabled,
        webcam_sharing_enabled=body.webcam_sharing_enabled,
        enforce_window_focus=body.enforce_window_focus,
        block_multiple_monitors=body.block_multiple_monitors,
    )
    db.add(policy)
    db.flush()
    logger.info("Policy created: %s name=%s", policy.policy_id, policy.name)
    return {"data": _policy_out(policy)}


@router.get("", summary="List all policies")
def list_policies(
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    policies = db.execute(
        select(ClassroomPolicy).order_by(ClassroomPolicy.created_at.desc())
    ).scalars().all()
    if not policies:
        seed_default_policy(db)
        policies = db.execute(
            select(ClassroomPolicy).order_by(ClassroomPolicy.created_at.desc())
        ).scalars().all()
    return {"data": [_policy_out(p) for p in policies]}


@router.get("/{policy_id}", summary="Get policy detail")
def get_policy(
    policy_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    p = db.get(ClassroomPolicy, policy_id)
    if not p:
        raise NotFoundError("Policy")
    return {"data": _policy_out(p)}


@router.put("/{policy_id}", summary="Update a policy")
def update_policy(
    policy_id: str = Path(...),
    body: PolicyCreate = ...,
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    p = db.get(ClassroomPolicy, policy_id)
    if not p:
        raise NotFoundError("Policy")

    p.name = body.name
    p.description = body.description
    p.blocked_process_names = json.dumps(body.blocked_process_names)
    p.allowed_process_names = json.dumps(body.allowed_process_names)
    p.blocked_domains = json.dumps(body.blocked_domains)
    p.allowed_domains = json.dumps(body.allowed_domains)
    p.screen_capture_interval_sec = body.screen_capture_interval_sec
    p.heartbeat_interval_sec = body.heartbeat_interval_sec
    p.process_scan_interval_sec = body.process_scan_interval_sec
    p.screen_sharing_enabled = body.screen_sharing_enabled
    p.webcam_sharing_enabled = body.webcam_sharing_enabled
    p.enforce_window_focus = body.enforce_window_focus
    p.block_multiple_monitors = body.block_multiple_monitors
    db.flush()
    return {"data": _policy_out(p)}


@router.delete("/{policy_id}", summary="Delete a policy (if not in use)")
def delete_policy(
    policy_id: str = Path(...),
    prof: dict = Depends(ProfessorUser),
    db: Session = Depends(get_classroom_db),
):
    p = db.get(ClassroomPolicy, policy_id)
    if not p:
        raise NotFoundError("Policy")

    # Guard: prevent deletion if referenced by any session
    in_use = db.execute(
        select(func.count()).where(ClassroomSession.policy_id == policy_id)
    ).scalar_one()

    if in_use > 0:
        raise ConflictError(
            f"Policy is used by {in_use} session(s). "
            "End those sessions before deleting the policy."
        )

    db.delete(p)
    db.flush()
    return {"data": {"deleted": True, "policy_id": policy_id}}


# ── Seed default policy on first boot ─────────────────────────────────────────

def seed_default_policy(db: Session) -> None:
    """
    Create a sensible default policy if no policies exist.
    Called once from application lifespan.
    """
    count = db.execute(select(func.count()).select_from(ClassroomPolicy)).scalar_one()
    if count == 0:
        default = ClassroomPolicy(
            name="Standard Exam Policy",
            description="Default policy: blocks common cheat tools, enforces focus, captures screen every 5 seconds.",
            blocked_process_names=json.dumps([
                "notepad.exe", "wordpad.exe", "cmd.exe", "powershell.exe",
                "calculator.exe", "mspaint.exe", "winword.exe", "excel.exe",
                "vlc.exe", "obs64.exe", "anydesk.exe", "teamviewer.exe",
                "screenpresso.exe", "snagit32.exe", "sharex.exe",
                "telegram.exe", "discord.exe", "slack.exe",
            ]),
            allowed_process_names=json.dumps([
                "chrome.exe", "msedge.exe", "firefox.exe",
                "electron.exe",  # the exam app itself
            ]),
            blocked_domains=json.dumps([
                "chatgpt.com", "claude.ai", "gemini.google.com", "bard.google.com",
                "copilot.microsoft.com", "chat.openai.com",
                "stackoverflow.com", "github.com", "pastebin.com",
                "reddit.com", "quora.com",
            ]),
            allowed_domains=json.dumps([]),
            screen_capture_interval_sec=5,
            heartbeat_interval_sec=5,
            process_scan_interval_sec=3,
            screen_sharing_enabled=True,
            webcam_sharing_enabled=True,
            enforce_window_focus=True,
            block_multiple_monitors=False,
        )
        db.add(default)
        db.commit()
        logger.info("Default classroom policy seeded: %s", default.policy_id)
