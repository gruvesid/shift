#!/usr/bin/env python3
"""
SQLite → PostgreSQL data migration script for SF2Dynamics.

Usage (local dev — migrate into docker-compose PostgreSQL):
    cd backend
    python migrate_to_postgres.py
    # No env vars needed — defaults to localhost:5432

Usage (Azure — migrate into Azure Flexible Server):
    export PG_URL="postgresql://sf2user:password@sf2dynamics-db.postgres.database.azure.com:5432/sf2dynamics?sslmode=require"
    cd backend
    python migrate_to_postgres.py

What it does:
    - Connects to the existing SQLite DB (backend/data/sf2dynamics.db)
    - Connects to the target PostgreSQL DB
    - Creates all tables in PostgreSQL (via SQLAlchemy Base.metadata.create_all)
    - Copies every row from every table, preserving IDs and all data
    - Resets PostgreSQL sequences so auto-increment IDs continue from the right value
    - Idempotent: safe to re-run (skips rows that already exist by primary key)

Tables migrated (in dependency order):
    connections → llm_configs → vector_configs → llm_routing
    → org_metadata → field_mappings → rulebooks → extraction_runs
    → converted_items → deployment_plans → deployment_plan_items
    → deployment_logs → deployment_runs → llm_usage
    → chat_sessions → chat_messages
"""

import os
import sys
import json
from datetime import datetime, timezone

# ── Validate env ──────────────────────────────────────────────────────────────
SQLITE_URL = os.environ.get("SQLITE_URL", "sqlite:///./data/sf2dynamics.db")
# Default: local docker-compose PostgreSQL (docker-compose.dev.yml)
PG_URL     = os.environ.get("PG_URL", "postgresql://sf2user:sf2password@localhost:5433/sf2dynamics")

print(f"Source : {SQLITE_URL}")
# Mask password in output
_pg_display = PG_URL
if "@" in _pg_display:
    _pg_display = _pg_display[:_pg_display.index("//") + 2] + "***@" + _pg_display.split("@", 1)[1]
print(f"Target : {_pg_display}")
print()

# ── SQLAlchemy setup ──────────────────────────────────────────────────────────
from sqlalchemy import create_engine, text, inspect, MetaData, Table
from sqlalchemy.orm import sessionmaker

sqlite_engine = create_engine(SQLITE_URL, connect_args={"check_same_thread": False})
pg_engine     = create_engine(
    PG_URL,
    pool_pre_ping=True,
    connect_args={"connect_timeout": 30},
)

# Test PostgreSQL connection
try:
    with pg_engine.connect() as c:
        c.execute(text("SELECT 1"))
    print("[OK] PostgreSQL connection OK")
except Exception as exc:
    print(f"[ERR] Cannot connect to PostgreSQL: {exc}")
    sys.exit(1)

# Test SQLite connection
try:
    with sqlite_engine.connect() as c:
        c.execute(text("SELECT 1"))
    print("[OK] SQLite connection OK")
except Exception as exc:
    print(f"[ERR] Cannot open SQLite: {exc}")
    sys.exit(1)

print()

# ── Create tables in PostgreSQL ───────────────────────────────────────────────
# Add backend/ to path so we can import app models
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Temporarily override DATABASE_URL to point at PostgreSQL so Base is bound correctly
os.environ["DATABASE_URL"] = PG_URL

from app.database import Base
from app.models import (  # noqa: F401
    connections, extraction_runs, converted_items, deployment_runs,
    llm_config, vector_config, rulebook, deployment_plan,
    deployment_plan_item, deployment_log, chat_session,
    org_metadata, llm_routing, field_mapping, llm_usage,
)

print("Creating tables in PostgreSQL (if not exist)...")
Base.metadata.create_all(bind=pg_engine)
print("[OK] Schema ready")
print()

# ── Migration order (respects FK dependencies) ────────────────────────────────
# Each entry: (table_name, primary_key_column)
MIGRATION_ORDER = [
    ("connections",            "id"),
    ("llm_configs",            "id"),
    ("vector_configs",         "id"),
    ("llm_routing",            "id"),
    ("org_metadata",           "id"),
    ("field_mappings",         "id"),
    ("rulebooks",              "id"),
    ("extraction_runs",        "id"),
    ("converted_items",        "id"),
    ("deployment_plans",       "id"),
    ("deployment_plan_items",  "id"),
    ("deployment_logs",        "id"),
    ("deployment_runs",        "id"),
    ("llm_usage",              "id"),
    ("chat_sessions",          "id"),
    ("chat_messages",          "id"),
]

