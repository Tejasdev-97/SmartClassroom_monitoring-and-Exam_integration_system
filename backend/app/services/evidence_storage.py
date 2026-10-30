"""
ExamProctor.ai — Durable Evidence Storage Service
Manages direct PostgreSQL BYTEA evidence storage with idempotency,
SHA-256 cryptographic verification, legacy disk fallback, and transactional safety.
"""

import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

import aiofiles
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError, ConflictError, NotFoundError
from app.db.models import Snapshot, SnapshotBlob


VALID_IMAGE_HEADERS = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"RIFF", "image/webp"),
)


def validate_image_bytes(content: bytes) -> Tuple[bool, Optional[str], str]:
    """Validate binary image content, size boundaries, and known magic byte headers."""
    if not content or len(content) == 0:
        return False, "Snapshot content is empty.", "application/octet-stream"
    if len(content) > settings.MAX_SNAPSHOT_SIZE_BYTES:
        return False, f"Snapshot exceeds maximum permitted size of {settings.MAX_SNAPSHOT_SIZE_BYTES} bytes.", "application/octet-stream"

    for magic, mime in VALID_IMAGE_HEADERS:
        if content.startswith(magic):
            if magic == b"RIFF" and content[8:12] != b"WEBP":
                continue
            return True, None, mime

    return False, "Invalid image format. Expected JPEG, PNG, or WebP bytes.", "application/octet-stream"


def compute_sha256(content: bytes) -> str:
    """Compute lowercase hexadecimal SHA-256 digest for byte sequence."""
    return hashlib.sha256(content).hexdigest().lower()


async def persist_snapshot_blob(
    db: AsyncSession,
    snap: Snapshot,
    content: bytes,
    expected_sha256: Optional[str] = None,
) -> Tuple[SnapshotBlob, str]:
    """
    Durably commit image bytes into PostgreSQL snapshot_blobs table.
    Enforces format validation, SHA-256 verification, and idempotency.
    Returns (blob_record, status_message).
    """
    # 1. Format validation
    is_valid, err_msg, detected_mime = validate_image_bytes(content)
    if not is_valid:
        raise AppError(422, "INVALID_IMAGE_FORMAT", err_msg or "Invalid image content.")

    # 2. Checksum verification
    actual_sha256 = compute_sha256(content)
    target_sha256 = (expected_sha256 or snap.sha256 or "").lower()
    if target_sha256 and actual_sha256 != target_sha256:
        snap.storage_status = "failed"
        raise AppError(422, "CHECKSUM_MISMATCH", "Snapshot binary does not match registered checksum.")

    now = datetime.now(timezone.utc)

    # 3. Idempotency check in snapshot_blobs
    stmt = select(SnapshotBlob).where(SnapshotBlob.snapshot_id == snap.snapshot_id)
    existing_blob: Optional[SnapshotBlob] = (await db.execute(stmt)).scalars().first()

    blob_record: SnapshotBlob
    result_status: str

    if existing_blob:
        if existing_blob.sha256.lower() == actual_sha256:
            blob_record = existing_blob
            result_status = "already_stored"
        else:
            raise ConflictError("Snapshot identifier already exists with different cryptographic content.")
    else:
        blob_record = SnapshotBlob(
            snapshot_id=snap.snapshot_id,
            image_data=content,
            size_bytes=len(content),
            sha256=actual_sha256,
            created_at=now,
        )
        db.add(blob_record)
        result_status = "stored"

    # 4. Storage dispatch: S3/Neon Object Storage or local disk fallback
    storage_type = os.environ.get("SNAPSHOT_STORAGE_TYPE", settings.SNAPSHOT_STORAGE_TYPE).lower()
    if storage_type in ("s3", "neon"):
        try:
            from app.services import s3_storage
            s3_key = f"snapshots/{snap.attempt_id or 'general'}/{snap.snapshot_id}.jpg"
            backend, key = s3_storage.put_object(s3_key, content, detected_mime, bucket_type="snapshot")
            snap.storage_key = key
        except Exception as e:
            # Fall back to PostgreSQL URI if S3 fails
            snap.storage_key = f"postgres://snapshot_blobs/{snap.snapshot_id}"
    else:
        try:
            base_dir = Path(settings.SNAPSHOT_LOCAL_DIR)
            sub_dir: Path
            if snap.video_analysis_session_id:
                sub_dir = base_dir / "video_analysis" / str(snap.video_analysis_session_id)
            elif snap.attempt_id:
                sub_dir = base_dir / str(snap.attempt_id)
            else:
                sub_dir = base_dir / "general"

            sub_dir.mkdir(parents=True, exist_ok=True)
            disk_path = sub_dir / f"{snap.snapshot_id}.jpg"
            async with aiofiles.open(disk_path, "wb") as f:
                await f.write(content)
            snap.storage_key = str(disk_path)
        except Exception:
            # Non-fatal if disk is read-only or ephemeral: PostgreSQL is authoritative
            snap.storage_key = f"postgres://snapshot_blobs/{snap.snapshot_id}"

    # 5. Update parent snapshot metadata
    snap.storage_status = "uploaded"
    snap.size_bytes = len(content)
    snap.sha256 = actual_sha256
    snap.mime_type = detected_mime
    snap.server_received_at = now

    await db.flush()
    return blob_record, result_status


