"""
ExamProctor.ai — PDF report generation using ReportLab.

Reports are built from PERSISTED records only. Evidence images are the real stored JPEG bytes
(read from the authorized snapshot store, integrity-checked against the registered SHA-256) and
are embedded with ReportLab. Nothing is fabricated: when evidence is missing the report says
*why* (never captured / still uploading / stored file unavailable / image unreadable).

`render_report_pdf()` is the shared renderer (also used by recorded-video analysis reports).
"""

import hashlib
import io
import os
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.db.session import get_db
from app.db.models import ExamAttempt, Exam, User, ProctorEvent, Snapshot
from app.core.permissions import ProfessorUser
from app.core.errors import NotFoundError, ForbiddenError
from app.core.config import settings

router = APIRouter(prefix="/reports", tags=["reports"])

MAX_REPORT_IMAGES = 200          # bound memory / PDF size
IMG_MAX_W_CM = 9.0
IMG_MAX_H_CM = 6.75

EVIDENCE_TYPES = {"face_absent", "multiple_faces", "sustained_head_turn", "phone_detected"}

DISCLAIMER = (
    "<b>Important Notice:</b> The events listed in this report describe observable camera conditions "
    "detected by automated algorithms. These observations represent technical detections only and "
    "do not constitute proof of misconduct or dishonest intent. All reported events require "
    "appropriate human review and contextual evaluation before any disciplinary action is considered. "
    "ExamProctor.ai does not automatically determine that any student cheated based solely on "
    "automated detections."
)


# ── Formatting helpers ────────────────────────────────────────────────────────

def _fmt_dt(dt) -> str:
    if not dt:
        return "-"
    if isinstance(dt, str):
        return dt[:19].replace("T", " ")
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def fmt_duration(ms) -> str:
    """Human duration. Never invents a value: None -> '-'."""
    if ms is None:
        return "-"
    if ms == 0:
        return "instant"
    if ms < 1000:
        return f"{ms} ms"
    return f"{ms / 1000:.1f} s"


def _esc(text) -> str:
    return (str(text) if text is not None else "-").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── Evidence image preparation ────────────────────────────────────────────────

def prepare_image(image_bytes: bytes):
    """Validate a JPEG/PNG and return (BytesIO, width_pt, height_pt). Raises ValueError if invalid."""
    from reportlab.lib.units import cm
    from PIL import Image as PILImage

    try:
        with PILImage.open(io.BytesIO(image_bytes)) as im:
            im.verify()  # structural check
        with PILImage.open(io.BytesIO(image_bytes)) as im:
            w, h = im.size
            im.load()  # forces full decode: catches truncated/corrupt data
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"unreadable image: {e}") from e
    if w <= 0 or h <= 0:
        raise ValueError("empty image")
    scale = min(IMG_MAX_W_CM * cm / w, IMG_MAX_H_CM * cm / h, 1e9)
    return io.BytesIO(image_bytes), w * scale, h * scale