# ── Helper: reflect a table from SQLite ──────────────────────────────────────
sqlite_meta = MetaData()
sqlite_meta.reflect(bind=sqlite_engine)

total_rows_migrated = 0

# ── Migrate each table ────────────────────────────────────────────────────────
for table_name, pk_col in MIGRATION_ORDER:
    if table_name not in sqlite_meta.tables:
        print(f"  SKIP  {table_name:35s} (not in SQLite)")
        continue

    sqlite_table = sqlite_meta.tables[table_name]

    with sqlite_engine.connect() as src_conn:
        rows = src_conn.execute(sqlite_table.select()).fetchall()
        col_names = sqlite_table.columns.keys()

    if not rows:
        print(f"  EMPTY {table_name:35s} (0 rows)")
        continue

    # Convert rows to list of dicts
    row_dicts = [dict(zip(col_names, row)) for row in rows]

    # ── Sanitize: fix None datetimes and coerce types ──────────────────────
    def _sanitize(d: dict) -> dict:
        out = {}
        for k, v in d.items():
            # SQLite stores booleans as 0/1 integers — convert to bool for PG
            col = sqlite_table.columns.get(k)
            if col is not None and str(col.type) == "BOOLEAN" and isinstance(v, int):
                v = bool(v)
            out[k] = v
        return out

    row_dicts = [_sanitize(r) for r in row_dicts]

    # ── Insert with conflict skip (idempotent) ─────────────────────────────
    inserted = 0
    skipped  = 0
    errors   = []

    with pg_engine.begin() as pg_conn:
        pg_meta = MetaData()
        pg_meta.reflect(bind=pg_engine, only=[table_name])
        pg_table = pg_meta.tables[table_name]

        for row in row_dicts:
            try:
                # Use INSERT ... ON CONFLICT DO NOTHING (PostgreSQL 9.5+)
                from sqlalchemy.dialects.postgresql import insert as pg_insert
                stmt = pg_insert(pg_table).values(**row).on_conflict_do_nothing(
                    index_elements=[pk_col]
                )
                pg_conn.execute(stmt)
                inserted += 1
            except Exception as exc:
                errors.append(f"row {row.get(pk_col)}: {exc}")
                skipped += 1

    status = "[OK]" if not errors else "[WARN]"
    print(f"  {status}     {table_name:35s} {inserted:4d} rows inserted, {skipped:3d} skipped")
    if errors:
        for e in errors[:3]:
            print(f"           - {e}")
        if len(errors) > 3:
            print(f"           - ... {len(errors)-3} more errors")

    total_rows_migrated += inserted

print()
print(f"Total rows migrated: {total_rows_migrated}")
print()

# ── Reset PostgreSQL sequences ─────────────────────────────────────────────────
# After INSERT with explicit IDs, PG sequences are still at 1 — must reset them
# so future auto-increment INSERTs don't collide with migrated IDs.
print("Resetting PostgreSQL sequences...")

with pg_engine.begin() as conn:
    for table_name, pk_col in MIGRATION_ORDER:
        try:
            result = conn.execute(text(
                f"SELECT MAX({pk_col}) FROM {table_name}"
            )).scalar()
            if result is not None:
                seq_name = f"{table_name}_{pk_col}_seq"
                conn.execute(text(
                    f"SELECT setval('{seq_name}', {result}, true)"
                ))
                print(f"  [OK] {table_name}.{pk_col} sequence → {result}")
        except Exception as exc:
            # Some tables may not have a sequence (e.g. if PK is not SERIAL)
            print(f"  - {table_name}: {exc}")

print()
print("=" * 60)
print("Migration complete!")
print()
print("Next steps:")
print("  1. Set DATABASE_URL=<your PG_URL> in your app environment")
print("  2. Restart the backend — it will connect to PostgreSQL automatically")
print("  3. Verify: open the app and check all orgs, conversions, and logs are present")
print("  4. Keep the SQLite file as a backup for 30 days before deleting")
