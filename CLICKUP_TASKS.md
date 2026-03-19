# SF → Dynamics 365 Migration Wizard — ClickUp Tasks

---

## SECTION 1: Metadata Migration

---

### Task 1.1 — Org Connection Dashboard (Shift Tab)

**Task Subject:** Build Org Connection Dashboard — Metadata Migration Home Screen

**Task Detail:**
Implement the main Metadata Migration landing page (ShiftTab) that serves as the hub for managing all connected Salesforce organizations.

- **Statistics Grid (3 cards):** Connected Orgs count, Metadata Extracted count, Agent Chat Sessions count — all fetched from `GET /shift/stats`
- **Org List View:** List all connected orgs via `GET /shift/connections`, each displayed as a card showing: connection name, SF → D365 status dots, Salesforce instance URL, last metadata sync timestamp, and status badges (connected / needs_reauth / pending / completed)
- **Org Card Actions:** Edit button (fetches full config via `GET /shift/connections/{id}/config` and opens edit modal), Delete button (with confirm dialog calling `DELETE /shift/connections/{id}`), click-to-view detail navigation
- **Empty State:** When no orgs — show prompt with "+ Connect Org" CTA
- **Warning Bar:** Show re-auth warning on cards with `needs_reauth` status
- **Navigation Callbacks:** `onNavigateToConverter(orgId)` and `onNavigateToDeployment(orgId, orgName)` wired to parent App for tab routing

---

### Task 1.2 — Connect Org Modal (Salesforce + Dynamics 365 + Fabric Auth)

**Task Subject:** Build Connect / Edit Org Modal with OAuth, D365 Auth, and Fabric Test

**Task Detail:**
Implement the full-featured modal for creating and editing org connections. Supports Salesforce OAuth2 (PKCE), Dynamics 365 credential auth, and optional Fabric Data Lake testing.

- **Connection Name Field:** Required text input at top of modal
- **3-Column Layout:**
  - **Col 1 — Salesforce Source:** Client ID, Client Secret (password), Instance URL inputs. "☁ Authorize Salesforce" button triggers OAuth via `POST /shift/salesforce/authorize`. OAuth popup opened via `window.open()`, result received via `postMessage`. Status indicator shows connected/error/authorizing state.
  - **Col 2 — Target CRM (D365):** Target CRM dropdown (Dynamics 365 / HubSpot coming soon / Zoho coming soon). For D365: Azure Tenant ID, App Client ID, App Client Secret, Environment URL. "🔒 Authorize Dynamics 365" button calls `POST /shift/dynamics/authorize` (WhoAmI API validation).
  - **Col 3 — Fabric Data Lake (Optional):** Toggle switch to enable/disable. When enabled shows: Tenant ID, Service Principal ID, Service Principal Secret, SQL Server Endpoint, Database Name. "⬡ Test Fabric Connection" calls `POST /shift/fabric/test`.
- **Create vs. Edit Mode:** POST to `POST /shift/connections` for new, PUT to `PUT /shift/connections/{id}` for edit
- **Backend OAuth Callback:** `GET /shift/oauth/callback/salesforce` returns an HTML page that posts `sf-oauth-result` back to the opener window
- **PKCE Security:** In-memory PKCE state store with 10-minute TTL; state, code_challenge, code_verifier generated server-side

---

### Task 1.3 — Org Detail Page (Metadata Extraction by Type)

**Task Subject:** Build Org Detail Page with Per-Type Metadata Extraction and Status Tracking

**Task Detail:**
Implement the detailed single-org view that shows connection health and allows extracting Salesforce metadata by component type.

- **Header:** Org name, connection status badges (SF + D365), back button, metadata extraction summary status
- **Metadata Types Grid (5 cards):** One card per type — Apex Classes, Apex Triggers, Flows, LWC Components, Aura Components. Each card shows: icon, name, description, count of extracted items, and an "Extract" / "Extracting…" button
- **Individual Extraction:** `POST /shift/connections/{orgId}/extract/{metadataType}` triggers extraction; UI polls `GET /shift/connections/{orgId}/extract/{metadataType}/status` until complete
- **Extract All Button:** `POST /shift/connections/{orgId}/extract-all` — extracts all 5 types in one call
- **Sticky Bottom Action Bar:** "Extract All" button, "Go to Code Converter" button (navigates to converter tab with orgId context), "Go to Deployment Plans" button
- **Toast Notifications:** Success/error toasts for extraction results
- **Agent Chat Button:** Opens in-page modal for AI-assisted analysis (requires metadata to be extracted first)

