# Flow Feature — Technical Implementation Reference

> **Scope:** Everything built for Salesforce Flow → Microsoft Power Automate pipeline
> **App:** SF2Dynamics Migration Wizard
> **Stack:** FastAPI (Python) backend · React 18 frontend · PostgreSQL · MSAL SP auth

---

## Table of Contents

1. [Flow Extraction from Salesforce](#1-flow-extraction-from-salesforce)
2. [Flow Display — Three Views](#2-flow-display--three-views)
3. [Flow Conversion via LLM](#3-flow-conversion-via-llm)
4. [Flow Rulebook](#4-flow-rulebook)
5. [Edit & Save Converted Flow](#5-edit--save-converted-flow)
6. [Deploy to Power Automate (Dataverse API)](#6-deploy-to-power-automate-dataverse-api)
7. [Connection Fix — Environments Endpoint](#7-connection-fix--environments-endpoint)
8. [Fix Button — LLM Auto-Fix on Error](#8-fix-button--llm-auto-fix-on-error)
9. [Deployment History & Logs](#9-deployment-history--logs)
10. [Manual Deploy Guide](#10-manual-deploy-guide)
11. [Key Architecture Decisions](#11-key-architecture-decisions)
12. [API Reference — All Flow Endpoints](#12-api-reference--all-flow-endpoints)
13. [DB Schema — Flow-Related Tables](#13-db-schema--flow-related-tables)

---

## 1. Flow Extraction from Salesforce

**Files:** `backend/app/code_converter_router.py`

### How It Works

Salesforce flows are extracted via the **Tooling API** (not the REST API) because the `Metadata` field on the `Flow` object is only accessible through Tooling SOQL.

### Flow ID Resolution — 4-Strategy Fallback

**Function:** `_resolve_flow_version_id()` (~line 120)

| Priority | Strategy | API Call |
|----------|----------|----------|
| 1 (PRIMARY) | REST FlowDefinitionView by ApiName | `SELECT ActiveVersionId, LatestVersionId FROM FlowDefinitionView WHERE ApiName = '{name}'` |
| 2 | Direct Tooling GET (if ID starts with `301`) | Tooling GET `/Flow/{id}` |
| 3 | REST sobjects FlowDefinitionView | `/services/data/v59.0/sobjects/FlowDefinitionView/{id}` |
| 4 | Tooling SOQL by DefinitionId | `SELECT Id FROM Flow WHERE DefinitionId = '{id}' ORDER BY VersionNumber DESC LIMIT 1` |

**Why needed:** Salesforce flow component list returns `DefinitionId` (starting with `300`), but the Tooling API `Metadata` field requires the active **version ID** (starting with `301`). The resolution chain handles both cases.

### Metadata Fetch

**Function:** `_fetch_flow_metadata()` (~line 202)

```python
# Primary query — Metadata field only accessible via Tooling SOQL
SELECT Metadata FROM Flow WHERE Id = '{version_id}'

# Secondary query — internal fields
SELECT Id, FullName, Status, ProcessType FROM Flow WHERE Id = '{version_id}'
```

Returns a dict with full `Metadata` + internal fields prefixed with `_` (`_version_id`, `_process_type`, etc.).

### Source Format Returned

**Function:** `_fetch_flow_source()` (~line 334)

Returns `__FLOW_META__:{json}` where `json` contains:
- `metadata` — full Flow.Metadata dict (all elements: variables, decisions, records, screens, etc.)
- `text` — formatted text for LLM (sections labelled VARIABLES, DECISIONS, RECORDS, etc.)
- `raw_json` — pretty-printed JSON for the XML view tab

---

## 2. Flow Display — Three Views

**File:** `frontend/src/components/CodeConverterPage.js`

The source panel shows flows in **4 tabs**: Visual · Chart · XML · Raw

### Visual View

**Components:** `FlowViewer()` (~line 470), `FlowSection()` (~line 130), `FlowItem()` (~line 152)

Renders an accordion of all flow elements grouped by type:

| Section | Data Source | Details Shown |
|---------|-------------|---------------|
| Variables | `metadata.variables[]` | dataType, isInput/isOutput/isCollection |
| Decisions | `metadata.decisions[]` | rules with conditions and connector targets |
| Record Lookups | `metadata.recordLookups[]` | object, filters, output assignments |
| Record Creates | `metadata.recordCreates[]` | object, field input assignments |
| Record Updates | `metadata.recordUpdates[]` | object, filters, field assignments |
| Record Deletes | `metadata.recordDeletes[]` | object, filters |
| Action Calls | `metadata.actionCalls[]` | actionType, inputParameters |
| Loops | `metadata.loops[]` | collection, iteration order |
| Screens | `metadata.screens[]` | fields list |
| Subflows | `metadata.subflows[]` | referencedFlowApiName |
| Assignments | `metadata.assignments[]` | assignmentItems |

### Chart View (Mermaid Diagram)

**Components:** `FlowChart()` (~line 350), `buildMermaidFlowchart()` (~line 239)

Converts metadata into Mermaid `flowchart TD` syntax:

| Element Type | Mermaid Shape | CSS Class |
|-------------|---------------|-----------|
| Decision | `{diamond}` | `decision` |
| Record (create/update/etc.) | `[rectangle]` | `record` |
| Action / Subflow | `([rounded])` | `action` |
| Loop | `{{hexagon}}` | `loop` |

Builds `-->` connections between nodes. Rendered via `Mermaid.js` with dark theme.

### XML View

Shows `flowMeta.raw_json` — the pretty-printed JSON of all Flow.Metadata fields.
Displayed in `CodeBlock()`. Source: returned by `_fetch_flow_source()` in `raw_json` field.

### Raw View

Shows `flowMeta.text` — the formatted text representation created during extraction:

```
// ─── Flow: Account_Creation ───
// Type: Flow | Status: Active
// ─── VARIABLES (2) ───
[JSON]
// ─── DECISIONS (1) ───
[JSON]
...
```

Displayed in `CodeBlock()`. Source: `text` field from `_fetch_flow_source()`.

---

## 3. Flow Conversion via LLM

**Files:** `backend/app/code_converter_router.py`, `backend/app/models/rulebook.py`

**Endpoint:** `POST /code-converter/convert`

### Conversion Pipeline

```
Source text (from _fetch_flow_source)
         ↓
_get_rulebook(db, "flow")          ← system_prompt + rules from DB
         ↓
_get_field_mapping_context(db)     ← Dataverse field/entity name mapping from Fabric SQL
         ↓
_build_prompt()                    ← concatenates: rules + field context + flow text
         ↓
_call_llm()                        ← calls configured LLM (OpenAI / Anthropic / Cohere)
         ↓
Parse output: extract <converted>...</converted>
         ↓
Auto-save to ConvertedItem table   ← upsert via POST /d365-deploy/save
```

### LLM Output Format

The LLM is instructed to return structured JSON inside `<converted>` tags:

```json
{
  "flow_name": "Account_Creation",
  "flow_type": "Manual",
  "trigger_table": "none",
  "trigger_event": "Manual",
  "description": "Plain English description of flow purpose",
  "power_automate_summary": "Step-by-step migration notes",
  "trigger_inputs": {
    "Account_Name": { "type": "string", "description": "Account name entered by user" }
  },
  "actions": [
    {
      "step": 1,
      "name": "Create_Account",
      "action_type": "AddRow",
      "description": "Create new Account record in Dataverse",
      "inputs": {
        "table_name": "accounts",
        "row": {
          "name": "@{triggerBody()?['Account_Name']}",
          "new_dynamiccheckbox": false
        }
      },
      "outputs": {}
    }
  ],
  "manual_steps": ["One-time: authorize Dataverse connection in PA portal"],
  "notes": "Migration notes"
}
```

---

## 4. Flow Rulebook

**Files:** `backend/app/models/rulebook.py`, `backend/app/power_automate_router.py`

### DB Model

Table: `rulebooks`

| Column | Type | Value for Flow |
|--------|------|----------------|
| `component_type` | VARCHAR(50) UNIQUE | `"flow"` |
| `title` | VARCHAR(200) | `"Salesforce Flow → Power Automate Cloud Flow (JSON)"` |
| `system_prompt` | TEXT | Expert migration engineer prompt |
| `rules` | TEXT | 6-section conversion rules |
| `updated_at` | DATETIME | Auto-set |

### Rules Structure (6 Sections)

| Section | Content |
|---------|---------|
| **1 — Flow Type Detection** | `process_type + trigger_type` → flow_type table (Screen Flow, Automated, Scheduled, etc.) |
| **2 — Trigger Inputs** | `fieldType + dataType` → trigger_inputs schema (InputField+String→string, DropdownBox→string, DisplayText→SKIP) |
| **3 — Action Mapping** | RecordCreate→AddRow, RecordUpdate→UpdateRow, RecordLookup→GetRow/ListRows, Decision→Condition, Loop→Foreach, emailSimple→SendEmail |
| **4 — Field Name Rules** | Always use `Dataverse_Column` from field mapping; entity logical names from `Dynamics_Object`; NEVER Salesforce `__c` names |
| **5 — Formula Mapping** | TODAY()→utcNow(), IF(c,t,f)→if(), TEXT()→string(), a=b→equals(), etc. |
| **6 — Output JSON Structure** | Exact JSON schema the LLM must return (inside `<converted>...</converted>`) |

### Critical Rules

- `AddRow` row values MUST use **simple** `@{triggerBody()?['field']}` references only — no `if()`, no `equals()` nested inside row values
- Always include `"new_dynamiccheckbox": false` in every Account `AddRow` action
- Choice/OptionSet fields → integer `DY_picklist` codes, **never** string labels

### Seed Endpoint

**Endpoint:** `POST /power-automate/seed-flow-rulebook`
**Function:** `seed_flow_rulebook()` — upserts the `rulebooks` row for `component_type="flow"` from `FLOW_PA_RULEBOOK` constant in `power_automate_router.py`.
**Response:** `{"ok": true, "action": "updated"|"created", "title": "..."}`

---

## 5. Edit & Save Converted Flow

**Files:** `backend/app/d365_deploy_router.py`, `frontend/src/components/CodeConverterPage.js`

### Initial Save (Auto on Convert)

**Endpoint:** `POST /d365-deploy/save`
**Model:** `SaveConversionRequest` — connection_id, component_type, component_name, sf_source, d365_output, llm_model, tokens, cost
**Logic:** Upsert — if `ConvertedItem` exists for same `run_id:type:name`, update it; else create new.
**Frontend:** Called automatically after successful conversion; `savedItemId` state set from response.

### Manual Edit

**Frontend flow:**
1. User clicks **✏ Edit** → `editMode = true`, `editedCode = convertedCode`
2. Textarea shown with full JSON for editing
3. **💾 Save Changes** → `PUT /d365-deploy/saved/{savedItemId}`

**Endpoint:** `PUT /d365-deploy/saved/{item_id}`
**Function:** `edit_saved()`
**Logic:** Updates `ConvertedItem.d365_output`, resets `status = "converted"` (must redeploy), updates timestamp.

---

## 6. Deploy to Power Automate (Dataverse API)

**File:** `backend/app/power_automate_router.py`

### Why Dataverse API (not PA Management API)

The PA Management API (`api.flow.microsoft.com`) **does not support Service Principal (app-only) tokens** — it requires delegated user auth. Calling it with an SP token returns `ClientScopeAuthorizationFailed`. The Dataverse Workflow API (category=5) works correctly with SP auth using scope `{env_url}/.default`.

### Full Deploy Pipeline

```
POST /power-automate/deploy
         ↓
Create DeploymentLog (status="running") FIRST — so all errors show in history
         ↓
_parse_flow_json(converted_code)
  ├── Strip <converted>...</converted> tags
  ├── Try direct JSON.parse
  ├── Regex search for JSON blocks (```json, {"flow_name":, {"properties":, etc.)
  └── Fallback: bracket-depth scan
         ↓
_is_structured_json(flow_json)?
  ├── YES → _build_clientdata_from_structured()
  └── NO  → _build_clientdata_from_logicapps() → _normalise_definition()
         ↓
_deploy_via_dataverse_api()
         ↓
Update DeploymentLog (status="success"|"manual"|"failed", flow_url, log_text)
Update ConvertedItem (status="deployed"|"manual")
```

### JSON Format Detection

**Function:** `_is_structured_json(flow_json)` — returns `True` if JSON has `"flow_name"` key **and** `"actions"` is a list.

| Format | Indicator | Handler |
|--------|-----------|---------|
| POC AI Structured | `flow_name` + `actions[]` | `_build_clientdata_from_structured()` |
| Logic Apps Definition | `properties.definition` or `$schema` | `_build_clientdata_from_logicapps()` |

### Build ClientData from Structured JSON

**Function:** `_build_clientdata_from_structured()` (~line 96)

Maps each `action_type` to a Power Automate action block:

| action_type | PA Action | operationId |
|-------------|-----------|-------------|
| `AddRow` | OpenApiConnection | `CreateRecord` |
| `UpdateRow` | OpenApiConnection | `UpdateRecord` |
| `GetRow` | OpenApiConnection | `GetItem` |
| `ListRows` | OpenApiConnection | `ListRecords` |
| `DeleteRow` | OpenApiConnection | `DeleteRecord` |
| `SendEmail` | OpenApiConnection (Office365) | `SendEmailV2` |
| `InitializeVariable` | InitializeVariable | — |
| `SetVariable` | SetVariable | — |
| `Condition` | If | — |
| `Foreach` | Foreach | — |
| `RunChildFlow` | Workflow | — |

Trigger selection by `flow_type`:

| flow_type | Trigger Type | PA Trigger |
|-----------|-------------|------------|
| `Automated` / `RecordAfterSave` | OpenApiConnectionNotification | `SubscribeToEntityChanges` (Dataverse row trigger) |
| `Scheduled` | Recurrence | `Recurrence` |
| `Manual` / `Instant` / `Screen Flow` | Request | `Button` with input schema |

All actions include `"authentication": "@parameters('$authentication')"` and `runAfter` chain.

### Normalize Legacy Logic Apps Format

**Function:** `_normalise_definition()` (~line 397)

| Transform | Old Value | New Value |
|-----------|-----------|-----------|
| Action type | `"ApiConnection"` | `"OpenApiConnection"` |
| operationId | `"PostItem"` | `"CreateRecord"` |
| operationId | `"PatchItem"` | `"UpdateRecord"` |
| operationId | `"GetItem"` | `"GetItem"` |
| operationId | `"GetItems"` | `"ListRecords"` |
| operationId | `"DeleteItem"` | `"DeleteRecord"` |
| Parameters | `body/item/*` → | `parameters/*` |
| Auth | missing | `"@parameters('$authentication')"` |

Also ensures `$connections` and `$authentication` parameters block exists.

### Deploy via Dataverse Workflow API

**Function:** `_deploy_via_dataverse_api()` (~line 521)

```python
# 1. Auth — MSAL SP token
scope = f"{env_url}/.default"
token = msal.ConfidentialClientApplication(...).acquire_token_for_client(scopes=[scope])

# 2. Check for existing flow (DELETE + re-CREATE — PATCH clientdata is unreliable)
GET {env_url}/api/data/v9.2/workflows?$filter=name eq '{name}' and category eq 5
if found: DELETE {env_url}/api/data/v9.2/workflows({wf_id})

# 3. Create flow
POST {env_url}/api/data/v9.2/workflows
Body: {
  "name": flow_name,
  "category": 5,          # Modern Flow (Power Automate)
  "type": 1,              # Definition
  "primaryentity": "none",
  "clientdata": "<json-string>",  # double-serialized!
  "statecode": 0,         # Draft
  "statuscode": 1
}

# 4. Extract workflow GUID from OData-EntityId response header

# 5. Auto-activate
PATCH {wf_api}({wf_id}) → {statecode: 1, statuscode: 2}
```

**Flow Portal URL built as:**
`https://make.powerautomate.com/environments/{power_platform_env_id}/flows/{wf_id}/edit`

---

## 7. Connection Fix — Environments Endpoint

**File:** `backend/app/power_automate_router.py`

**Endpoint:** `GET /power-automate/environments/{connection_id}`
**Function:** `list_environments()`

**What changed:** Previously called PA Management API (`api.flow.microsoft.com`) to list environments — this fails with SP auth (`ClientScopeAuthorizationFailed`). Now derives environment directly from connection config.

**Required connection config fields** (stored in `Connection.config_json`):

| Field | Required | Example | Purpose |
|-------|----------|---------|---------|
| `d365_environment_url` | **YES** | `https://org0734f801.crm8.dynamics.com` | Dataverse API base URL |
| `d365_tenant_id` | YES | `a5c8736e-...` | Azure AD tenant |
| `d365_client_id` | YES | `...` | Service principal app ID |
| `d365_client_secret` | YES | `...` | Service principal secret |
| `power_platform_env_id` | optional | `abc123-...` | PA portal env GUID (for correct flow URLs) |

Returns a single environment object derived from config (no API call made).

---

## 8. Fix Button — LLM Auto-Fix on Error

**Files:** `backend/app/d365_deploy_router.py`, `frontend/src/components/CodeConverterPage.js`

### What It Does

After a deploy failure, the **🔧 Fix** button sends the full context to the LLM and auto-updates the converted code so the user can deploy again immediately.

### Backend Endpoint

**Endpoint:** `POST /d365-deploy/saved/{item_id}/fix`
**Function:** `fix_saved()`
**Request:** `{ "error_context": "<deploy error message>" }`

**System Prompt sent to LLM:**
```
You are an expert Salesforce → Microsoft Dynamics 365 migration engineer.
A converted component failed to deploy. Analyse the error and produce a corrected version.

Rules:
1. Fix ONLY the issues described in the error. Do not refactor unrelated code.
2. For C# plugins: keep IPlugin structure, recursion guard, Contains() guards, using statements.
3. For Flow JSON: keep same JSON structure, fix field names / action types / expressions.
4. For PCF TypeScript: keep StandardControl<IInputs,IOutputs> structure.
5. Return COMPLETE fixed code — not a diff.

Respond ONLY in: <fixed_code>...</fixed_code> <explanation>...</explanation>
```

**User Prompt built includes:**
- `COMPONENT TYPE` and `COMPONENT NAME`
- `ORIGINAL SOURCE CODE` (Salesforce Apex/Flow) — from `ConvertedItem.sf_source`
- `CURRENT CONVERTED CODE` (the version that failed)
- `DEPLOY ERROR` (exact error from Dataverse or PA API)

**LLM:** Uses `get_llm_for_task(db, "convert")` — highest-quality model configured for conversion.

**Auto-update:** If `fixed_code` differs from current, `ConvertedItem.d365_output` is updated and `status` reset to `"converted"`. LLM usage logged to `llm_usage` table.

### Frontend Behavior

**Function:** `handleFix()` (~line 725)

`_getLastError()` automatically collects the most recent error:
- `deployResult.errors[]` (D365 plugin/PCF deploy errors)
- `deployResult.manual_instructions` (manual deploy message)
- `paResult.error` (Power Automate deploy error)
- `paResult.log_text` (full deploy log)

After fix:
- `convertedCode` state updated with fixed code
- `deployResult` and `paResult` reset (so user deploys fresh)
- Green banner shows: explanation + model used + token cost

**Visual cue:** The Fix button turns **red with warning styling** when there is an active unresolved deploy error.

---

## 9. Deployment History & Logs

**Files:** `backend/app/models/deployment_log.py`, `backend/app/d365_deploy_router.py`, `frontend/src/components/CodeConverterPage.js`

### DB Model: `DeploymentLog`

Table: `deployment_logs`

| Column | Type | Purpose |
|--------|------|---------|
| `connection_id` | INT FK | Which org |
| `component_type` | VARCHAR | `"flow"` |
| `component_name` | VARCHAR | e.g. `"Account_Creation"` |
| `source` | VARCHAR | `"converter"` or `"plan"` |
| `source_item_id` | INT | FK to ConvertedItem |
| `status` | VARCHAR | `running` / `success` / `failed` / `manual` |
| `log_text` | TEXT | Full deployment output (capped 50k chars) |
| `log_file_path` | TEXT | Path to full log file on disk |
| `flow_url` | TEXT | `https://make.powerautomate.com/.../flows/{id}/edit` |
| `assembly_id` | TEXT | Plugin GUID (non-flow) |
| `step_ids_json` | TEXT | JSON array of step GUIDs (non-flow) |
| `web_resource_id` | TEXT | PCF GUID (non-flow) |
| `error_message` | TEXT | Short error summary |
| `created_at` | DATETIME | Log start |
| `completed_at` | DATETIME | Log finish |

**Key behaviour:** Log is created **before** the deploy attempt starts — so all failures (credential errors, JSON parse failures, Dataverse API errors) are always captured in history.

### Endpoints

| Endpoint | Function | Purpose |
|----------|----------|---------|
| `GET /d365-deploy/logs/{connection_id}` | `list_logs()` | List logs, filter by component_name + component_type |
| `GET /d365-deploy/logs/{connection_id}/{log_id}` | `get_log()` | Full detail including `log_text` |
| `GET /d365-deploy/log-download/{log_id}` | `download_log()` | Download `.log` file (FileResponse or PlainTextResponse) |

### Frontend History Modal

**Trigger:** **📋 History** button → `handleLoadHistory()`
Calls: `GET /d365-deploy/logs/{selectedOrg}?component_name={name}&component_type={type}&limit=50`

**History table columns:** Time · Status · Source · Assembly/Flow URL · Steps · Download

**Flow URL display:** If `log.flow_url` set → shows **⚡ Open Flow ↗** link (yellow, opens PA portal).

**Expandable rows:** Click any row → fetches `GET /d365-deploy/logs/{conn_id}/{log_id}` → shows:
- Red error banner if `error_message` present
- Full `log_text` in scrollable dark `<pre>` block

**Download button (⬇):** Links directly to `GET /d365-deploy/log-download/{log_id}` — downloads full log as `deploy_{name}_{id}.log`.

---

## 10. Manual Deploy Guide

**File:** `frontend/src/components/CodeConverterPage.js`

**Trigger:** **📖 Manual Deploy** button (top-right of target panel, visible when component selected)
Sets `guideTab = selectedComp.type` and `showManualGuide = true`.

**Component:** `ManualDeployGuide()` — full-screen slide-in panel

**Tab navigation:** Apex Class · Apex Trigger · LWC→PCF · Aura→PCF · **Flow→PA**

### Flow Guide Content (`GUIDE_CONTENT["flow"]`)

**Title:** Deploy Flow as Power Automate Flow
**Prerequisites:** Power Automate license · Microsoft 365 account · Dataverse environment access

| Step | Description |
|------|-------------|
| 1 | Copy converted flow JSON from Target panel |
| 2 | Open `make.powerautomate.com` and sign in |
| 3 | Create new Instant/Automated cloud flow |
| 4 | Use "Peek code" (⋯ menu) to paste individual actions, or import flow package |
| 5 | Update each connector → authorize Dataverse connection |
| 6 | Test with sample data → fix errors → Turn On |

**Error Hints (shown when matching error in deployResult):**

| Keyword | Hint |
|---------|------|
| `connection` | Click "Fix connection" → sign in with account that has Dataverse access |
| `environment` | Ensure you are in the matching Power Automate environment |
| `schema` | Schema errors mean action type changed — recreate that action manually |

**Also shown:** After PA deploy failure (`paResult.is_manual = true`), a "📖 Open Manual Deploy Guide" button appears inline in the deploy result banner.

---

## 11. Key Architecture Decisions

### Decision 1: Dataverse API over PA Management API

The PA Management API (`api.flow.microsoft.com`) **requires delegated user auth** and rejects service principal tokens with `ClientScopeAuthorizationFailed`. The Dataverse Workflow API (`/api/data/v9.2/workflows`) accepts SP auth via `{env_url}/.default` scope — matching exactly how the reference POC AI project deploys flows.

### Decision 2: DELETE + re-CREATE (not PATCH)

PATCH on an existing workflow's `clientdata` field returns `TemplateValidationError`. The reliable pattern is: check for existing flow by name → DELETE → POST new. This guarantees a clean state.

### Decision 3: Log Created Before Deployment

The `DeploymentLog` row is committed to DB before any deployment attempt. This ensures that **all failures** — including credential errors, JSON parse failures, Dataverse API 400/401 errors — are always visible in the History modal.

### Decision 4: Two-Format Clientdata Pipeline

Two paths exist for backward compatibility:
- **Structured JSON** (POC AI format, `flow_name` + `actions[]`): directly built via `_build_clientdata_from_structured()`
- **Legacy Logic Apps** (old `ApiConnection`/`PostItem` format): passes through `_normalise_definition()` to convert to `OpenApiConnection`/`CreateRecord` before wrapping

### Decision 5: Fix Before Redeploy (not Retry)

Rather than silently retrying failed deployments, the Fix button sends the actual error to the LLM for targeted correction. The fixed code replaces the stored conversion and the user explicitly re-deploys — maintaining full visibility and control.

---

## 12. API Reference — All Flow Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/code-converter/components/{connection_id}` | List all flows (with name, status, processType) |
| `GET` | `/code-converter/source/{connection_id}/flow/{component_id}` | Fetch flow source (`__FLOW_META__:{json}`) |
| `POST` | `/code-converter/convert` | Convert flow via LLM (component_type="flow") |
| `POST` | `/d365-deploy/save` | Save converted flow JSON to DB |
| `GET` | `/d365-deploy/saved/{connection_id}?component_type=flow` | List saved flow conversions |
| `GET` | `/d365-deploy/saved/{connection_id}/{item_id}` | Get single saved flow (with sf_source) |
| `PUT` | `/d365-deploy/saved/{item_id}` | Edit converted flow JSON |
| `POST` | `/d365-deploy/saved/{item_id}/fix` | LLM auto-fix with error context |
| `POST` | `/d365-deploy/saved/{item_id}/deploy` | Deploy (non-flow only — triggers D365 service) |
| `GET` | `/d365-deploy/logs/{connection_id}?component_type=flow` | List flow deployment history |
| `GET` | `/d365-deploy/logs/{connection_id}/{log_id}` | Full log detail with log_text |
| `GET` | `/d365-deploy/log-download/{log_id}` | Download full log file |
| `GET` | `/power-automate/environments/{connection_id}` | List PA environments (config-derived) |
| `POST` | `/power-automate/deploy` | Deploy flow to Dataverse Workflow API |
| `POST` | `/power-automate/seed-flow-rulebook` | Upsert flow rulebook in DB |

---

## 13. DB Schema — Flow-Related Tables

### `rulebooks`

```sql
id              SERIAL PRIMARY KEY
component_type  VARCHAR(50) UNIQUE NOT NULL   -- "flow"
title           VARCHAR(200) NOT NULL
system_prompt   TEXT NOT NULL DEFAULT ''
rules           TEXT NOT NULL DEFAULT ''
updated_at      DATETIME
```

### `converted_items` (flow rows)

```sql
id            SERIAL PRIMARY KEY
run_id        VARCHAR  -- "{connection_id}:flow:{flow_name}"
item_type     VARCHAR  -- "flow"
item_name     VARCHAR  -- e.g. "Account_Creation"
sf_source     TEXT     -- __FLOW_META__:{json} from Tooling API
d365_output   TEXT     -- converted PA JSON (LLM output)
status        VARCHAR  -- converted / deploying / deployed / manual / failed
llm_model     VARCHAR
input_tokens  INT
output_tokens INT
cost_usd      FLOAT
created_at    DATETIME
updated_at    DATETIME
```

### `deployment_logs` (flow rows)

```sql
id              SERIAL PRIMARY KEY
connection_id   INT
component_type  VARCHAR  -- "flow"
component_name  VARCHAR
source          VARCHAR  -- "converter"
source_item_id  INT      -- FK to converted_items.id
status          VARCHAR  -- running / success / failed / manual
log_text        TEXT     -- full deployment output
flow_url        TEXT     -- https://make.powerautomate.com/environments/{env_id}/flows/{wf_id}/edit
error_message   TEXT
created_at      DATETIME
completed_at    DATETIME
```

### `llm_usage` (fix calls)

```sql
call_type      VARCHAR  -- "fix" (also "convert", "validate")
provider       VARCHAR  -- "anthropic", "openai", "cohere"
model          VARCHAR
connection_id  INT
component_name VARCHAR
component_type VARCHAR  -- "flow"
input_tokens   INT
output_tokens  INT
cost_usd       FLOAT
duration_ms    INT
status         VARCHAR  -- "success" / "error"
```
