"""
ExamProctor.ai — Student Agent: Main Entry Point.

Orchestrates:
  1. Self-registration with the classroom server
  2. Policy fetch (once enrolled and approved)
  3. Activity monitoring loop (processes + windows)
  4. WebSocket connection to the classroom server for bidirectional comms
  5. Localhost HTTP bridge (for Electron ↔ Agent IPC)
  6. Periodic screen thumbnail upload
  7. Graceful reconnection with exponential back-off

Run with: python agent.py [--server http://192.168.1.1:8000]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import queue
import signal
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List

import websockets
from websockets.exceptions import ConnectionClosed
import httpx

from config import config
from monitor import ActivityMonitor
from screen_capture import capture_screen_jpeg
from bridge import LocalhostBridge

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(Path(__file__).parent / "agent.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("agent")

# ── Global state ──────────────────────────────────────────────────────────────
event_queue: queue.Queue = queue.Queue(maxsize=500)
bridge = LocalhostBridge(port=config.bridge_port)
_stop = asyncio.Event()


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _headers() -> dict:
    return {
        "X-Device-Secret": config.device_secret or "",
        "Content-Type":    "application/json",
    }


def _api(path: str) -> str:
    base = config.server_url.rstrip("/")
    return f"{base}/api/v1{path}"


async def register() -> bool:
    """
    Self-register this machine with the classroom server.
    Saves device_id + device_secret to config file on success.
    Returns True if already registered (device_id set) or new registration succeeded.
    """
    import platform
    import socket

    if config.device_id and config.device_secret:
        logger.info("Already registered: device_id=%s", config.device_id)
        return True

    body = {
        "hostname":      socket.gethostname(),
        "os_type":       platform.system().lower(),
        "os_version":    platform.version(),
        "agent_version": "1.0.0",
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(_api("/classroom/devices/register"), json=body)
            r.raise_for_status()
            data = r.json()["data"]
            config.device_id = data["device_id"]
            config.device_secret = data["device_secret"]
            config.save()
            logger.info(
                "Registered as device_id=%s — ask the instructor to approve this device.",
                config.device_id,
            )
            return True
    except Exception as e:
        logger.error("Registration failed: %s", e)
        return False


async def fetch_policy(session_id: str) -> bool:
    """Fetch effective monitoring policy for the given session."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                _api(f"/classroom/sessions/{session_id}/policy"),
                headers=_headers(),
            )
            r.raise_for_status()
            policy = r.json()["data"]
            config.apply_policy(policy)
            bridge.update_policy(policy)
            logger.info("Policy loaded: %s", policy.get("name", "unknown"))
            return True
    except Exception as e:
        logger.warning("Failed to fetch policy: %s", e)
        return False