---

### Task 1.4 — Deployment Plans — List View with Stats

**Task Subject:** Build Deployment Plans List View with Stat Cards and Plan Cards

**Task Detail:**
Implement the top-level Deployment Plans page that shows all plans for a selected org with summary statistics.

- **Header Row:** Title "🚀 Deployment Plans", subtitle with org name, "+ New Plan" button (right-aligned with green glow shadow)
- **Stat Cards Grid (4 cards):** Total, Completed (green), Draft (blue), Failed (red) — each with left accent border, left-aligned label + big number, ghost icon, fetched from `GET /shift/connections/{orgId}/plans`
- **Plan Cards List:** Each card shows: plan name, description (truncated), item counts (total / converted / failed), created date. Status-colored left border (grey=draft, green=completed, red=failed, orange=partial, yellow=deploying). Status badge (Draft / Completed / Partial / Failed). Full-width progress bar (converted/total %). Chevron arrow that animates on hover.
- **Empty State:** When no plans — icon + CTA button to create first plan
- **Create Plan Modal:** Plan name (required), description (optional textarea). Calls `POST /shift/connections/{orgId}/plans`. On success, immediately opens the new plan's detail view.
- **Navigation:** Click any plan card → opens Plan Detail view

---

### Task 1.5 — Deployment Plans — Plan Detail View (Items + Bulk Convert)

**Task Subject:** Build Plan Detail View with Item Cards, Individual Conversion, and Bulk Deploy

**Task Detail:**
Implement the inner detail view for a single deployment plan — adding components, viewing/converting items individually or in bulk.

- **Header:** Back button, editable plan name (inline edit, pencil icon, Enter to save, Escape to cancel — only in draft status), status badge, description text
- **Result Summary Cards (on completed/partial):** Total / Converted / Failed counts shown as mini cards
- **Item Cards List:** Each item card shows: type badge (CLS / TRG / LWC / AUR / FLW) with color, component name, convert status chip (Pending / Converting / Converted / Failed), action buttons
  - Converted items: 📋 Notes button, ⎘ Copy button, ⬇ Download button
  - Failed/pending with source: ↻ Retry button (calls `POST /…/items/{id}/convert`)
  - All items: 🗑 Delete button (`DELETE /…/items/{id}`)
  - Click row to expand/collapse converted code preview
  - Error message shown inline for failed items
- **Migration Notes Modal:** Full-screen modal showing LLM migration notes for a converted item
- **Add Items Modal:** Search bar + type filter pills (All / Apex Class / Apex Trigger / LWC / Aura / Flow). Select-all checkbox + individual checkboxes. Calls `GET /…/metadata-components` to list available components. Adds via `POST /…/items`.
- **Sticky Action Bar (bottom):** Item count summary, Delete Plan button (danger), + Add Items button (draft only), "🚀 Convert & Deploy All (N)" button calls `POST /…/deploy` — converts all pending items via LLM in sequence
- **Bulk Deploy Flow:** Plan status changes to `deploying` → items convert one-by-one → final status: completed / partial / failed based on results

---

### Task 1.6 — Backend: Org Connection & OAuth Router

**Task Subject:** Implement shift_router.py — Org CRUD, Salesforce OAuth, D365 Auth, Fabric Test

**Task Detail:**
Implement the full FastAPI router for org connection management with security-first design.

- **CRUD Endpoints:** `GET /shift/stats`, `GET /shift/connections`, `POST /shift/connections`, `GET /shift/connections/{id}`, `GET /shift/connections/{id}/config`, `PUT /shift/connections/{id}`, `DELETE /shift/connections/{id}`
- **Salesforce OAuth:** `POST /shift/salesforce/authorize` — generates PKCE state + code_challenge, stores in memory (10 min TTL), returns authorization URL. `GET /shift/oauth/callback/salesforce` — exchanges code for tokens, updates connection's `sf_status`, returns HTML page posting `sf-oauth-result` via postMessage.
- **Dynamics 365 Auth:** `POST /shift/dynamics/authorize` — acquires Azure AD token via MSAL (client credentials), calls D365 WhoAmI API to confirm connectivity, updates `d365_status`
- **Fabric Test:** `POST /shift/fabric/test` — tests pyodbc/SQL connection to Microsoft Fabric SQL endpoint using service principal auth
- **Status Computation:** Connection `overall_status` derived from SF + D365 statuses: `needs_reauth` if either failed, `connected` if both OK, `pending` otherwise
- **Data Model:** `connections` table with `id`, `name`, `type="org"`, `config_json` (stores all credentials + status fields)
- **Security:** All credentials stored in `config_json`; encrypted fields for secrets

