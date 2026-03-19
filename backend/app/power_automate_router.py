"""
Power Automate Router — Deploy converted Salesforce Flows to Microsoft Power Automate.

Endpoints:
  GET  /power-automate/environments/{connection_id}   List PA environments
  POST /power-automate/deploy                         Deploy flow to PA
  POST /power-automate/seed-flow-rulebook             Upsert the Flow rulebook with PA rules
"""

import json
import re
from datetime import datetime, timezone
from typing import Optional

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .database import get_db
from .models.connections import Connection
from .models.rulebook import Rulebook
from .models.deployment_log import DeploymentLog
from .models.converted_items import ConvertedItem

router = APIRouter(prefix="/power-automate", tags=["power-automate"])

# NOTE: PA_SCOPE / PA_API_BASE removed — the PA Management API
# (api.flow.microsoft.com) does NOT support Service Principal (app-only) tokens.
# All operations use the Dataverse API (org.crm.dynamics.com) with
# scope "{env_url}/.default" which works correctly with SP auth.


# ── Helpers ────────────────────────────────────────────────────────────────────

def _extract_d365_creds(cfg: dict) -> tuple[str, str, str]:
    """Return (tenant_id, client_id, client_secret) from a connection config."""
    tenant_id     = cfg.get("d365_tenant_id")     or cfg.get("tenant_id", "")
    client_id     = cfg.get("d365_client_id")     or cfg.get("client_id", "")
    client_secret = cfg.get("d365_client_secret") or cfg.get("client_secret", "")
    return tenant_id, client_id, client_secret


