"""
ExamProctor.ai — Classroom Monitoring: Real-time WebSocket hub.

Manages subscriptions from the instructor dashboard and pushes
live updates (grid refresh, alert, command-ack) to all connected
professor browsers for a given session.

Usage:
  - On agent heartbeat / event: call `await hub.broadcast_to_session(session_id, payload)`
  - On new alert: call `await hub.broadcast_alert(session_id, alert_dict)`
  - Dashboard connects to `GET /classroom/ws/{session_id}` (see api/ws.py)
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Dict, List, Any, Optional

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("classroom.ws_hub")


class ClassroomWSHub:
    """Thread-safe WebSocket connection manager for classroom sessions."""

    def __init__(self):
        # session_id → list of connected WebSocket instances (professor browsers)
        self._sessions: Dict[str, List[WebSocket]] = defaultdict(list)
        # device_id → active WebSocket instance for student agent
        self._agents: Dict[str, WebSocket] = {}
        self._lock = asyncio.Lock()

    async def connect(self, session_id: str, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._sessions[session_id].append(ws)
        logger.info("WS connected session=%s total=%d", session_id, len(self._sessions[session_id]))

    async def disconnect(self, session_id: str, ws: WebSocket) -> None:
        async with self._lock:
            try:
                self._sessions[session_id].remove(ws)
            except ValueError:
                pass
            if not self._sessions[session_id]:
                del self._sessions[session_id]

    async def register_agent(self, device_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._agents[device_id] = ws
        logger.info("Agent registered in hub: device=%s total_agents=%d", device_id, len(self._agents))

    async def unregister_agent(self, device_id: str) -> None:
        async with self._lock:
            self._agents.pop(device_id, None)
        logger.info("Agent unregistered from hub: device=%s", device_id)

    async def send_command_to_device(self, device_id: str, command: dict) -> bool:
        """Deliver command directly to student agent over its active WebSocket."""
        async with self._lock:
            ws = self._agents.get(device_id)
        if not ws:
            return False
        try:
            msg = {"type": "command", **command}
            await ws.send_text(json.dumps(msg, default=str))
            logger.info("Command sent directly to agent over WS: device=%s command_id=%s", device_id, command.get("command_id"))
            return True
        except Exception as e:
            logger.warning("Failed to send command to agent %s over WS: %s", device_id, e)
            return False

    async def disconnect_agent(self, device_id: str, reason: str = "Device revoked") -> None:
        """Immediately disconnect an active agent WebSocket (e.g. on revocation)."""
        async with self._lock:
            ws = self._agents.pop(device_id, None)
        if ws:
            try:
                await ws.close(code=4004, reason=reason)
                logger.info("Agent %s WebSocket forcefully disconnected: %s", device_id, reason)
            except Exception:
                pass

    async def broadcast_to_session(
        self, session_id: str, payload: dict
    ) -> None:
        """Push a JSON message to all instructor dashboards watching this session."""
        async with self._lock:
            subscribers = list(self._sessions.get(session_id, []))

        if not subscribers:
            return

        text = json.dumps(payload, default=str)
        dead: List[WebSocket] = []

        for ws in subscribers:
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)

        if dead:
            async with self._lock:
                for ws in dead:
                    try:
                        self._sessions[session_id].remove(ws)
                    except ValueError:
                        pass

    async def broadcast_alert(self, session_id: str, alert: dict) -> None:
        await self.broadcast_to_session(
            session_id, {"type": "alert", "data": alert}
        )

    async def broadcast_grid_update(self, session_id: str, cards: list) -> None:
        await self.broadcast_to_session(
            session_id, {"type": "grid_update", "data": cards}
        )

    async def broadcast_command_ack(self, session_id: str, ack: dict) -> None:
        await self.broadcast_to_session(
            session_id, {"type": "command_ack", "data": ack}
        )

    def set_latest_screen_frame(self, device_id: str, image_b64: str, timestamp: str) -> None:
        if not hasattr(self, "_screen_frames"):
            self._screen_frames: Dict[str, dict] = {}
        self._screen_frames[device_id] = {
            "image_b64": image_b64,
            "timestamp": timestamp,
        }

    def get_latest_screen_frame(self, device_id: str) -> Optional[dict]:
        if not hasattr(self, "_screen_frames"):
            return None
        return self._screen_frames.get(device_id)

    async def broadcast_screen_frame(
        self, session_id: str, device_id: str, image_b64: str, timestamp: str
    ) -> None:
        self.set_latest_screen_frame(device_id, image_b64, timestamp)
        await self.broadcast_to_session(
            session_id,
            {
                "type": "screen_frame",
                "device_id": device_id,
                "image_b64": image_b64,
                "timestamp": timestamp,
            },
        )

    def set_latest_webcam_frame(
        self, device_id: str, image_b64: str, timestamp: str, student_user_id: Optional[str] = None
    ) -> None:
        if not hasattr(self, "_webcam_frames"):
            self._webcam_frames: Dict[str, dict] = {}
        self._webcam_frames[device_id] = {
            "image_b64": image_b64,
            "timestamp": timestamp,
            "student_user_id": student_user_id,
        }

    def get_latest_webcam_frame(self, device_id: str) -> Optional[dict]:
        if not hasattr(self, "_webcam_frames"):
            return None
        return self._webcam_frames.get(device_id)

    async def broadcast_webrtc_signal(self, session_id: str, from_device_id: str, signal: dict) -> None:
        """Relay WebRTC signaling message from student device to professor dashboard."""
        await self.broadcast_to_session(
            session_id,
            {
                "type": "webrtc_signal",
                "from_device_id": from_device_id,
                "signal": signal,
            },
        )

    async def send_webrtc_signal_to_device(self, device_id: str, signal: dict) -> bool:
        """Deliver WebRTC signaling message to student agent / client over its active WebSocket."""
        async with self._lock:
            ws = self._agents.get(device_id)
        if not ws:
            return False
        try:
            msg = {"type": "webrtc_signal", **signal}
            await ws.send_text(json.dumps(msg, default=str))
            return True
        except Exception as e:
            logger.warning("Failed to relay WebRTC signal to device %s: %s", device_id, e)
            return False


# Singleton — imported by routers
classroom_hub = ClassroomWSHub()


