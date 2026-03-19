# PostgreSQL Migration Plan — SF2Dynamics

> **Goal:** Replace SQLite with PostgreSQL everywhere — local dev (Docker) and Azure production.
> Zero data loss. App works identically after migration.
> **Date:** 2026-03-14

---

## Architecture After Migration

```
Local Dev                          Azure Production
─────────────────────────────      ──────────────────────────────────
docker-compose.dev.yml:            Azure Container App:
  postgres:16-alpine (port 5432)     DATABASE_URL → Azure Flexible Server
  redis:7-alpine     (port 6379)     REDIS_URL    → Azure Cache for Redis
  qdrant:latest      (port 6333)     QDRANT_URL   → Qdrant Cloud / ACI

uvicorn (local, port 8000)         Container App (port 8000)
npm start (local, port 3000)       Static Web App / Container (port 3000)
```

**Same DATABASE_URL format everywhere.** Only the hostname changes.

---

## What Changes in Code

### Already done (in this branch)

| File | Change |
|------|--------|
| `backend/app/database.py` | Default URL → local PostgreSQL; added PG connection pooling |
| `backend/app/models/llm_config.py` | Fixed bare `Column(String)` → explicit lengths for PostgreSQL |
| `backend/app/models/llm_routing.py` | Fixed bare `Column(String)` → `Column(Text)` |
| `backend/app/models/vector_config.py` | Fixed bare `Column(String)` → explicit lengths |
| `backend/requirements.txt` | Added `psycopg2-binary>=2.9.9` |
| `docker-compose.dev.yml` | Added `postgres:16-alpine` service |
| `docker-compose.yml` | Added `postgres:16-alpine`; backend uses PG `DATABASE_URL`; removed `sqlite_data` volume |
| `.env.example` | Updated `DATABASE_URL` to PostgreSQL |
| `backend/migrate_to_postgres.py` | One-time data migration script (SQLite → PostgreSQL) |

### Nothing else changes

- All FastAPI routers — zero changes
- All SQLAlchemy queries — zero changes
- All model files (except the 3 fixed above) — zero changes
- Frontend — zero changes

---

## Step-by-Step Migration

### Phase 1 — Start PostgreSQL Locally (Docker)

```bash
# Start PostgreSQL + Redis + Qdrant
docker-compose -f docker-compose.dev.yml up -d

# Verify PostgreSQL is running
docker logs sf2d_postgres
# Should end with: "database system is ready to accept connections"
```

This creates:
- PostgreSQL on `localhost:5432`
- Database: `sf2dynamics`
- User: `sf2user` / Password: `sf2password`
- Persistent volume: `sf2dynamics-infra_postgres_data` (survives container restarts)

---

### Phase 2 — Install Python Driver

```bash
cd backend
pip install psycopg2-binary
```

---

### Phase 3 — Migrate Existing SQLite Data

Run this ONCE to copy all data from your SQLite file into the new PostgreSQL container:

```bash
cd backend

# SQLite source (your existing data)
export SQLITE_URL="sqlite:///./data/sf2dynamics.db"

# PostgreSQL target (local docker-compose — this is the default, no env var needed)
# export PG_URL="postgresql://sf2user:sf2password@localhost:5432/sf2dynamics"

python migrate_to_postgres.py
```

Expected output:
```
Source : sqlite:///./data/sf2dynamics.db
Target : postgresql://***@localhost:5432/sf2dynamics

✓ PostgreSQL connection OK
✓ SQLite connection OK

Creating tables in PostgreSQL (if not exist)...
✓ Schema ready

  ✓     connections                          1 rows inserted,   0 skipped
  ✓     llm_configs                          2 rows inserted,   0 skipped
  ✓     rulebooks                            5 rows inserted,   0 skipped
  ✓     converted_items                     47 rows inserted,   0 skipped
  ✓     deployment_logs                     18 rows inserted,   0 skipped
  ...

Resetting PostgreSQL sequences...
  ✓ connections.id sequence → 1
  ...

Migration complete!
```

---

### Phase 4 — Run Backend Locally Against PostgreSQL

```bash
cd backend

# No DATABASE_URL needed — default is postgresql://sf2user:sf2password@localhost:5432/sf2dynamics
uvicorn app.main:app --reload --port 8000
```

**Verification checklist:**
- [ ] Open http://localhost:3000
- [ ] Metadata Migration → org "Gruve POC" visible
- [ ] Code Converter → 153 components listed
- [ ] Convert a component → works
- [ ] Deployment Logs → history visible
- [ ] LLM Usage → history visible
- [ ] Field Mapping → 3 objects visible
- [ ] Rulebooks → 5 rulebooks including PA Flow rulebook

