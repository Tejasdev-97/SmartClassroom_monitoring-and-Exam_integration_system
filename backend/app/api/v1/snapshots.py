"""
ExamProctor.ai — Snapshot metadata registration and binary upload.
"""

import hashlib
import os
import uuid
import aiofiles
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, UploadFile, Query
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.db.session import get_db
from app.db.models import ExamAttempt, Snapshot, Exam, ProctorEvent, VideoAnalysisSession
from app.core.permissions import StudentUser, ProfessorUser
from app.core.errors import NotFoundError, ForbiddenError, ConflictError, AppError
from app.schemas.schemas import SnapshotMetadataRequest, SnapshotOut
from app.core.config import settings

router = APIRouter(prefix="/snapshots", tags=["snapshots"])


@router.post("/metadata", status_code=201)
async def register_snapshot_metadata(
    body: SnapshotMetadataRequest,
    actor: StudentUser,
    db: AsyncSession = Depends(get_db),
):
    """Register snapshot metadata before binary upload."""
    # Verify attempt ownership
    stmt = select(ExamAttempt).where(
        ExamAttempt.attempt_id == body.attempt_id,
        ExamAttempt.student_user_id == actor["sub"],
    )
    attempt: ExamAttempt | None = (await db.execute(stmt)).scalars().first()
    if not attempt:
        raise ForbiddenError("Attempt not found or not authorized.")

    # Check for duplicate snapshot (idempotent)
    stmt = select(Snapshot).where(Snapshot.snapshot_id == body.snapshot_id)
    existing: Snapshot | None = (await db.execute(stmt)).scalars().first()
    if existing:
        if existing.attempt_id != body.attempt_id:
            raise ForbiddenError("Snapshot belongs to a different attempt.")
        return {"data": SnapshotOut.model_validate(existing)}

    # The linked event (if any) must already exist AND belong to this same attempt.
    if body.event_id:
        ev = (await db.execute(
            select(ProctorEvent).where(ProctorEvent.event_id == body.event_id)
        )).scalars().first()
        if not ev:
            raise AppError(409, "EVENT_NOT_RECEIVED", "Event has not been synchronized yet; retry later.")
        if ev.attempt_id != body.attempt_id:
            raise ForbiddenError("Event does not belong to this attempt.")

    snap = Snapshot(
        snapshot_id=body.snapshot_id,
        attempt_id=body.attempt_id,
        event_id=body.event_id,
        capture_reason=body.capture_reason,
        client_captured_at=datetime.fromisoformat(body.client_captured_at.replace("Z", "+00:00")),
        mime_type=body.mime_type,
        size_bytes=body.size_bytes,
        sha256=body.sha256,
        width=body.width,
        height=body.height,
        storage_status="pending",
    )
    db.add(snap)
    await db.flush()

    return {"data": SnapshotOut.model_validate(snap)}


@router.post("/{snapshot_id}/upload")
async def upload_snapshot_binary(
    snapshot_id: str,
    actor: StudentUser,
    db: AsyncSession = Depends(get_db),
    file: UploadFile = File(...),
):
    """Upload binary snapshot data after metadata registration."""
    stmt = select(Snapshot).where(Snapshot.snapshot_id == snapshot_id)
    snap: Snapshot | None = (await db.execute(stmt)).scalars().first()
    if not snap:
        raise NotFoundError("Snapshot")

    # Verify ownership through attempt
    stmt = select(ExamAttempt).where(
        ExamAttempt.attempt_id == snap.attempt_id,
        ExamAttempt.student_user_id == actor["sub"],
    )
    attempt: ExamAttempt | None = (await db.execute(stmt)).scalars().first()
    if not attempt:
        raise ForbiddenError("Not authorized to upload this snapshot.")

    # Read binary content safely
    content = await file.read()

    # Use durable evidence storage service
    from app.services.evidence_storage import persist_snapshot_blob
    blob_record, status_msg = await persist_snapshot_blob(
        db=db,
        snap=snap,
        content=content,
        expected_sha256=snap.sha256,
    )

    # Commit transaction to PostgreSQL before acknowledging success
    await db.commit()

    return {
        "data": {
            "snapshot_id": snapshot_id,
            "status": "uploaded",
            "server_received_at": snap.server_received_at.isoformat() if snap.server_received_at else None,
        }
    }


