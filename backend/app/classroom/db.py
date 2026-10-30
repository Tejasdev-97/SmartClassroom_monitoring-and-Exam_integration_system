"""
ExamProctor.ai — Classroom Monitoring: Independent SQLite database engine.

This module creates and manages a SEPARATE SQLAlchemy session factory
that connects to a local SQLite file. It is completely isolated from
the existing PostgreSQL engine in app.db.session and does not touch
any of the original tables.

The classroom DB stores:
  - classroom_devices
  - classroom_sessions
  - classroom_session_devices
  - classroom_policies
  - desktop_activity_events
  - browser_activity_events
  - classroom_alerts
  - instructor_commands
  - classroom_sync_log
"""

import os
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase, Session

# ── File location ─────────────────────────────────────────────────────────────
# Default to ./storage/classroom.db relative to the backend working directory.
# Override via CLASSROOM_DB_PATH environment variable.
_default_db_path = str(
    Path(os.environ.get("CLASSROOM_DB_PATH", "./storage/classroom.db")).resolve()
)

# Ensure storage directory exists before creating the engine
Path(_default_db_path).parent.mkdir(parents=True, exist_ok=True)


# ── SQLite engine (synchronous — SQLite's async support requires aiosqlite,
#    but for the classroom local DB we use sync sessions via run_in_executor
#    or direct sync calls to keep the setup simple and dependency-minimal).
# ─────────────────────────────────────────────────────────────────────────────
# Production: set CLASSROOM_DATABASE_URL to a SYNC PostgreSQL URL (e.g. postgresql+psycopg2://...)
# so classroom state survives restarts/redeploys. Unset => local SQLite file (development only).
_classroom_url = os.environ.get("CLASSROOM_DATABASE_URL", "").strip()
_is_sqlite = not _classroom_url
if _is_sqlite:
    classroom_engine = create_engine(
        f"sqlite:///{_default_db_path}",
        connect_args={"check_same_thread": False},
        echo=os.environ.get("APP_ENV") == "development",
    )
else:
    classroom_engine = create_engine(_classroom_url, pool_pre_ping=True)


if _is_sqlite:
    # Enable WAL mode and foreign keys for every SQLite connection
    @event.listens_for(classroom_engine, "connect")
    def _set_sqlite_pragmas(dbapi_conn, _connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


ClassroomSessionLocal = sessionmaker(
    bind=classroom_engine,
    autoflush=False,
    autocommit=False,
)


class ClassroomBase(DeclarativeBase):
    """Shared declarative base for ALL classroom ORM models.
    MUST NOT be mixed with app.db.session.Base."""
    pass


def get_classroom_db() -> Session:
    """
    FastAPI dependency that yields a sync SQLite classroom DB session.

    Usage:
        db: Session = Depends(get_classroom_db)
    """
    db = ClassroomSessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_classroom_db() -> None:
    """Create all classroom tables if they do not already exist.
    Called at application startup from lifespan."""
    # Import models here to register them against ClassroomBase
    from app.classroom import models  # noqa: F401
    ClassroomBase.metadata.create_all(bind=classroom_engine)
