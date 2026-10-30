"""
ExamProctor.ai — Unified S3-compatible Object Storage Service.
Supports Neon Object Storage, AWS S3, Cloudflare R2, MinIO, and other S3-compatible APIs.

Environment variables supported (checked in priority order):
  Endpoint:
    NEON_OBJECT_STORAGE_ENDPOINT, S3_ENDPOINT_URL, AWS_ENDPOINT_URL_S3, CLIP_S3_ENDPOINT_URL
  Credentials:
    NEON_OBJECT_STORAGE_ACCESS_KEY_ID, AWS_ACCESS_KEY_ID, CLIP_S3_ACCESS_KEY
    NEON_OBJECT_STORAGE_SECRET_ACCESS_KEY, AWS_SECRET_ACCESS_KEY, CLIP_S3_SECRET_KEY
  Region:
    NEON_OBJECT_STORAGE_REGION, AWS_REGION, AWS_DEFAULT_REGION, CLIP_S3_REGION (default: us-east-1)
  Bucket Names:
    Snapshots: SNAPSHOT_S3_BUCKET, NEON_SNAPSHOT_BUCKET, NEON_OBJECT_STORAGE_BUCKET, S3_BUCKET_NAME
    Clips:     CLIP_S3_BUCKET, NEON_CLIP_BUCKET, NEON_OBJECT_STORAGE_BUCKET, S3_BUCKET_NAME
"""
from __future__ import annotations

import logging
import os
from typing import Optional, Tuple

logger = logging.getLogger("storage.s3")


def get_endpoint_url() -> Optional[str]:
    return (
        os.environ.get("NEON_OBJECT_STORAGE_ENDPOINT")
        or os.environ.get("S3_ENDPOINT_URL")
        or os.environ.get("AWS_ENDPOINT_URL_S3")
        or os.environ.get("CLIP_S3_ENDPOINT_URL")
        or None
    )


def get_access_key() -> Optional[str]:
    return (
        os.environ.get("NEON_OBJECT_STORAGE_ACCESS_KEY_ID")
        or os.environ.get("AWS_ACCESS_KEY_ID")
        or os.environ.get("CLIP_S3_ACCESS_KEY")
        or None
    )


def get_secret_key() -> Optional[str]:
    return (
        os.environ.get("NEON_OBJECT_STORAGE_SECRET_ACCESS_KEY")
        or os.environ.get("AWS_SECRET_ACCESS_KEY")
        or os.environ.get("CLIP_S3_SECRET_KEY")
        or None
    )


def get_region() -> str:
    return (
        os.environ.get("NEON_OBJECT_STORAGE_REGION")
        or os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or os.environ.get("CLIP_S3_REGION")
        or "us-east-1"
    )


def get_bucket(bucket_type: str = "clip") -> str:
    if bucket_type == "snapshot":
        b = (
            os.environ.get("SNAPSHOT_S3_BUCKET")
            or os.environ.get("NEON_SNAPSHOT_BUCKET")
            or os.environ.get("NEON_OBJECT_STORAGE_BUCKET")
            or os.environ.get("S3_BUCKET_NAME")
            or "examproctor-snapshots"
        )
        return b.strip()
    # Default: clips
    b = (
        os.environ.get("CLIP_S3_BUCKET")
        or os.environ.get("NEON_CLIP_BUCKET")
        or os.environ.get("NEON_OBJECT_STORAGE_BUCKET")
        or os.environ.get("S3_BUCKET_NAME")
        or "examproctor-clips"
    )
    return b.strip()


def is_s3_configured(bucket_type: str = "clip") -> bool:
    """Return True if S3/Neon object storage has required credentials or endpoint."""
    access_key = get_access_key()
    secret_key = get_secret_key()
    bucket = get_bucket(bucket_type)
    return bool(access_key and secret_key and bucket)


def safe_key(key: str) -> str:
    """Sanitize and validate object key against path traversal."""
    if not key or ".." in key or key.startswith(("/", "\\")):
        raise ValueError(f"Unsafe storage key: {key}")
    return key.replace("\\", "/")


def get_client():
    """Build and return a boto3 S3 client configured with Neon / S3 settings."""
    try:
        import boto3
        from botocore.config import Config
    except ImportError as e:
        raise RuntimeError("S3/Neon object storage requires the boto3 package. Run 'pip install boto3'.") from e

    endpoint = get_endpoint_url()
    access_key = get_access_key()
    secret_key = get_secret_key()
    region = get_region()

    cfg = Config(
        signature_version="s3v4",
        retries={"max_attempts": 3, "mode": "standard"},
        s3={"addressing_style": "virtual" if not endpoint else "path"},
    )

    kwargs = {
        "service_name": "s3",
        "region_name": region,
        "config": cfg,
    }
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    if access_key and secret_key:
        kwargs["aws_access_key_id"] = access_key
        kwargs["aws_secret_access_key"] = secret_key

    return boto3.client(**kwargs)


def put_object(key: str, data: bytes, mime: str, bucket_type: str = "clip") -> Tuple[str, str]:
    """
    Upload byte payload to S3 / Neon Object Storage.
    Returns ('s3', key).
    """
    cleaned_key = safe_key(key)
    bucket = get_bucket(bucket_type)
    client = get_client()

    client.put_object(
        Bucket=bucket,
        Key=cleaned_key,
        Body=data,
        ContentType=mime,
    )
    logger.info("Successfully uploaded object key=%s to bucket=%s", cleaned_key, bucket)
    return "s3", cleaned_key


def get_object(key: str, bucket_type: str = "clip") -> bytes:
    """
    Download byte payload from S3 / Neon Object Storage.
    """
    cleaned_key = safe_key(key)
    bucket = get_bucket(bucket_type)
    client = get_client()

    response = client.get_object(Bucket=bucket, Key=cleaned_key)
    return response["Body"].read()


def generate_presigned_url(key: str, bucket_type: str = "clip", expires_in: int = 300) -> str:
    """
    Generate an authenticated, short-lived presigned download URL for private buckets.
    Defaults to 300 seconds (5 minutes).
    """
    cleaned_key = safe_key(key)
    bucket = get_bucket(bucket_type)
    client = get_client()

    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": cleaned_key},
        ExpiresIn=expires_in,
    )
