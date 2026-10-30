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
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List

import websockets
from websockets.exceptions import ConnectionClosed
import httpx

from config import config
from monitor import ActivityMonitor
from screen_capture import capture_screen_jpeg
from bridge import LocalhostBridge
from offline_queue import offline_queue
import agent_lease
import clip_outbox

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
            await fetch_session_lease(session_id)
            return True
    except Exception as e:
        logger.warning("Failed to fetch policy: %s", e)
        return False


async def fetch_session_lease(session_id: str) -> bool:
    """
    Obtain and VERIFY a server-signed authorization lease.

    - Online: fetch (pin the public key on first use), verify the Ed25519 signature locally,
      cache the verified lease on disk.
    - Offline (network error): only a previously verified, unexpired cached lease is honoured.
    - Server refusal (403/404: revoked device, ended session): the lease is cleared and monitoring stops.
    Never fabricates or extends a lease locally. Returns True when a valid lease is in force.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if not agent_lease.pinned_public_key():
                kr = await client.get(_api("/classroom/agent/lease-key"))
                kr.raise_for_status()
                agent_lease.pin_public_key(kr.json()["data"]["public_key"])
            r = await client.get(
                _api("/classroom/agent/lease"),
                params={"device_id": config.device_id, "session_id": session_id},
                headers=_headers(),
            )
        if r.status_code in (401, 403, 404):
            agent_lease.clear_lease()
            config.lease_expires_at = datetime.fromtimestamp(0, tz=timezone.utc)
            logger.error("Authorization refused by server (HTTP %d) — monitoring not authorized", r.status_code)
            return False
        r.raise_for_status()
        lease = r.json()["data"]
        ok, reason = agent_lease.verify_lease(
            lease, agent_lease.pinned_public_key() or "", config.device_id, session_id
        )
        if not ok:
            logger.error("Lease verification failed: %s", reason)
            config.lease_expires_at = datetime.fromtimestamp(0, tz=timezone.utc)
            return False
        agent_lease.save_lease(lease)
        config.lease_expires_at = agent_lease.lease_expiry(lease)
        logger.info("Verified authorization lease valid until %s", config.lease_expires_at.isoformat())
        return True
    except Exception as e:
        cached = agent_lease.load_cached_lease(config.device_id, session_id)
        if cached:
            config.lease_expires_at = agent_lease.lease_expiry(cached)
            logger.warning("Server unreachable (%s) — continuing under cached verified lease until %s",
                           e, config.lease_expires_at.isoformat())
            return True
        config.lease_expires_at = datetime.fromtimestamp(0, tz=timezone.utc)
        logger.error("No valid authorization lease and server unreachable (%s) — monitoring not authorized", e)
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


async def flush_browser_events(session_id: str) -> None:
    """Drain browser navigation events collected by the bridge (from browser extension)."""
    events = bridge._state.pop("browser_events", [])
    if not events:
        return
    body = {
        "device_id":  config.device_id,
        "session_id": session_id,
        "events":     events,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                _api("/classroom/agent/events/browser"),
                json=body,
                headers=_headers(),
            )
            if r.status_code not in (200, 201):
                logger.warning("Browser event flush HTTP %d", r.status_code)
    except Exception as e:
        logger.warning("Browser event flush failed: %s", e)
        # Return events to buffer on network failure
        bridge._state.setdefault("browser_events", []).extend(events)


async def flush_event_batch(session_id: str, batch: List[dict]) -> None:
    """Send a batch of desktop events to the server; persist to disk on failure."""
    if not batch:
        return
    body = {
        "device_id":  config.device_id,
        "session_id": session_id,
        "events":     batch,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                _api("/classroom/agent/events/desktop"),
                json=body,
                headers=_headers(),
            )
            if r.status_code in (200, 201):
                return  # Server accepted — events are persisted server-side
            # 4xx = permanent rejection (malformed); do NOT re-queue
            if 400 <= r.status_code < 500:
                logger.warning("Server rejected event batch (HTTP %d) — dropping", r.status_code)
                return
    except Exception as e:
        logger.warning("Event batch upload failed (offline): %s", e)

    # Network failure or 5xx — save to offline queue for later sync
    for ev in batch:
        offline_queue.push("desktop", ev)
    logger.info("Queued %d events offline (total queued: %d)", len(batch), offline_queue.size())


async def drain_offline_queue(session_id: str) -> None:
    """Flush all queued offline events to the server after reconnection."""
    total = offline_queue.size()
    if total == 0:
        return
    logger.info("Syncing %d queued offline events…", total)
    batch_size = 50
    flushed = 0
    while True:
        events = offline_queue.peek(batch_size, exclude_type="ai_event")
        if not events:
            break
        body = {
            "device_id":  config.device_id,
            "session_id": session_id,
            "events":     [ev["payload"] for ev in events],
        }
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.post(
                    _api("/classroom/agent/events/desktop"),
                    json=body,
                    headers=_headers(),
                )
                if r.status_code in (200, 201):
                    offline_queue.acknowledge([ev["event_id"] for ev in events])
                    flushed += len(events)
                    logger.debug("Synced %d offline events", len(events))
                elif 400 <= r.status_code < 500:
                    # Permanently bad — drop
                    offline_queue.acknowledge([ev["event_id"] for ev in events])
                    logger.warning("Dropped %d malformed offline events", len(events))
                else:
                    # Server still unavailable — stop trying
                    break
        except Exception as e:
            logger.warning("Offline sync failed: %s", e)
            break
    offline_queue.drop_permanently_failed(max_attempts=10)
    logger.info("Offline sync complete — flushed %d events", flushed)


# ── WebSocket connection loop ──────────────────────────────────────────────────

async def upload_pending_clips(session_id: str) -> None:
    """Upload clips from the durable outbox. Removed only after server confirmation/permanent rejection."""
    global _clip_upload_busy
    if _clip_upload_busy:
        return
    _clip_upload_busy = True
    try:
        await _upload_pending_clips(session_id)
    finally:
        _clip_upload_busy = False


_clip_upload_busy = False


async def _upload_pending_clips(session_id: str) -> None:
    for path in clip_outbox.pending()[:3]:
        try:
            body = clip_outbox.load(path)
        except Exception:
            clip_outbox.remove(path)   # corrupt file can never succeed
            continue
        body["device_id"] = config.device_id
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                r = await client.post(_api("/classroom/agent/clips"), json=body, headers=_headers())
        except Exception as e:
            logger.warning("Clip upload deferred (offline): %s", e)
            return
        if r.status_code in (200, 201):
            clip_outbox.remove(path)
        elif 400 <= r.status_code < 500 and r.status_code not in (408, 429):
            logger.warning("Clip %s permanently rejected (HTTP %d)", path.stem, r.status_code)
            clip_outbox.remove(path)
        else:
            logger.warning("Clip upload HTTP %d - will retry", r.status_code)
            return


_AI_SEVERITY = {
    "face_absent": "high", "multiple_faces": "critical", "phone_detected": "critical",
    "sustained_head_turn": "medium", "camera_unavailable": "high",
    "focus_loss": "medium", "window_inactive": "medium",
}
_LEASE_RECHECK_SEC = 60.0


def _ai_message(ai_ev: dict, session_id: str) -> Optional[dict]:
    ev_type = ai_ev.get("event_type", "")
    if not ev_type:
        return None
    return {
        "type":            "policy_violation",
        "device_id":       config.device_id,
        "session_id":      session_id,
        "rule":            ev_type,
        "alert_type":      ev_type,
        "severity":        ai_ev.get("severity") or _AI_SEVERITY.get(ev_type, "medium"),
        "event_id":        ai_ev.get("event_id", ""),   # stable ID => server de-duplicates replays
        "attempt_id":      ai_ev.get("attempt_id", ""),
        "student_user_id": ai_ev.get("student_user_id", ""),
        "confidence":      ai_ev.get("confidence", 1.0),
        "timestamp":       ai_ev.get("client_timestamp", datetime.now(timezone.utc).isoformat()),
        "source":          "ai_proctoring",
        "metadata":        ai_ev.get("metadata", {}),
    }


async def replay_ai_events(ws, session_id: str) -> None:
    """Re-send AI events that could not be delivered earlier (survives agent restarts)."""
    while True:
        queued = offline_queue.peek(50, event_type="ai_event")
        if not queued:
            return
        for q in queued:
            msg = _ai_message(q["payload"], session_id)
            if msg is not None:
                await ws.send(json.dumps(msg))   # raises on failure -> stays queued
        offline_queue.acknowledge([q["event_id"] for q in queued])


async def run_ws_connection(session_id: str) -> None:
    """
    Maintain a persistent WebSocket connection to the server.
    Handles reconnection with exponential back-off.
    On each successful reconnect, drains the offline event queue.
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

                # Re-verify authorization with the server on every (re)connect
                await fetch_session_lease(session_id)

                # Drain offline queue immediately after reconnect
                asyncio.create_task(drain_offline_queue(session_id))
                try:
                    await replay_ai_events(ws, session_id)
                except Exception as e:
                    logger.warning("AI event replay interrupted: %s", e)

                # Start a reader task
                async def _reader():
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except Exception:
                            continue
                        msg_type = msg.get("type", "")
                        if msg_type == "command":
                            cmd_type = msg.get("command_type", "")
                            cmd_id = msg.get("command_id")
                            payload = msg.get("payload") or {}
                            logger.info("Received command: %s (id=%s)", cmd_type, cmd_id)

                            # Execute agent-level actions
                            if cmd_type in ("request_screen_refresh", "force_refresh"):
                                if config.screen_sharing_enabled:
                                    fresh_b64 = capture_screen_jpeg(max_dimension=960, quality=70)
                                    if fresh_b64:
                                        try:
                                            await ws.send(json.dumps({
                                                "type": "screen_frame",
                                                "device_id": config.device_id,
                                                "session_id": session_id,
                                                "image_b64": fresh_b64,
                                                "timestamp": datetime.now(timezone.utc).isoformat(),
                                            }))
                                        except Exception as e:
                                            logger.debug("Failed sending refreshed screen frame: %s", e)

                            elif cmd_type == "lock_workstation":
                                config.workstation_locked = True
                                logger.warning("WORKSTATION LOCKED by instructor.")

                            elif cmd_type == "unlock_workstation":
                                config.workstation_locked = False
                                logger.info("WORKSTATION UNLOCKED by instructor.")

                            elif cmd_type in ("restrict_apps", "blocked_processes"):
                                new_blocked = payload.get("blocked_processes") or payload.get("apps") or []
                                if isinstance(new_blocked, list):
                                    config.blocked_processes = list(set(config.blocked_processes + new_blocked))
                                    logger.info("Restricted applications updated: %s", config.blocked_processes)

                            # Push to localhost bridge so Electron app can show notifications/actions
                            bridge.push_command(msg)

                            # Acknowledge command execution immediately to instructor dashboard
                            if cmd_id:
                                try:
                                    await ws.send(json.dumps({
                                        "type": "command_ack",
                                        "command_id": cmd_id,
                                        "device_id": config.device_id,
                                        "session_id": session_id,
                                        "result": ("executed" if cmd_type in ("request_screen_refresh", "force_refresh", "restrict_apps", "blocked_processes") else "received"),
                                         "message": (
                                             "Fresh screen frame captured and sent" if cmd_type in ("request_screen_refresh", "force_refresh")
                                             else "Application policy updated: processes are DETECTED and reported, not terminated" if cmd_type in ("restrict_apps", "blocked_processes")
                                             else "Forwarded to the exam client (exam-interface lock, not an operating-system lock)" if cmd_type in ("lock_workstation", "unlock_workstation")
                                             else f"Command {cmd_type} delivered to the student client"
                                         ),
                                        "timestamp": datetime.now(timezone.utc).isoformat(),
                                    }))
                                    logger.info("Acknowledged command_id=%s over WebSocket", cmd_id)
                                except Exception as e:
                                    logger.warning("Failed sending command_ack: %s", e)

                        elif msg_type == "policy_update":
                            config.apply_policy(msg.get("data", {}))
                            bridge.update_policy(msg.get("data", {}))
                        elif msg_type == "session_status":
                            status = msg.get("status")
                            logger.info("Session status: %s", status)
                            if status == "ended":
                                logger.info("Session ended by instructor — stopping monitoring.")
                                _stop.set()
                                break

                reader_task = asyncio.create_task(_reader())

                # Heartbeat + event flusher loop
                last_screen = time.monotonic()
                _last_lease_check = time.monotonic()
                batch: List[dict] = []

                while not _stop.is_set():
                    # ── Lease expiry enforcement (verified lease only; no lease => not authorized) ──
                    _now_utc = datetime.now(timezone.utc)
                    _lease_exp = getattr(config, "lease_expires_at", None)
                    if _lease_exp is None or _now_utc > _lease_exp:
                        logger.warning("Authorization lease missing/expired (%s) — halting monitoring", _lease_exp)
                        _stop.set()
                        break
                    if time.monotonic() - _last_lease_check >= _LEASE_RECHECK_SEC:
                        _last_lease_check = time.monotonic()
                        asyncio.create_task(fetch_session_lease(session_id))

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

                    # Flush accumulated desktop batch to HTTP endpoint
                    if batch:
                        asyncio.create_task(flush_event_batch(session_id, batch))
                        batch = []

                    # Real-time Screen Frame + Webcam Frame streaming
                    now = time.monotonic()
                    if now - last_screen >= min(config.screen_capture_interval, 1.0):
                        last_screen = now
                        if config.screen_sharing_enabled:
                            screen_b64 = capture_screen_jpeg(max_dimension=640, quality=55)
                            if screen_b64:
                                try:
                                    await ws.send(json.dumps({
                                        "type": "screen_frame",
                                        "device_id": config.device_id,
                                        "session_id": session_id,
                                        "image_b64": screen_b64,
                                        "timestamp": datetime.now(timezone.utc).isoformat(),
                                    }))
                                except Exception as e:
                                    logger.debug("WS screen frame send failed: %s", e)

                        # Relay webcam frame from Electron/web client via bridge
                        cam_frame = bridge._state.pop("latest_webcam_frame", None)
                        if cam_frame and cam_frame.get("image_b64"):
                            try:
                                await ws.send(json.dumps({
                                    "type": "webcam_frame",
                                    "device_id": config.device_id,
                                    "session_id": session_id,
                                    "student_user_id": cam_frame.get("student_user_id"),
                                    "image_b64": cam_frame["image_b64"],
                                    "timestamp": cam_frame.get("timestamp", datetime.now(timezone.utc).isoformat()),
                                }))
                            except Exception as e:
                                logger.debug("WS webcam frame send failed: %s", e)

                        asyncio.create_task(flush_browser_events(session_id))

                        # Drain AI proctoring events from the bridge (MediaPipe/ONNX)
                        # AI events are persisted by the bridge on arrival; deliver (and replay) from the durable queue.
                        try:
                            await replay_ai_events(ws, session_id)
                        except Exception as e:
                            logger.warning("AI event delivery deferred (%s) - kept in local queue", e)

                        asyncio.create_task(upload_pending_clips(session_id))

                        # Drain external command execution results reported by Electron/bridge
                        cmd_results = bridge._state.pop("command_results", [])
                        for cr in cmd_results:
                            try:
                                await ws.send(json.dumps({
                                    "type": "command_ack",
                                    "command_id": cr.get("command_id"),
                                    "device_id": config.device_id,
                                    "session_id": session_id,
                                    "result": cr.get("result", "ok"),
                                    "message": cr.get("message", ""),
                                    "timestamp": datetime.now(timezone.utc).isoformat(),
                                }))
                            except Exception as e:
                                logger.debug("WS external command_ack send failed: %s", e)

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
    parser.add_argument("--server",      help="Server URL override (e.g. http://192.168.1.1:8000)")
    parser.add_argument("--session",     help="Classroom session ID (override)")
    parser.add_argument("--bridge-port", type=int, default=0,
                        help="Localhost bridge port (0 = use config default)")
    args = parser.parse_args()

    if args.server:
        config.server_url = args.server
        config.save()
    if args.session:
        config.session_id = args.session
        config.save()
    if args.bridge_port and args.bridge_port > 0:
        config.bridge_port = args.bridge_port

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