def _parse_flow_json(converted_code: str) -> dict | None:
    """Extract the Power Automate / structured JSON from the LLM output."""
    text = converted_code.strip()
    if text.startswith("<converted>"):
        text = text[len("<converted>"):].strip()
    if text.endswith("</converted>"):
        text = text[:-len("</converted>")].strip()

    try:
        return json.loads(text)
    except Exception:
        pass

    for pattern in [
        r"```json\s*(\{.*?\})\s*```",
        r"```\s*(\{.*?\})\s*```",
        r'(\{"flow_name"\s*:.*\})',
        r'(\{"properties"\s*:.*\})',
        r'(\{"\$schema"\s*:.*\})',
        r'(\{"triggers"\s*:.*\})',
    ]:
        m = re.search(pattern, text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except Exception:
                pass

    start = text.find("{")
    if start != -1:
        depth = 0
        for i, ch in enumerate(text[start:], start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except Exception:
                        break
    return None


def _is_structured_json(flow_json: dict) -> bool:
    """True if the JSON is in POC AI structured format (flow_name + trigger_inputs + actions[])."""
    return (
        "flow_name" in flow_json
        and isinstance(flow_json.get("actions"), list)
    )


def _build_clientdata_from_structured(flow_json: dict) -> str:
    """
    Build a deployable Dataverse clientdata JSON string from POC AI structured flow JSON.
    The structured format has: flow_name, flow_type, trigger_table, trigger_event,
    trigger_inputs: {FieldName: {type, description}}, actions: [{step, name, action_type, inputs, ...}]
    """
    flow_type     = flow_json.get("flow_type", "Manual")
    trigger_event = flow_json.get("trigger_event", "Manual")
    trigger_table = flow_json.get("trigger_table", "none")

    # ── Step 1: trigger input schema ──
    input_schema_props: dict = {}
    raw_trigger_inputs = flow_json.get("trigger_inputs") or {}
    if isinstance(raw_trigger_inputs, dict):
        for ti_name, ti_val in raw_trigger_inputs.items():
            ti_type = (ti_val.get("type", "string") if isinstance(ti_val, dict) else "string")
            ti_desc = (ti_val.get("description", ti_name) if isinstance(ti_val, dict) else str(ti_val))
            input_schema_props[ti_name] = {"type": ti_type, "description": ti_desc}

    # ── Step 2: build actions dict ──
    built_actions: dict = {}
    prev_action: Optional[str] = None

    for act in (flow_json.get("actions") or []):
        if not isinstance(act, dict):
            continue
        act_type = act.get("action_type", "")
        act_name = re.sub(r"\W", "_", str(act.get("name", "Action"))).strip("_")
        run_after: dict = {}
        if prev_action:
            run_after = {prev_action: ["Succeeded"]}

        if act_type == "AddRow" and isinstance(act.get("inputs"), dict):
            table  = str(act["inputs"].get("table_name", "accounts"))
            row    = act["inputs"].get("row") or {}
            params = {"entityName": table}
            if isinstance(row, dict):
                for rk, rv in row.items():
                    rv_str = str(rv) if rv is not None else ""
                    # Keep booleans/numbers as-is, keep existing @{triggerBody()} refs as-is
                    if isinstance(rv, (bool, int, float)):
                        params[f"item/{rk}"] = rv
                    elif "@{triggerBody()" in rv_str or "@triggerBody()" in rv_str:
                        params[f"item/{rk}"] = rv_str
                    else:
                        clean = re.sub(r"[{}@\[\]?]", "", rv_str).strip(" '\"")
                        params[f"item/{rk}"] = f"@{{triggerBody()?['{clean}']}}" if clean else rv_str
            built_actions[act_name] = {
                "type": "OpenApiConnection",
                "inputs": {
                    "host": {
                        "connectionName": "shared_commondataserviceforapps",
                        "operationId":    "CreateRecord",
                        "apiId":          "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                    },
                    "parameters":     params,
                    "authentication": "@parameters('$authentication')",
                },
                "runAfter": run_after,
            }

        elif act_type == "UpdateRow" and isinstance(act.get("inputs"), dict):
            table     = str(act["inputs"].get("table_name", "accounts"))
            row       = act["inputs"].get("row") or {}
            record_id = act["inputs"].get("recordId", "@{triggerBody()?['accountid']}")
            params    = {"entityName": table, "recordId": record_id}
            if isinstance(row, dict):
                for rk, rv in row.items():
                    params[f"item/{rk}"] = rv
            built_actions[act_name] = {
                "type": "OpenApiConnection",
                "inputs": {
                    "host": {
                        "connectionName": "shared_commondataserviceforapps",
                        "operationId":    "UpdateRecord",
                        "apiId":          "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                    },
                    "parameters":     params,
                    "authentication": "@parameters('$authentication')",
                },
                "runAfter": run_after,
            }

        elif act_type in ("GetRow", "ListRows") and isinstance(act.get("inputs"), dict):
            table  = str(act["inputs"].get("table_name", "accounts"))
            op_id  = "GetItem" if act_type == "GetRow" else "ListRecords"
            params = {"entityName": table}
            if act_type == "GetRow":
                params["recordId"] = act["inputs"].get("recordId", "@{triggerBody()?['accountid']}")
                if act["inputs"].get("select"):
                    params["$select"] = act["inputs"]["select"]
            else:
                if act["inputs"].get("filter"):
                    params["$filter"] = act["inputs"]["filter"]
                if act["inputs"].get("select"):
                    params["$select"] = act["inputs"]["select"]
                if act["inputs"].get("top"):
                    params["$top"] = act["inputs"]["top"]
            built_actions[act_name] = {
                "type": "OpenApiConnection",
                "inputs": {
                    "host": {
                        "connectionName": "shared_commondataserviceforapps",
                        "operationId":    op_id,
                        "apiId":          "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                    },
                    "parameters":     params,
                    "authentication": "@parameters('$authentication')",
                },
                "runAfter": run_after,
            }

        elif act_type == "DeleteRow" and isinstance(act.get("inputs"), dict):
            table     = str(act["inputs"].get("table_name", "accounts"))
            record_id = act["inputs"].get("recordId", "@{triggerBody()?['accountid']}")
            built_actions[act_name] = {
                "type": "OpenApiConnection",
                "inputs": {
                    "host": {
                        "connectionName": "shared_commondataserviceforapps",
                        "operationId":    "DeleteRecord",
                        "apiId":          "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                    },
                    "parameters":     {"entityName": table, "recordId": record_id},
                    "authentication": "@parameters('$authentication')",
                },
                "runAfter": run_after,
            }

        elif act_type == "SendEmail" and isinstance(act.get("inputs"), dict):
            inp = act["inputs"]
            built_actions[act_name] = {
                "type": "OpenApiConnection",
                "inputs": {
                    "host": {
                        "connectionName": "shared_office365",
                        "operationId":    "SendEmailV2",
                        "apiId":          "/providers/Microsoft.PowerApps/apis/shared_office365",
                    },
                    "parameters": {
                        "emailMessage/To":      inp.get("to", ""),
                        "emailMessage/Subject": inp.get("subject", ""),
                        "emailMessage/Body":    inp.get("body", ""),
                    },
                    "authentication": "@parameters('$authentication')",
                },
                "runAfter": run_after,
            }

        elif act_type in ("InitializeVariable", "SetVariable") and isinstance(act.get("inputs"), dict):
            inp = act["inputs"]
            if act_type == "InitializeVariable":
                built_actions[act_name] = {
                    "type":   "InitializeVariable",
                    "inputs": {"variables": [{"name": inp.get("name", "var"), "type": inp.get("type", "string"), "value": inp.get("value", "")}]},
                    "runAfter": run_after,
                }
            else:
                built_actions[act_name] = {
                    "type":   "SetVariable",
                    "inputs": {"name": inp.get("name", "var"), "value": inp.get("value", "")},
                    "runAfter": run_after,
                }

        elif act_type == "Condition" and isinstance(act.get("inputs"), dict):
            built_actions[act_name] = {
                "type":       "If",
                "expression": act["inputs"].get("expression", {"and": []}),
                "actions":    {},
                "else":       {"actions": {}},
                "runAfter":   run_after,
            }

        elif act_type == "Foreach" and isinstance(act.get("inputs"), dict):
            built_actions[act_name] = {
                "type":    "Foreach",
                "foreach": act["inputs"].get("from", "@body('List_Records')?['value']"),
                "actions": {},
                "runAfter": run_after,
            }

        else:
            # Generic Compose for unrecognised action types
            built_actions[act_name] = {
                "type":     "Compose",
                "inputs":   json.dumps(act.get("inputs", {})),
                "runAfter": run_after,
            }

        prev_action = act_name

    # ── Step 3: fallback defaults ──
    if not input_schema_props:
        input_schema_props = {
            "Account_Name": {"type": "string", "description": "Account name"},
            "CurrencyISO":  {"type": "string", "description": "Currency ISO code"},
        }
    if not built_actions:
        built_actions = {
            "Create_Account": {
                "type": "OpenApiConnection",
                "inputs": {
                    "host": {
                        "connectionName": "shared_commondataserviceforapps",
                        "operationId":    "CreateRecord",
                        "apiId":          "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                    },
                    "parameters": {
                        "entityName":            "accounts",
                        "item/name":             "@{triggerBody()?['Account_Name']}",
                        "item/new_currencyisocode": "@{triggerBody()?['CurrencyISO']}",
                        "item/new_dynamiccheckbox": False,
                    },
                    "authentication": "@parameters('$authentication')",
                },
                "runAfter": {},
            }
        }

    # ── Step 4: choose trigger ──
    filter_clause_map = {
        "Added":            "entityCreated",
        "Modified":         "entityUpdated",
        "Added or Modified": "entityCreatedOrUpdated",
        "Deleted":          "entityDeleted",
    }
    if flow_type == "Automated" and trigger_table not in ("none", ""):
        triggers = {
            "When_a_row_is_added_modified_or_deleted": {
                "type": "OpenApiConnectionNotification",
                "inputs": {
                    "host": {
                        "connectionName": "shared_commondataserviceforapps",
                        "operationId":    "SubscribeToEntityChanges",
                        "apiId":          "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                    },
                    "parameters": {
                        "subscriptionRequest/entityname":    trigger_table,
                        "subscriptionRequest/scope":         "organization",
                        "subscriptionRequest/filterclause":  filter_clause_map.get(trigger_event, "entityCreated"),
                    },
                    "authentication": "@parameters('$authentication')",
                },
            }
        }
    elif flow_type == "Scheduled":
        triggers = {
            "Recurrence": {
                "type": "Recurrence",
                "recurrence": {
                    "frequency": "Day",
                    "interval":  1,
                    "startTime": "2026-01-01T09:00:00",
                    "timeZone":  "UTC",
                },
            }
        }
    else:
        # Manual / Instant / Screen Flow
        triggers = {
            "manual": {
                "type": "Request",
                "kind": "Button",
                "inputs": {
                    "schema": {
                        "type":       "object",
                        "properties": input_schema_props,
                    }
                },
            }
        }

    clientdata = {
        "schemaVersion": "1.0.0.0",
        "properties": {
            "connectionReferences": {},
            "definition": {
                "$schema":        "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
                "contentVersion": "1.0.0.0",
                "parameters": {
                    "$connections":    {"defaultValue": {}, "type": "Object"},
                    "$authentication": {"defaultValue": {}, "type": "SecureObject"},
                },
                "triggers": triggers,
                "actions":  built_actions,
            },
        },
    }
    return json.dumps(clientdata)


_OP_MAP = {
    # Old ApiConnection operationIds → OpenApiConnection equivalents
    "PostItem":   "CreateRecord",
    "PatchItem":  "UpdateRecord",
    "GetItem":    "GetItem",
    "GetItems":   "ListRecords",
    "DeleteItem": "DeleteRecord",
}


def _normalise_definition(definition: dict) -> dict:
    """
    Convert old-format Logic Apps definitions to the OpenApiConnection format
    that the Dataverse Workflow API (category=5) requires.

    - type: "ApiConnection"  → type: "OpenApiConnection"
    - operationId: "PostItem" → operationId: "CreateRecord"  (etc.)
    - adds "authentication": "@parameters('$authentication')" to every action
    - ensures $connections / $authentication parameters exist
    """
    import copy
    defn = copy.deepcopy(definition)

    # Ensure required parameters block
    defn.setdefault("parameters", {})
    defn["parameters"].setdefault("$connections",    {"defaultValue": {}, "type": "Object"})
    defn["parameters"].setdefault("$authentication", {"defaultValue": {}, "type": "SecureObject"})

    def _fix_actions(actions: dict):
        for name, act in actions.items():
            if not isinstance(act, dict):
                continue
            # Convert type
            if act.get("type") == "ApiConnection":
                act["type"] = "OpenApiConnection"
            # Fix operationId and add authentication
            inp = act.get("inputs", {})
            if isinstance(inp, dict):
                host = inp.get("host", {})
                if isinstance(host, dict):
                    old_op = host.get("operationId", "")
                    if old_op in _OP_MAP:
                        host["operationId"] = _OP_MAP[old_op]
                    # Flatten parameters/ prefix for item/* fields (old format uses body/item/*)
                    params = inp.get("parameters", inp.get("body", {}))
                    if params and "parameters" not in inp:
                        inp["parameters"] = params
                        inp.pop("body", None)
                if "authentication" not in inp:
                    inp["authentication"] = "@parameters('$authentication')"
            # Recurse into branches
            for branch_key in ("actions", "else"):
                branch = act.get(branch_key, {})
                if isinstance(branch, dict):
                    nested = branch if branch_key == "actions" else branch.get("actions", {})
                    if nested:
                        _fix_actions(nested)

    _fix_actions(defn.get("actions", {}))
    return defn


def _build_clientdata_from_logicapps(flow_json: dict) -> str:
    """
    Build Dataverse clientdata from a Logic Apps definition JSON (old format).
    Normalises ApiConnection → OpenApiConnection and PostItem → CreateRecord.
    """
    if "properties" in flow_json and "definition" in flow_json["properties"]:
        raw_def = flow_json["properties"]["definition"]
    elif "$schema" in flow_json or "triggers" in flow_json or "actions" in flow_json:
        raw_def = flow_json
    else:
        raw_def = flow_json

    definition = _normalise_definition(raw_def)

    clientdata = {
        "schemaVersion": "1.0.0.0",
        "properties": {
            "connectionReferences": {},
            "definition": definition,
        },
    }
    return json.dumps(clientdata)


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/environments/{connection_id}")
def list_environments(connection_id: int, db: Session = Depends(get_db)):
    """
    Return the Power Automate environment derived from the connection's
    d365_environment_url and power_platform_env_id config fields.

    NOTE: The PA Management API (api.flow.microsoft.com) does NOT support
    Service Principal tokens — it requires delegated (user) auth.
    We therefore derive the environment directly from the stored config.
    """
    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found.")
    try:
        cfg = json.loads(conn.config_json or "{}")
    except Exception:
        raise HTTPException(status_code=500, detail="Invalid connection config.")

    env_url = cfg.get("d365_environment_url", "").strip().rstrip("/")
    env_id  = cfg.get("power_platform_env_id", "").strip()

    if not env_url:
        return {"environments": []}

    return {
        "environments": [
            {
                "id":          env_id or env_url,
                "displayName": env_url,
                "location":    "configured",
                "type":        "Production",
                "isDefault":   True,
            }
        ]
    }


class DeployFlowRequest(BaseModel):
    connection_id:  int
    environment_id: str                   # PA environment name/id (used for flow URL)
    flow_name:      str
    converted_code: str                   # Full LLM output
    component_type: str = "flow"
    saved_item_id:  Optional[int] = None  # ConvertedItem.id to update status after deploy


def _deploy_via_dataverse_api(
    tenant_id: str, client_id: str, client_secret: str,
    env_url: str, env_id: str, flow_name: str, clientdata_str: str,
) -> dict:
    """
    PRIMARY deployment path: Dataverse Workflow API (category=5 Modern Flow).
    Works with service-principal auth — no x-ms-client-scope issues.
    """
    import msal
    app = msal.ConfidentialClientApplication(
        client_id,
        authority=f"https://login.microsoftonline.com/{tenant_id}",
        client_credential=client_secret,
    )
    result = app.acquire_token_for_client(scopes=[f"{env_url.rstrip('/')}/.default"])
    if "access_token" not in result:
        raise ValueError(f"Dataverse token error: {result.get('error_description', 'unknown')}")

    dv_token = result["access_token"]
    headers = {
        "Authorization":    f"Bearer {dv_token}",
        "Content-Type":     "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version":    "4.0",
        "Accept":           "application/json",
    }
    wf_api = f"{env_url.rstrip('/')}/api/data/v9.2/workflows"

    # Check if a flow with this name already exists (category=5)
    search = requests.get(
        wf_api,
        headers=headers,
        params={"$filter": f"name eq '{flow_name}' and category eq 5", "$select": "workflowid,name,statecode"},
        timeout=30,
    )
    existing_wf_id = None
    if search.status_code == 200:
        existing = search.json().get("value", [])
        if existing:
            existing_wf_id = existing[0].get("workflowid")

    if existing_wf_id:
        # DELETE then re-CREATE (PATCH clientdata is unreliable)
        requests.delete(f"{wf_api}({existing_wf_id})", headers=headers, timeout=30)

    wf_body = {
        "name":          flow_name,
        "category":      5,       # Modern Flow (Power Automate)
        "type":          1,       # Definition
        "primaryentity": "none",
        "clientdata":    clientdata_str,
        "statecode":     0,       # Draft
        "statuscode":    1,       # Draft
    }
    resp = requests.post(wf_api, headers=headers, json=wf_body, timeout=30)
    if resp.status_code not in (200, 201, 204):
        raise ValueError(f"Dataverse workflow POST failed ({resp.status_code}): {resp.text[:500]}")

    # Extract workflow GUID from OData-EntityId header
    entity_id_header = resp.headers.get("OData-EntityId", "")
    wf_id_match = re.search(r"\(([0-9a-f\-]{36})\)", entity_id_header)
    wf_id = wf_id_match.group(1) if wf_id_match else ""

    if not wf_id and resp.content:
        try:
            wf_id = resp.json().get("workflowid", "")
        except Exception:
            pass

    # Auto-activate (statecode=1)
    activation_ok = False
    if wf_id:
        try:
            act_resp = requests.patch(
                f"{wf_api}({wf_id})",
                headers=headers,
                json={"statecode": 1, "statuscode": 2},
                timeout=30,
            )
            activation_ok = act_resp.status_code in (200, 204)
        except Exception:
            pass

    # Build flow URLs — env_id must be a GUID, not an org URL
    if env_id and env_id.startswith("http"):
        env_id = ""  # discard — org URL is not valid for make.powerautomate.com

    if env_id and wf_id:
        edit_url = f"https://make.powerautomate.com/environments/{env_id}/flows/{wf_id}/edit"
        run_url  = f"https://make.powerautomate.com/environments/{env_id}/flows/{wf_id}"
    elif wf_id:
        edit_url = f"https://make.powerautomate.com/flows/{wf_id}/edit"
        run_url  = f"https://make.powerautomate.com/flows/{wf_id}"
    else:
        edit_url = run_url = ""

    return {
        "flow_id":         wf_id,
        "flow_name":       flow_name,
        "edit_url":        edit_url,
        "run_url":         run_url,
        "created_at":      datetime.now(timezone.utc).isoformat(),
        "state":           "Started" if activation_ok else "Draft",
        "activation_ok":   activation_ok,
    }


_FLOW_MANUAL_STEPS = """\
MANUAL DEPLOYMENT STEPS (Power Automate):
1. Go to make.powerautomate.com and sign in.
2. Click "My flows" → "+ New flow" → "Import" (or paste the JSON).
3. Copy the converted JSON from the Target panel.
4. Create a new Instant/Automated flow → paste actions from JSON.
5. On each Dataverse action: click the connection icon → sign in to authorize.
6. Save the flow and click "Turn on".
7. Test by triggering the flow manually or via the configured event.

Alternatively use Power Automate CLI:
  pac flow import --file flow.json --environment <env-id>
"""


@router.post("/deploy")
def deploy_flow(req: DeployFlowRequest, db: Session = Depends(get_db)):
    """
    Deploy a converted Power Automate flow JSON to the specified environment.

    PRIMARY path: Dataverse Workflow API (category=5) — works with SP auth, no x-ms-client-scope needed.
    FALLBACK: manual deploy instructions returned when Dataverse URL is not configured.
    """
    conn = db.query(Connection).filter(Connection.id == req.connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found.")
    try:
        cfg = json.loads(conn.config_json or "{}")
    except Exception:
        raise HTTPException(status_code=500, detail="Invalid connection config.")

    tenant_id, client_id, client_secret = _extract_d365_creds(cfg)
    env_url = cfg.get("d365_environment_url", "").strip().rstrip("/")

    # Create deployment log entry FIRST so all failures are visible in history
    deploy_log = DeploymentLog(
        connection_id  = req.connection_id,
        component_type = "flow",
        component_name = req.flow_name,
        source         = "converter",
        source_item_id = req.saved_item_id,
        status         = "running",
        created_at     = datetime.now(timezone.utc),
    )
    db.add(deploy_log)
    db.commit()
    db.refresh(deploy_log)

    log_lines: list[str] = [
        f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] Starting flow deployment: {req.flow_name}",
        f"  Environment: {req.environment_id}",
        f"  Tenant: {tenant_id[:8] if tenant_id else '(missing)'}...",
        f"  env_url: {env_url or '(not configured)'}",
    ]

    def _fail_log(msg: str, status: str = "failed") -> dict:
        deploy_log.status        = status
        deploy_log.error_message = msg
        deploy_log.log_text      = "\n".join(log_lines + [f"FAILED: {msg}"])
        deploy_log.completed_at  = datetime.now(timezone.utc)
        db.commit()
        return {"ok": False, "error": msg, "log_id": deploy_log.id, "log_text": deploy_log.log_text}

    if not all([tenant_id, client_id, client_secret]):
        result = _fail_log("D365 credentials missing. Add tenant_id, client_id, client_secret in the Metadata Migration tab.")
        raise HTTPException(status_code=400, detail=result["error"])

    # Parse the flow JSON from LLM output
    flow_json = _parse_flow_json(req.converted_code)
    if not flow_json:
        result = _fail_log("Could not find valid JSON in the converted output.")
        raise HTTPException(status_code=422, detail=result["error"])

    # Build the Dataverse clientdata string (detect format)
    fmt = "unknown"
    try:
        if _is_structured_json(flow_json):
            clientdata_str = _build_clientdata_from_structured(flow_json)
            fmt = "structured"
        else:
            clientdata_str = _build_clientdata_from_logicapps(flow_json)
            fmt = "logicapps"
    except Exception as build_exc:
        result = _fail_log(f"Failed to build clientdata: {build_exc}")
        raise HTTPException(status_code=500, detail=result["error"])

    log_lines.append(f"  Input format: {fmt}")

    deploy_result = None
    deploy_error  = None
    is_manual     = False

    # PRIMARY: Dataverse Workflow API (category=5) — no x-ms-client-scope needed
    if env_url:
        try:
            log_lines.append(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] Trying Dataverse Workflow API (category=5)...")
            deploy_result = _deploy_via_dataverse_api(
                tenant_id, client_id, client_secret,
                env_url, req.environment_id, req.flow_name, clientdata_str,
            )
            activation_status = "activated" if deploy_result.get("activation_ok") else "draft (needs manual activation)"
            log_lines.append(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] Dataverse API deploy success!")
            log_lines.append(f"  Flow ID  : {deploy_result['flow_id']}")
            log_lines.append(f"  Edit URL : {deploy_result['edit_url']}")
            log_lines.append(f"  Status   : {activation_status}")
            if not deploy_result.get("activation_ok"):
                log_lines.append("  ACTION REQUIRED: Open flow in Power Automate portal, authorize Dataverse connection, Save, then Turn On.")
        except Exception as exc:
            dv_err = str(exc)
            log_lines.append(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] Dataverse API failed: {dv_err[:400]}")
            deploy_error = dv_err
    else:
        log_lines.append("  No d365_environment_url configured — Dataverse API path skipped.")
        log_lines.append("  Add d365_environment_url (e.g. https://org.crm.dynamics.com) in the connection settings.")
        deploy_error = "d365_environment_url not configured"

    # If Dataverse API failed / not configured → manual
    if deploy_result is None:
        is_manual = True
        log_lines.append(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] Auto-deploy failed. Manual deployment required.")
        log_lines.append(_FLOW_MANUAL_STEPS)

    # Update deployment log
    flow_url = deploy_result["edit_url"] if deploy_result else ""
    deploy_log.status        = "success" if deploy_result else "manual" if is_manual else "failed"
    deploy_log.log_text      = "\n".join(log_lines)
    deploy_log.flow_url      = flow_url
    deploy_log.error_message = deploy_error
    deploy_log.completed_at  = datetime.now(timezone.utc)
    db.commit()

    # Update ConvertedItem status if saved_item_id provided
    if req.saved_item_id:
        try:
            item = db.query(ConvertedItem).filter(ConvertedItem.id == req.saved_item_id).first()
            if item:
                item.status     = "deployed" if deploy_result else "manual"
                item.updated_at = datetime.now(timezone.utc)
                db.commit()
        except Exception:
            pass

    if deploy_result:
        return {
            "ok":         True,
            "flow_id":    deploy_result["flow_id"],
            "flow_name":  deploy_result["flow_name"],
            "edit_url":   deploy_result["edit_url"],
            "run_url":    deploy_result["run_url"],
            "created_at": deploy_result["created_at"],
            "state":      deploy_result["state"],
            "log_id":     deploy_log.id,
            "log_text":   "\n".join(log_lines),
        }
    else:
        return {
            "ok":           False,
            "error":        deploy_error,
            "is_manual":    True,
            "manual_steps": _FLOW_MANUAL_STEPS,
            "log_id":       deploy_log.id,
            "log_text":     "\n".join(log_lines),
        }


# ── Rulebook seed ──────────────────────────────────────────────────────────────

FLOW_PA_RULEBOOK = {
    "title": "Salesforce Flow → Power Automate Cloud Flow (JSON)",
    "system_prompt": (
        "You are a Salesforce-to-Power Automate migration expert. "
        "Detect flow type from process_type + trigger_type: "
        "process_type=Flow + trigger_type=null = Screen Flow (Manual Button trigger, NOT Canvas App); "
        "process_type=AutoLaunchedFlow + trigger_type=RecordAfterSave = Record-Triggered After-Save (Dataverse row trigger); "
        "process_type=AutoLaunchedFlow + trigger_type=RecordBeforeSave = Before-Save (document as Dataverse Plugin — no PA equivalent); "
        "process_type=AutoLaunchedFlow + trigger_type=RecordBeforeDelete = Before-Delete (Dataverse row trigger, Deleted); "
        "process_type=AutoLaunchedFlow + trigger_type=Scheduled = Scheduled (Recurrence trigger); "
        "process_type=AutoLaunchedFlow + trigger_type=PlatformEvent = Platform Event (HTTP trigger); "
        "process_type=AutoLaunchedFlow + trigger_type=null = Auto-launched subflow (Manual Button trigger); "
        "process_type=Orchestrator = Orchestration (Scope + Approvals pattern). "
        "SCREEN FLOW screen field mapping: "
        "fieldType=InputField dataType=String->string, Number->integer, Currency->number, Boolean->boolean, Date->string, DateTime->string; "
        "fieldType=LargeTextArea->string; fieldType=DropdownBox->string; fieldType=RadioButtons->string; "
        "fieldType=MultiSelectPicklist->string (semicolon-delimited); "
        "fieldType=DisplayText/DisplayImage/RegionContainer/Region->SKIP (no input). "
        "Screen field 'name' property becomes the exact trigger input parameter key. "
        "ELEMENT MAPPING: "
        "RecordCreate->AddRow (table_name + row with simple trigger refs, item/new_dynamiccheckbox=false for accounts); "
        "RecordUpdate->UpdateRow; RecordLookup single->GetRow; RecordLookup multiple->ListRows with $filter; "
        "RecordDelete->DeleteRow; Decision->Condition (2-branch) or Switch (multi-branch); "
        "Assignment->SetVariable/InitializeVariable/Compose; Loop->Foreach (Apply to each); "
        "CollectionFilter->FilterArray; CollectionSort->sort() expression; Transform->Select; "
        "Subflow->RunChildFlow; ActionCall emailSimple/emailAlert->SendEmail (Office365 SendEmailV2); "
        "ActionCall chatterPost->PostMessage (Teams); ActionCall submit->Approval (CreateApprovalWaitForResponse); "
        "ActionCall apex->HTTP; ActionCall customNotification->SendNotification; "
        "Wait amount->Delay; Wait until date->DelayUntil; FaultConnector->Scope Try/Catch; "
        "CustomError->Terminate (Status: Failed) + note that DB rollback requires Dataverse plugin. "
        "CRITICAL: AddRow row values must use @{triggerBody()?['name']} syntax only — no if(), no equals(), no nested expressions. "
        "Use field mapping Dataverse_Column for all field references when MANDATORY FIELD MAPPING is provided. "
        "Choice/OptionSet fields use integer values, never string labels. "
        "Return ONLY valid JSON inside <converted>...</converted> — no markdown, no explanation outside the tags."
    ),
    "rules": """\
SALESFORCE FLOW -> POWER AUTOMATE / DATAVERSE CONVERSION RULES
==============================================================
These rules produce deployable Power Automate flows via the Dataverse workflow entity API (category=5).
Every output must be valid structured JSON (see SECTION 7 for exact output shape).
Covers ALL Salesforce Flow types and ALL element/action types.

══════════════════════════════════════════════════════════════
SECTION 1 — FLOW TYPE DETECTION (process_type + trigger_type)
══════════════════════════════════════════════════════════════

Detect Salesforce flow type from EXACTLY TWO fields: process_type AND trigger_type.

COMPLETE DETECTION TABLE:
  process_type=Flow,                trigger_type=null              -> SCREEN FLOW            -> Manual Button trigger
  process_type=AutoLaunchedFlow,    trigger_type=RecordBeforeSave  -> RECORD-TRIGGERED-BEFORE -> Dataverse Plugin (no PA equivalent)
  process_type=AutoLaunchedFlow,    trigger_type=RecordAfterSave   -> RECORD-TRIGGERED-AFTER  -> Dataverse row trigger
  process_type=AutoLaunchedFlow,    trigger_type=RecordBeforeDelete-> RECORD-TRIGGERED-DELETE -> Dataverse row trigger (Deleted)
  process_type=AutoLaunchedFlow,    trigger_type=Scheduled         -> SCHEDULED FLOW          -> Recurrence trigger
  process_type=AutoLaunchedFlow,    trigger_type=PlatformEvent     -> PLATFORM EVENT          -> HTTP webhook trigger
  process_type=AutoLaunchedFlow,    trigger_type=null              -> AUTO-LAUNCHED (subflow) -> Instant / child flow
  process_type=Orchestrator,        trigger_type=null              -> ORCHESTRATION           -> Scope/Approvals pattern
  process_type=Orchestrator,        trigger_type=RecordAfterSave   -> RECORD ORCHESTRATION    -> Dataverse row + Approvals

IMPORTANT SUB-VARIANT: recordTriggerType inside RecordAfterSave:
  recordTriggerType=Create           -> trigger_event "Added"
  recordTriggerType=Update           -> trigger_event "Modified"
  recordTriggerType=CreateAndUpdate  -> trigger_event "Added or Modified"
  recordTriggerType=Delete           -> trigger_event "Deleted"

BEFORE-SAVE LIMITATION (CRITICAL — must document in notes):
  RecordBeforeSave flows run synchronously before DB commit — cannot be replicated in Power Automate cloud flows.
  Power Automate is always asynchronous and post-commit. Migration path:
  1. Dataverse C# Plug-in (Pre-Operation stage) — for field updates and blocking saves
  2. Dataverse Business Rules — for simple field defaults and validation
  Output flow_type="Automated" with notes explaining the limitation and recommended Dataverse plugin approach.

SCREEN FLOW CONFIRMATION: if process_type=Flow AND trigger_type=null AND screens[] array is non-empty
  -> confirmed Screen Flow. screen fields become trigger_inputs.
  DisplayText, DisplayImage, RegionContainer, Region fields -> SKIP (informational/container only)

══════════════════════════════════════════════════════════════
SECTION 2 — TRIGGER DEFINITIONS BY TYPE
══════════════════════════════════════════════════════════════

── 2A. SCREEN FLOW → Manual Button Trigger ──
  SCREEN FIELD TYPE MAPPING (fieldType + dataType → trigger_inputs type):
    fieldType=InputField, dataType=String      -> type "string"
    fieldType=InputField, dataType=Number      -> type "integer" (use "number" for decimals)
    fieldType=InputField, dataType=Currency    -> type "number"
    fieldType=InputField, dataType=Boolean     -> type "boolean"
    fieldType=InputField, dataType=Date        -> type "string" (ISO 8601 date yyyy-MM-dd)
    fieldType=InputField, dataType=DateTime    -> type "string" (ISO 8601 datetime)
    fieldType=LargeTextArea                    -> type "string"
    fieldType=DropdownBox                      -> type "string" (selected choice API value)
    fieldType=RadioButtons                     -> type "string" (selected choice API value)
    fieldType=MultiSelectPicklist              -> type "string" (semicolon-delimited values)
    fieldType=DisplayText                      -> SKIP — informational output only
    fieldType=DisplayImage                     -> SKIP — display only
    fieldType=RegionContainer                  -> SKIP — container
    fieldType=Region                           -> SKIP — container
    fieldType=ObjectProvided (lookup)          -> type "string" (Dataverse row GUID)

  Screen field "name" property -> trigger_inputs key (EXACT same name, case-preserved)
  Access in actions: @{triggerBody()?['Account_Name']}  @{triggerBody()?['IsActive']}

── 2B. RECORD-TRIGGERED FLOW → Dataverse Row Trigger ──
  recordTriggerType=Create           -> trigger_event "Added"
  recordTriggerType=Update           -> trigger_event "Modified"
  recordTriggerType=CreateAndUpdate  -> trigger_event "Added or Modified"
  recordTriggerType=Delete           -> trigger_event "Deleted"
  object (objectApiName)             -> Dataverse table logical name -> trigger_table

  Access in actions: @{triggerBody()?['name']}  @{triggerBody()?['accountid']}

── 2C. SCHEDULED FLOW → Recurrence Trigger ──
  flow_type = "Scheduled", trigger_event = "Scheduled"

── 2D. AUTO-LAUNCHED FLOW → Instant Manual Trigger ──
  variables with isInput=true  -> trigger_inputs parameters
  variables with isOutput=true -> document as flow outputs in notes

══════════════════════════════════════════════════════════════
SECTION 3 — ELEMENT → ACTION MAPPING
══════════════════════════════════════════════════════════════

ALL ELEMENT TYPES:
  Decision              -> Condition (2 branches) or Switch (multi-branch)
  Assignment            -> SetVariable / InitializeVariable
  Loop                  -> Foreach (Apply to each)
  CollectionFilter      -> FilterArray action
  CollectionSort        -> sort() expression inside Compose
  Transform             -> Select action (field mapping)
  RecordCreate          -> action_type: AddRow  — operationId: CreateRecord
  RecordUpdate          -> action_type: UpdateRow — operationId: UpdateRecord
  RecordLookup single   -> action_type: GetRow — operationId: GetItem
  RecordLookup multiple -> action_type: ListRows — operationId: ListRecords
  RecordDelete          -> action_type: DeleteRow — operationId: DeleteRecord
  ActionCall emailSimple -> action_type: SendEmail — Office365 SendEmailV2
  ActionCall chatterPost -> Post message to Microsoft Teams
  ActionCall submit      -> Approval (CreateApprovalWaitForResponse)
  ActionCall apex        -> HTTP action (call Azure Function or custom API endpoint)
  Subflow               -> action_type: RunChildFlow
  Wait (amount of time) -> Delay action
  Wait (until date)     -> DelayUntil action
  FaultConnector        -> Scope Try/Catch pattern
  CustomError           -> Terminate action (Status: Failed)

── AddRow action format ──
  {
    "step": 1,
    "name": "Create_Account",
    "action_type": "AddRow",
    "description": "Create new Account record in Dataverse",
    "inputs": {
      "table_name": "accounts",
      "row": {
        "name":                   "@{triggerBody()?['Account_Name']}",
        "new_currencyisocode":    "@{triggerBody()?['CurrencyISO']}",
        "new_dynamiccheckbox":    false
      }
    },
    "outputs": {"accountid": "GUID of created account"}
  }
  CRITICAL: row values MUST be simple @{triggerBody()?['name']} references — NO if(), NO equals(), NO complex expressions.
  Required field "new_dynamiccheckbox": always include with value false in every Account AddRow action.

── UpdateRow action format ──
  {
    "step": 2,
    "name": "Update_Account",
    "action_type": "UpdateRow",
    "inputs": {
      "table_name": "accounts",
      "recordId":   "@{triggerBody()?['accountid']}",
      "row": {
        "name": "@{triggerBody()?['Account_Name']}"
      }
    }
  }

── GetRow action format ──
  {
    "step": 3,
    "name": "Get_Account",
    "action_type": "GetRow",
    "inputs": {
      "table_name": "accounts",
      "recordId":   "@{triggerBody()?['accountid']}",
      "select":     "accountid,name,revenue"
    }
  }

── ListRows action format ──
  {
    "step": 4,
    "name": "List_Accounts",
    "action_type": "ListRows",
    "inputs": {
      "table_name": "accounts",
      "filter":     "statecode eq 0 and revenue gt 100000",
      "select":     "accountid,name,revenue",
      "top":        200
    }
  }

── DeleteRow action format ──
  {
    "step": 5,
    "name": "Delete_Account",
    "action_type": "DeleteRow",
    "inputs": {
      "table_name": "accounts",
      "recordId":   "@{triggerBody()?['accountid']}"
    }
  }

── Condition action format ──
  {
    "step": 6,
    "name": "Check_Revenue",
    "action_type": "Condition",
    "inputs": {
      "expression": {
        "and": [
          {"equals": ["@triggerBody()?['statecode']", 0]},
          {"greater": ["@triggerBody()?['revenue']", 100000]}
        ]
      }
    }
  }

── SendEmail action format ──
  {
    "step": 7,
    "name": "Send_Email",
    "action_type": "SendEmail",
    "inputs": {
      "to":      "recipient@company.com",
      "subject": "@{concat('Account Created: ', triggerBody()?['name'])}",
      "body":    "@{concat('<p>Account Name: ', triggerBody()?['name'], '</p>')}"
    }
  }

── InitializeVariable / SetVariable format ──
  {
    "step": 8,
    "name": "Initialize_Total",
    "action_type": "InitializeVariable",
    "inputs": { "name": "total", "type": "integer", "value": 0 }
  }
  {
    "step": 9,
    "name": "Set_Total",
    "action_type": "SetVariable",
    "inputs": { "name": "total", "value": "@add(variables('total'), 1)" }
  }

── Foreach / Loop format ──
  {
    "step": 10,
    "name": "Apply_to_each",
    "action_type": "Foreach",
    "inputs": { "from": "@body('List_Accounts')?['value']" }
  }

══════════════════════════════════════════════════════════════
SECTION 4 — FORMULA → EXPRESSION MAPPING
══════════════════════════════════════════════════════════════

TEXT:   TEXT(v) -> string(variables('v'))  |  LEN -> length()  |  UPPER -> toUpper()
DATE:   TODAY() -> utcNow('yyyy-MM-dd')    |  NOW() -> utcNow()  |  ADDDAYS -> addDays()
MATH:   ROUND -> round()  |  FLOOR -> floor()  |  MOD -> mod()  |  n+m -> add(n,m)
LOGIC:  IF(c,t,f) -> if(condition,t,f)  |  AND -> and()  |  OR -> or()  |  ISBLANK -> empty()
COMPARE: a=b -> equals(a,b)  |  a>b -> greater(a,b)  |  a<>b -> not(equals(a,b))

SALESFORCE GLOBAL VARIABLES:
  $Record.FieldName     -> @{triggerBody()?['fieldlogicalname']}
  $Flow.CurrentDateTime -> utcNow()
  $Flow.CurrentDate     -> formatDateTime(utcNow(), 'yyyy-MM-dd')

══════════════════════════════════════════════════════════════
SECTION 5 — VARIABLES, DATAVERSE FIELD & TABLE RULES
══════════════════════════════════════════════════════════════

SALESFORCE dataType → PA TYPE:
  String -> string  |  Number -> float  |  Currency -> float  |  Boolean -> boolean
  Date -> string (ISO)  |  DateTime -> string (ISO)  |  SObject -> object  |  SObject collection -> array

STANDARD OBJECT MAPPING:
  Account -> accounts  |  Contact -> contacts  |  Opportunity -> opportunities
  Lead -> leads  |  Case -> incidents  |  Task -> tasks  |  User -> systemusers
  Custom__c -> use Dynamics_Object from MANDATORY FIELD MAPPING

LOOKUP FIELDS use @odata.bind:
  "parentcustomerid_account@odata.bind": "/accounts(@{variables('accountId')})"

CHOICE / OPTIONSET FIELDS -> integer value (NEVER string label):
  "item/new_accountsource": 100000000

ODATA FILTER OPERATORS:
  eq/ne/gt/ge/lt/le  |  and/or  |  contains(field,'val')

══════════════════════════════════════════════════════════════
SECTION 6 — FIELD MAPPING RULES
══════════════════════════════════════════════════════════════

  If a MANDATORY FIELD MAPPING block is provided, use Dataverse_Column for ALL field references.
  Use Dynamics_Object as the Dataverse table logical name in all Dataverse actions.
  For Account table: logical name = "accounts" (plural lowercase), primary key = "accountid"
  For Contact table: logical name = "contacts", primary key = "contactid"
  ALWAYS use Dataverse_Column — NEVER use Salesforce API names (no __c suffix fields)

══════════════════════════════════════════════════════════════
SECTION 7 — OUTPUT JSON STRUCTURE (return ONLY this exact shape)
══════════════════════════════════════════════════════════════

{
  "flow_name": "Account_Creation",
  "flow_type": "Manual",
  "trigger_table": "none",
  "trigger_event": "Manual",
  "description": "Plain English description of what the flow does",
  "power_automate_summary": "Step-by-step plain English migration notes",
  "trigger_inputs": {
    "Account_Name": {"type": "string", "description": "Account name entered by user"},
    "CurrencyISO":  {"type": "string", "description": "Currency ISO code selected by user"}
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
          "name":                "@{triggerBody()?['Account_Name']}",
          "new_currencyisocode": "@{triggerBody()?['CurrencyISO']}",
          "new_dynamiccheckbox": false
        }
      },
      "outputs": {}
    }
  ],
  "manual_steps": ["One-time: Open flow in Power Automate portal, authorize Dataverse connection on Create Account step, Save, then Turn On"],
  "notes": "Migration notes including any Before-Save limitations, required Dataverse plugins, etc."
}

CRITICAL OUTPUT RULES:
1. Return ONLY valid JSON inside <converted>...</converted> — absolutely no prose or markdown outside tags.
2. flow_type values: "Manual" | "Automated" | "Scheduled" | "Instant"
3. trigger_event values: "Added" | "Modified" | "Deleted" | "Added or Modified" | "Scheduled" | "Manual" | "HTTP"
4. AddRow row values: SIMPLE @{triggerBody()?['fieldName']} references ONLY — no if(), no equals(), no nested expressions.
5. Include "new_dynamiccheckbox": false in every Account AddRow action row.
6. Use Dataverse_Column field names from MANDATORY FIELD MAPPING when provided — never Salesforce API names.
""",
}


@router.post("/seed-flow-rulebook")
def seed_flow_rulebook(db: Session = Depends(get_db)):
    """Upsert the flow rulebook with the full POC AI-based Power Automate conversion rules."""
    existing = db.query(Rulebook).filter(Rulebook.component_type == "flow").first()
    if existing:
        existing.title         = FLOW_PA_RULEBOOK["title"]
        existing.system_prompt = FLOW_PA_RULEBOOK["system_prompt"]
        existing.rules         = FLOW_PA_RULEBOOK["rules"]
        existing.updated_at    = datetime.now(timezone.utc)
        db.commit()
        return {"ok": True, "action": "updated", "title": existing.title}
    else:
        row = Rulebook(
            component_type = "flow",
            title          = FLOW_PA_RULEBOOK["title"],
            system_prompt  = FLOW_PA_RULEBOOK["system_prompt"],
            rules          = FLOW_PA_RULEBOOK["rules"],
        )
        db.add(row)
        db.commit()
        return {"ok": True, "action": "created", "title": row.title}