---

### Task 1.7 — Backend: Deployment Plans Router + LLM Conversion Pipeline

**Task Subject:** Implement deployment_router.py — Plan CRUD, Item Management, LLM Conversion, Bulk Deploy

**Task Detail:**
Implement the deployment plans router including the full LLM-powered code conversion pipeline.

- **Plan CRUD:** `GET /plans` (with stats), `POST /plans`, `GET /plans/{id}` (with items), `PUT /plans/{id}`, `DELETE /plans/{id}`
- **Item CRUD:** `POST /plans/{id}/items` (bulk add), `DELETE /plans/{id}/items/{item_id}`
- **Metadata Component Listing:** `GET /connections/{id}/metadata-components` — flattens `OrgMetadata.metadata_json` into a flat list of `{item_type, item_name, sf_id, label}` for use in the Add Items modal
- **Source Code Fetching:** Before conversion, fetches Apex/LWC/Aura source from Salesforce REST API v59.0 using stored access token:
  - ApexClass/ApexTrigger → SOQL query on Body field
  - LWC → LightningComponentResource API
  - Aura → AuraDefinitionBundleMember API
- **LLM Conversion (`_convert_with_llm`):**
  - Reads component rulebook from DB (or DEFAULT_RULEBOOKS fallback)
  - Gets field mapping context from FieldMapping table
  - Builds system prompt (SF→D365 migration expert persona) + user prompt (source code + target)
  - Calls `_call_llm()` using default LLM config from connectors
  - Splits response on `## Migration Notes` separator
  - Strips markdown code fences from converted code
  - Returns `{converted_code, migration_notes, file_ext}`
- **TYPE_MAP:** apex_class→`.cs` (IPlugin), apex_trigger→`.cs` (IPlugin Pre/Post), lwc→`.ts` (PCF), aura→`.ts` (PCF), flow→`.json` (Power Automate)
- **Bulk Deploy (`POST /plans/{id}/deploy`):** Sets status→deploying, iterates pending items, converts each, updates converted_count/failed_count, sets final status (completed/partial/failed), records started_at/completed_at
- **Single Item Retry (`POST /…/items/{id}/convert`):** Re-fetches source + re-runs LLM conversion for one item
- **DB Models:** `DeploymentPlan` and `DeploymentPlanItem` tables with all fields above

---

## SECTION 2: LLM Connector

---

### Task 2.1 — LLM Connector Page (Frontend)

**Task Subject:** Build LLM Connector Page — Add, Test, and Manage AI Provider Configurations

**Task Detail:**
Implement the LLM Connector page for configuring OpenAI, Anthropic, and Cohere providers used across code conversion, agent chat, and sense features.

- **Provider Cards List:** List all saved LLM configs via `GET /connectors/llm`. Each card shows: provider logo (SVG icon), display name, "★ Default" badge, provider/model metadata. Action buttons: "✓ Set Default" (`POST /connectors/llm/{id}/set-default`), "✎ Edit", "🗑" Delete (`DELETE /connectors/llm/{id}`)
- **"How It Works" Info Card:** Explains default provider system, AES-256 encryption note, multiple provider support
- **Add/Edit LLM Modal:**
  - Provider selector (3 toggle buttons: OpenAI / Anthropic / Cohere)
  - Model dropdown (updates per provider):
    - OpenAI: GPT-4o, GPT-4o Mini, GPT-4 Turbo, GPT-3.5 Turbo
    - Anthropic: Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5
    - Cohere: Command R+, Command R (Aug 2024), Command R
  - API Key password input (shows "Encrypted key stored securely" in edit mode)
  - Display Name input (optional)
  - "Set as default provider" checkbox (add mode only)
  - "Test Connection" button → `POST /connectors/llm/test` → shows success/error inline
  - Save → `POST /connectors/llm` or `PUT /connectors/llm/{id}`