---

### Phase 5 — Provision Azure PostgreSQL

1. In Azure Portal → **Create a resource** → **Azure Database for PostgreSQL Flexible Server**

2. Settings:
   ```
   Subscription:    your subscription
   Resource group:  sf2dynamics-rg  (or existing)
   Server name:     sf2dynamics-db  (becomes sf2dynamics-db.postgres.database.azure.com)
   Region:          Same as your Container App (e.g. East US 2)
   PostgreSQL version: 16
   Workload type:   Development (cheapest — ~$12/month)
   Admin username:  sf2admin
   Admin password:  <strong password>
   ```

3. **Networking tab:**
   - Allow public access (or use VNet if your Container App is on a VNet)
   - Add your current machine's IP to the firewall rules
   - Enable "Allow Azure services" → Yes

4. After provisioning, create the database:
   ```sql
   -- Connect via Azure Portal Query editor or psql
   CREATE DATABASE sf2dynamics;
   CREATE USER sf2user WITH PASSWORD 'your-password';
   GRANT ALL PRIVILEGES ON DATABASE sf2dynamics TO sf2user;
   ```

5. Note your connection string:
   ```
   postgresql://sf2user:your-password@sf2dynamics-db.postgres.database.azure.com:5432/sf2dynamics?sslmode=require
   ```

---

### Phase 2 — Install Dependencies Locally

```bash
cd backend
pip install psycopg2-binary>=2.9.9
```

Verify:
```bash
python -c "import psycopg2; print('psycopg2 OK', psycopg2.__version__)"
```

---

### Phase 3 — Run the Migration Script

The script copies all data from SQLite → PostgreSQL and resets sequences.

```bash
cd backend

# Set environment variables
export SQLITE_URL="sqlite:///./data/sf2dynamics.db"
export PG_URL="postgresql://sf2user:your-password@sf2dynamics-db.postgres.database.azure.com:5432/sf2dynamics?sslmode=require"

# Run
python migrate_to_postgres.py
```

**Expected output:**
```
Source : sqlite:///./data/sf2dynamics.db
Target : postgresql://sf2user@***

✓ PostgreSQL connection OK
✓ SQLite connection OK

Creating tables in PostgreSQL (if not exist)...
✓ Schema ready

  ✓     connections                          1 rows inserted,   0 skipped
  ✓     llm_configs                          2 rows inserted,   0 skipped
  ✓     vector_configs                       1 rows inserted,   0 skipped
  ✓     llm_routing                          1 rows inserted,   0 skipped
  ✓     org_metadata                         1 rows inserted,   0 skipped
  ✓     field_mappings                       1 rows inserted,   0 skipped
  ✓     rulebooks                            5 rows inserted,   0 skipped
  ✓     extraction_runs                      0 rows inserted,   0 skipped
  ✓     converted_items                     47 rows inserted,   0 skipped
  ✓     deployment_plans                     3 rows inserted,   0 skipped
  ✓     deployment_plan_items               12 rows inserted,   0 skipped
  ✓     deployment_logs                     18 rows inserted,   0 skipped
  ...

Resetting PostgreSQL sequences...
  ✓ connections.id sequence → 1
  ✓ llm_configs.id sequence → 2
  ...

Migration complete!
```

The script is **idempotent** — safe to re-run if it fails halfway. Rows that already exist in PostgreSQL are skipped (`ON CONFLICT DO NOTHING`).

---

### Phase 4 — Test Locally Against PostgreSQL

Before touching Azure, verify the app works locally with PostgreSQL:

```bash
cd backend

# Point app at PostgreSQL (NOT SQLite)
export DATABASE_URL="postgresql://sf2user:your-password@sf2dynamics-db.postgres.database.azure.com:5432/sf2dynamics?sslmode=require"

# Start backend
uvicorn app.main:app --reload --port 8000
```

**Verification checklist:**
- [ ] Open app at http://localhost:3000
- [ ] Metadata Migration tab → org "Gruve POC" visible
- [ ] Code Converter → 153 components listed
- [ ] Click a component → source loads
- [ ] Convert a component → LLM runs, result shows
- [ ] Deployment Logs → history visible
- [ ] LLM Usage → usage history visible
- [ ] Field Mapping tab → 3 objects (Account, Contact, Opportunity) visible
- [ ] Rulebooks → 5 rulebooks including PA Flow rulebook

---

### Phase 5 — Update Azure Container App

Once local testing passes, update the Azure Container App environment variable:

