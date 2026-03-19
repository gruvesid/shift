"""
Database setup using SQLAlchemy (synchronous).
Uses PostgreSQL everywhere — local dev via docker-compose.dev.yml, Azure via Flexible Server.
All tables are created on app startup via init_db().
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

# ── Connection URL ────────────────────────────────────────────────
# Local dev (default): PostgreSQL in docker-compose.dev.yml
# Azure production:    Set DATABASE_URL env var to Azure Flexible Server URL
_DEFAULT_DB = "postgresql://sf2user:sf2password@localhost:5433/sf2dynamics"
DATABASE_URL = os.environ.get("DATABASE_URL", _DEFAULT_DB)

_is_sqlite = DATABASE_URL.startswith("sqlite")

# ── Engine configuration ──────────────────────────────────────────
if _is_sqlite:
    # SQLite: allow same connection across threads (needed for FastAPI sync)
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        echo=os.environ.get("LOG_LEVEL", "INFO") == "DEBUG",
    )
else:
    # PostgreSQL: use connection pooling, enable pre-ping to recover stale connections
    engine = create_engine(
        DATABASE_URL,
        pool_size=int(os.environ.get("DB_POOL_SIZE", "10")),
        max_overflow=int(os.environ.get("DB_MAX_OVERFLOW", "20")),
        pool_pre_ping=True,          # verify connection is alive before using
        pool_recycle=1800,           # recycle connections older than 30 min
        echo=os.environ.get("LOG_LEVEL", "INFO") == "DEBUG",
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency — yields a DB session and closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Create all tables if they don't exist. Called once on app startup."""
    # Import models so SQLAlchemy registers them on Base.metadata
    from app.models import (  # noqa: F401
        connections, extraction_runs, converted_items, deployment_runs,
        llm_config, vector_config, rulebook, deployment_plan,
        deployment_plan_item, deployment_log, chat_session,
        org_metadata, llm_routing,
        tenant, user, otp_token, trial_request,
    )

    # For SQLite only: ensure the data directory exists
    if _is_sqlite:
        db_path = DATABASE_URL.replace("sqlite:///", "").replace("sqlite://", "")
        if db_path and not db_path.startswith(":"):
            os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)

    Base.metadata.create_all(bind=engine)

    # Add new nullable columns to existing tables (idempotent ALTER TABLE)
    from sqlalchemy import text
    _migrations = [
        "ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS flow_url TEXT",
        "ALTER TABLE deployment_plan_items ADD COLUMN IF NOT EXISTS stats_json TEXT",
    ]
    with engine.begin() as _conn:
        for _stmt in _migrations:
            try:
                if _is_sqlite:
                    cols = [r[1] for r in _conn.execute(text("PRAGMA table_info(deployment_logs)")).fetchall()]
                    if "flow_url" not in cols:
                        _conn.execute(text("ALTER TABLE deployment_logs ADD COLUMN flow_url TEXT"))
                else:
                    _conn.execute(text(_stmt))
            except Exception:
                pass

    # Seed default tenant + admin user
    _seed_defaults()


def _seed_defaults():
    """Create default Gruve tenant and admin user if not already present."""
    from app.models.tenant import Tenant
    from app.models.user import User
    from passlib.context import CryptContext
    from datetime import datetime

    pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
    db = SessionLocal()
    try:
        # Create default tenant
        tenant = db.query(Tenant).filter(Tenant.slug == "gruve").first()
        if not tenant:
            tenant = Tenant(name="Gruve AI", slug="gruve", plan="enterprise", is_active=True)
            db.add(tenant)
            db.commit()
            db.refresh(tenant)
            print("[SEED] Created tenant: Gruve AI")

        # Create admin user
        admin = db.query(User).filter(User.email == "siddhrajsinh.atodaria@gruve.ai").first()
        if not admin:
            admin = User(
                tenant_id=tenant.id,
                email="siddhrajsinh.atodaria@gruve.ai",
                name="Siddhrajsinh Atodaria",
                password_hash=pwd.hash("Test123"),
                role="admin",
                plan="enterprise",
                approval_status="approved",
                is_active=True,
                email_verified=True,
            )
            db.add(admin)
            db.commit()
            print("[SEED] Created admin: siddhrajsinh.atodaria@gruve.ai")
    except Exception as e:
        print(f"[SEED] Error: {e}")
        db.rollback()
    finally:
        db.close()
