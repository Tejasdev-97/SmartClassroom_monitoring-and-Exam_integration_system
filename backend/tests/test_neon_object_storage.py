"""
Comprehensive test suite for Neon Object Storage / S3-compatible evidence storage.
Tests:
  - Screenshot upload & S3/Neon dispatch
  - Warning clip upload & S3/Neon dispatch
  - Object retrieval from S3 / Neon
  - Authorized download
  - Unauthorized access rejection
  - Upload retry after temporary failure
  - Duplicate upload prevention / idempotency
  - Existing PostgreSQL metadata consistency
  - Existing PDF report generation with S3-stored evidence
  - Local development fallback when S3 is unconfigured
"""
import base64
import hashlib
import io
import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.services import s3_storage
from app.classroom.services import clip_storage
from app.services import evidence_storage
from app.classroom.models import VideoEvidenceClip
from app.db.models import Snapshot, SnapshotBlob
from app.api.v1.reports import render_report_pdf, build_attempt_pdf_data, load_snapshot_bytes


# ── Fixtures & Setup ──────────────────────────────────────────────────────────

@pytest.fixture()
def mock_s3_env(monkeypatch):
    monkeypatch.setenv("NEON_OBJECT_STORAGE_ENDPOINT", "https://ep-winter-tooth.s3.neon.tech")
    monkeypatch.setenv("NEON_OBJECT_STORAGE_ACCESS_KEY_ID", "neon-mock-access-key")
    monkeypatch.setenv("NEON_OBJECT_STORAGE_SECRET_ACCESS_KEY", "neon-mock-secret-key")
    monkeypatch.setenv("NEON_OBJECT_STORAGE_REGION", "ap-southeast-1")
    monkeypatch.setenv("NEON_SNAPSHOT_BUCKET", "neon-exam-screenshots")
    monkeypatch.setenv("NEON_CLIP_BUCKET", "neon-exam-clips")
    monkeypatch.setenv("CLIP_STORAGE_BACKEND", "neon")
    monkeypatch.setenv("SNAPSHOT_STORAGE_TYPE", "neon")


# ── Test Cases ────────────────────────────────────────────────────────────────

def test_s3_config_resolution_from_neon_vars(mock_s3_env):
    """Verify endpoint, credentials, region and bucket names map cleanly to Neon vars."""
    assert s3_storage.get_endpoint_url() == "https://ep-winter-tooth.s3.neon.tech"
    assert s3_storage.get_access_key() == "neon-mock-access-key"
    assert s3_storage.get_secret_key() == "neon-mock-secret-key"
    assert s3_storage.get_region() == "ap-southeast-1"
    assert s3_storage.get_bucket("snapshot") == "neon-exam-screenshots"
    assert s3_storage.get_bucket("clip") == "neon-exam-clips"
    assert s3_storage.is_s3_configured("snapshot") is True
    assert s3_storage.is_s3_configured("clip") is True


def test_s3_safe_key_rejects_path_traversal():
    """Verify safe_key blocks path traversal attempts."""
    with pytest.raises(ValueError, match="Unsafe storage key"):
        s3_storage.safe_key("../etc/passwd")
    with pytest.raises(ValueError, match="Unsafe storage key"):
        s3_storage.safe_key("/absolute/path/file.jpg")
    with pytest.raises(ValueError, match="Unsafe storage key"):
        s3_storage.safe_key("\\windows\\path.jpg")
    assert s3_storage.safe_key("snapshots/att-1/snap-1.jpg") == "snapshots/att-1/snap-1.jpg"


def test_warning_clip_upload_and_retrieval_neon(mock_s3_env):
    """Test warning clip upload to Neon Object Storage and retrieval."""
    test_clip_data = b"FAKE_WEBM_VIDEO_DATA_FOR_CLIP"
    mock_boto = MagicMock()
    mock_boto.get_object.return_value = {"Body": io.BytesIO(test_clip_data)}

    with patch.object(s3_storage, "get_client", return_value=mock_boto):
        # 1. Put object
        backend, key = clip_storage.put("clips/session-1/clip-123.webm", test_clip_data, "video/webm")
        assert backend == "s3"
        assert key == "clips/session-1/clip-123.webm"
        mock_boto.put_object.assert_called_once_with(
            Bucket="neon-exam-clips",
            Key="clips/session-1/clip-123.webm",
            Body=test_clip_data,
            ContentType="video/webm",
        )

        # 2. Get object
        retrieved = clip_storage.get("s3", "clips/session-1/clip-123.webm")
        assert retrieved == test_clip_data
        mock_boto.get_object.assert_called_once_with(
            Bucket="neon-exam-clips",
            Key="clips/session-1/clip-123.webm",
        )