async def get_snapshot_image_bytes(
    db: AsyncSession,
    snap: Snapshot,
    auto_migrate_legacy: bool = True,
) -> Tuple[Optional[bytes], Optional[str]]:
    """
    Retrieve snapshot image bytes.
    Strategy:
      1. Check S3 / Neon Object Storage if key is stored in S3/Neon
      2. Check PostgreSQL snapshot_blobs table (durable relational source)
      3. If missing, check legacy filesystem storage (fallback)
      4. If found on disk and valid, auto-migrate to snapshot_blobs
    Returns (image_bytes, mime_type) or (None, None).
    """
    if not snap:
        return None, None

    storage_type = os.environ.get("SNAPSHOT_STORAGE_TYPE", settings.SNAPSHOT_STORAGE_TYPE).lower()

    # Step 1: Check S3 / Neon Object Storage if key indicates object storage or configured
    if snap.storage_key and not snap.storage_key.startswith("postgres://") and not os.path.isabs(snap.storage_key):
        try:
            from app.services import s3_storage
            if storage_type in ("s3", "neon") or s3_storage.is_s3_configured(bucket_type="snapshot"):
                data = s3_storage.get_object(snap.storage_key, bucket_type="snapshot")
                if data and (not snap.sha256 or compute_sha256(data) == snap.sha256.lower()):
                    return data, (snap.mime_type or "image/jpeg")
        except Exception:
            pass  # Fall through to PostgreSQL snapshot_blobs

    # Step 2: Query PostgreSQL snapshot_blobs
    stmt = select(SnapshotBlob).where(SnapshotBlob.snapshot_id == snap.snapshot_id)
    blob_row: Optional[SnapshotBlob] = (await db.execute(stmt)).scalars().first()

    if blob_row and blob_row.image_data:
        # Verify integrity
        if snap.sha256 and blob_row.sha256.lower() != snap.sha256.lower():
            return None, None
        return blob_row.image_data, (snap.mime_type or "image/jpeg")

    # Step 3: Fall back to legacy disk storage
    from app.api.v1.snapshots import resolve_snapshot_path
    disk_path = resolve_snapshot_path(snap)
    if disk_path and disk_path.is_file():
        try:
            disk_bytes = disk_path.read_bytes()
            disk_sha = compute_sha256(disk_bytes)
            if snap.sha256 and disk_sha != snap.sha256.lower():
                return None, None

            # Step 4: Auto-migrate verified disk bytes into PostgreSQL
            if auto_migrate_legacy:
                try:
                    new_blob = SnapshotBlob(
                        snapshot_id=snap.snapshot_id,
                        image_data=disk_bytes,
                        size_bytes=len(disk_bytes),
                        sha256=disk_sha,
                        created_at=datetime.now(timezone.utc),
                    )
                    db.add(new_blob)
                    await db.flush()
                except Exception:
                    pass  # Non-fatal during read

            return disk_bytes, (snap.mime_type or "image/jpeg")
        except OSError:
            return None, None

    return None, None


def get_snapshot_download_url(snap: Snapshot, expires_in: int = 300) -> str:
    """Generate authenticated short-lived presigned URL if in S3/Neon, or API route."""
    if not snap or not snap.storage_key:
        return ""
    storage_type = os.environ.get("SNAPSHOT_STORAGE_TYPE", settings.SNAPSHOT_STORAGE_TYPE).lower()
    if snap.storage_key and not snap.storage_key.startswith("postgres://") and not os.path.isabs(snap.storage_key):
        try:
            from app.services import s3_storage
            if storage_type in ("s3", "neon") or s3_storage.is_s3_configured(bucket_type="snapshot"):
                return s3_storage.generate_presigned_url(snap.storage_key, bucket_type="snapshot", expires_in=expires_in)
        except Exception:
            pass
    return f"/api/v1/snapshots/{snap.snapshot_id}/image"


async def has_durable_snapshot_bytes(db: AsyncSession, snap: Snapshot) -> bool:
    """Check whether actual image bytes are retrievable for this snapshot."""
    stmt = select(SnapshotBlob.snapshot_id).where(SnapshotBlob.snapshot_id == snap.snapshot_id)
    has_blob = (await db.execute(stmt)).scalars().first() is not None
    if has_blob:
        return True

    from app.api.v1.snapshots import resolve_snapshot_path
    disk_path = resolve_snapshot_path(snap)
    return bool(disk_path and disk_path.is_file())