```bash
# Azure CLI
az containerapp update \
  --name sf2dynamics-backend \
  --resource-group sf2dynamics-rg \
  --set-env-vars \
    "DATABASE_URL=postgresql://sf2user:your-password@sf2dynamics-db.postgres.database.azure.com:5432/sf2dynamics?sslmode=require"
```

Or via Azure Portal:
1. Container Apps → sf2dynamics-backend → **Configuration** → **Environment variables**
2. Add / update `DATABASE_URL` with the PostgreSQL connection string
3. Click **Save** → container restarts automatically

---

### Phase 6 — (Optional) Tighten Networking

For production security, move the DB to a private VNet:

1. Create a VNet with two subnets: `app-subnet` and `db-subnet`
2. Enable VNet integration on the Container App → `app-subnet`
3. Deploy PostgreSQL with VNet injection → `db-subnet`
4. Remove the public IP firewall rules from PostgreSQL
5. Connection string stays the same (private DNS resolves internally)

---

## Environment Variables Reference

| Variable | Local Dev | Azure Production |
|----------|-----------|-----------------|
| `DATABASE_URL` | `postgresql://sf2user:sf2password@localhost:5432/sf2dynamics` | `postgresql://sf2user:pass@host.postgres.database.azure.com:5432/sf2dynamics?sslmode=require` |
| `POSTGRES_PASSWORD` | `sf2password` (docker-compose default) | Set in Container App env vars |
| `DB_POOL_SIZE` | `10` (default) | `10` (default) |
| `DB_MAX_OVERFLOW` | `20` (default) | `20` (default) |

---

## Day-to-Day Local Dev Workflow

```bash
# 1. Start infra (PostgreSQL + Redis + Qdrant) — run once, stays up
docker-compose -f docker-compose.dev.yml up -d

# 2. Start backend (no DATABASE_URL needed — default is localhost:5432)
cd backend && uvicorn app.main:app --reload --port 8000

# 3. Start frontend
cd frontend && npm start

# 4. Stop infra when done for the day
docker-compose -f docker-compose.dev.yml down
# Data is preserved in the postgres_data Docker volume
```

---

## Rollback Plan

If anything goes wrong after switching to PostgreSQL on Azure, revert to local PostgreSQL connection:

```bash
# Remove Azure DATABASE_URL — app will fail to start since default is localhost
# Instead, point it back to the last known good PostgreSQL URL
az containerapp update \
  --name sf2dynamics-backend \
  --resource-group sf2dynamics-rg \
  --set-env-vars "DATABASE_URL=postgresql://sf2user:pass@old-server:5432/sf2dynamics?sslmode=require"
```

The SQLite file (`backend/data/sf2dynamics.db`) is untouched — it was the source of the migration, never the target. It remains as a backup.

---

## Azure PostgreSQL Cost Estimate

| Tier | vCores | RAM | Storage | Est. Monthly |
|------|--------|-----|---------|-------------|
| Burstable B1ms | 1 | 2 GB | 32 GB | ~$12 |
| Burstable B2s  | 2 | 4 GB | 32 GB | ~$25 |
| General Purpose D2s | 2 | 8 GB | 128 GB | ~$120 |

**Recommendation:** Start with **Burstable B1ms** (~$12/month). Upgrade if you see CPU throttling under load.

---

## Troubleshooting

### `psycopg2.OperationalError: SSL connection is required`
Add `?sslmode=require` to the connection string. Azure PostgreSQL enforces SSL by default.

### `connection refused` from migration script
Add your current machine's IP to the PostgreSQL firewall in Azure Portal → Server → Networking.

### `duplicate key value violates unique constraint`
The migration script uses `ON CONFLICT DO NOTHING` — re-run is safe. If you see this on first run, a partial migration happened before. Re-run from scratch after dropping PostgreSQL tables:
```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
```

### Sequence reset errors (`relation "tablename_id_seq" does not exist`)
Some tables may use `BIGSERIAL` instead of `SERIAL`. The script logs these as warnings — they are non-fatal. PostgreSQL will handle the sequence automatically for new rows.

### App connects to SQLite even after setting `DATABASE_URL`
Check for a `.env` file in `backend/` that overrides the environment variable. The app loads `python-dotenv` — `.env` takes priority over shell exports. Update `.env` directly.

---

## Local Dev After Migration

**Keep using SQLite locally** — no change needed for day-to-day development:

```bash
# Local dev: no DATABASE_URL set → defaults to SQLite
cd backend
uvicorn app.main:app --reload

# Azure / staging: set DATABASE_URL in env or .env
DATABASE_URL=postgresql://... uvicorn app.main:app
```

This means your local environment is always fast (SQLite) and Azure always uses the shared PostgreSQL database.