async def _authorize_professor_for_attempt(db: AsyncSession, attempt_id: str, actor: dict) -> None:
    attempt = (await db.execute(
        select(ExamAttempt).where(ExamAttempt.attempt_id == attempt_id)
    )).scalars().first()
    if not attempt:
        raise NotFoundError("Attempt")
    exam = (await db.execute(select(Exam).where(Exam.exam_id == attempt.exam_id))).scalars().first()
    if exam and exam.owner_user_id != actor["sub"] and actor["role"] != "admin":
        raise ForbiddenError()


@router.get("/attempt/{attempt_id}")
async def list_attempt_snapshots(
    attempt_id: str,
    actor: ProfessorUser,
    db: AsyncSession = Depends(get_db),
):
    """List snapshots for an attempt. Professor (owner) or admin only."""
    await _authorize_professor_for_attempt(db, attempt_id, actor)
    stmt = select(Snapshot).where(Snapshot.attempt_id == attempt_id).order_by(Snapshot.client_captured_at)
    snaps = (await db.execute(stmt)).scalars().all()
    return {"data": [SnapshotOut.model_validate(s) for s in snaps]}


def resolve_snapshot_path(snap: Snapshot) -> Path | None:
    """Return the on-disk path of a stored snapshot, or None if unavailable/unsafe."""
    if not snap.storage_key or snap.storage_status != "uploaded":
        return None
    base = Path(settings.SNAPSHOT_LOCAL_DIR).resolve()
    try:
        p = Path(snap.storage_key).resolve()
        p.relative_to(base)  # path-traversal guard: must live under the snapshot dir
    except (ValueError, OSError):
        return None
    return p if p.is_file() else None


@router.get("/{snapshot_id}/image")
async def get_snapshot_image(
    snapshot_id: str,
    actor: ProfessorUser,
    db: AsyncSession = Depends(get_db),
):
    """Serve stored JPEG bytes from PostgreSQL snapshot_blobs, falling back to legacy disk."""
    snap = (await db.execute(select(Snapshot).where(Snapshot.snapshot_id == snapshot_id))).scalars().first()
    if not snap:
        raise NotFoundError("Snapshot")
    if snap.video_analysis_session_id:
        sess = (await db.execute(
            select(VideoAnalysisSession).where(
                VideoAnalysisSession.video_analysis_session_id == snap.video_analysis_session_id
            )
        )).scalars().first()
        if not sess:
            raise NotFoundError("Video analysis session")
        if sess.created_by_user_id != actor["sub"] and actor["role"] != "admin":
            raise ForbiddenError("Not authorized to view snapshots for this session.")
    elif snap.attempt_id:
        await _authorize_professor_for_attempt(db, snap.attempt_id, actor)
    else:
        raise NotFoundError("Snapshot")

    from app.services.evidence_storage import get_snapshot_image_bytes
    from fastapi.responses import Response

    image_bytes, mime_type = await get_snapshot_image_bytes(db, snap, auto_migrate_legacy=True)
    if not image_bytes:
        raise NotFoundError("Snapshot image")

    # If legacy image was auto-migrated during read, commit the new blob
    try:
        await db.commit()
    except Exception:
        pass

    return Response(
        content=image_bytes,
        media_type=mime_type or "image/jpeg",
        headers={
            "Cache-Control": "private, no-cache, no-store, must-revalidate",
            "Content-Length": str(len(image_bytes)),
        },
    )


@router.get("/{snapshot_id}/url")
async def get_snapshot_presigned_url(
    snapshot_id: str,
    actor: ProfessorUser,
    db: AsyncSession = Depends(get_db),
):
    """Return authenticated short-lived presigned download URL (S3/Neon) or fallback route."""
    snap = (await db.execute(select(Snapshot).where(Snapshot.snapshot_id == snapshot_id))).scalars().first()
    if not snap:
        raise NotFoundError("Snapshot")
    if snap.video_analysis_session_id:
        sess = (await db.execute(
            select(VideoAnalysisSession).where(
                VideoAnalysisSession.video_analysis_session_id == snap.video_analysis_session_id
            )
        )).scalars().first()
        if not sess:
            raise NotFoundError("Video analysis session")
        if sess.created_by_user_id != actor["sub"] and actor["role"] != "admin":
            raise ForbiddenError("Not authorized to view snapshots for this session.")
    elif snap.attempt_id:
        await _authorize_professor_for_attempt(db, snap.attempt_id, actor)
    else:
        raise NotFoundError("Snapshot")

    from app.services.evidence_storage import get_snapshot_download_url
    url = get_snapshot_download_url(snap, expires_in=300)
    is_presigned = bool(url and url.startswith(("http://", "https://")))
    return {
        "ok": True,
        "url": url,
        "expires_in": 300 if is_presigned else None,
        "storage_key": snap.storage_key,
    }


