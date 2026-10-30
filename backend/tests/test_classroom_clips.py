"""
Tests for warning video clip evidence, WebRTC ICE config, signaling relay and storage safety.
Uses an in-memory SQLite DB and a temp directory; no network.
"""
import asyncio
import base64
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.classroom.db import ClassroomBase
from app.classroom import models  # noqa: F401  (registers tables)
from app.classroom.api import clips as clips_api
from app.classroom.services import clip_storage
from app.classroom.hub import ClassroomWSHub
from app.core.errors import BadRequestError, ForbiddenError


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("CLIP_STORAGE_BACKEND", "local")
    monkeypatch.setenv("CLIP_LOCAL_DIR", str(tmp_path / "clips"))
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    ClassroomBase.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _request(body: dict):
    req = MagicMock()
    req.body = AsyncMock(return_value=json.dumps(body).encode())
    return req


def _body(**over):
    data = b"\x1a\x45\xdf\xa3webm-bytes"
    b = {
        "device_id": "dev-1", "clip_id": "11111111-2222-3333-4444-555555555555",
        "session_id": "sess-1", "source": "screen", "event_ids": ["e1", "e2"],
        "started_at": "2026-01-01T10:00:00Z", "ended_at": "2026-01-01T10:00:09Z",
        "mime_type": "video/webm", "data_b64": base64.b64encode(data).decode(),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    b.update(over)
    return b


@pytest.fixture()
def authed(monkeypatch):
    monkeypatch.setattr(clips_api, "_get_authed_device",
                        lambda request, device_id, db: SimpleNamespace(device_id=device_id))


def run(coro):
    return asyncio.run(coro)


def test_upload_is_idempotent_and_keeps_merged_event_ids(db, authed):
    r1 = run(clips_api.upload_clip(_request(_body()), db))["data"]
    r2 = run(clips_api.upload_clip(_request(_body()), db))["data"]
    assert r1["status"] == "uploaded" and r1["duplicate"] is False
    assert r2["duplicate"] is True
    assert r1["event_ids"] == ["e1", "e2"]  # merged warnings keep every event reference
    assert db.query(models.VideoEvidenceClip).count() == 1


def test_upload_rejects_bad_checksum_source_and_mime(db, authed):
    with pytest.raises(BadRequestError):
        run(clips_api.upload_clip(_request(_body(sha256="0" * 64)), db))
    with pytest.raises(BadRequestError):
        run(clips_api.upload_clip(_request(_body(source="mic")), db))
    with pytest.raises(BadRequestError):
        run(clips_api.upload_clip(_request(_body(mime_type="text/html")), db))


def test_upload_rejects_oversized_clip(db, authed, monkeypatch):
    monkeypatch.setenv("CLIP_MAX_BYTES", "4")
    with pytest.raises(BadRequestError):
        run(clips_api.upload_clip(_request(_body()), db))


def test_other_device_cannot_overwrite_clip(db, authed, monkeypatch):
    run(clips_api.upload_clip(_request(_body()), db))
    monkeypatch.setattr(clips_api, "_get_authed_device",
                        lambda request, device_id, db: SimpleNamespace(device_id=device_id))
    with pytest.raises(ForbiddenError):
        run(clips_api.upload_clip(_request(_body(device_id="dev-2")), db))


def test_storage_rejects_path_traversal():
    with pytest.raises(ValueError):
        clip_storage.put("../evil.webm", b"x", "video/webm")


def test_webrtc_config_turn_from_environment(monkeypatch):
    monkeypatch.delenv("TURN_SERVER_URL", raising=False)
    cfg = run(clips_api.webrtc_config())["data"]
    assert cfg["turn_configured"] is False
    monkeypatch.setenv("TURN_SERVER_URL", "turn:t.example:3478,turns:t.example:443?transport=tcp")
    monkeypatch.setenv("TURN_USERNAME", "u")
    monkeypatch.setenv("TURN_CREDENTIAL", "c")
    cfg = run(clips_api.webrtc_config())["data"]
    turn = cfg["iceServers"][-1]
    assert cfg["turn_configured"] is True
    assert any(u.startswith("turns:") for u in turn["urls"])
    assert turn["username"] == "u"


def test_signaling_routes_to_the_target_device_only():
    async def go():
        hub = ClassroomWSHub()
        a, b = AsyncMock(), AsyncMock()
        await hub.register_agent("devA", a)
        await hub.register_agent("devB", b)
        assert await hub.send_webrtc_signal_to_device("devA", {"type": "webrtc_offer", "sdp": "x"})
        a.send_text.assert_awaited_once()
        b.send_text.assert_not_awaited()
        assert not await hub.send_webrtc_signal_to_device("missing", {"type": "webrtc_offer"})
    run(go())