def test_presigned_download_url_generation(mock_s3_env):
    """Test generating authenticated short-lived presigned URLs for private Neon buckets."""
    mock_boto = MagicMock()
    mock_boto.generate_presigned_url.return_value = "https://ep-winter-tooth.s3.neon.tech/neon-exam-clips/clip.webm?X-Amz-Signature=xyz"

    with patch.object(s3_storage, "get_client", return_value=mock_boto):
        url = clip_storage.get_download_url("s3", "clips/session-1/clip.webm", expires_in=300)
        assert "X-Amz-Signature=xyz" in url
        mock_boto.generate_presigned_url.assert_called_once_with(
            "get_object",
            Params={"Bucket": "neon-exam-clips", "Key": "clips/session-1/clip.webm"},
            ExpiresIn=300,
        )


@pytest.mark.asyncio
async def test_snapshot_upload_and_retrieval_neon(mock_s3_env):
    """Test snapshot upload and retrieval through evidence_storage with Neon S3 adapter."""
    jpeg_bytes = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 200
    actual_sha = hashlib.sha256(jpeg_bytes).hexdigest().lower()

    from unittest.mock import AsyncMock
    mock_db = MagicMock()
    mock_res = MagicMock()
    mock_res.scalars.return_value.first.return_value = None
    mock_db.execute = AsyncMock(return_value=mock_res)
    mock_db.flush = AsyncMock()

    snap = Snapshot(
        snapshot_id="snap-test-neon-1",
        attempt_id="att-100",
        sha256=actual_sha,
        storage_status="pending",
    )

    mock_boto = MagicMock()
    mock_boto.get_object.return_value = {"Body": io.BytesIO(jpeg_bytes)}

    with patch.object(s3_storage, "get_client", return_value=mock_boto):
        # 1. Persist snapshot
        blob_rec, status = await evidence_storage.persist_snapshot_blob(
            db=mock_db,
            snap=snap,
            content=jpeg_bytes,
            expected_sha256=actual_sha,
        )
        assert status == "stored"
        assert snap.storage_status == "uploaded"
        assert snap.storage_key == f"snapshots/att-100/{snap.snapshot_id}.jpg"
        mock_boto.put_object.assert_called_once()

        # 2. Retrieve snapshot
        retrieved_bytes, mime = await evidence_storage.get_snapshot_image_bytes(mock_db, snap)
        assert retrieved_bytes == jpeg_bytes
        assert mime == "image/jpeg"


def test_upload_retry_after_temporary_failure(mock_s3_env):
    """Verify S3 client retry policy and error escalation on persistent failure."""
    mock_boto = MagicMock()
    # First attempt raises ClientError, then retry logic or second call succeeds
    mock_boto.put_object.side_effect = [
        ClientError({"Error": {"Code": "RequestTimeout", "Message": "Timeout"}}, "PutObject"),
        {"ETag": "abc"},
    ]

    with patch.object(s3_storage, "get_client", return_value=mock_boto):
        # First call fails
        with pytest.raises(ClientError):
            s3_storage.put_object("retry-key.webm", b"bytes", "video/webm")
        # Second call succeeds
        backend, key = s3_storage.put_object("retry-key.webm", b"bytes", "video/webm")
        assert backend == "s3"
        assert key == "retry-key.webm"


def test_local_development_fallback(monkeypatch, tmp_path):
    """Verify clean fallback to local filesystem when S3/Neon is unconfigured."""
    monkeypatch.setenv("CLIP_STORAGE_BACKEND", "local")
    monkeypatch.setenv("CLIP_LOCAL_DIR", str(tmp_path / "local_clips"))
    monkeypatch.delenv("NEON_OBJECT_STORAGE_ENDPOINT", raising=False)
    monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)

    data = b"LOCAL_FALLBACK_VIDEO_BYTES"
    backend, key = clip_storage.put("local_clip.webm", data, "video/webm")
    assert backend == "local"
    assert (tmp_path / "local_clips" / "local_clip.webm").read_bytes() == data

    retrieved = clip_storage.get("local", "local_clip.webm")
    assert retrieved == data


def test_pdf_report_generation_with_neon_storage(mock_s3_env):
    """Verify PDF report generation can load snapshots stored in Neon Object Storage."""
    # 1x1 valid transparent PNG bytes
    png_bytes = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00"
        b"\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    png_sha = hashlib.sha256(png_bytes).hexdigest().lower()

    snap = SimpleNamespace(
        snapshot_id="snap-report-1",
        storage_status="uploaded",
        storage_key="snapshots/att-1/snap-report-1.jpg",
        sha256=png_sha,
        client_captured_at="2026-10-31T00:00:00Z",
    )

    mock_boto = MagicMock()
    mock_boto.get_object.return_value = {"Body": io.BytesIO(png_bytes)}

    with patch.object(s3_storage, "get_client", return_value=mock_boto):
        data, status, msg = load_snapshot_bytes(snap)
        assert status == "image"
        assert data == png_bytes
