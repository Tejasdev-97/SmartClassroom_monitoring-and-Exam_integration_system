"""
ExamProctor.ai — Student Agent: OS-level activity monitor.

Monitors:
  - Active window & process (Windows via win32gui/win32process, Linux via ewmh/Xlib)
  - Running process list scanned for policy violations
  - Window focus events

Runs in a dedicated thread and feeds events into a shared queue.
"""

from __future__ import annotations

import logging
import platform
import queue
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

logger = logging.getLogger("agent.monitor")

PLATFORM = platform.system().lower()  # 'windows' | 'linux' | 'darwin'


# ── Platform adapters ─────────────────────────────────────────────────────────

class _WindowsAdapter:
    """Reads active window info on Windows using pywin32."""

    def __init__(self):
        try:
            import win32gui
            import win32process
            import psutil
            self._win32gui = win32gui
            self._win32process = win32process
            self._psutil = psutil
            self.available = True
        except ImportError:
            logger.warning("pywin32/psutil not installed — window monitoring unavailable on Windows")
            self.available = False

    def get_active_window(self) -> tuple[str, str]:
        """Returns (process_name, window_title)."""
        if not self.available:
            return ("", "")
        try:
            hwnd = self._win32gui.GetForegroundWindow()
            title = self._win32gui.GetWindowText(hwnd)
            _, pid = self._win32process.GetWindowThreadProcessId(hwnd)
            proc = self._psutil.Process(pid)
            return (proc.name(), title)
        except Exception:
            return ("", "")

    def list_processes(self) -> List[str]:
        """Returns list of running process names."""
        if not self.available:
            return []
        try:
            import psutil
            return [p.name() for p in psutil.process_iter(["name"])]
        except Exception:
            return []


class _LinuxAdapter:
    """Reads active window info on Linux using ewmh + Xlib."""

    def __init__(self):
        try:
            import ewmh
            import Xlib
            self._ewmh = ewmh.EWMH()
            self.available = True
        except Exception:
            logger.warning("ewmh/Xlib not installed — window monitoring unavailable on Linux")
            self.available = False

    def get_active_window(self) -> tuple[str, str]:
        if not self.available:
            return ("", "")
        try:
            win = self._ewmh.getActiveWindow()
            if not win:
                return ("", "")
            title = self._ewmh.getWmName(win) or ""
            if isinstance(title, bytes):
                title = title.decode("utf-8", errors="replace")
            # Get PID from _NET_WM_PID
            pid = win.get_full_property(
                win.display.intern_atom("_NET_WM_PID"), 0
            )
            proc_name = ""
            if pid:
                import psutil
                try:
                    proc_name = psutil.Process(pid.value.tolist()[0]).name()
                except Exception:
                    pass
            return (proc_name, title)
        except Exception:
            return ("", "")

    def list_processes(self) -> List[str]:
        try:
            import psutil
            return [p.name() for p in psutil.process_iter(["name"])]
        except Exception:
            return []


class _FallbackAdapter:
    """No-op adapter when platform is not supported."""
    available = False

    def get_active_window(self) -> tuple[str, str]:
        return ("", "")

    def list_processes(self) -> List[str]:
        return []


def _make_adapter():
    if PLATFORM == "windows":
        return _WindowsAdapter()
    elif PLATFORM == "linux":
        return _LinuxAdapter()
    return _FallbackAdapter()


# ── Activity Monitor ──────────────────────────────────────────────────────────

class ActivityMonitor:
    """
    Background thread that continuously samples OS state and emits events.

    Events emitted (as dicts on the event_queue):
      type='window_change'    — when the active window changes
      type='heartbeat'        — periodic liveness signal
      type='prohibited_app'   — blocked process detected (from policy)
    """

    def __init__(
        self,
        event_queue: queue.Queue,
        blocked_processes: List[str],
        heartbeat_interval: float = 5.0,
        process_scan_interval: float = 3.0,
    ):
        self.event_queue = event_queue
        self.blocked_processes = [p.lower() for p in blocked_processes]
        self.heartbeat_interval = heartbeat_interval
        self.process_scan_interval = process_scan_interval

        self._adapter = _make_adapter()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self._last_process: str = ""
        self._last_title: str = ""
        self._last_heartbeat: float = 0.0
        self._last_process_scan: float = 0.0

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="ActivityMonitor")
        self._thread.start()
        logger.info("ActivityMonitor started (platform=%s)", PLATFORM)

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        logger.info("ActivityMonitor stopped")

    def update_blocked_processes(self, processes: List[str]) -> None:
        self.blocked_processes = [p.lower() for p in processes]

    def _emit(self, event: dict) -> None:
        event.setdefault("idempotency_key", str(uuid.uuid4()))
        event.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
        try:
            self.event_queue.put_nowait(event)
        except queue.Full:
            logger.warning("Event queue full — dropping event type=%s", event.get("type"))

    def _run(self) -> None:
        while not self._stop_event.is_set():
            now = time.monotonic()

            # ── Active window sampling ──────────────────────────────────────
            process_name, title = self._adapter.get_active_window()
            if process_name != self._last_process or title != self._last_title:
                self._emit({
                    "type":                 "window_change",
                    "active_process_name":  process_name,
                    "active_window_title":  title,
                    "additional_metadata":  {},
                })
                self._last_process = process_name
                self._last_title = title

            # ── Heartbeat ───────────────────────────────────────────────────
            if now - self._last_heartbeat >= self.heartbeat_interval:
                self._emit({
                    "type":                 "heartbeat",
                    "active_process_name":  process_name,
                    "active_window_title":  title,
                    "additional_metadata":  {
                        "cpu_percent": self._cpu(),
                        "ram_percent": self._ram(),
                    },
                })
                self._last_heartbeat = now

            # ── Process scan (policy enforcement) ──────────────────────────
            if now - self._last_process_scan >= self.process_scan_interval:
                procs = self._adapter.list_processes()
                for p in procs:
                    if p.lower() in self.blocked_processes:
                        self._emit({
                            "type":                 "prohibited_app",
                            "active_process_name":  p,
                            "active_window_title":  "",
                            "additional_metadata":  {"rule": "blocked_app"},
                        })
                self._last_process_scan = now

            time.sleep(0.5)

    @staticmethod
    def _cpu() -> float:
        try:
            import psutil
            return psutil.cpu_percent(interval=None)
        except Exception:
            return 0.0

    @staticmethod
    def _ram() -> float:
        try:
            import psutil
            return psutil.virtual_memory().percent
        except Exception:
            return 0.0
