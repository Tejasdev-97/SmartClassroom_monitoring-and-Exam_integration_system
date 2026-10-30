"""
ExamProctor.ai — Student Agent: Localhost HTTP Bridge.

Exposes a tiny HTTP server on 127.0.0.1:41732 so the Electron exam app
can communicate with the Python agent without needing a named pipe or
IPC mechanism.

Endpoints:
  GET  /status          — returns agent status, device_id, session_id
  GET  /health          — alias for /status (compatibility)
  GET  /policy          — returns active monitoring policy
  POST /session         — Electron notifies agent of active exam session
  GET  /commands        — Electron polls for pending instructor commands
  POST /command-result  — Electron reports command execution result
  POST /browser-events  — Browser extension posts navigation events
  POST /webcam-frame    — Electron/web posts webcam thumbnail (base64)
  POST /ai-events       — React proctoring hook posts MediaPipe/ONNX alerts
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("agent.bridge")

_MAX_BODY_BYTES = 2 * 1024 * 1024   # largest legitimate payload is a base64 webcam thumbnail / clip chunk


def _origin_ok(origin: str) -> bool:
    """Allow the exam web app, the Electron shell and the browser extension only.
    Extra origins (e.g. the deployed Vercel URL) come from BRIDGE_ALLOWED_ORIGINS (comma separated)."""
    if origin.startswith(("chrome-extension://", "app://", "file://")) or origin == "null":
        return True
    extra = {o.strip().rstrip("/") for o in os.environ.get("BRIDGE_ALLOWED_ORIGINS", "").split(",") if o.strip()}
    defaults = {"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"}
    return origin.rstrip("/") in (extra | defaults)


class _BridgeHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler — no framework dependency."""

    def log_message(self, format, *args):  # noqa: A002
        logger.debug("bridge: %s", format % args)

    def _json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return {}
        from clip_outbox import MAX_CLIP_BODY_BYTES
        limit = MAX_CLIP_BODY_BYTES if self.path.split("?")[0] == "/clips" else _MAX_BODY_BYTES
        if length > limit:
            raise ValueError("payload too large")
        if length:
            try:
                return json.loads(self.rfile.read(length))
            except Exception:
                return {}
        return {}

    def _origin_allowed(self) -> bool:
        """Browsers always send Origin on cross-site requests; reject unknown web origins.
        Requests without an Origin header (Electron main process, agent tooling) are allowed."""
        origin = self.headers.get("Origin")
        return origin is None or _origin_ok(origin)

    def _cors_origin(self) -> str:
        origin = self.headers.get("Origin")
        return origin if origin and _origin_ok(origin) else "null"

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if not self._origin_allowed():
            self._json({"error": "Origin not allowed"}, 403)
            return
        handlers = self.server._bridge_handlers  # type: ignore[attr-defined]
        handler = handlers.get(("GET", self.path.split("?")[0]))
        if handler:
            try:
                result = handler()
                self._json(result)
            except Exception as e:
                logger.error("Bridge GET %s error: %s", self.path, e)
                self._json({"error": str(e)}, 500)
        else:
            self._json({"error": "Not found"}, 404)

    def do_POST(self):  # noqa: N802
        if not self._origin_allowed():
            self._json({"error": "Origin not allowed"}, 403)
            return
        handlers = self.server._bridge_handlers  # type: ignore[attr-defined]
        handler = handlers.get(("POST", self.path.split("?")[0]))
        if handler:
            try:
                body = self._read_body()
                result = handler(body)
                self._json(result)
            except ValueError as e:
                self._json({"error": str(e)}, 413)
            except Exception as e:
                logger.error("Bridge POST %s error: %s", self.path, e)
                self._json({"error": "internal error"}, 500)
        else:
            self._json({"error": "Not found"}, 404)


