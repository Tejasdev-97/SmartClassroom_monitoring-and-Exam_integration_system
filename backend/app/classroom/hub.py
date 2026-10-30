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


# Singleton — imported by routers
classroom_hub = ClassroomWSHub()