def load_snapshot_bytes(snap: Snapshot, blob_bytes: bytes | None = None):
    """
    Read a stored snapshot safely. Returns (bytes|None, status, message):
      ('image',        ...) bytes verified against the registered checksum
      ('pending',      ...) registered but binary not (yet) acknowledged by server
      ('file_missing', ...) server believes it is stored but file is not readable/safe
      ('corrupt',      ...) bytes do not match the registered checksum
    """
    if snap.storage_status != "uploaded":
        return None, "pending", f"Evidence upload not completed (status: {snap.storage_status})."

    # 1. Check PostgreSQL blob bytes if supplied or attached to model
    data = blob_bytes
    if data is None and hasattr(snap, "blob") and snap.blob is not None:
        data = getattr(snap.blob, "image_data", None)

    if data is not None:
        if len(data) > settings.MAX_SNAPSHOT_SIZE_BYTES:
            return None, "corrupt", "Evidence file exceeds the permitted size."
        if snap.sha256 and hashlib.sha256(data).hexdigest().lower() != snap.sha256.lower():
            return None, "corrupt", "Evidence file failed its integrity check (checksum mismatch)."
        return data, "image", ""

    # 2. S3 / Neon Object Storage check
    if snap.storage_key and not snap.storage_key.startswith("postgres://") and not os.path.isabs(snap.storage_key):
        try:
            from app.services import s3_storage
            s3_data = s3_storage.get_object(snap.storage_key, bucket_type="snapshot")
            if s3_data:
                if len(s3_data) > settings.MAX_SNAPSHOT_SIZE_BYTES:
                    return None, "corrupt", "Evidence file exceeds the permitted size."
                if snap.sha256 and hashlib.sha256(s3_data).hexdigest().lower() != snap.sha256.lower():
                    return None, "corrupt", "Evidence file failed its integrity check (checksum mismatch)."
                return s3_data, "image", ""
        except Exception:
            pass

    # 3. Legacy filesystem fallback
    from app.api.v1.snapshots import resolve_snapshot_path
    path = resolve_snapshot_path(snap)
    if path is None:
        return None, "file_missing", "Evidence file is unavailable on the server."
    try:
        if path.stat().st_size > settings.MAX_SNAPSHOT_SIZE_BYTES:
            return None, "corrupt", "Evidence file exceeds the permitted size."
        data = path.read_bytes()
    except OSError:
        return None, "file_missing", "Evidence file could not be read."
    if snap.sha256 and hashlib.sha256(data).hexdigest().lower() != snap.sha256.lower():
        return None, "corrupt", "Evidence file failed its integrity check (checksum mismatch)."
    return data, "image", ""


# ── Shared PDF renderer ───────────────────────────────────────────────────────

