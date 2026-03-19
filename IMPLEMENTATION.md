# SF2Dynamics — Complete Implementation Reference

> **Project:** Salesforce → Dynamics 365 Migration Wizard
> **Working dir:** `c:\Users\SiddhrajsinhAtodaria\OneDrive - Gruve AI\Desktop\2026\Salesforce2dynamic`
> **Stack:** FastAPI (Python) backend · React 18 frontend · SQLite (SQLAlchemy) · Redis · Qdrant
> **Last updated:** 2026-03-14

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Models](#2-database-models)
3. [Org Connection & Authentication](#3-org-connection--authentication)
4. [Metadata Extraction (Shift Screen)](#4-metadata-extraction-shift-screen)
5. [Field Mapping Pipeline](#5-field-mapping-pipeline)
6. [Code Converter — Core Flow](#6-code-converter--core-flow)
7. [Component Type Handling](#7-component-type-handling)
   - [Apex Class → C# IPlugin](#71-apex-class--c-iplugin)
   - [Apex Trigger → C# IPlugin](#72-apex-trigger--c-iplugin)
   - [LWC → PCF TypeScript](#73-lwc--pcf-typescript)
   - [Aura → PCF TypeScript](#74-aura--pcf-typescript)
   - [Flow → Power Automate JSON](#75-flow--power-automate-json)
8. [Flow Visual Viewer (Visual / Chart / XML / Raw)](#8-flow-visual-viewer-visual--chart--xml--raw)
9. [Rulebook System](#9-rulebook-system)
10. [LLM Integration](#10-llm-integration)
11. [Validate Button](#11-validate-button)
12. [D365 Deploy Pipeline (Apex / LWC / Aura)](#12-d365-deploy-pipeline-apex--lwc--aura)
13. [Power Automate Deploy Pipeline (Flows)](#13-power-automate-deploy-pipeline-flows)
14. [Deployment Logs](#14-deployment-logs)
15. [LLM Usage Tracking](#15-llm-usage-tracking)
16. [API Route Map](#16-api-route-map)
17. [Frontend Component Map](#17-frontend-component-map)
18. [Environment Variables](#18-environment-variables)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  React 18 Frontend  (port 3000)                                 │
│  CodeConverterPage.js  MappingTab.js  DeployLogsPage.js  etc.  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP REST (JSON)
┌───────────────────────────▼─────────────────────────────────────┐
│  FastAPI Backend  (port 8000)                                   │
│  main.py — registers all routers                                │
│                                                                 │
│  Routers:                                                       │
│   /shift/*           shift_router.py      — org management      │
│   /code-converter/*  code_converter_router.py — SF fetch+LLM   │
│   /d365-deploy/*     d365_deploy_router.py — save/validate/deploy│
│   /power-automate/*  power_automate_router.py — PA deploy       │
│   /mapping/*         routers.py           — field mapping       │
│   /field-suggestions/ routers.py          — Fabric SQL mapping  │
│   /connectors/*      connectors_router.py — LLM config         │
│   /llm-usage/*       llm_usage_router.py  — token usage log    │
│   /deployment-logs/* deployment_router.py — log browsing       │
└───┬────────────────┬────────────────┬───────────────────────────┘
    │                │                │
    ▼                ▼                ▼
SQLite DB      Salesforce API    Azure AD / D365 / PA API
(SQLAlchemy)   (REST + Tooling)  (MSAL client credentials)
```

---

## 2. Database Models

File: `backend/app/models/`

| Model | Table | Key Columns |
|-------|-------|-------------|
| `Connection` | `connections` | `id, name, type, config_json` |
| `OrgMetadata` | `org_metadata` | `connection_id, metadata_json, summary_json, extracted_at` |
| `FieldMapping` | `field_mappings` | `connection_id, mapping_json, fetched_at` |
| `ConvertedItem` | `converted_items` | `run_id, item_type, item_name, sf_source, d365_output, status` |
| `DeploymentLog` | `deployment_logs` | `connection_id, component_type, component_name, status, log_text, log_file_path` |
| `LLMUsage` | `llm_usage` | `call_type, provider, model, input_tokens, output_tokens, cost_usd` |
| `Rulebook` | `rulebooks` | `component_type (unique), title, system_prompt, rules` |

**`config_json` structure** (stored in `connections` for an `org` type):
```json
{
  "sf_username": "...",
  "sf_password": "...",
  "sf_security_token": "...",
  "sf_access_token": "...",
  "sf_instance_url": "https://xxx.salesforce.com",
  "sf_status": "connected",
  "d365_environment_url": "https://org.crm8.dynamics.com",
  "d365_tenant_id": "...",
  "d365_client_id": "...",
  "d365_client_secret": "...",
  "d365_status": "connected",
  "fabric_tenant_id": "...",
  "fabric_service_principal_id": "...",
  "fabric_service_principal_secret": "...",
  "fabric_server": "xxx.datawarehouse.fabric.microsoft.com",
  "fabric_database": "..."
}
```

---

## 3. Org Connection & Authentication

**File:** `backend/app/shift_router.py`

### Salesforce Connection
1. User enters username, password, security token in `ConnectOrgModal.js`
2. Backend calls `simple_salesforce.Salesforce(username, password, security_token)` to get `access_token` + `instance_url`
3. Both stored encrypted in `config_json` via `crypto.py` (Fernet symmetric)
4. Status shown as `sf_status: "connected"` in the UI

### Token Refresh
```python
# shift_router.py — refresh_sf_token()
# Called automatically by code_converter_router when a 401/403 is received
# Re-authenticates with stored credentials and patches config_json
```

### D365 Authentication
MSAL `ConfidentialClientApplication` with client credentials flow:
```
scope = {d365_environment_url}/.default
token_url = https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token
```

### Power Automate Authentication
Separate MSAL token with scope `https://service.flow.microsoft.com/.default`
Used only for PA deploy; D365 Dataverse token does NOT work for the PA Management API.

---

## 4. Metadata Extraction (Shift Screen)

**Files:** `backend/app/shift_router.py` · `frontend/src/components/ShiftTab.js`

The Shift screen (Metadata Migration tab) extracts all component metadata from Salesforce:

```
User clicks "Extract" on an org
       ↓
POST /shift/extract/{connection_id}
       ↓
simple_salesforce queries:
  ApexClass     → SELECT Id, Name, ApiVersion, Status, NamespacePrefix FROM ApexClass
  ApexTrigger   → SELECT Id, Name, TableEnumOrId, ApiVersion, NamespacePrefix FROM ApexTrigger
  FlowDefinitionView → SELECT Id, ApiName, Label, ProcessType, ActiveVersionId, Status FROM FlowDefinitionView
  LightningComponentBundle → SELECT Id, DeveloperName, MasterLabel, ApiVersion FROM LightningComponentBundle
  AuraDefinitionBundle     → SELECT Id, DeveloperName, MasterLabel, ApiVersion FROM AuraDefinitionBundle
       ↓
Stored in OrgMetadata.metadata_json (SQLite)
Stored summary counts in OrgMetadata.summary_json
```

**Key note:** Managed/namespaced components (`NamespacePrefix != ""`) are FILTERED OUT — their source code is hidden by Salesforce and cannot be converted.

---

## 5. Field Mapping Pipeline

**Files:**
- `backend/app/services/fabric_field_mapping.py` — Fabric SQL fetch
- `backend/app/models/field_mapping.py` — SQLite cache
- `backend/app/routers.py` — `/field-suggestions/{object}` endpoint
- `frontend/src/components/MappingTab.js` — UI table

### Data Sources (Fabric SQL — Microsoft Fabric Lakehouse)

| Table | Purpose |
|-------|---------|
| `raw.sf_to_dv_column_mapping` | Main SF Column → D365 Column mapping |
| `raw.sf_to_dv_picklist_mapping` | Picklist option labels + integer D365 codes |

### Backend Fetch Flow (`fetch_field_mapping`)

```
1. Connect to Fabric SQL via pyodbc
   Driver: "ODBC Driver 18 for SQL Server"
   Auth: Service Principal (ActiveDirectoryServicePrincipal)

2. SELECT * FROM raw.sf_to_dv_column_mapping
   → col_rows[] sorted by Salesforce_Object, Salesforce_Column

3. SELECT SF_Object, Dynamics_Object, SF_Field, D365_Field, SF_picklist, DY_picklist
   FROM raw.sf_to_dv_picklist_mapping
   → pick_rows[]

4. Build picklist_lookup dict:
   key = (sf_object.lower(), sf_field.lower())   ← primary
   key = (sf_object.lower(), d365_field.lower())  ← fallback
   value = [{ label, value(int), d365_field }]

5. Group col_rows by Salesforce_Object:
   For each field:
     - if Dataverse_Data_Type in {picklist, optionset, multipicklist, multioptionset}:
         attach options[] from picklist_lookup (deduplicated by label+value)

6. Return:
{
  "_fetched_at": "...",
  "_total_objects": 3,
  "_total_fields": 259,
  "objects": {
    "Account": {
      "UID": "...",
      "Dynamics_Object": "account",
      "fields": [
        {
          "Salesforce_Column": "accountsource",
          "Dataverse_Column": "new_accountsource",
          "Dataverse_Data_Type": "Picklist",
          "Dataverse_Display_Name": "Account Source",
          "options": [{ "label": "Web", "value": 100000001 }, ...]
        }
      ]
    }
  }
}
```

**Currently mapped objects:** Account (93 fields), Contact (76 fields), Opportunity (90 fields)
**Total:** 259 fields, 30 picklist fields across all objects

### Field Mapping → LLM Prompt Injection

```python
# code_converter_router.py — _get_field_mapping_context()
# Called before every LLM conversion
# Reads FieldMapping from SQLite (cached from Fabric fetch)
# Formats as compact text block:

FIELD MAPPING (Salesforce → Dataverse) — use these for all field/entity references:
  [Account] → D365 Table: account
    accountsource → new_accountsource (Picklist) [options: Web=100000001, Phone=100000002, ...]
    annualrevenue → revenue (Money)
    billingcity   → address1_city (String)
    ...
```

The LLM rulebook instructs it to use `Dataverse_Column` for all field references and `Dynamics_Object` for entity type names.

### Frontend Fetch Logic (MappingTab.js)

When an SF object row is expanded, two parallel requests fire:

```javascript
Promise.allSettled([
  GET /field-suggestions/{object}         // Lakehouse confirmed mappings
  GET /salesforce/objects/{object}/fields  // Live SF describe (optional)
])
```

**Merge logic:**
- If live SF fields returned → SF is source of truth for which columns exist; overlay D365 mappings from Lakehouse
- If no live SF → use Lakehouse data alone

Each row in the table shows: SF Field · SF Type · D365 Field (searchable dropdown) · D365 Type · Picklist options inline

**Save flow:**
User clicks Confirm per object → Sync Now → `POST /mapping/bulk` → writes all confirmed mappings back to Fabric Lakehouse Delta table

---

## 6. Code Converter — Core Flow

**File:** `backend/app/code_converter_router.py`

```
User selects component in sidebar → click Convert
           ↓
POST /code-converter/convert
{
  connection_id, component_type, component_name, component_id, target: "dynamics365"
}
           ↓
1. GET /code-converter/source/{connection_id}/{comp_type}/{comp_id}
   (or code passed directly from frontend after "Load Source" was clicked)
   → Fetches live source from Salesforce Tooling API

2. _get_rulebook(db, component_type)
   → Reads from rulebooks table in SQLite
   → Falls back to DEFAULT_RULEBOOKS if no DB entry exists

3. _get_field_mapping_context(db, connection_id)
   → Reads FieldMapping from SQLite
   → Formats as compact text for LLM

4. _build_prompt(name, comp_type, code, rules, field_mapping_ctx)
   → Assembles: rulebook rules + field mapping + source code
   → Instructs LLM to respond in <converted>...</converted><notes>...</notes>

5. _call_llm(llm, prompt, system_prompt, max_tokens)
   → max_tokens = 16000 for flows (large JSON), 4096 for others

6. _parse_llm_response(raw)
   → Extracts code from <converted> tags
   → If tags missing (truncation) → takes everything after <converted>
   → Strips markdown code fences

7. Returns: { converted_code, notes, usage: { input_tokens, output_tokens, cost_usd, model } }

8. LLMUsage row saved to DB with call_type="code_convert"
```

### Prompt Assembly (`_build_prompt`)

```
[rulebook.rules]          ← conversion rules specific to component_type
[field_mapping_context]   ← SF→D365 field mapping table
Convert this Salesforce {type} named "{name}" to {target}:
```{source_code}```

Respond ONLY in this exact XML-like format:
<converted>
[code here]
</converted>
<notes>
[One migration note per line]
</notes>
```

---

## 7. Component Type Handling

### 7.1 Apex Class → C# IPlugin

**Source fetch:** `GET /services/data/v59.0/tooling/sobjects/ApexClass/{id}` → `Body` field

**Rulebook rules (apex_class):**
- Always use `IPlugin` + `public void Execute(IServiceProvider serviceProvider)`
- Mandatory recursion guard: `if (context.Depth > 1) return;`
- Field access always guarded with `Contains()`
- SOQL → `QueryExpression` with `ColumnSet` and `FilterExpression`
- DML: `service.Create()`, `service.Update()`, `service.Delete()`
- Use `Dataverse_Column` from field mapping for all field names
- Picklist → `OptionSetValue(intCode)` using `DY_picklist` from mapping

**Output:** Complete compilable C# IPlugin class

### 7.2 Apex Trigger → C# IPlugin

**Source fetch:** `GET /services/data/v59.0/tooling/sobjects/ApexTrigger/{id}` → `Body` field

**Rulebook rules (apex_trigger):**
- Stage detection: `before insert/update → Stage=20`, `after insert/update → Stage=40`
- Context: `var target = (Entity)context.InputParameters["Target"]`
- Pre/Post images for change detection
- Trigger context checks: `context.MessageName == "Create"/"Update"/"Delete"`

**Output:** Complete compilable C# IPlugin class

### 7.3 LWC → PCF TypeScript

**Source fetch:** Tooling SOQL on `LightningComponentResource` filtered by `LightningComponentBundleId`
Returns all files: `.html`, `.js`, `.css`, `.js-meta.xml`

**Rulebook rules (lwc):**
- Implement `StandardControl<IInputs, IOutputs>`
- `@wire` → `Xrm.WebApi` calls
- `@api` properties → `IInputs` interface
- Custom events → `notifyOutputChanged()` + `IOutputs`
- Use integer option codes (NOT string labels) for picklist fields

### 7.4 Aura → PCF TypeScript

**Source fetch:** Tooling SOQL on `AuraDefinition` filtered by `AuraDefinitionBundleId`
Returns all Aura definition types: `COMPONENT`, `CONTROLLER`, `HELPER`, `STYLE`, etc.

**Rulebook rules (aura):**
- Map Aura attributes → `IInputs`; Aura events → `IOutputs`
- `force:recordData` → `Xrm.WebApi.retrieveRecord()`
- `aura:iteration` → `Array.map()` in TypeScript
- All field refs use `Dataverse_Column` from mapping

### 7.5 Flow → Power Automate JSON

**Source fetch:** Multi-strategy resolution (see §8).

**Rulebook (seeded into SQLite DB, id=5, component_type='flow'):**

| SF Element | PA Element |
|-----------|-----------|
| `RecordAfterSave (Create)` | `subscriptionRequest/message: 1` |
| `RecordAfterSave (Update)` | `subscriptionRequest/message: 2` |
| `RecordAfterSave (CreateAndUpdate)` | `subscriptionRequest/message: 3` |
| `Decision` | `type: "If"` with `expression.and[{equals:[...]}]` |
| `Record Lookup` | `type: "ApiConnection"`, `operationId: "GetItems"` |
| `Record Create` | `type: "ApiConnection"`, `operationId: "PostItem"` |
| `Record Update` | `type: "ApiConnection"`, `operationId: "PatchItem"` |
| `Record Delete` | `type: "ApiConnection"`, `operationId: "DeleteItem"` |
| `Assignment` | `type: "InitializeVariable"` / `"SetVariable"` |
| `Loop` | `type: "Foreach"` |
| `Subflow` | `type: "Workflow"` with `workflowReferenceName` |
| `Action (Send Email)` | `type: "ApiConnection"`, `connectionName: "shared_office365"` |

**Required JSON envelope:**
```json
{
  "properties": {
    "displayName": "FlowName",
    "definition": {
      "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
      "triggers": { ... },
      "actions": { ... }
    },
    "state": "Started"
  }
}
```

**max_tokens = 16000** for flow conversions to avoid truncation of large JSON output.

---

## 8. Flow Visual Viewer (Visual / Chart / XML / Raw)

**File:** `backend/app/code_converter_router.py` → `_fetch_flow_source()` + `_fetch_flow_metadata()`

### Step 1 — Resolve Flow Version ID (4 strategies)

```python
# Strategy 1 (PRIMARY — always try first):
REST: SELECT Id, ActiveVersionId, LatestVersionId
      FROM FlowDefinitionView WHERE ApiName = '{name}'
→ Returns ActiveVersionId (a "301..." prefixed ID)

# Strategy 2: Check if the stored definition_id IS already a version ID
GET /tooling/sobjects/Flow/{definition_id}
→ If it has an "Id" field, it's valid

# Strategy 3: REST sobjects GET
GET /sobjects/FlowDefinitionView/{definition_id}
→ Returns ActiveVersionId if the ID format matches

# Strategy 4: Tooling SOQL fallback
SELECT Id FROM Flow WHERE DefinitionId = '{definition_id}' ORDER BY VersionNumber DESC LIMIT 1
```

**Key Salesforce API facts discovered:**
- `FlowDefinitionView` is NOT supported in Tooling API (only REST API)
- `FlowDefinitionView WHERE Id = '...'` always returns 0 records (ID format mismatch)
- `Flow.DeveloperName` does NOT exist in Tooling API
- `SELECT Metadata FROM Flow` must query `Metadata` ALONE — combined with other fields fails

### Step 2 — Fetch Flow Metadata

```python
# Primary (Tooling SOQL):
SELECT Metadata FROM Flow WHERE Id = '{version_id}'
→ Returns full Metadata dict with decisions, assignments, recordLookups, etc.

# Then fetch supplementary fields separately:
SELECT Id, FullName, Status, ProcessType FROM Flow WHERE Id = '{version_id}'
```

### Step 3 — Build Source Representation

`_fetch_flow_source()` returns `__FLOW_META__:{json}` containing:
```json
{
  "name": "Lead_Flow",
  "label": "Lead Flow",
  "process_type": "AutoLaunchedFlow",
  "status": "Active",
  "metadata": { ...full SF metadata... },
  "text": "// ─── Flow: Lead Flow ───\n// Decisions (4) ...",
  "raw_json": "{ ...pretty-printed metadata... }"
}
```

The frontend detects `__FLOW_META__:` prefix and splits:
- `flow_meta` → drives the Visual + Chart + XML tabs
- `code` → `text` field sent to LLM for conversion

### Frontend Tab Rendering

| Tab | Source | Renderer |
|-----|--------|---------|
| **Visual** | `flowMeta.metadata` | Custom React components: Decisions, Get Records, Update Records, Subflows, Screens — each section collapsible |
| **Chart** | `flowMeta.metadata` | Mermaid.js `flowchart TD` — loaded from CDN, zoom controls (−/+/↺), default zoom 50%, color-coded nodes by type |
| **XML** | `flowMeta.raw_json` | JSON pretty-printed in a `<pre>` code block |
| **Raw** | `flowMeta.text` | Plain text representation |

**Mermaid chart node colors:**
```css
classDef decision fill:#8B5CF6    (purple)
classDef action   fill:#0EA5E9    (blue)
classDef record   fill:#10B981    (green)
classDef screen   fill:#F59E0B    (amber)
classDef subflow  fill:#6366F1    (indigo)
```

---

## 9. Rulebook System

**File:** `backend/app/models/rulebook.py`

Rulebooks are per-component-type instructions given to the LLM with every conversion request.

### Storage
- DB table: `rulebooks` — one row per `component_type` (unique)
- Fields: `title`, `system_prompt` (LLM system role), `rules` (injected into user prompt)
- Fallback: `DEFAULT_RULEBOOKS` dict in `rulebook.py` used if no DB row exists
- Priority: **DB row always takes precedence** over `DEFAULT_RULEBOOKS`

### Rulebook Read (per conversion)
```python
# code_converter_router.py
def _get_rulebook(db, component_type):
    row = db.query(Rulebook).filter(Rulebook.component_type == component_type).first()
    if row:
        return {"system_prompt": row.system_prompt, "rules": row.rules, "title": row.title}
    return DEFAULT_RULEBOOKS.get(component_type, {})
```

### Rulebooks Available

| component_type | Default Title | Target |
|---------------|--------------|--------|
| `apex_class` | Apex Class → C# IPlugin / Service Class | C# IPlugin |
| `apex_trigger` | Apex Trigger → C# IPlugin (Pre/PostOperation) | C# IPlugin |
| `lwc` | LWC → PCF TypeScript Component | TypeScript PCF |
| `aura` | Aura Component → PCF TypeScript Component | TypeScript PCF |
| `flow` | Salesforce Flow → Power Automate Cloud Flow (JSON) | PA JSON (**DB row**) |

### Seeding the Flow Rulebook
```
POST /power-automate/seed-flow-rulebook
→ Upserts rulebooks row for component_type='flow' with full PA rulebook
→ This was done directly via Python script to SQLite as well (id=5, updated 2026-03-13)
```

### Editing Rulebooks (Frontend)
In the Code Converter page, click the `</> Rulebook` button in the top bar to open the rulebook editor. Changes are saved via `PUT /connectors/rulebooks/{component_type}`.

---

## 10. LLM Integration

**File:** `backend/app/connectors_router.py`

### Supported Providers
- `openai` — GPT-4o, GPT-4o-mini, GPT-4-turbo, GPT-4, GPT-3.5-turbo
- `anthropic` — claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
- `cohere` — command-r-plus, command-r

### Configuration
LLMs are configured in the **LLM Connector** page. Multiple LLMs can be configured, with roles:
- `default` — used for code conversion
- `validate` — used for the Validate button (may be different model)
- `escalation` — used when validation fails, escalates to a more capable model

### LLM Call (`_call_llm` in `code_converter_router.py`)
```python
def _call_llm(llm, prompt, system_prompt, max_tokens=4096):
    if provider == "openai":
        client.chat.completions.create(messages=[{system}, {user}], max_tokens=max_tokens)
    elif provider == "anthropic":
        client.messages.create(system=sys_p, messages=[{user}], max_tokens=max_tokens)
    elif provider == "cohere":
        client.chat(preamble=sys_p, message=prompt)
    return raw_text, input_tokens, output_tokens
```

### Token Limits
| Component Type | max_tokens |
|---------------|-----------|
| Flow | 16,000 |
| All others | 4,096 |

### Model Pricing (for cost tracking)
```python
MODEL_PRICING = {
    "claude-opus-4-6":   (0.015, 0.075),  # ($/1K input, $/1K output)
    "claude-sonnet-4-6": (0.003, 0.015),
    "gpt-4o":            (0.005, 0.015),
    ...
}
```

---

## 11. Validate Button

**File:** `backend/app/d365_deploy_router.py` → `POST /d365-deploy/saved/{item_id}/validate`

The Validate button runs LLM-based code review with an automatic fix loop.

### Flow
```
1. Load ConvertedItem from DB
2. Build system prompt based on component type:
   - apex_class/apex_trigger → _VALIDATE_SYSTEM_PROMPT (C# IPlugin review)
   - lwc/aura               → _VALIDATE_SYSTEM_PROMPT_WR (web resource review)

3. Fix loop (up to max_retries, default 3):
   Attempt 1..N:
     a. Call LLM with current code
     b. Parse response: <verdict>PASS|FAIL</verdict> <issues>...</issues> <fixed_code>...</fixed_code>
     c. If PASS → break
     d. If FAIL + fixed_code → replace current_code with fixed_code, retry
     e. If attempt > escalate_after → switch to escalation LLM

4. Save final code to DB
5. Update status: "validated" (PASS) or "converted" (still FAIL)
6. Log LLMUsage per attempt
```

### Validation Checks (C# IPlugin)
- Missing recursion guard (`if (context.Depth > 1) return;`)
- Missing `Contains()` checks before field access
- Incorrect DML patterns
- Missing using directives
- Compilation errors

### Validation Checks (Web Resource)
- XRM API usage correctness
- Missing `_resolveXrm()` helper
- Hardcoded Salesforce field names
- Integer picklist values vs string labels
- Correct `Xrm.WebApi` calls

---

## 12. D365 Deploy Pipeline (Apex / LWC / Aura)

**Files:** `backend/app/d365_deploy_router.py` · `backend/app/services/d365_deploy_service.py`

### Save → Validate → Deploy Workflow

```
Code Converter produces converted_code
      ↓
POST /d365-deploy/save
→ Upserts ConvertedItem in SQLite (run_id = "{connection_id}:{type}:{name}")
→ Status: "converted"
      ↓
(Optional) POST /d365-deploy/saved/{item_id}/validate
→ LLM fix loop → Status: "validated"
      ↓
POST /d365-deploy/saved/{item_id}/deploy
→ Reads D365 creds from Connection.config_json
→ Calls deploy_component() → DeployResult
→ Creates DeploymentLog entry
→ Status: "deployed" | "failed" | "manual"
```

### Apex Class / Trigger Deploy (`deploy_plugin`)

```
1. _extract_plugin_classname(csharp_code, fallback)
   → Regex: public class (\w+) : (?:...,)*IPlugin
   → CRITICAL: D365 typename must EXACTLY match the class name in the DLL

2. compile_csharp(code, assembly_name, connection_id, log)
   → Writes Plugin.cs + {assembly_name}.csproj
   → .csproj: net462, Microsoft.CrmSdk.CoreAssemblies 9.0.2.56, signed with SNK key
   → dotnet build -c Release → produces {assembly_name}.dll
   → Returns (success, dll_bytes, error)

3. _ensure_snk(connection_id, log)
   → One SNK key per org, stored at backend/data/orgs/{id}/keys/PluginKey.snk
   → Generated via `dotnet sn -k` or Python cryptography RSA-1024

4. D365 Authentication: _d365_get_token(d365_cfg)
   → scope: {d365_environment_url}/.default

5. Upsert pluginassemblies:
   → GET pluginassemblies?$filter=name eq '{assembly_name}'
   → If exists: PATCH with new DLL bytes
   → If PATCH fails (PublicKeyToken changed): DELETE all + POST new

6. POST plugintypes:
   → typename = plugin_classname (extracted from C# source)
   → NOT assembly_name (they may differ, e.g. class "AccountPlugin" in assembly "AccountController")

7. Register sdkmessageprocessingsteps:
   → _infer_entity_name() from component name / source code
   → _infer_messages() → ["Create", "Update"] for triggers, ["Create"] for classes
   → _infer_stage() → 20 (Pre) or 40 (Post)
   → _infer_mode() → 0 (Sync) or 1 (Async, if @future detected)

8. POST PublishAllXml (allows up to 120s timeout)
```

**Build output location:** `backend/data/orgs/{connection_id}/compiled/{name}_{timestamp}/`

### LWC / Aura Deploy (`deploy_web_resource`)

```
1. D365 auth
2. Extract HTML portion from converted code (strips markdown fences)
3. Base64 encode HTML content
4. Upsert webresourceset:
   → name: "new_{component_name}" (D365 requires publisher prefix)
   → webresourcetype: 1 (HTML)
5. POST PublishAllXml
```

---

## 13. Power Automate Deploy Pipeline (Flows)

**File:** `backend/app/power_automate_router.py`

### Step 1 — Load PA Environments

```javascript
// CodeConverterPage.js
handleLoadPaEnvs() → GET /power-automate/environments/{connection_id}
```

```python
# power_automate_router.py
token = _get_pa_token(tenant_id, client_id, client_secret)
# scope: https://service.flow.microsoft.com/.default
GET /providers/Microsoft.ProcessSimple/environments
→ Returns [{ id, displayName, location, type, isDefault }]
```

### Step 2 — Parse Flow JSON from LLM Output

```python
# _parse_flow_json(converted_code)
# Handles all truncation/wrapping scenarios:
1. Strip <converted> wrapper if present
2. Try json.loads(text) directly
3. Try regex patterns: ```json{...}```, {"properties":...}, {"$schema":...}
4. Walk braces to extract outermost { } block
```

### Step 3 — Build Connection References

```python
# Auto-detect which APIs the flow uses:
if "shared_commondataserviceforapps" in def_str:
    add "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps"
if "shared_office365" in def_str:
    add "/providers/Microsoft.PowerApps/apis/shared_office365"

connection_references = {
    "shared_commondataserviceforapps": {
        "connectionName": "shared_commondataserviceforapps",
        "source": "Invoker",
        "id": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps"
    }
}
```

### Step 4 — POST to PA API

```python
POST https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/{envId}/flows
Headers:
  Authorization: Bearer {pa_token}
  x-ms-client-scope: /providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps
Body:
{
  "properties": {
    "displayName": "FlowName",
    "definition": { ...Logic Apps schema... },
    "connectionReferences": { ... },
    "state": "Started"
  }
}
```

**Important:** `x-ms-client-scope` header is required — omitting it causes `ClientScopeAuthorizationFailed`.

### Step 5 — Return URLs

```json
{
  "ok": true,
  "flow_id": "...",
  "edit_url": "https://make.powerautomate.com/environments/{envId}/flows/{flowId}/edit",
  "run_url":  "https://make.powerautomate.com/environments/{envId}/flows/{flowId}"
}
```

### Required Permissions (Azure App Registration)
The D365 App Registration (client_id/secret) must have:
- `Flows.Manage.All` on Power Automate service
- `Dynamics CRM → user_impersonation` for Dataverse

---

## 14. Deployment Logs

**Files:** `backend/app/deployment_router.py` · `backend/app/d365_deploy_router.py` · `frontend/src/components/DeployLogsPage.js`

### Log Storage

Each deployment writes:
1. **DB row** (`deployment_logs` table) — status, assembly_id, step_ids, error_message, truncated log_text (≤50K chars)
2. **File** — `backend/data/orgs/{connection_id}/logs/deploy_{name}_{timestamp}.log`

### Log Format (`_StepLogger`)

```
=== Deployment log started at 2026-03-13T10:11:03.130120+00:00 ===
[   0.0s] ► Component: AccountListController (apex_class)
[   0.3s] ✓ Using existing signing key: .../PluginKey.snk
[   2.9s] ✓ Compiled → AccountListController.dll (7,680 bytes)
[   3.6s] ✓ D365 token acquired
[   5.1s] ✓ Assembly updated: 5b367a1b-aa1e-f111-88b4-000d3aca0d75
[   6.3s] ✓ Plugin type registered: AccountPlugin → {typeId}
[   8.1s] ✓ Step registered: Create → {stepId}
[   9.4s] ✓ Customizations published
=== SUCCESS — 9.4s elapsed ===
```

### Log Retrieval Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /d365-deploy/logs/{connection_id}` | List all logs (filterable by status, component_name, component_type) |
| `GET /d365-deploy/logs/{connection_id}/{log_id}` | Full log with log_text |
| `GET /d365-deploy/log-download/{log_id}` | Download raw .log file (falls back to DB text) |

### Deployment Statuses

| Status | Meaning |
|--------|---------|
| `running` | Deploy in progress |
| `success` | Fully deployed and published |
| `failed` | Error during compile / register / publish |
| `manual` | Flow type — instructions returned, no auto-deploy |

---

## 15. LLM Usage Tracking

**File:** `backend/app/llm_usage_router.py` · `backend/app/models/llm_usage.py`

Every LLM call logs to the `llm_usage` table:

| Field | Value |
|-------|-------|
| `call_type` | `code_convert` / `validate` / `agent_chat` |
| `provider` | `openai` / `anthropic` / `cohere` |
| `model` | e.g. `claude-opus-4-6` |
| `connection_id` | Org connection ID |
| `org_name` | Human name for the org |
| `input_tokens` | Prompt tokens |
| `output_tokens` | Completion tokens |
| `cost_usd` | Calculated from MODEL_PRICING table |
| `duration_ms` | Wall clock time |
| `component_name` | e.g. `AccountListController` |
| `component_type` | e.g. `apex_class` |

**Viewed in:** LLM Usage page (`/llm-usage` in frontend)

**Cost is displayed live in the Code Converter header:** `In 4.7K  Out 1.3K  Cost $0.0087  Time 27.8s  Model claude-opus-4-6`

---

## 16. API Route Map

### `backend/app/main.py` — Registered Routers

| Prefix | File | Purpose |
|--------|------|---------|
| (root) | `routers.py` | Field suggestions, mapping save, SF objects |
| `/shift` | `shift_router.py` | Org CRUD, test connections, extraction |
| `/connectors` | `connectors_router.py` | LLM config, rulebook CRUD, fix loop settings |
| `/code-converter` | `code_converter_router.py` | Component listing, source fetch, LLM convert |
| `/d365-deploy` | `d365_deploy_router.py` | Save/edit/validate/deploy, logs |
| `/power-automate` | `power_automate_router.py` | PA environments, deploy flow, seed rulebook |
| `/llm-usage` | `llm_usage_router.py` | Usage analytics |
| `/deployment-logs` | `deployment_router.py` | Cross-org deployment log browsing |
| `/agent-chat` | `agent_chat_router.py` | AI chat assistant |

### Key Endpoints Quick Reference

```
GET  /code-converter/orgs                          List orgs with metadata
GET  /code-converter/components/{connection_id}    List all SF components
GET  /code-converter/source/{cid}/{type}/{comp_id} Fetch live SF source
POST /code-converter/convert                       LLM conversion
GET  /code-converter/debug-flow/{cid}/{flow_id}    Flow resolution diagnostics

POST /d365-deploy/save                             Save conversion to DB
GET  /d365-deploy/saved/{connection_id}            List saved conversions
POST /d365-deploy/saved/{item_id}/validate         LLM validate + fix loop
POST /d365-deploy/saved/{item_id}/deploy           Deploy to D365

GET  /power-automate/environments/{connection_id}  List PA environments
POST /power-automate/deploy                        Deploy PA flow
POST /power-automate/seed-flow-rulebook            Upsert PA rulebook

GET  /field-suggestions/{object_name}              Lakehouse field mapping
POST /mapping/bulk                                 Save bulk mapping to Lakehouse
GET  /salesforce/objects/{object_name}/fields      Live SF Describe
```

---

## 17. Frontend Component Map

| File | Route | Purpose |
|------|-------|---------|
| `App.js` | — | Router, nav, theme toggle |
| `ShiftTab.js` | `/shift` | Metadata Migration: org list, extract, connect |
| `ConnectOrgModal.js` | modal | SF + D365 + Fabric credential entry |
| `ObjectsTab.js` | `/shift` step 3 | Select SF objects to migrate |
| `MappingTab.js` | `/shift` step 4 | Field mapping table with D365 dropdowns |
| `CodeConverterPage.js` | `/converter` | Main converter: sidebar + source + target |
| `DeploymentPlanPage.js` | `/deployment-plan` | Migration plan view |
| `DeployLogsPage.js` | `/logs` | Deployment log browser |
| `LLMConnectorPage.js` | `/llm` | LLM provider configuration |
| `LLMUsagePage.js` | `/usage` | Token usage dashboard |
| `AgentChatPage.js` | `/chat` | AI migration assistant |
| `OrgDetailPage.js` | `/org/:id` | Org detail and management |

### CodeConverterPage.js — Key State

```javascript
// Source side
selectedOrg          // { id, name } — org connection
components           // { apex_class: [...], flow: [...], ... }
selectedComp         // { id, name, type, ... }
sourceCode           // raw Apex/LWC/Aura/Flow text
flowMeta             // parsed Flow metadata (if flow)
flowView             // 'visual' | 'chart' | 'xml' | 'raw'

// Target side
convertedCode        // LLM output (C# or PA JSON)
notes                // migration notes from LLM
converting           // loading state
usage                // { input_tokens, output_tokens, cost_usd, model }

// PA Deploy state (flows only)
paEnvs               // [{ id, displayName }]
paEnvId              // selected environment
paDeploying          // loading state
paResult             // { ok, edit_url, run_url }

// D365 Deploy state (apex/lwc/aura)
savedItemId          // after save to DB
deploying            // loading state
deployResult         // { success, assembly_id, step_ids, log_id }
validateResult       // { verdict, issues, fixed_code }
```

---

## 18. Environment Variables

File: `.env.example`

```bash
# Salesforce (set per-connection in UI, not global)
# SF_USERNAME, SF_PASSWORD, SF_SECURITY_TOKEN

# D365 / Azure (set per-connection in UI)
# D365_ENVIRONMENT_URL, D365_TENANT_ID, D365_CLIENT_ID, D365_CLIENT_SECRET

# Fabric (set per-connection in UI)
# FABRIC_TENANT_ID, FABRIC_SERVICE_PRINCIPAL_ID
# FABRIC_SERVICE_PRINCIPAL_SECRET, FABRIC_SERVER, FABRIC_DATABASE

# LLM providers (set in LLM Connector UI)
# OPENAI_API_KEY, ANTHROPIC_API_KEY, COHERE_API_KEY

# App
DATABASE_URL=sqlite:///./backend/data/sf2dynamics.db
REDIS_URL=redis://localhost:6379
QDRANT_URL=http://localhost:6333
ENCRYPTION_KEY=<fernet_key_base64>   # generated on first run
```

---

## Known Issues & Notes

1. **Flow conversion max_tokens:** Set to 16,000 for complex flows. If still truncated, the `_parse_llm_response` truncation fallback handles missing `</converted>` tags.

2. **Plugin type name mismatch:** Fixed by `_extract_plugin_classname()` — parses C# source for actual `IPlugin` class name instead of using assembly name.

3. **PA deploy `x-ms-client-scope`:** Required header listing all connection API IDs used by the flow. `ClientScopeAuthorizationFailed` is thrown if omitted.

4. **FlowDefinitionView Tooling API:** NOT supported — always use REST API with `WHERE ApiName = '{name}'` (Strategy 1 in `_resolve_flow_version_id`).

5. **Field mapping coverage:** Currently only Account, Contact, Opportunity in Fabric Lakehouse. Lead, Task, etc. are not yet mapped and the LLM will use best-effort naming for those.

6. **Managed components:** Components with a `NamespacePrefix` are automatically filtered from the component list — their source is hidden by Salesforce and cannot be converted.

7. **Default Flow rulebook:** `DEFAULT_RULEBOOKS["flow"]` in `rulebook.py` still contains the old C# rulebook. The DB row (id=5) overrides it with the Power Automate rulebook. If the DB is reset, re-run `POST /power-automate/seed-flow-rulebook` to restore PA rules.
