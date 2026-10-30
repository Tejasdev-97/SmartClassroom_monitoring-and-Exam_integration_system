"""
ExamProctor.ai — Main FastAPI application entry point.
"""

from contextlib import asynccontextmanager
import uuid

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import settings
from app.core.errors import (
    AppError, app_error_handler,
    http_exception_handler, validation_exception_handler,
)
from app.api.v1 import (
    auth, users, exams, questions, attempts, sync, snapshots, monitoring,
    reports, retakes, settings as settings_router, video_analysis,
)

# ── Classroom monitoring routers (additive — new module, zero changes above) ──
from app.classroom.api import (
    devices as classroom_devices,
    sessions as classroom_sessions,
    alerts as classroom_alerts,
    commands as classroom_commands,
    policies as classroom_policies,
    agent_events as classroom_agent_events,
    ws as classroom_ws,
)


class _BodyCacheMiddleware(BaseHTTPMiddleware):
    """Cache request body bytes so sync agent endpoints can re-read it."""
    async def dispatch(self, request: Request, call_next):
        body = await request.body()
        request.state._body = body
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup/shutdown lifecycle."""
    # Ensure storage directory exists
    from pathlib import Path
    Path(settings.SNAPSHOT_LOCAL_DIR).mkdir(parents=True, exist_ok=True)

    # ── Classroom monitoring: create SQLite tables + seed default policy ──────
    from app.classroom.db import init_classroom_db
    from app.classroom.api.policies import seed_default_policy
    from app.classroom.db import ClassroomSessionLocal
    init_classroom_db()
    with ClassroomSessionLocal() as _db:
        seed_default_policy(_db)
    # ─────────────────────────────────────────────────────────────────────────

    yield
    # Cleanup on shutdown


app = FastAPI(
    title="ExamProctor.ai",
    description="AI-powered examination management and computer-vision proctoring platform.",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs" if settings.APP_ENV == "development" else None,
    redoc_url="/api/redoc" if settings.APP_ENV == "development" else None,
)

# ── Body cache (for sync classroom agent endpoints) ──────────────────────────
app.add_middleware(_BodyCacheMiddleware)

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Exception handlers ────────────────────────────────────────────────────────
app.add_exception_handler(AppError, app_error_handler)
app.add_exception_handler(HTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)

# ── API routers ───────────────────────────────────────────────────────────────
PREFIX = "/api/v1"

app.include_router(auth.router, prefix=PREFIX)
app.include_router(users.router, prefix=PREFIX)
app.include_router(exams.router, prefix=PREFIX)
app.include_router(questions.router, prefix=PREFIX)
app.include_router(attempts.router, prefix=PREFIX)
app.include_router(sync.router, prefix=PREFIX)
app.include_router(snapshots.router, prefix=PREFIX)
app.include_router(monitoring.router, prefix=PREFIX)
app.include_router(reports.router, prefix=PREFIX)
app.include_router(retakes.router, prefix=PREFIX)
app.include_router(settings_router.router, prefix=PREFIX)
app.include_router(video_analysis.router, prefix=PREFIX)

# ── Classroom monitoring routers (all under /api/v1) ──────────────────────────
app.include_router(classroom_policies.router,       prefix=PREFIX)
app.include_router(classroom_devices.router,        prefix=PREFIX)
app.include_router(classroom_sessions.router,       prefix=PREFIX)
app.include_router(classroom_alerts.router,         prefix=PREFIX)
app.include_router(classroom_commands.session_router, prefix=PREFIX)
app.include_router(classroom_commands.device_router,  prefix=PREFIX)
app.include_router(classroom_agent_events.router,   prefix=PREFIX)
app.include_router(classroom_ws.router)                 # WS paths: no prefix


# ── Health / readiness ────────────────────────────────────────────────────────

@app.get("/api/v1/health", tags=["health"])
async def health():
    return {"status": "ok"}


@app.get("/api/v1/ready", tags=["health"])
async def ready():
    from app.db.session import engine
    try:
        async with engine.connect() as conn:
            await conn.execute(__import__("sqlalchemy").text("SELECT 1"))
        db_status = "available"
    except Exception:
        db_status = "unavailable"

    status_code = 200 if db_status == "available" else 503
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=status_code,
        content={"status": "ready" if db_status == "available" else "not_ready",
                 "dependencies": {"database": db_status}},
    )


# ── Root redirect ─────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def root():
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/api/docs")