- **Auto-default Logic:** First config saved is auto-set as default

---

### Task 2.2 — Backend: LLM Connector Router

**Task Subject:** Implement connectors_router.py — LLM Config CRUD with Encrypted Key Storage and Provider Testing

**Task Detail:**
Implement the `/connectors/llm` FastAPI routes for managing LLM provider configurations with Fernet encryption.

- **Endpoints:** `GET /connectors/llm`, `POST /connectors/llm/test`, `POST /connectors/llm`, `PUT /connectors/llm/{id}`, `POST /connectors/llm/{id}/set-default`, `DELETE /connectors/llm/{id}`
- **Encryption:** API keys encrypted with `crypto.encrypt()` (Fernet/AES-128) before DB storage; never returned to frontend — only `has_api_key: bool` sent back
- **Test Provider (`POST /connectors/llm/test`):** Makes minimal API call (5 tokens) per provider: Anthropic `messages.create`, Cohere `generate`, OpenAI `chat.completions.create`; returns `{success, message|error}`
- **Default Logic:** On create, if `is_default=True` or no existing configs, unsets all others and sets this one. On delete, auto-promotes next config to default if deleted was default.
- **Edit Without Re-key:** If `api_key` field is blank/omitted in PUT request, skips re-encryption and keeps existing key
- **Helper Function `get_default_llm(db)`:** Returns `{provider, api_key, model}` for default config (or first created); used by deployment_router for LLM calls
- **DB Model:** `LLMConfig` with: `id`, `provider`, `api_key_encrypted`, `model`, `display_name`, `is_default`, `created_at`, `updated_at`

---

## SECTION 3: Vector Connector

---

### Task 3.1 — Vector Connector Page (Frontend)

**Task Subject:** Build Vector Connector Page — Add, Test, and Manage Qdrant/Pinecone Configurations

**Task Detail:**
Implement the Vector Connector page for configuring Qdrant or Pinecone vector databases used for RAG, Agent Chat, and Sense.

- **Config Cards List:** List all vector configs via `GET /connectors/vector`. Each card shows: provider logo (Qdrant / Pinecone SVG), display name, "Default" badge, embedding model + URL metadata. Test result inline (collection/index count). Action buttons: "⊙ Test" (`POST /connectors/vector/{id}/test`), "✎ Edit", "☆ Set Default", "🗑" Delete
- **"How It Works" Info Card:** Explains local file fallback for Qdrant dev mode, cloud mode, Pinecone managed details
- **Add/Edit Vector Modal:**
  - Provider toggle (Qdrant / Pinecone)
  - URL input (optional for Qdrant — shows "leave blank for local file" hint; required for Pinecone). Edit mode shows current URL.
  - API Key password input (optional for Qdrant; edit mode shows "Encrypted key stored" hint)
  - Embedding Model dropdown: Use app default / OpenAI text-embedding-3-small (1536 dims) / OpenAI text-embedding-3-large (3072 dims)
  - Display Name input (optional)
  - "Set as default" checkbox (add mode only)
  - "Test Connection" button → `POST /connectors/vector/test` → shows collection/index count or error
  - Save → `POST /connectors/vector` or `PUT /connectors/vector/{id}`
- **Auto-default Logic:** First config auto-set as default

---

### Task 3.2 — Backend: Vector Connector Router

**Task Subject:** Implement connectors_router.py — Vector DB Config CRUD with Qdrant/Pinecone Support and Local Fallback

**Task Detail:**
Implement the `/connectors/vector` FastAPI routes for Qdrant and Pinecone with encrypted key storage and local file fallback.

- **Endpoints:** `GET /connectors/vector`, `POST /connectors/vector/test`, `POST /connectors/vector`, `PUT /connectors/vector/{id}`, `POST /connectors/vector/{id}/set-default`, `POST /connectors/vector/{id}/test`, `DELETE /connectors/vector/{id}`
- **Qdrant Test:** Creates `QdrantClient` (remote with URL+key, OR local path if no URL), calls `get_collections()`, returns collection count
- **Pinecone Test:** Initializes Pinecone SDK, calls `list_indexes()`, returns index count
- **Vector Size Auto-Mapping:** `text-embedding-3-small` → 1536, `text-embedding-3-large` → 3072, default → 1536
- **Encryption:** API keys encrypted with Fernet before storage; `has_api_key` bool returned instead of key
- **Helper Function `get_default_qdrant_client(db)`:** Returns configured `QdrantClient` — priority: default Qdrant config → first Qdrant config → local file path fallback; used by agent chat and indexing features
- **Default & Delete Logic:** Same pattern as LLM connector
- **DB Model:** `VectorConfig` with: `id`, `provider`, `api_key_encrypted`, `url`, `display_name`, `embedding_model`, `vector_size`, `is_default`, `created_at`, `updated_at`