async def upload_screen_frame(session_id: str) -> None:
    """Capture and upload a screen thumbnail."""
    if not config.screen_sharing_enabled:
        return
    image_b64 = capture_screen_jpeg(max_dimension=960, quality=60)
    if not image_b64:
        return
    frame_id = str(uuid.uuid4())
    body = {
        "device_id":  config.device_id,
        "session_id": session_id,
        "frame_id":   frame_id,
        "image_b64":  image_b64,
        "timestamp":  datetime.now(timezone.utc).isoformat(),
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(_api("/classroom/agent/screen-frame"), json=body, headers=_headers())
    except Exception as e:
        logger.warning("Screen frame upload failed: %s", e)


async def flush_event_batch(session_id: str, batch: List[dict]) -> None:
    """Send a batch of desktop events to the server."""
    if not batch:
        return
    body = {
        "device_id":  config.device_id,
        "session_id": session_id,
        "events":     batch,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                _api("/classroom/agent/events/desktop"),
                json=body,
                headers=_headers(),
            )
    except Exception as e:
        logger.warning("Event batch upload failed: %s", e)


# ── WebSocket connection loop ──────────────────────────────────────────────────

async def run_ws_connection(session_id: str) -> None:
    """
    Maintain a persistent WebSocket connection to the server.
    Handles reconnection with exponential back-off.
    """
    ws_url = (
        config.server_url
        .replace("http://", "ws://")
        .replace("https://", "wss://")
        .rstrip("/")
        + f"/classroom/agent/ws/{config.device_id}"
        f"?secret={config.device_secret}&session_id={session_id}"
    )

    back_off = 1.0
    max_back_off = 60.0

    while not _stop.is_set():
        try:
            async with websockets.connect(ws_url, ping_interval=20) as ws:
                logger.info("WebSocket connected to server")
                back_off = 1.0   # Reset on success

                # Start a reader task
                async def _reader():
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except Exception:
                            continue
                        msg_type = msg.get("type", "")
                        if msg_type == "command":
                            bridge.push_command(msg)
                            logger.info("Received command: %s", msg.get("command_type"))
                        elif msg_type == "policy_update":
                            config.apply_policy(msg.get("data", {}))
                            bridge.update_policy(msg.get("data", {}))
                        elif msg_type == "session_status":
                            logger.info("Session status: %s", msg.get("status"))

                reader_task = asyncio.create_task(_reader())

                # Heartbeat + event flusher loop
                last_screen = time.monotonic()
                batch: List[dict] = []

                while not _stop.is_set():
                    # Drain the OS event queue (non-blocking)
                    while True:
                        try:
                            ev = event_queue.get_nowait()
                        except queue.Empty:
                            break
                        ev["idempotency_key"] = ev.get("idempotency_key", str(uuid.uuid4()))
                        ev["client_timestamp"] = ev.get("timestamp", datetime.now(timezone.utc).isoformat())

                        # Send window_change / prohibited_app immediately via WS
                        if ev["type"] in ("prohibited_app",):
                            await ws.send(json.dumps({
                                "type":         "policy_violation",
                                "device_id":    config.device_id,
                                "session_id":   session_id,
                                "rule":         "blocked_app",
                                "process_name": ev.get("active_process_name", ""),
                                "window_title": ev.get("active_window_title", ""),
                                "idempotency_key": ev["idempotency_key"],
                                "timestamp":    ev["client_timestamp"],
                            }))
                        elif ev["type"] == "heartbeat":
                            await ws.send(json.dumps({
                                "type":                 "heartbeat",
                                "device_id":            config.device_id,
                                "session_id":           session_id,
                                "active_process_name":  ev.get("active_process_name", ""),
                                "active_window_title":  ev.get("active_window_title", ""),
                                "cpu_percent":          ev.get("additional_metadata", {}).get("cpu_percent"),
                                "ram_percent":          ev.get("additional_metadata", {}).get("ram_percent"),
                                "timestamp":            ev["client_timestamp"],
                            }))
                        elif ev["type"] == "window_change":
                            await ws.send(json.dumps({
                                "type":        "window_change",
                                "device_id":   config.device_id,
                                "session_id":  session_id,
                                "process_name": ev.get("active_process_name", ""),
                                "window_title": ev.get("active_window_title", ""),
                                "idempotency_key": ev["idempotency_key"],
                                "timestamp":   ev["client_timestamp"],
                            }))

                        # Accumulate all events for HTTP batch upload (idempotent store)
                        batch.append(ev)

                    # Flush accumulated batch to HTTP endpoint
                    if batch:
                        asyncio.create_task(flush_event_batch(session_id, batch))
                        batch = []

                    # Screen frame upload
                    now = time.monotonic()
                    if now - last_screen >= config.screen_capture_interval:
                        asyncio.create_task(upload_screen_frame(session_id))
                        last_screen = now

                    await asyncio.sleep(0.5)

                reader_task.cancel()

        except ConnectionClosed as e:
            logger.warning("WS disconnected: %s — reconnecting in %.1fs", e, back_off)
        except Exception as e:
            logger.error("WS error: %s — reconnecting in %.1fs", e, back_off)

        if _stop.is_set():
            break
        await asyncio.sleep(back_off)
        back_off = min(back_off * 2, max_back_off)


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    parser = argparse.ArgumentParser(description="ExamProctor.ai Student Agent")
    parser.add_argument("--server", help="Server URL override (e.g. http://192.168.1.1:8000)")
    parser.add_argument("--session", help="Classroom session ID (override)")
    args = parser.parse_args()

    if args.server:
        config.server_url = args.server
        config.save()
    if args.session:
        config.session_id = args.session
        config.save()

    # Start localhost bridge (Electron ↔ Agent IPC)
    bridge.set_device_id(config.device_id or "pending")
    bridge.start()

    # Handle Ctrl-C / SIGTERM
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _stop.set)
        except NotImplementedError:
            pass  # Windows

    # ── Registration ──────────────────────────────────────────────────────────
    if not await register():
        logger.critical("Could not register with server. Exiting.")
        return

    bridge.set_device_id(config.device_id)
    logger.info("Waiting for instructor approval…")

    # Poll until approved
    while not _stop.is_set():
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.put(
                    _api(f"/classroom/devices/{config.device_id}/heartbeat"),
                    headers=_headers(),
                )
                if r.status_code == 200:
                    logger.info("Device approved! Starting monitoring.")
                    break
                elif r.status_code in (403, 404):
                    logger.info("Still pending approval…")
        except Exception as e:
            logger.warning("Heartbeat check failed: %s", e)
        await asyncio.sleep(10)

    if _stop.is_set():
        return

    # ── Wait for a session assignment ─────────────────────────────────────────
    session_id = config.session_id
    if not session_id:
        logger.info("Waiting for a classroom session to be assigned…")
        while not _stop.is_set():
            # Electron app may set session_id via the bridge
            if bridge._state.get("session_id"):
                session_id = bridge._state["session_id"]
                config.session_id = session_id
                config.save()
                break
            await asyncio.sleep(5)

    if _stop.is_set() or not session_id:
        return

    logger.info("Session assigned: %s", session_id)

    # Fetch monitoring policy
    await fetch_policy(session_id)

    # ── Start OS monitor ──────────────────────────────────────────────────────
    monitor = ActivityMonitor(
        event_queue=event_queue,
        blocked_processes=config.blocked_processes,
        heartbeat_interval=config.heartbeat_interval,
        process_scan_interval=config.process_scan_interval,
    )
    monitor.start()

    try:
        await run_ws_connection(session_id)
    finally:
        monitor.stop()
        bridge.stop()
        logger.info("Agent shutdown complete.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
