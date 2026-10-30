"""
Provider-independent object storage for warning video clips.

CLIP_STORAGE_BACKEND = local | s3   (default: local, for development only)

s3 works with any S3-compatible provider (AWS S3, Cloudflare R2, Backblaze B2, MinIO...):
  CLIP_S3_BUCKET, CLIP_S3_ENDPOINT_URL (optional), CLIP_S3_REGION (optional),
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   (server-side only)

local writes under CLIP_LOCAL_DIR and is NOT durable on ephemeral hosts such as Render.
"""
import os
from pathlib import Path
from typing import Tuple

ALLOWED_MIME = {"video/webm", "video/mp4"}


def max_clip_bytes() -> int:
    return int(os.environ.get("CLIP_MAX_BYTES", str(15 * 1024 * 1024)))


def retention_days() -> int:
    return int(os.environ.get("CLIP_RETENTION_DAYS", "90"))


def backend_name() -> str:
    return os.environ.get("CLIP_STORAGE_BACKEND", "local").lower()


def _safe_key(key: str) -> str:
    if ".." in key or key.startswith(("/", "\\")):
        raise ValueError("Unsafe storage key")
    return key


def _local_dir() -> Path:
    return Path(os.environ.get("CLIP_LOCAL_DIR", "./storage/clips")).resolve()


def _s3():
    try:
        import boto3  # optional dependency, required only for the s3 backend
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("CLIP_STORAGE_BACKEND=s3 requires the boto3 package") from e
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("CLIP_S3_ENDPOINT_URL") or None,
        region_name=os.environ.get("CLIP_S3_REGION") or None,
    )


def put(key: str, data: bytes, mime: str) -> Tuple[str, str]:
    """Store bytes; returns (backend, key)."""
    key = _safe_key(key)
    if backend_name() == "s3":
        _s3().put_object(Bucket=os.environ["CLIP_S3_BUCKET"], Key=key, Body=data, ContentType=mime)
        return "s3", key
    path = _local_dir() / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return "local", key


def get(backend: str, key: str) -> bytes:
    key = _safe_key(key)
    if backend == "s3":
        obj = _s3().get_object(Bucket=os.environ["CLIP_S3_BUCKET"], Key=key)
        return obj["Body"].read()
    return (_local_dir() / key).read_bytes()