---

## SECTION 4: LLM Usage

---

### Task 4.1 — LLM Usage Page (Frontend)

**Task Subject:** Build LLM Usage Analytics Page — Token Tracking, Cost Reporting, and Paginated History

**Task Detail:**
Implement the LLM Usage page for tracking all AI API calls with token counts, costs, and filtering by call type.

- **Stats Row (5 cards):** Total Calls, Input Tokens (blue), Output Tokens (green), Total Tokens, Total Cost ($USD) — fetched from `GET /llm-usage/stats?call_type=X` (filtered by active pill)
- **Filter Pills:** All / ⟨/⟩ Code Convert / 💬 Agent Chat / ⬡ Indexing / ✦ Sense — selecting a pill re-fetches both stats and history
- **Usage Table (10 columns):** Time (MMM D HH:MM), Type (colored chip with icon), Model, Org (or —), Component (truncated, or —), Input tokens, Output tokens, Cost ($0.0000), Duration (ms or s), Status (green ✓ / red ✗ dot)
  - Error rows highlighted with red tint
  - Ordered newest-first
- **Pagination:** "1–50 of 1234" display, Previous/Next buttons, disabled at boundaries; 50 rows per page via `GET /llm-usage/history?limit=50&offset=N`
- **Call Type Color Coding:** Code Convert=#10b981, Agent Chat=#3b82f6, Indexing=#8b5cf6, Sense=#f59e0b
- **Empty / Loading States:** Spinner during load, "No usage recorded yet" for empty history

---

### Task 4.2 — Backend: LLM Usage Router

**Task Subject:** Implement llm_usage_router.py — Aggregated Stats and Paginated Usage History

**Task Detail:**
Implement the `/llm-usage` FastAPI routes for usage analytics reporting.

- **Stats Endpoint (`GET /llm-usage/stats`):** Optional `call_type` query param. Returns: `{total_calls, input_tokens, output_tokens, total_tokens, total_cost_usd}`. Aggregates computed in Python over DB query results.
- **History Endpoint (`GET /llm-usage/history`):** Params: `call_type` (optional filter), `limit` (default 100, max 500), `offset` (default 0). Returns: `{total, offset, limit, history: [...rows]}`. Ordered by `created_at DESC`.
- **LLMUsage DB Model:** `id`, `call_type` (code_convert|agent_chat|indexing|sense), `provider`, `model`, `connection_id`, `org_name`, `input_tokens`, `output_tokens`, `total_tokens`, `cost_usd`, `duration_ms`, `status` (success|error), `error_message`, `component_name`, `component_type`, `created_at`
- **Usage Logging:** Other routers (deployment_router, agent chat) call an internal `log_llm_usage()` helper after each LLM API call to write a row into this table
- **Serializer:** Timestamps converted to ISO string format for JSON response

---

## SECTION 5: Infrastructure & App Shell

---

### Task 5.1 — Docker + SQLite + FastAPI Backend Setup

**Task Subject:** Set Up Docker Compose, SQLite Database, and FastAPI Application Shell

**Task Detail:**
Implement the foundational infrastructure for the SF → D365 Migration Wizard.