def render_report_pdf(report: dict) -> bytes:
    """
    report = {
      title, subtitle, info_rows: [(label, value)],
      summary: [(label, count)],
      events: [{ label, status, start, end, duration_ms, received, confidence, detail,
                 evidence: {state: 'image'|'not_applicable'|'unavailable'|'pending'|'file_missing'|'corrupt',
                            image_bytes, message, captured, snapshot_id} }],
      notes: [str]
    }
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.lib import colors
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, KeepTogether,
        Image as RLImage,
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, topMargin=2*cm, bottomMargin=2*cm, leftMargin=2*cm, rightMargin=2*cm,
        title=report.get("title", "ExamProctor.ai Report"),
    )
    styles = getSampleStyleSheet()
    navy = colors.HexColor("#172554")
    orange = colors.HexColor("#F97316")
    blue_light = colors.HexColor("#DCEBFF")
    cream = colors.HexColor("#FFF8EE")
    red = colors.HexColor("#DC2626")

    title_style = ParagraphStyle("Title", parent=styles["Title"], textColor=navy, fontSize=22, spaceAfter=6)
    heading_style = ParagraphStyle("Heading", parent=styles["Heading2"], textColor=navy, fontSize=14)
    body_style = ParagraphStyle("Body", parent=styles["Normal"], textColor=navy, fontSize=10, leading=14)
    small_style = ParagraphStyle("Small", parent=body_style, fontSize=8.5, leading=11)
    evid_note = ParagraphStyle("EvNote", parent=body_style, textColor=red, fontSize=9)
    disclaimer_style = ParagraphStyle(
        "Disclaimer", parent=styles["Normal"], textColor=navy, fontSize=9,
        borderColor=orange, borderWidth=1, borderPadding=8, backColor=colors.HexColor("#FFEDD5"), leading=14,
    )

    story = [
        Paragraph("ExamProctor.ai", title_style),
        Paragraph(_esc(report.get("title", "Examination Integrity Report")),
                  ParagraphStyle("Sub", parent=styles["Normal"], textColor=orange, fontSize=14)),
    ]
    if report.get("subtitle"):
        story.append(Paragraph(_esc(report["subtitle"]), body_style))
    story += [Spacer(1, 0.4*cm), HRFlowable(width="100%", thickness=2, color=navy), Spacer(1, 0.4*cm)]

    rows = [[Paragraph(f"<b>{_esc(k)}</b>", body_style), Paragraph(_esc(v), body_style)]
            for k, v in report.get("info_rows", [])]
    if rows:
        t = Table(rows, colWidths=[5*cm, 12*cm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (0, -1), blue_light),
            ("ROWBACKGROUNDS", (1, 0), (-1, -1), [colors.white, cream]),
            ("GRID", (0, 0), (-1, -1), 0.5, navy),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story += [t, Spacer(1, 0.5*cm)]

    # Summary of confirmed episodes per type
    summary = report.get("summary", [])
    if summary:
        story.append(Paragraph("Event Summary", heading_style))
        srows = [["Event Type", "Episodes"]] + [[_label(k), str(v)] for k, v in summary]
        st = Table(srows, colWidths=[8*cm, 3*cm])
        st.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), navy), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("TEXTCOLOR", (0, 1), (-1, -1), navy), ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.5, navy),
        ]))
        story += [st, Spacer(1, 0.5*cm)]

    events = report.get("events", [])
    story.append(Paragraph(f"Event Timeline and Evidence ({len(events)})", heading_style))
    story.append(Spacer(1, 0.2*cm))
    if not events:
        story.append(Paragraph("No monitoring events recorded.", body_style))

    images_embedded = 0
    for idx, e in enumerate(events, start=1):
        head = [
            [Paragraph(f"<b>#{idx} {_esc(_label(e.get('label')))}</b>", body_style),
             Paragraph(f"Status: {_esc(e.get('status'))}", body_style)],
            [Paragraph(f"Start: {_esc(e.get('start'))}", small_style),
             Paragraph(f"End: {_esc(e.get('end'))}", small_style)],
            [Paragraph(f"Duration: {_esc(fmt_duration(e.get('duration_ms')))}", small_style),
             Paragraph(f"Server received: {_esc(e.get('received'))}", small_style)],
        ]
        if e.get("confidence") is not None or e.get("detail"):
            conf = f"Confidence: {e['confidence']:.2f}" if e.get("confidence") is not None else ""
            head.append([Paragraph(_esc(conf), small_style), Paragraph(_esc(e.get("detail") or ""), small_style)])
        ht = Table(head, colWidths=[8.5*cm, 8.5*cm])
        ht.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), blue_light),
            ("BOX", (0, 0), (-1, -1), 0.8, navy),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        block = [ht]

        ev = e.get("evidence") or {"state": "not_applicable"}
        state = ev.get("state")
        if state == "image" and ev.get("image_bytes") and images_embedded < MAX_REPORT_IMAGES:
            try:
                bio, w, h = prepare_image(ev["image_bytes"])
                block.append(Spacer(1, 0.15*cm))
                block.append(RLImage(bio, width=w, height=h))
                images_embedded += 1
                block.append(Paragraph(
                    f"Evidence captured: {_esc(ev.get('captured'))} &nbsp;|&nbsp; "
                    f"Snapshot {_esc(str(ev.get('snapshot_id', '-'))[:8])}", small_style))
            except ValueError:
                block.append(Paragraph("Evidence image is present but unreadable (invalid image data).", evid_note))
        elif state == "image":
            block.append(Paragraph("Evidence image omitted from this PDF (report image limit reached).", evid_note))
        elif state == "pending":
            block.append(Paragraph(f"Evidence pending: {_esc(ev.get('message'))}", evid_note))
        elif state == "file_missing":
            block.append(Paragraph(f"Evidence unavailable: {_esc(ev.get('message'))}", evid_note))
        elif state == "corrupt":
            block.append(Paragraph(f"Evidence rejected: {_esc(ev.get('message'))}", evid_note))
        elif state == "unavailable":
            block.append(Paragraph(f"No evidence image: {_esc(ev.get('message') or 'not captured')}", evid_note))
        # 'not_applicable' (e.g. tab hidden): no evidence line needed
        block.append(Spacer(1, 0.35*cm))
        story.append(KeepTogether(block))

    for n in report.get("notes", []):
        story.append(Paragraph(_esc(n), small_style))
    story += [Spacer(1, 0.4*cm), Paragraph(DISCLAIMER, disclaimer_style)]

    doc.build(story)
    return buf.getvalue()


def _label(t) -> str:
    return str(t or "-").replace("_", " ").title()


# ── Attempt report data ───────────────────────────────────────────────────────

async def _authorize(db: AsyncSession, attempt_id: str, actor: dict):
    attempt = (await db.execute(select(ExamAttempt).where(ExamAttempt.attempt_id == attempt_id))).scalars().first()
    if not attempt:
        raise NotFoundError("Attempt")
    from app.api.v1.attempts import reconcile_attempt_submission_state
    await reconcile_attempt_submission_state(db, attempt)
    exam = (await db.execute(select(Exam).where(Exam.exam_id == attempt.exam_id))).scalars().first()
    if exam and exam.owner_user_id != actor["sub"] and actor["role"] != "admin":
        raise ForbiddenError()
    return attempt, exam


def build_attempt_pdf_data(attempt, exam, student, events, snapshots, with_images=True, blob_map: dict[str, bytes] | None = None) -> dict:
    """Assemble the shared-renderer structure from persisted records (pure given its inputs)."""
    by_event: dict[str, list] = {}
    for s in snapshots:
        # Only evidence that belongs to THIS attempt may ever be shown.
        if s.attempt_id == attempt.attempt_id and s.event_id:
            by_event.setdefault(s.event_id, []).append(s)

    event_rows = []
    counts: dict[str, int] = {}
    for e in events:
        if e.event_status != "confirmed":
            continue  # rejected/candidate rows are never reported as violations
        counts[e.event_type] = counts.get(e.event_type, 0) + 1
        meta = e.meta or {}
        ev: dict
        snaps = sorted(by_event.get(e.event_id, []), key=lambda s: s.client_captured_at)
        if e.event_type not in EVIDENCE_TYPES and not snaps:
            ev = {"state": "not_applicable"}
        else:
            if not snaps:
                msg = ("Evidence could not be captured on the student's device."
                       if meta.get("evidence_unavailable") else "No snapshot has been received for this event.")
                ev = {"state": "unavailable", "message": msg}
            else:
                snap = snaps[0]  # one representative image per continuous event
                if with_images:
                    blob_b = blob_map.get(snap.snapshot_id) if blob_map else getattr(snap, "_blob_bytes", None)
                    try:
                        data, state, msg = load_snapshot_bytes(snap, blob_bytes=blob_b)
                    except TypeError:
                        data, state, msg = load_snapshot_bytes(snap)
                else:
                    data, state, msg = None, ("image" if snap.storage_status == "uploaded" else "pending"), ""
                ev = {"state": state, "image_bytes": data, "message": msg,
                      "captured": _fmt_dt(snap.client_captured_at), "snapshot_id": snap.snapshot_id,
                      "capture_reason": getattr(snap, "capture_reason", "evidence")}
        event_rows.append({
            "label": e.event_type,
            "status": e.event_status,
            "start": _fmt_dt(e.client_started_at),
            "end": _fmt_dt(e.client_ended_at) if e.client_ended_at else "in progress / not recorded",
            "duration_ms": e.duration_ms,
            "received": _fmt_dt(e.server_received_at),
            "confidence": float(e.confidence) if e.confidence is not None else None,
            "evidence": ev,
        })

    return {
        "title": "Examination Integrity Report",
        "subtitle": exam.title if exam else None,
        "info_rows": [
            ("Examination", exam.title if exam else "-"),
            ("Student", student.full_name if student else "Unknown"),
            ("USN", (student.usn_normalized if student else None) or "-"),
            ("Attempt ID", attempt.attempt_id),
            ("Attempt Number", str(attempt.attempt_number)),
            ("Status", (attempt.status or "-").upper()),
            ("Start Time (client)", _fmt_dt(attempt.client_started_at or attempt.server_started_at)),
            ("Submission Time (client)", _fmt_dt(attempt.client_submitted_at or (attempt.server_submitted_at if attempt.submission_received else None))),
            ("Submission Received (server)", _fmt_dt(attempt.server_submitted_at)),
            ("Server Confirmed", "Yes" if (attempt.submission_received or attempt.status == "submitted") else "No"),
            ("Last Sync Sequence", str(attempt.last_accepted_sequence or attempt.final_sequence or 0)),
        ],
        "summary": sorted(counts.items()),
        "events": event_rows,
        "notes": [
            "Event times are the student device's clock (client time); 'Server received' is when the "
            "server stored the record. Durations are measured on a monotonic clock on the device.",
        ],
    }


def _generate_pdf_report(data: dict) -> bytes:
    """Back-compat wrapper: render an already-assembled report structure."""
    return render_report_pdf(data)


async def _load(db: AsyncSession, attempt_id: str, actor: dict, with_images: bool):
    attempt, exam = await _authorize(db, attempt_id, actor)
    student = (await db.execute(select(User).where(User.user_id == attempt.student_user_id))).scalars().first()
    events = (await db.execute(
        select(ProctorEvent).where(ProctorEvent.attempt_id == attempt_id).order_by(ProctorEvent.client_started_at)
    )).scalars().all()
    snapshots = (await db.execute(
        select(Snapshot).where(Snapshot.attempt_id == attempt_id)
    )).scalars().all()
    return attempt, exam, student, events, snapshots


@router.get("/attempts/{attempt_id}")
async def get_attempt_report(
    attempt_id: str,
    actor: ProfessorUser,
    db: AsyncSession = Depends(get_db),
):
    """Get report data for an attempt (all values come from persisted server records)."""
    attempt, exam, student, events, snapshots = await _load(db, attempt_id, actor, with_images=False)

    summary: dict[str, dict] = {}
    for e in events:
        summary.setdefault(e.event_type, {"total": 0, "confirmed": 0})
        summary[e.event_type]["total"] += 1
        if e.event_status == "confirmed":
            summary[e.event_type]["confirmed"] += 1

    return {
        "data": {
            "attempt_id": attempt_id,
            "exam_title": exam.title if exam else "-",
            "student_name": student.full_name if student else "Unknown",
            "student_usn": student.usn_normalized if student else None,
            "attempt_number": attempt.attempt_number,
            "status": attempt.status,
            "client_started_at": (attempt.client_started_at or attempt.server_started_at).isoformat() if (attempt.client_started_at or attempt.server_started_at) else None,
            "client_submitted_at": attempt.client_submitted_at.isoformat() if attempt.client_submitted_at else (attempt.server_submitted_at.isoformat() if attempt.submission_received else None),
            "server_submitted_at": attempt.server_submitted_at.isoformat() if attempt.server_submitted_at else None,
            "last_accepted_sequence": attempt.last_accepted_sequence or attempt.final_sequence or 0,
            "submission_received": attempt.submission_received or attempt.status == "submitted",
            "event_summaries": [
                {"event_type": k, "total": v["total"], "confirmed": v["confirmed"]}
                for k, v in summary.items()
            ],
            "events": [
                {
                    "event_id": e.event_id,
                    "event_type": e.event_type,
                    "event_status": e.event_status,
                    "client_started_at": e.client_started_at.isoformat(),
                    "client_ended_at": e.client_ended_at.isoformat() if e.client_ended_at else None,
                    "server_received_at": e.server_received_at.isoformat() if e.server_received_at else None,
                    "duration_ms": e.duration_ms,
                    "confidence": float(e.confidence) if e.confidence is not None else None,
                    "metadata": e.meta or {},
                }
                for e in events
            ],
            "snapshots": [
                {
                    "snapshot_id": s.snapshot_id,
                    "event_id": s.event_id,
                    "capture_reason": s.capture_reason,
                    "client_captured_at": s.client_captured_at.isoformat(),
                    "storage_status": s.storage_status,
                    "size_bytes": s.size_bytes,
                    "sha256": s.sha256,
                }
                for s in snapshots
            ],
        }
    }


@router.get("/attempts/{attempt_id}/pdf")
async def download_pdf_report(
    attempt_id: str,
    actor: ProfessorUser,
    db: AsyncSession = Depends(get_db),
):
    """Generate and download a PDF report (with embedded evidence images) for an attempt."""
    attempt, exam, student, events, snapshots = await _load(db, attempt_id, actor, with_images=True)
    blob_map: dict[str, bytes] = {}
    snap_ids = [s.snapshot_id for s in snapshots]
    if snap_ids:
        from app.db.models import SnapshotBlob
        blob_rows = (await db.execute(
            select(SnapshotBlob.snapshot_id, SnapshotBlob.image_data)
            .where(SnapshotBlob.snapshot_id.in_(snap_ids))
        )).all()
        blob_map = {row[0]: row[1] for row in blob_rows}

    pdf_bytes = render_report_pdf(build_attempt_pdf_data(attempt, exam, student, events, snapshots, with_images=True, blob_map=blob_map))
    filename = f"examproctor_report_{attempt_id[:8]}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
