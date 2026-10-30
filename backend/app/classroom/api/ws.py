"""
ExamProctor.ai — Classroom Monitoring: Real-time WebSocket endpoints.

Endpoints:
  WS  /classroom/ws/{session_id}         — professor dashboard subscribes for live events
  WS  /classroom/agent/ws/{device_id}    — Python student agent connects for bidirectional comms
"""

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from app.classroom.hub import classroom_hub
from app.classroom.db import ClassroomSessionLocal
from app.classroom.models import ClassroomDevice, ClassroomSession, ClassroomSessionDevice, DesktopActivityEvent
from app.classroom.services.alert_service import create_alert
from app.classroom.services.grid_service import build_grid

logger = logging.getLogger("classroom.ws")
router = APIRouter(tags=["Classroom — WebSocket"])

# ── Professor Dashboard WebSocket ─────────────────────────────────────────────

@router.websocket("/classroom/ws/{session_id}")
async def professor_dashboard_ws(
    websocket: WebSocket,
    session_id: str,
    token: Optional[str] = Query(None),
):
    """
    Bi-directional WebSocket for the professor classroom dashboard.
    Authentication: JWT access token supplied as `?token=<jwt>` query param
    or Authorization header.

    Server → Client messages:
      {"type": "grid_update", "data": [...DeviceGridCard...]}
      {"type": "alert",       "data": {...AlertOut...}}
      {"type": "command_ack", "data": {...}}

    Client → Server messages:
      {"type": "ping"}
      {"type": "request_grid"}  — forces an immediate grid push
    """
    from app.core.security import decode_access_token
    from app.core.errors import ForbiddenError

    # Validate JWT
    if not token:
        await websocket.close(code=4001, reason="Missing authentication token")
        return

    payload = decode_access_token(token)
    if not payload or payload.get("role") not in ("professor", "admin"):
        await websocket.close(code=4003, reason="Forbidden")
        return

    await classroom_hub.connect(session_id, websocket)
    logger.info("Dashboard WS connected session=%s user=%s", session_id, payload.get("sub"))

    try:
        # Send an immediate grid snapshot on connect
        with ClassroomSessionLocal() as db:
            cards = build_grid(db, session_id)
        await websocket.send_text(
            json.dumps({"type": "grid_update", "data": [c.model_dump() for c in cards]}, default=str)
        )

        # Listen for client messages
        while True:
            try:
                data = await websocket.receive_text()
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
                elif msg.get("type") == "request_grid":
                    with ClassroomSessionLocal() as db:
                        cards = build_grid(db, session_id)
                    await websocket.send_text(
                        json.dumps(
                            {"type": "grid_update", "data": [c.model_dump() for c in cards]},
                            default=str,
                        )
                    )
                elif msg.get("type") in ("webrtc_offer", "webrtc_answer", "webrtc_ice_candidate"):
                    target_device = msg.get("target_device_id")
                    if target_device:
                        await classroom_hub.send_webrtc_signal_to_device(target_device, msg)
            except WebSocketDisconnect:
                break
            except Exception as e:
                logger.warning("Dashboard WS error session=%s: %s", session_id, e)
                break
    finally:
        await classroom_hub.disconnect(session_id, websocket)
        logger.info("Dashboard WS disconnected session=%s", session_id)


# ── Student Agent WebSocket ───────────────────────────────────────────────────

