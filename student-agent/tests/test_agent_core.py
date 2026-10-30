"""
Student Agent core tests: signed lease verification, durable AI-event queue, clip outbox,
loopback bridge origin/size protection. No network, no real device identity.

Run:  python -m pytest student-agent/tests -q   (needs pytest + cryptography)
"""
import base64
import http.client
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent_lease  # noqa: E402
import clip_outbox  # noqa: E402
import offline_queue as oq  # noqa: E402
from bridge import LocalhostBridge  # noqa: E402


def _keys():
    priv = Ed25519PrivateKey.generate()
    pub = base64.b64encode(priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    return priv, pub


def _lease(priv, device="dev-1", session="sess-1", minutes=30):
    now = datetime.now(timezone.utc)
    payload = {"device_id": device, "session_id": session, "student_user_id": "stu-1",
               "issued_at": now.isoformat(), "expires_at": (now + timedelta(minutes=minutes)).isoformat()}
    sig = base64.b64encode(priv.sign(agent_lease.canonical(payload))).decode()
    return {"payload": payload, "signature": sig}


# ── lease ────────────────────────────────────────────────────────────────────

def test_valid_lease_verifies():
    priv, pub = _keys()
    assert agent_lease.verify_lease(_lease(priv), pub, "dev-1", "sess-1") == (True, "ok")


def test_expired_lease_rejected():
    priv, pub = _keys()
    ok, reason = agent_lease.verify_lease(_lease(priv, minutes=-1), pub, "dev-1", "sess-1")
    assert (ok, reason) == (False, "expired")


def test_editing_expiry_invalidates_signature():
    priv, pub = _keys()
    lease = _lease(priv, minutes=1)
    lease["payload"]["expires_at"] = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    assert agent_lease.verify_lease(lease, pub, "dev-1", "sess-1") == (False, "bad_signature")


def test_wrong_device_session_or_key_rejected():
    priv, pub = _keys()
    lease = _lease(priv)
    assert agent_lease.verify_lease(lease, pub, "other", "sess-1")[1] == "device_mismatch"
    assert agent_lease.verify_lease(lease, pub, "dev-1", "other")[1] == "session_mismatch"
    _, other_pub = _keys()
    assert agent_lease.verify_lease(lease, other_pub, "dev-1", "sess-1")[1] == "bad_signature"


def test_cached_lease_is_reverified_after_restart(tmp_path, monkeypatch):
    priv, pub = _keys()
    monkeypatch.setattr(agent_lease, "LEASE_FILE", tmp_path / "lease.json")
    monkeypatch.setattr(agent_lease, "PUBKEY_FILE", tmp_path / "pub.txt")
    monkeypatch.delenv("EXAMPROCTOR_LEASE_PUBKEY", raising=False)
    agent_lease.pin_public_key(pub)
    agent_lease.save_lease(_lease(priv))
    assert agent_lease.load_cached_lease("dev-1", "sess-1") is not None
    # tamper with the file on disk
    data = json.loads((tmp_path / "lease.json").read_text())
    data["payload"]["expires_at"] = (datetime.now(timezone.utc) + timedelta(days=9)).isoformat()
    (tmp_path / "lease.json").write_text(json.dumps(data))
    assert agent_lease.load_cached_lease("dev-1", "sess-1") is None


# ── offline queue: durable AI events across restart, kinds kept apart ─────────

def test_ai_events_survive_restart_and_are_kept_separate(tmp_path):
    db = tmp_path / "q.db"
    q1 = oq.OfflineQueue(db)
    q1.push("ai_event", {"event_id": "e-1", "event_type": "phone_detected"})
    q1.push("desktop", {"type": "heartbeat"})
    q2 = oq.OfflineQueue(db)  # simulated agent restart
    ai = q2.peek(10, event_type="ai_event")
    assert [e["payload"]["event_id"] for e in ai] == ["e-1"]
    assert all(e["event_type"] != "ai_event" for e in q2.peek(10, exclude_type="ai_event"))
    q2.acknowledge([e["event_id"] for e in ai])
    assert q2.peek(10, event_type="ai_event") == []


# ── clip outbox ──────────────────────────────────────────────────────────────

def _clip(**over):
    c = {"clip_id": "11111111-2222-3333-4444-555555555555", "session_id": "s", "source": "webcam",
         "started_at": "2026-01-01T00:00:00Z", "ended_at": "2026-01-01T00:00:08Z", "data_b64": "AAAA"}
    c.update(over)
    return c


def test_clip_outbox_is_durable_idempotent_and_validated(tmp_path, monkeypatch):
    monkeypatch.setattr(clip_outbox, "OUTBOX_DIR", tmp_path / "box")
    assert clip_outbox.enqueue(_clip()) == "queued"
    assert clip_outbox.enqueue(_clip()) == "duplicate"
    assert len(clip_outbox.pending()) == 1
    for bad in (_clip(source="mic"), _clip(clip_id="../x"), _clip(data_b64=""), _clip(mime_type="text/html")):
        with pytest.raises(ValueError):
            clip_outbox.enqueue(bad)


def test_clip_outbox_quota(tmp_path, monkeypatch):
    monkeypatch.setattr(clip_outbox, "OUTBOX_DIR", tmp_path / "box")
    monkeypatch.setattr(clip_outbox, "MAX_OUTBOX_BYTES", 50)
    with pytest.raises(ValueError):
        clip_outbox.enqueue(_clip())


# ── bridge ───────────────────────────────────────────────────────────────────

@pytest.fixture()
def bridge(tmp_path, monkeypatch):
    monkeypatch.setattr(oq, "offline_queue", oq.OfflineQueue(tmp_path / "bridge.db"))
    monkeypatch.setattr(clip_outbox, "OUTBOX_DIR", tmp_path / "box")
    b = LocalhostBridge(port=0)
    b.start()
    port = b._server.server_address[1]
    assert b._server.server_address[0] == "127.0.0.1"  # loopback only, never 0.0.0.0
    yield b, port
    b.stop()


def _req(port, method, path, body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = {"Content-Type": "application/json", **(headers or {})}
    c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = c.getresponse()
    data = r.read()
    return r.status, (json.loads(data) if data else {}), r


def test_bridge_rejects_unknown_web_origin_and_never_leaks_token(bridge):
    b, port = bridge
    status, _, _ = _req(port, "GET", "/health", headers={"Origin": "https://evil.example"})
    assert status == 403
    status, body, resp = _req(port, "GET", "/health", headers={"Origin": "http://localhost:5173"})
    assert status == 200 and body.get("session_token") is None
    assert resp.getheader("Access-Control-Allow-Origin") == "http://localhost:5173"


def test_bridge_ai_events_are_deduplicated_and_persisted(bridge):
    b, port = bridge
    ev = {"events": [{"event_type": "phone_detected", "event_id": "ev-123", "attempt_id": "a1",
                      "confidence": 0.9, "client_timestamp": "2026-01-01T00:00:00Z"}]}
    assert _req(port, "POST", "/ai-events", ev)[1]["queued"] == 1
    assert _req(port, "POST", "/ai-events", ev)[1]["queued"] == 0   # duplicate request
    queued = oq.offline_queue.peek(10, event_type="ai_event")
    assert len(queued) == 1 and queued[0]["payload"]["confidence"] == 0.9


def test_bridge_rejects_unknown_event_types_and_oversized_body(bridge):
    b, port = bridge
    assert _req(port, "POST", "/ai-events", {"events": [{"event_type": "rm_rf", "event_id": "x"}]})[1]["queued"] == 0
    big = {"events": [], "pad": "x" * (3 * 1024 * 1024)}
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request("POST", "/ai-events", body=json.dumps(big), headers={"Content-Type": "application/json"})
    # On Windows the server may close the socket before the client finishes
    # sending, raising ConnectionAbortedError instead of returning 413.
    # Both outcomes prove the oversized payload was rejected.
    try:
        resp = c.getresponse()
        assert resp.status == 413, f"Expected 413, got {resp.status}"
    except (ConnectionAbortedError, ConnectionResetError):
        pass  # server forcefully rejected the body — valid on Windows


def test_bridge_clip_identity_comes_from_agent_not_caller(bridge):
    b, port = bridge
    b.set_device_id("real-device")
    st, body, _ = _req(port, "POST", "/clips", _clip(device_id="spoofed"))
    assert body == {"ok": True, "status": "queued"}
    stored = clip_outbox.load(clip_outbox.pending()[0])
    assert stored["device_id"] == "real-device"
