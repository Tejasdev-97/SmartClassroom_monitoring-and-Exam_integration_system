"""
ExamProctor.ai — Student Agent: Localhost HTTP Bridge.

Exposes a tiny HTTP server on 127.0.0.1:41732 so the Electron exam app
can communicate with the Python agent without needing a named pipe or
IPC mechanism.

Endpoints:
  GET  /status          — returns agent status, device_id, session_id
  GET  /policy          — returns active monitoring policy
  POST /session         — Electron notifies agent of active exam session
  GET  /commands        — Electron polls for pending instructor commands
  POST /command-result  — Electron reports command execution result
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("agent.bridge")


class _BridgeHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler — no framework dependency."""

    def log_message(self, format, *args):  # noqa: A002
        logger.debug("bridge: %s", format % args)

    def _json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length:
            try:
                return json.loads(self.rfile.read(length))
            except Exception:
                return {}
        return {}

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):  # noqa: N802
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
        handlers = self.server._bridge_handlers  # type: ignore[attr-defined]
        handler = handlers.get(("POST", self.path.split("?")[0]))
        if handler:
            try:
                body = self._read_body()
                result = handler(body)
                self._json(result)
            except Exception as e:
                logger.error("Bridge POST %s error: %s", self.path, e)
                self._json({"error": str(e)}, 500)
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
                "ok":         True,
                "device_id":  self._state.get("device_id"),
                "session_id": self._state.get("session_id"),
                "started_at": self._state.get("started_at"),
                "server_time": datetime.now(timezone.utc).isoformat(),
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

        self.register("GET",  "/status",         status)
        self.register("GET",  "/policy",          get_policy)
        self.register("POST", "/session",         set_session)
        self.register("GET",  "/commands",        get_commands)
        self.register("POST", "/command-result",  command_result)

    def push_command(self, command: dict) -> None:
        """Called by the agent when a new instructor command arrives."""
        self._state.setdefault("commands", []).append(command)

    def update_policy(self, policy: dict) -> None:
        self._state["policy"] = policy

    def set_device_id(self, device_id: str) -> None:
        self._state["device_id"] = device_id

    def start(self) -> None:
        self._default_handlers()
        self._server = HTTPServer(("127.0.0.1", self.port), _BridgeHandler)
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