@router.websocket("/classroom/agent/ws/{device_id}")
async def agent_ws(
    websocket: WebSocket,
    device_id: str,
    secret: Optional[str] = Query(None),
    session_id: Optional[str] = Query(None),
):
    """
    Persistent WebSocket for the Python student agent.
    Authentication: X-Device-Secret supplied as `?secret=<value>` query param.

    Agent → Server messages:
      {"type": "heartbeat", ...AgentHeartbeat}
      {"type": "window_change", ...AgentWindowEvent}
      {"type": "policy_violation", ...AgentPolicyViolation}
      {"type": "screen_frame_meta", ...AgentScreenFrame}  (followed by binary frame)
      {"type": "command_ack", ...AgentCommandAck}

    Server → Agent messages:
      {"type": "command", ...InstructorCommand}
      {"type": "policy_update", ...policy dict}
      {"type": "session_status", "status": "active"|"paused"|"ended"}
    """
    import bcrypt

    # Authenticate device
    with ClassroomSessionLocal() as db:
        device = db.get(ClassroomDevice, device_id)
        if not device or device.enrollment_status != "approved":
            await websocket.close(code=4004, reason="Device not found or not approved")
            return
        if not secret:
            await websocket.close(code=4001, reason="Missing device secret")
            return
        try:
            ok = bcrypt.checkpw(secret.encode(), device.device_secret_hash.encode())
        except Exception:
            ok = False
        if not ok:
            await websocket.close(code=4003, reason="Invalid device secret")
            return

    await websocket.accept()
    await classroom_hub.register_agent(device_id, websocket)
    logger.info("Agent WS connected device=%s session=%s", device_id, session_id)

    # Confirm connection
    await websocket.send_text(json.dumps({
        "type": "connected",
        "device_id": device_id,
        "session_id": session_id,
        "server_time": datetime.now(timezone.utc).isoformat(),
    }))

    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break

            try:
                msg = json.loads(raw)
            except Exception:
                continue

            msg_type = msg.get("type", "")

            # ── heartbeat ──────────────────────────────────────────────────
            if msg_type == "heartbeat":
                with ClassroomSessionLocal() as db:
                    d = db.get(ClassroomDevice, device_id)
                    if d:
                        d.last_heartbeat_at = datetime.now(timezone.utc)
                        if d.current_status in ("offline", "error"):
                            d.current_status = "online"
                        db.commit()

                # Push grid update to all watching dashboards
                if session_id:
                    with ClassroomSessionLocal() as db:
                        cards = build_grid(db, session_id)
                    await classroom_hub.broadcast_grid_update(
                        session_id, [c.model_dump() for c in cards]
                    )

            # ── policy_violation ───────────────────────────────────────────
            elif msg_type == "policy_violation" and session_id:
                sev = str(msg.get("severity", "high")).lower()
                if sev not in ("low", "medium", "high", "critical"):
                    sev = "high"
                is_ai = msg.get("source") == "ai_proctoring"
                event_id = str(msg.get("event_id") or "")[:36]
                with ClassroomSessionLocal() as db:
                    from app.classroom.models import ClassroomSyncLog
                    from sqlalchemy import select as _select
                    duplicate = False
                    if is_ai and event_id:
                        # Stable event IDs make replays after reconnect idempotent.
                        duplicate = db.execute(
                            _select(ClassroomSyncLog).where(ClassroomSyncLog.idempotency_key == event_id)
                        ).scalar_one_or_none() is not None
                    alert = None
                    if not duplicate:
                        alert = create_alert(
                            db=db,
                            session_id=session_id,
                            device_id=device_id,
                            alert_type=msg.get("rule", "prohibited_app"),
                            description=(
                                f"Potential violation detected: {msg.get('rule')}"
                                + (f" — {msg.get('process_name') or msg.get('domain')}"
                                   if (msg.get('process_name') or msg.get('domain')) else "")
                            ),
                            severity=sev,
                            student_user_id=(msg.get("student_user_id") or None),
                            metadata=msg,
                            # Each distinct AI episode is its own alert; app/domain rules keep the cooldown.
                            cooldown_sec=0 if is_ai else 30,
                        )
                    if alert:
                        if is_ai and event_id:
                            db.add(ClassroomSyncLog(
                                device_id=device_id, event_type="ai_event",
                                idempotency_key=event_id, payload_hash="-", status="accepted",
                            ))
                        db.commit()
                        # Notify dashboards (a detection is a POTENTIAL violation, not a confirmed one)
                        from app.classroom.api.alerts import _alert_out
                        await classroom_hub.broadcast_alert(session_id, _alert_out(alert))

            # ── window_change ──────────────────────────────────────────────
            elif msg_type == "window_change":
                with ClassroomSessionLocal() as db:
                    d = db.get(ClassroomDevice, device_id)
                    if d:
                        d.last_heartbeat_at = datetime.now(timezone.utc)
                        db.commit()

                if session_id:
                    with ClassroomSessionLocal() as db:
                        cards = build_grid(db, session_id)
                    await classroom_hub.broadcast_grid_update(
                        session_id, [c.model_dump() for c in cards]
                    )

            # ── command_ack ────────────────────────────────────────────────
            elif msg_type == "command_ack":
                from app.classroom.models import InstructorCommand
                cmd_id = msg.get("command_id")
                if cmd_id:
                    with ClassroomSessionLocal() as db:
                        cmd = db.get(InstructorCommand, cmd_id)
                        if cmd:
                            cmd.delivery_status = "acknowledged"
                            cmd.execution_result = msg.get("result", "ok")
                            cmd.acknowledged_at = datetime.now(timezone.utc)
                            db.commit()
                    if session_id:
                        await classroom_hub.broadcast_command_ack(session_id, msg)

            # ── screen_frame ───────────────────────────────────────────────
            elif msg_type == "screen_frame":
                img_b64 = msg.get("image_b64", "")
                ts = msg.get("timestamp") or datetime.now(timezone.utc).isoformat()
                if session_id and img_b64:
                    await classroom_hub.broadcast_screen_frame(session_id, device_id, img_b64, ts)
                elif img_b64:
                    classroom_hub.set_latest_screen_frame(device_id, img_b64, ts)

            # ── webcam_frame ───────────────────────────────────────────────
            elif msg_type == "webcam_frame":
                img_b64 = msg.get("image_b64", "")
                ts = msg.get("timestamp") or datetime.now(timezone.utc).isoformat()
                uid = msg.get("student_user_id")
                if session_id and img_b64:
                    await classroom_hub.broadcast_webcam_frame(session_id, device_id, img_b64, ts, uid)
                elif img_b64:
                    classroom_hub.set_latest_webcam_frame(device_id, img_b64, ts, uid)

            # ── webrtc signaling ──────────────────────────────────────────
            elif msg_type in ("webrtc_offer", "webrtc_answer", "webrtc_ice_candidate"):
                if session_id:
                    await classroom_hub.broadcast_webrtc_signal(session_id, device_id, msg)

            # ── ping ───────────────────────────────────────────────────────
            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except Exception as e:
        logger.warning("Agent WS error device=%s: %s", device_id, e)
    finally:
        await classroom_hub.unregister_agent(device_id)
        # Mark device offline on disconnect
        with ClassroomSessionLocal() as db:
            d = db.get(ClassroomDevice, device_id)
            if d:
                d.current_status = "offline"
                db.commit()
        logger.info("Agent WS disconnected device=%s", device_id)


