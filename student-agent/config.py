"""
ExamProctor.ai — Student Agent Configuration.

Reads persisted config from agent_config.json in the agent directory.
All values can be overridden by environment variables.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import List, Optional

CONFIG_FILE = Path(__file__).parent / "agent_config.json"


def _load_saved() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


class AgentConfig:
    """Singleton-like config object, read at startup."""

    def __init__(self):
        saved = _load_saved()

        # Server connection
        self.server_url: str = os.environ.get(
            "EP_SERVER_URL",
            saved.get("server_url", "http://192.168.1.1:8000"),
        )

        # Device identity (set after successful registration)
        self.device_id: Optional[str] = os.environ.get(
            "EP_DEVICE_ID", saved.get("device_id")
        )
        self.device_secret: Optional[str] = os.environ.get(
            "EP_DEVICE_SECRET", saved.get("device_secret")
        )

        # Active session (set when instructor starts a session)
        self.session_id: Optional[str] = saved.get("session_id")

        # Monitoring intervals (seconds)
        self.heartbeat_interval: int = int(
            os.environ.get("EP_HEARTBEAT_INTERVAL", saved.get("heartbeat_interval", 5))
        )
        self.process_scan_interval: int = int(
            os.environ.get("EP_PROCESS_SCAN_INTERVAL", saved.get("process_scan_interval", 3))
        )
        self.screen_capture_interval: int = int(
            os.environ.get("EP_SCREEN_CAPTURE_INTERVAL", saved.get("screen_capture_interval", 5))
        )

        # Policy (fetched from server on session start)
        self.blocked_processes: List[str] = saved.get("blocked_processes", [])
        self.allowed_processes: List[str] = saved.get("allowed_processes", [])
        self.blocked_domains: List[str] = saved.get("blocked_domains", [])

        # Feature toggles
        self.screen_sharing_enabled: bool = saved.get("screen_sharing_enabled", True)
        self.enforce_window_focus: bool = saved.get("enforce_window_focus", True)

        # Localhost bridge (Electron ↔ Agent)
        self.bridge_port: int = int(
            os.environ.get("EP_BRIDGE_PORT", saved.get("bridge_port", 41732))
        )

    def save(self) -> None:
        """Persist mutable fields to disk."""
        data = {
            "server_url":              self.server_url,
            "device_id":               self.device_id,
            "device_secret":           self.device_secret,
            "session_id":              self.session_id,
            "heartbeat_interval":      self.heartbeat_interval,
            "process_scan_interval":   self.process_scan_interval,
            "screen_capture_interval": self.screen_capture_interval,
            "blocked_processes":       self.blocked_processes,
            "allowed_processes":       self.allowed_processes,
            "blocked_domains":         self.blocked_domains,
            "screen_sharing_enabled":  self.screen_sharing_enabled,
            "enforce_window_focus":    self.enforce_window_focus,
            "bridge_port":             self.bridge_port,
        }
        CONFIG_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def apply_policy(self, policy: dict) -> None:
        """Update monitoring parameters from a server policy response."""
        self.blocked_processes        = policy.get("blocked_process_names", self.blocked_processes)
        self.allowed_processes        = policy.get("allowed_process_names", self.allowed_processes)
        self.blocked_domains          = policy.get("blocked_domains", self.blocked_domains)
        self.heartbeat_interval       = policy.get("heartbeat_interval_sec", self.heartbeat_interval)
        self.process_scan_interval    = policy.get("process_scan_interval_sec", self.process_scan_interval)
        self.screen_capture_interval  = policy.get("screen_capture_interval_sec", self.screen_capture_interval)
        self.screen_sharing_enabled   = policy.get("screen_sharing_enabled", self.screen_sharing_enabled)
        self.enforce_window_focus     = policy.get("enforce_window_focus", self.enforce_window_focus)
        self.save()


config = AgentConfig()
