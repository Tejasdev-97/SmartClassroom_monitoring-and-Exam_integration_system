"""
Provider-independent object storage for warning video clips.
Supports Neon Object Storage, AWS S3, Cloudflare R2, MinIO, and local filesystem fallback.

CLIP_STORAGE_BACKEND = local | s3 | neon (default: local, for development only)
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Tuple

from app.services import s3_storage

ALLOWED_MIME = {"video/webm", "video/mp4"}


def max_clip_bytes() -> int:
    return int(os.environ.get("CLIP_MAX_BYTES", str(15 * 1024 * 1024)))


def retention_days() -> int:
    return int(os.environ.get("CLIP_RETENTION_DAYS", "90"))


def backend_name() -> str:
    return os.environ.get("CLIP_STORAGE_BACKEND", "local").lower()


def _safe_key(key: str) -> str:
    return s3_storage.safe_key(key)


def _local_dir() -> Path:
    return Path(os.environ.get("CLIP_LOCAL_DIR", "./storage/clips")).resolve()


def put(key: str, data: bytes, mime: str) -> Tuple[str, str]:
    """Store bytes; returns (backend, key)."""
    key = _safe_key(key)
    backend = backend_name()
    if backend in ("s3", "neon"):
        b, k = s3_storage.put_object(key, data, mime, bucket_type="clip")
        return b, k

    path = _local_dir() / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return "local", key


def get(backend: str, key: str) -> bytes:
    """Retrieve raw clip bytes from storage backend."""
    key = _safe_key(key)
    if backend in ("s3", "neon"):
        return s3_storage.get_object(key, bucket_type="clip")
    return (_local_dir() / key).read_bytes()


def get_download_url(backend: str, key: str, expires_in: int = 300) -> str:
    """Generate authenticated short-lived presigned URL if in S3/Neon, or return key."""
    key = _safe_key(key)
    if backend in ("s3", "neon"):
        return s3_storage.generate_presigned_url(key, bucket_type="clip", expires_in=expires_in)
    return f"/api/v1/classroom/clips/{key}/download"