class LocalhostBridge:
    """
    Lightweight HTTP bridge between the Electron app and the Python agent.
    Runs in a daemon thread so it doesn't block the main event loop.
    """

    def __init__(self, port: int = 41732):
        self.port = port
        self._server: Optional[HTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._handlers: Dict[tuple, Callable] = {}
        self._lock = threading.Lock()
        self._seen_event_ids: set = set()
        self._state: Dict[str, Any] = {
            "device_id":  None,
            "session_id": None,
            "policy":     {},
            "commands":   [],
            "started_at": datetime.now(timezone.utc).isoformat(),
        }

    def register(self, method: str, path: str, handler: Callable) -> None:
        """Register a handler for (method, path)."""
        self._handlers[(method.upper(), path)] = handler

    def _default_handlers(self) -> None:
        """Register the built-in bridge endpoints."""

        def status():
            return {
                "ok":            True,
                "device_id":     self._state.get("device_id"),
                "session_id":    self._state.get("session_id"),
                "session_token": None,  # never exposed over the bridge
                "bridge_port":   self.port,
                "started_at":    self._state.get("started_at"),
                "server_time":   datetime.now(timezone.utc).isoformat(),
            }

        def get_policy():
            return self._state.get("policy", {})

        def set_session(body: dict):
            self._state["session_id"] = body.get("session_id")
            self._state["attempt_id"] = body.get("attempt_id")
            return {"ok": True, "session_id": self._state["session_id"]}

        def get_commands():
            cmds = list(self._state.get("commands", []))
            self._state["commands"] = []  # consume
            return {"commands": cmds}

        def command_result(body: dict):
            # Store result for the agent's WS uplink to forward
            self._state.setdefault("command_results", []).append(body)
            return {"ok": True}

        def browser_events(body: dict):
            """
            Accept navigation events from the browser extension.
            Fields: session_id, device_id, events: [{domain, title, client_timestamp, idempotency_key}]
            Only domain + page title (truncated) are stored — no URL path, no keystrokes.
            """
            events = body.get("events", [])
            self._state.setdefault("browser_events", []).extend(events[-100:])  # cap at 100
            return {"ok": True, "queued": len(events)}

        def webcam_frame(body: dict):
            """Accept webcam thumbnail frame from Electron or web client."""
            self._state["latest_webcam_frame"] = body
            return {"ok": True}

        def ai_events(body: dict):
            """
            Accept AI proctoring events from the React MediaPipe/ONNX pipeline.
            Fields:
              events: List of dicts each containing:
                event_type: str  (face_absent, multiple_faces, phone_detected,
                                  sustained_head_turn, camera_unavailable,
                                  focus_loss, exam_submitted)
                severity:   str  (low | medium | high | critical)
                event_id:   str  (stable UUID for deduplication)
                attempt_id: str
                student_user_id: str (optional)
                client_timestamp: str (ISO-8601)
                confidence:  float (0-1, optional)
                metadata:    dict (optional)

            These are queued in _state['ai_events'] for the WS uplink thread
            to drain into the classroom hub as alert messages.
            Only the most recent 200 events are kept in memory.
            """
            events = body if isinstance(body, list) else body.get("events", [])
            if isinstance(events, list):
                valid_types = {
                    "face_absent", "multiple_faces", "phone_detected",
                    "sustained_head_turn", "camera_unavailable",
                    "focus_loss", "window_inactive", "exam_submitted",
                }
                safe = []
                for ev in events:
                    if not isinstance(ev, dict):
                        continue
                    ev_type = str(ev.get("event_type", ""))
                    if ev_type not in valid_types:
                        continue
                    safe.append({
                        "event_type": ev_type,
                        "severity": str(ev.get("severity", "medium")),
                        "event_id": str(ev.get("event_id", "")),
                        "attempt_id": str(ev.get("attempt_id", "")),
                        "student_user_id": str(ev.get("student_user_id", "")),
                        "client_timestamp": str(ev.get("client_timestamp", "")),
                        "confidence": float(ev.get("confidence", 1.0)),
                        "metadata": ev.get("metadata", {}),
                    })
                from offline_queue import offline_queue
                accepted = 0
                with self._lock:
                    for ev in safe:
                        if not ev["event_id"] or ev["event_id"] in self._seen_event_ids:
                            continue                       # duplicate request / retry
                        self._seen_event_ids.add(ev["event_id"])
                        offline_queue.push("ai_event", ev)  # durable: survives disconnects and restarts
                        accepted += 1
                    if len(self._seen_event_ids) > 5000:
                        self._seen_event_ids.clear()
                return {"ok": True, "queued": accepted}
            return {"ok": True, "queued": 0}

        self.register("GET",  "/status",          status)
        self.register("GET",  "/health",          status)   # alias for compatibility
        self.register("GET",  "/policy",           get_policy)
        self.register("POST", "/session",          set_session)
        self.register("GET",  "/commands",         get_commands)
        self.register("POST", "/command-result",   command_result)
        self.register("POST", "/browser-events",   browser_events)
        self.register("POST", "/webcam-frame",     webcam_frame)
        self.register("POST", "/ai-events",        ai_events)

        def clips(body: dict):
            """Accept a finalized warning clip from the exam client; persisted durably for upload."""
            import clip_outbox
            body = dict(body)
            body["device_id"] = self._state.get("device_id")  # identity is the agent's, never the caller's
            body.setdefault("session_id", self._state.get("session_id"))
            try:
                status = clip_outbox.enqueue(body)
            except ValueError as e:
                return {"ok": False, "error": str(e)}
            return {"ok": True, "status": status}

        self.register("POST", "/clips",            clips)

    def push_command(self, command: dict) -> None:
        """Called by the agent when a new instructor command arrives."""
        self._state.setdefault("commands", []).append(command)

    def update_policy(self, policy: dict) -> None:
        self._state["policy"] = policy

    def set_device_id(self, device_id: str) -> None:
        self._state["device_id"] = device_id

    def start(self) -> None:
        self._default_handlers()
        try:
            self._server = HTTPServer(("127.0.0.1", self.port), _BridgeHandler)
        except OSError as exc:
            logger.error(
                "Cannot bind bridge on 127.0.0.1:%d — %s. "
                "Pass --bridge-port <free_port> to resolve.", self.port, exc
            )
            raise
        self._server._bridge_handlers = self._handlers  # type: ignore[attr-defined]
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            daemon=True,
            name="LocalhostBridge",
        )
        self._thread.start()
        logger.info("Localhost bridge listening on 127.0.0.1:%d", self.port)

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
        logger.info("Localhost bridge stopped")