- **Docker Compose Files:** `docker-compose.dev.yml` (Redis + Qdrant only — run backend/frontend locally), `docker-compose.yml` (all 4 services: frontend, backend, Redis, Qdrant), `docker-compose.prod.yml` (production config)
- **Database Setup (`backend/app/database.py`):** SQLAlchemy engine pointing to `backend/data/sf2dynamics.db` (SQLite), `get_db()` dependency for FastAPI, `init_db()` to create all tables on startup
- **FastAPI App (`backend/app/main.py`):** App init with lifespan calling `init_db()`, `/health` endpoint, router includes for all modules, CORS middleware
- **DB Tables (in `backend/app/models/`):** `connections` (org configs), `extraction_runs` (SF extraction jobs), `converted_items` (LLM output), `deployment_runs` (D365 jobs), `LLMConfig`, `VectorConfig`, `LLMUsage`, `DeploymentPlan`, `DeploymentPlanItem`
- **Encryption Module (`backend/app/crypto.py`):** Fernet-based `encrypt()`/`decrypt()` helpers for API key storage
- **Requirements (`backend/requirements.txt`):** sqlalchemy, fastapi, uvicorn, redis, qdrant-client, openai, anthropic, cohere, simple-salesforce, msal, cryptography, pyodbc
- **Environment Variables (`.env.example`):** All env vars documented — DB path, Redis URL, Qdrant URL, LLM keys, etc.
- **Services:** Redis 7-alpine (port 6379), Qdrant latest (port 6333), Backend Uvicorn (port 8000), Frontend React (port 3000)

---

### Task 5.2 — React App Shell + Sidebar Navigation

**Task Subject:** Build React App Shell with Sidebar Navigation, Tab Routing, and Persistent State

**Task Detail:**
Implement the main App.js shell with sidebar navigation, multi-tab routing, and localStorage-persisted state.

- **Sidebar:** Collapsible (persisted to localStorage). Nav items: Data Migration, Metadata Migration, LLM Connector, Vector Connector, LLM Usage. Active state highlight, disabled state during migration. Migration-running lock banner.
- **Topbar:** Page title that updates per active tab, status indicator dot (yellow during migration, green otherwise)
- **Tab Routing (state-based, no React Router):** `activeMainTab` drives which page renders: `data` → Data Migration steps, `metadata` → ShiftTab, `converter` → CodeConverterPage, `deployment` → DeploymentPlanPage, `llm` → LLMConnectorPage, `vector` → VectorConnectorPage, `llm_usage` → LLMUsagePage
- **Persistent State (localStorage):** `activeMainTab`, `currentTab` (data migration step), `confirmed` (step completion map), `selectedObjects`, `sidebarCollapsed`
- **Navigation Context:** `converterOrgId`, `deploymentOrgId`/`deploymentOrgName`, `metadataDetailOrgId` — ephemeral state (not persisted) wired between tabs so navigating back restores the correct org detail view
- **localStorage Safety:** `'converter'` and `'deployment'` are never persisted as `activeMainTab` (saved as `'metadata'` instead) to prevent null-orgId state on page refresh
- **Custom SVG Icons:** IconDataMigration, IconMetadata, IconLLM, IconVector, IconCodeConverter, IconLLMUsage — all inline SVG components
- **Mobile Nav:** Hamburger toggle + overlay backdrop for mobile sidebar

---

## SECTION 6: Design System & UX

---

### Task 6.1 — Dark Theme Design System (CSS Variables + Components)

**Task Subject:** Implement Dark Theme CSS Design System with Reusable Component Styles

**Task Detail:**
Implement the complete CSS design system used across all pages.

- **CSS Variables:** `--bg-primary`, `--bg-secondary`, `--bg-card`, `--bg-card-hover`, `--border`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent-primary` (#23a55e green), `--accent-hover`, `--radius-sm/md`, `--sidebar-width` (220px collapsed: 52px)
- **Deployment Plans Components:** `.dp-stat-card` (left accent border, ghost icon, left-aligned), `.dp-plan-card` (status-colored left border, progress bar, hover lift), `.dp-badge/item-status` chips, `.dp-action-bar` sticky bottom bar
- **Shift Tab Components:** `.shift-stat-card`, `.shift-orgs-header`, `.shift-connect-btn`, `.shift-plan-card`
- **Org Detail Page Components:** `.odp-page`, `.odp-section`, `.odp-action-btn`, `.odp-metadata-card`, sticky `.odp-action-bar`
- **Modal System:** `.ai-modal-overlay`, `.ai-modal`, `.ai-modal-header`, `.ai-modal-close` — used across all modals
- **Form Components:** `.rb-field`, `.rb-label`, `.rb-input`, `.rb-textarea`, `.rb-footer` — standardized form styles
- **Responsive Breakpoints:** 1400px, 1200px, 1024px, 768px, 640px, 480px — `main-content` padding and grid adjustments at each
- **Animations:** Spin keyframe for spinners, fade-in for overlays, shimmer for loading states

---

*Total Tasks: 14 (6 Frontend, 5 Backend, 2 Infrastructure, 1 Design System)*