# ── REST: session-for-attempt lookup (used by React exam page → bridge) ───────

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select as sa_select

_oauth2 = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


@router.get("/classroom/agent/session-for-attempt/{attempt_id}")
async def session_for_attempt(
    attempt_id: str,
    token: Optional[str] = Depends(_oauth2),
):
    """
    Returns the active classroom session assigned to a specific exam attempt.
    Called by ExamSessionPage.jsx to discover the session_id before posting
    it to the local student-agent bridge.

    The bridge uses this session_id to connect the agent to the correct
    classroom WebSocket channel so the professor can see the student.

    Requires: valid JWT token (student, professor or admin).
    Returns: {session_id, room_name} or null data if no active session.
    """
    from app.core.security import decode_access_token

    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    with ClassroomSessionLocal() as db:
        # Find a ClassroomSessionDevice that has this attempt_id assigned and
        # belongs to a session that is currently active or pending
        stmt = (
            sa_select(ClassroomSessionDevice, ClassroomSession)
            .join(ClassroomSession, ClassroomSession.session_id == ClassroomSessionDevice.session_id)
            .where(ClassroomSessionDevice.attempt_id == attempt_id)
            .where(ClassroomSession.status.in_(["active", "pending"]))
            .order_by(ClassroomSession.created_at.desc())
            .limit(1)
        )
        row = db.execute(stmt).first()
        if row is None:
            # Fallback: try to find the session by the device's active session
            # (attempt not yet linked — return the most recent active session)
            stmt2 = (
                sa_select(ClassroomSession)
                .where(ClassroomSession.status.in_(["active", "pending"]))
                .order_by(ClassroomSession.created_at.desc())
                .limit(1)
            )
            session = db.execute(stmt2).scalar_one_or_none()
            if session is None:
                return {"ok": True, "data": None}
            return {"ok": True, "data": {"session_id": session.session_id, "room_name": session.room_name}}

        _device_assignment, session = row
        return {
            "ok": True,
            "data": {
                "session_id": session.session_id,
                "room_name":  session.room_name,
            },
        }
