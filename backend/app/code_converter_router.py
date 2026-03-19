"""
Code Converter router — Salesforce → Dynamics 365 (C#) code conversion.

Fetches source code on-demand from Salesforce via Tooling API, then converts
using the default LLM. Every conversion is logged in llm_usage.
"""

import json
import re
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .connectors_router import get_default_llm
from .shift_router import refresh_sf_token, get_valid_sf_config
from .crypto import decrypt
from .database import get_db
from .models.connections import Connection
from .models.llm_usage import LLMUsage
from .models.org_metadata import OrgMetadata
from .models.field_mapping import FieldMapping
from .models.rulebook import Rulebook, DEFAULT_RULEBOOKS

router = APIRouter(prefix="/code-converter", tags=["code-converter"])

SF_API_VERSION = "v59.0"

# ── Pricing ────────────────────────────────────────────────────────────────────

MODEL_PRICING: dict[str, tuple[float, float]] = {
    "gpt-4o":                      (0.005,   0.015),
    "gpt-4o-mini":                 (0.00015, 0.0006),
    "gpt-4-turbo":                 (0.01,    0.03),
    "gpt-4":                       (0.03,    0.06),
    "gpt-3.5-turbo":               (0.0005,  0.0015),
    "claude-opus-4-5":             (0.015,   0.075),
    "claude-sonnet-4-5":           (0.003,   0.015),
    "claude-haiku-4-5":            (0.001,   0.005),
    "claude-3-5-sonnet-20241022":  (0.003,   0.015),
    "claude-3-5-haiku-20241022":   (0.001,   0.005),
    "claude-3-opus-20240229":      (0.015,   0.075),
    "claude-3-haiku-20240307":     (0.00025, 0.00125),
    "command-r-plus":              (0.003,   0.015),
    "command-r":                   (0.0005,  0.0015),
}


def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    rates = MODEL_PRICING.get(model.lower(), (0.001, 0.003))
    return round((input_tokens / 1000 * rates[0]) + (output_tokens / 1000 * rates[1]), 6)


# ── Salesforce API helpers ─────────────────────────────────────────────────────

def _sf_headers(access_token: str) -> dict:
    return {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}


def _sf_get(instance_url: str, access_token: str, path: str) -> dict:
    url = f"{instance_url.rstrip('/')}{path}"
    resp = requests.get(url, headers=_sf_headers(access_token), timeout=30)
    resp.raise_for_status()
    return resp.json()


def _fetch_apex_body(instance_url: str, access_token: str, comp_id: str, sf_type: str) -> str:
    """Fetch Apex class or trigger body from Salesforce Tooling API."""
    obj = "ApexClass" if sf_type == "apex_class" else "ApexTrigger"
    data = _sf_get(instance_url, access_token, f"/services/data/{SF_API_VERSION}/tooling/sobjects/{obj}/{comp_id}")
    return data.get("Body") or data.get("body") or "// No source code available"


def _fetch_lwc_source(instance_url: str, access_token: str, bundle_id: str) -> str:
    """Fetch all LWC files for a bundle via Tooling API."""
    q = f"SELECT FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '{bundle_id}'"
    data = _sf_get(instance_url, access_token, f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q)}")
    records = data.get("records", [])
    if not records:
        return "// No source files available"
    parts = []
    for r in records:
        fp = r.get("FilePath") or "file"
        src = r.get("Source") or "// Empty file"
        parts.append(f"// ─── {fp} ───\n{src}")
    return "\n\n".join(parts)


def _fetch_aura_source(instance_url: str, access_token: str, bundle_id: str) -> str:
    """Fetch all Aura definitions for a bundle via Tooling API."""
    q = f"SELECT DefType, Format, Source FROM AuraDefinition WHERE AuraDefinitionBundleId = '{bundle_id}'"
    data = _sf_get(instance_url, access_token, f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q)}")
    records = data.get("records", [])
    if not records:
        return "// No source files available"
    parts = []
    for r in records:
        def_type = r.get("DefType") or "file"
        fmt = r.get("Format") or ""
        src = r.get("Source") or "// Empty file"
        parts.append(f"// ─── {def_type} ({fmt}) ───\n{src}")
    return "\n\n".join(parts)


import logging as _logging
_log = _logging.getLogger("code_converter")


def _sf_rest_query(instance_url: str, access_token: str, q: str) -> dict:
    """Query via standard REST API (not Tooling) — same as simple_salesforce."""
    return _sf_get(instance_url, access_token,
                   f"/services/data/{SF_API_VERSION}/query/?q={quote(q)}")


def _resolve_flow_version_id(instance_url: str, access_token: str,
                              definition_id: str, name: str) -> str | None:
    """
    Resolve the Flow version ID (starts with 301) from a FlowDefinitionView record.

    Key facts learned from Salesforce API testing:
    - FlowDefinitionView is NOT supported in Tooling API
    - FlowDefinitionView WHERE Id = '...' returns 0 records (stored ID format not filterable)
    - Flow.DeveloperName does NOT exist in Tooling API
    - Flow.FullName cannot be used in WHERE clause
    - WORKING: REST FlowDefinitionView WHERE ApiName = '{name}' → returns ActiveVersionId
    - WORKING: Tooling GET /sobjects/Flow/{version_id} directly
    - WORKING: Tooling SOQL Flow WHERE DefinitionId (only if we have the real 300... ID)
    """
    def _is_auth_error(exc: Exception) -> bool:
        return (
            isinstance(exc, requests.exceptions.HTTPError)
            and exc.response is not None
            and exc.response.status_code in (401, 403)
        )

    # Strategy 1 (PRIMARY): REST FlowDefinitionView by ApiName — confirmed working
    if name:
        try:
            q = f"SELECT Id, ActiveVersionId, LatestVersionId FROM FlowDefinitionView WHERE ApiName = '{name}'"
            data = _sf_rest_query(instance_url, access_token, q)
            rec = (data.get("records") or [None])[0]
            if rec:
                vid = rec.get("ActiveVersionId") or rec.get("LatestVersionId")
                if vid:
                    _log.info(f"[FlowResolve] S1 by ApiName={name}: version_id={vid}")
                    return vid
        except Exception as exc:
            if _is_auth_error(exc):
                raise  # propagate 401 so caller can refresh token
            _log.warning(f"[FlowResolve] S1 failed: {exc}")

    # Strategy 2: The stored definition_id might already be a Flow version ID (starts with 301)
    try:
        data = _sf_get(instance_url, access_token,
                       f"/services/data/{SF_API_VERSION}/tooling/sobjects/Flow/{definition_id}")
        if data.get("Id"):
            _log.info(f"[FlowResolve] S2: definition_id IS a Flow version Id")
            return definition_id
    except Exception as exc:
        if _is_auth_error(exc):
            raise
        _log.warning(f"[FlowResolve] S2 failed: {exc}")

    # Strategy 3: The REST FlowDefinitionView URL uses 300... IDs; try swapping prefix chars
    # Stored ID from simple_salesforce may differ in checksum chars from the filterable ID.
    # Try the REST sobjects endpoint to get ActiveVersionId
    try:
        data = _sf_get(instance_url, access_token,
                       f"/services/data/{SF_API_VERSION}/sobjects/FlowDefinitionView/{definition_id}")
        vid = data.get("ActiveVersionId") or data.get("LatestVersionId")
        if vid:
            _log.info(f"[FlowResolve] S3 REST sobject GET: version_id={vid}")
            return vid
    except Exception as exc:
        if _is_auth_error(exc):
            raise
        _log.warning(f"[FlowResolve] S3 failed: {exc}")

    # Strategy 4: Tooling SOQL — Flow WHERE DefinitionId using the stored definition_id
    try:
        q = f"SELECT Id, VersionNumber, Status FROM Flow WHERE DefinitionId = '{definition_id}' ORDER BY VersionNumber DESC LIMIT 1"
        data = _sf_get(instance_url, access_token,
                       f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q)}")
        rec = (data.get("records") or [None])[0]
        if rec:
            _log.info(f"[FlowResolve] S4 Tooling Flow by DefinitionId: rec={rec}")
            return rec.get("Id")
    except Exception as exc:
        if _is_auth_error(exc):
            raise
        _log.warning(f"[FlowResolve] S4 failed: {exc}")

    _log.error(f"[FlowResolve] ALL strategies failed for definition_id={definition_id}, name={name}")
    return None


def _fetch_flow_metadata(instance_url: str, access_token: str,
                          definition_id: str, name: str) -> dict | None:
    """
    Fetch the full Flow.Metadata dict.
    The Metadata field is NOT returned by a plain GET on the Flow sObject —
    it must be requested via a Tooling API SOQL SELECT Metadata query.
    """
    version_id = _resolve_flow_version_id(instance_url, access_token, definition_id, name)
    if not version_id:
        return None

    def _is_auth_err(exc: Exception) -> bool:
        return (
            isinstance(exc, requests.exceptions.HTTPError)
            and exc.response is not None
            and exc.response.status_code in (401, 403)
        )

    # Primary: SELECT Metadata FROM Flow — Metadata field must be queried alone in Tooling API
    try:
        q = f"SELECT Metadata FROM Flow WHERE Id = '{version_id}'"
        data = _sf_get(instance_url, access_token,
                       f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q)}")
        rec = (data.get("records") or [None])[0]
        if rec:
            meta = rec.get("Metadata") or rec.get("metadata")
            if meta and isinstance(meta, dict):
                meta["_version_id"] = version_id
                meta["_definition_id"] = definition_id
                # Fetch additional fields (FullName, Status, ProcessType) separately
                try:
                    q2 = f"SELECT Id, FullName, Status, ProcessType FROM Flow WHERE Id = '{version_id}'"
                    d2 = _sf_get(instance_url, access_token,
                                 f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q2)}")
                    r2 = (d2.get("records") or [None])[0]
                    if r2:
                        meta["_full_name"]    = r2.get("FullName", "")
                        meta["_status"]       = r2.get("Status", "")
                        meta["_process_type"] = r2.get("ProcessType", "")
                except Exception:
                    pass
                return meta
    except Exception as exc:
        if _is_auth_err(exc):
            raise
        pass

    # Fallback 1: GET with explicit ?fields=Metadata parameter
    try:
        flow_data = _sf_get(instance_url, access_token,
                            f"/services/data/{SF_API_VERSION}/tooling/sobjects/Flow/{version_id}?fields=Metadata")
        meta = flow_data.get("Metadata") or flow_data.get("metadata")
        if meta and isinstance(meta, dict) and len(meta) > 2:
            meta["_version_id"] = version_id
            meta["_definition_id"] = definition_id
            return meta
    except Exception as exc:
        if _is_auth_err(exc):
            raise
        pass

    # Fallback 2: plain GET (will usually return Metadata as null, but try anyway)
    try:
        flow_data = _sf_get(instance_url, access_token,
                            f"/services/data/{SF_API_VERSION}/tooling/sobjects/Flow/{version_id}")
        meta = flow_data.get("Metadata") or flow_data.get("metadata")
        if meta and isinstance(meta, dict) and len(meta) > 2:
            meta["_version_id"] = version_id
            meta["_definition_id"] = definition_id
            return meta
    except Exception as exc:
        if _is_auth_err(exc):
            raise
        pass

    return None


def _resolve_flow_version_id_debug(instance_url: str, access_token: str,
                                    definition_id: str, name: str) -> list[dict]:
    """Debug version — returns a trace of every strategy attempted."""
    trace = []

    def _try(label: str, fn):
        try:
            result = fn()
            trace.append({"strategy": label, "ok": True, "result": result})
            return result
        except Exception as exc:
            trace.append({"strategy": label, "ok": False, "error": str(exc)})
            return None

    # S1
    def s1():
        q = f"SELECT Id, ActiveVersionId, LatestVersionId FROM FlowDefinitionView WHERE Id = '{definition_id}'"
        d = _sf_get(instance_url, access_token, f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q)}")
        return d
    _try("S1: FlowDefinitionView SOQL by Id", s1)

    # S2
    def s2():
        return _sf_get(instance_url, access_token,
                       f"/services/data/{SF_API_VERSION}/tooling/sobjects/FlowDefinitionView/{definition_id}")
    _try("S2: FlowDefinitionView REST GET", s2)

    # S3
    def s3():
        return _sf_get(instance_url, access_token,
                       f"/services/data/{SF_API_VERSION}/tooling/sobjects/Flow/{definition_id}")
    _try("S3: Flow REST GET using definition_id", s3)

    # S4
    def s4():
        q = f"SELECT Id, ActiveVersionId, LatestVersionId FROM FlowDefinitionView WHERE DeveloperName = '{name}'"
        return _sf_get(instance_url, access_token, f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q)}")
    _try(f"S4: FlowDefinitionView SOQL by name={name}", s4)

    # S5
    def s5():
        q = f"SELECT Id, VersionNumber, Status FROM Flow WHERE DefinitionId = '{definition_id}' ORDER BY VersionNumber DESC LIMIT 5"
        return _sf_get(instance_url, access_token, f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q)}")
    _try("S5: Flow SOQL by DefinitionId (any status)", s5)

    # S6
    def s6():
        q = f"SELECT Id, VersionNumber, Status FROM Flow WHERE DeveloperName = '{name}' ORDER BY VersionNumber DESC LIMIT 5"
        return _sf_get(instance_url, access_token, f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q)}")
    _try(f"S6: Flow SOQL by DeveloperName={name}", s6)

    return trace


def _fetch_flow_source(instance_url: str, access_token: str, definition_id: str,
                       name: str, label: str, process_type: str, status: str) -> str:
    """Fetch the active flow version and format it as structured text for LLM conversion.
    Returns __FLOW_META__:{json} so the frontend can render a visual viewer."""
    base_info = {
        "name": name,
        "label": label or name,
        "process_type": process_type or "Unknown",
        "status": status or "Unknown",
        "definition_id": definition_id,
    }

    meta = _fetch_flow_metadata(instance_url, access_token, definition_id, name)

    if meta:
        base_info["metadata"] = meta
        # Also build a text representation for the LLM context
        lines = [
            f"// ─── Flow: {label or name} ───",
            f"// Type: {process_type or 'Unknown'}  |  Status: {status or 'Unknown'}",
            "",
        ]

        def _sec(key, items):
            if items:
                lines.append(f"// ─── {key} ({len(items)}) ───")
                lines.append(json.dumps(items, indent=2))
                lines.append("")

        if meta.get("start"):
            lines.append("// ─── START ───")
            lines.append(json.dumps(meta["start"], indent=2))
            lines.append("")

        _sec("VARIABLES",      meta.get("variables", []))
        _sec("FORMULAS",       meta.get("formulas", []))
        _sec("DECISIONS",      meta.get("decisions", []))
        _sec("ASSIGNMENTS",    meta.get("assignments", []))
        _sec("RECORD LOOKUPS", meta.get("recordLookups", []))
        _sec("RECORD CREATES", meta.get("recordCreates", []))
        _sec("RECORD UPDATES", meta.get("recordUpdates", []))
        _sec("RECORD DELETES", meta.get("recordDeletes", []))
        _sec("ACTION CALLS",   meta.get("actionCalls", []))
        _sec("LOOPS",          meta.get("loops", []))
        _sec("SCREENS",        meta.get("screens", []))
        _sec("SUBFLOWS",       meta.get("subflows", []))

        base_info["text"] = "\n".join(lines)
        # raw_json for the "XML" tab in the frontend — pretty-printed metadata JSON
        # Filter out internal _ keys before sending
        public_meta = {k: v for k, v in meta.items() if not k.startswith("_")}
        base_info["raw_json"] = json.dumps(public_meta, indent=2)
    else:
        base_info["text"] = (
            f"// ─── Flow: {label or name} ───\n"
            f"// Type: {process_type or 'Unknown'}  |  Status: {status or 'Unknown'}\n"
            f"// Could not fetch full flow definition.\n"
            f"// Re-extract metadata or check Salesforce connectivity."
        )
        base_info["raw_json"] = None

    return f"__FLOW_META__:{json.dumps(base_info)}"


# ── Component listing ──────────────────────────────────────────────────────────

COMP_KEY_MAP = {
    "apex_class":   "apex_classes",
    "apex_trigger": "apex_triggers",
    "flow":         "flows",
    "lwc":          "lwc_components",
    "aura":         "aura_components",
}


def _parse_components(metadata_json: str) -> dict[str, list]:
    try:
        data = json.loads(metadata_json)
    except Exception:
        return {}

    result: dict[str, list] = {}

    for ct, key in COMP_KEY_MAP.items():
        items = data.get(key, [])
        parsed = []
        for item in items:
            if not isinstance(item, dict):
                continue
            # Skip managed / packaged components — their source is "(hidden)"
            ns = item.get("NamespacePrefix") or item.get("namespace_prefix") or ""
            if ns.strip():
                continue
            if ct == "apex_class":
                parsed.append({
                    "id":   item.get("Id") or item.get("id", ""),
                    "name": item.get("Name") or item.get("name", "Unknown"),
                    "api_version": item.get("ApiVersion") or item.get("api_version"),
                    "status": item.get("Status") or item.get("status"),
                })
            elif ct == "apex_trigger":
                parsed.append({
                    "id":    item.get("Id") or item.get("id", ""),
                    "name":  item.get("Name") or item.get("name", "Unknown"),
                    "table": item.get("TableEnumOrId") or item.get("table", ""),
                    "api_version": item.get("ApiVersion") or item.get("api_version"),
                })
            elif ct == "flow":
                parsed.append({
                    "id":           item.get("Id") or item.get("id", ""),
                    "name":         item.get("ApiName") or item.get("name", "Unknown"),
                    "label":        item.get("Label") or item.get("label", ""),
                    "process_type": item.get("ProcessType") or item.get("process_type", ""),
                    "status":       item.get("Status") or item.get("status", ""),
                })
            elif ct == "lwc":
                parsed.append({
                    "id":    item.get("Id") or item.get("id", ""),
                    "name":  item.get("DeveloperName") or item.get("name", "Unknown"),
                    "label": item.get("MasterLabel") or item.get("label", ""),
                    "api_version": item.get("ApiVersion") or item.get("api_version"),
                })
            elif ct == "aura":
                parsed.append({
                    "id":    item.get("Id") or item.get("id", ""),
                    "name":  item.get("DeveloperName") or item.get("name", "Unknown"),
                    "label": item.get("MasterLabel") or item.get("label", ""),
                    "api_version": item.get("ApiVersion") or item.get("api_version"),
                })
        result[ct] = parsed

    return result


# ── LLM Conversion ─────────────────────────────────────────────────────────────

_FALLBACK_SYSTEM_PROMPT = """You are an expert Salesforce to Microsoft Dynamics 365 migration engineer.
Convert the provided Salesforce code/metadata to equivalent Microsoft Dynamics 365 / .NET C# code.
Use Dynamics 365 SDK patterns: IPlugin, IWorkflowActivity, Xrm.Sdk namespaces.
Always end with a section of migration notes.

Respond ONLY in this exact XML-like format:
<converted>
[C# code here]
</converted>
<notes>
[One migration note per line]
</notes>"""


def _get_rulebook(db: Session, component_type: str) -> dict:
    """Return rulebook for component_type from DB, falling back to defaults."""
    row = db.query(Rulebook).filter(Rulebook.component_type == component_type).first()
    if row:
        return {"system_prompt": row.system_prompt, "rules": row.rules, "title": row.title}
    defaults = DEFAULT_RULEBOOKS.get(component_type, {})
    return {
        "system_prompt": defaults.get("system_prompt", _FALLBACK_SYSTEM_PROMPT),
        "rules":         defaults.get("rules", ""),
        "title":         defaults.get("title", component_type),
    }


def _get_field_mapping_context(db: Session, connection_id: int, sf_object: str | None = None) -> str:
    """Return a compact field mapping context string for the LLM prompt."""
    row = db.query(FieldMapping).filter(FieldMapping.connection_id == connection_id).first()
    if not row or not row.mapping_json:
        return ""
    try:
        mapping = json.loads(row.mapping_json)
    except Exception:
        return ""
    objects = mapping.get("objects", {})
    if not objects:
        return ""

    lines = ["FIELD MAPPING (Salesforce → Dataverse) — use these for all field/entity references:"]
    # If we know the SF object, show that object's full mapping first
    target_obj = None
    if sf_object:
        target_obj = next((k for k in objects if k.lower() == sf_object.lower()), None)

    def _fmt_object(obj_name: str, obj: dict):
        dv = obj.get("Dynamics_Object", "")
        lines.append(f"\n  [{obj_name}] → D365 Table: {dv}")
        for f in obj.get("fields", [])[:40]:  # cap at 40 fields per object
            sf_col = f.get("Salesforce_Column", "")
            dv_col = f.get("Dataverse_Column", "")
            dtype  = f.get("Dataverse_Data_Type", "")
            opts   = f.get("options", [])
            opt_str = ""
            if opts:
                sample = ", ".join(f"{o['label']}={o['value']}" for o in opts[:6])
                opt_str = f" [options: {sample}]"
            lines.append(f"    {sf_col} → {dv_col} ({dtype}){opt_str}")

    if target_obj:
        _fmt_object(target_obj, objects[target_obj])
    # Add remaining objects (capped)
    count = 0
    for name, obj in objects.items():
        if name == target_obj:
            continue
        if count >= 5:
            remaining = len(objects) - (1 if target_obj else 0) - count
            if remaining > 0:
                lines.append(f"\n  ... and {remaining} more objects (full mapping available in Step 4)")
            break
        _fmt_object(name, obj)
        count += 1

    return "\n".join(lines)

TYPE_LABEL_MAP = {
    "apex_class": "Apex Class",
    "apex_trigger": "Apex Trigger",
    "flow": "Flow",
    "lwc": "LWC Component",
    "aura": "Aura Component",
}


def _build_prompt(name: str, comp_type: str, code: str,
                  rules: str = "", field_mapping_ctx: str = "") -> str:
    label = TYPE_LABEL_MAP.get(comp_type, comp_type)
    is_flow = comp_type == "flow"
    target_desc = "Power Automate Cloud Flow JSON" if is_flow else "Dynamics 365 C#"
    parts = []
    if rules:
        parts.append(rules)
    if field_mapping_ctx:
        parts.append(field_mapping_ctx)
    if not code or not code.strip() or code.strip().startswith("// No source"):
        parts.append(f'Convert Salesforce {label} "{name}" to {target_desc}.\nNo source code is available — generate a documented stub/skeleton based on the component name and field mapping above.')
    else:
        parts.append(f'Convert this Salesforce {label} named "{name}" to {target_desc}:\n\n```\n{code}\n```')
    if is_flow:
        parts.append('\nRespond ONLY in this exact XML-like format:\n<converted>\n[Power Automate JSON here]\n</converted>\n<notes>\n[One migration note per line]\n</notes>')
    else:
        parts.append('\nRespond ONLY in this exact XML-like format:\n<converted>\n[code here]\n</converted>\n<notes>\n[One migration note per line]\n</notes>')
    return "\n\n".join(parts)


def _call_llm(llm: dict, prompt: str, system_prompt: str | None = None,
              max_tokens: int = 4096) -> tuple[str, int, int]:
    provider = llm["provider"]
    model    = llm["model"]
    api_key  = llm["api_key"]
    sys_p    = system_prompt or _FALLBACK_SYSTEM_PROMPT

    if provider == "openai":
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": sys_p}, {"role": "user", "content": prompt}],
            max_tokens=max_tokens,
        )
        return resp.choices[0].message.content or "", resp.usage.prompt_tokens, resp.usage.completion_tokens

    if provider == "anthropic":
        import anthropic as _a
        client = _a.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=model, system=sys_p,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
        )
        text = resp.content[0].text if resp.content else ""
        return text, resp.usage.input_tokens, resp.usage.output_tokens

    if provider == "cohere":
        import cohere as _c
        client = _c.Client(api_key)
        resp = client.chat(model=model, preamble=sys_p, message=prompt)
        raw = resp.text or ""
        try:
            in_tok  = resp.meta.billed_units.input_tokens
            out_tok = resp.meta.billed_units.output_tokens
        except Exception:
            in_tok = out_tok = 0
        return raw, in_tok, out_tok

    raise ValueError(f"Unknown provider: {provider}")


def _strip_fences(code: str) -> str:
    """Remove markdown code fences (```csharp ... ```) that LLMs sometimes include."""
    code = code.strip()
    if code.startswith("```"):
        code = re.sub(r"^```[a-zA-Z]*\r?\n?", "", code)
        code = re.sub(r"\n?```\s*$", "", code)
    return code.strip()


def _parse_llm_response(raw: str) -> tuple[str, list[str]]:
    code_m  = re.search(r"<converted>(.*?)</converted>", raw, re.DOTALL)
    notes_m = re.search(r"<notes>(.*?)</notes>",         raw, re.DOTALL)
    if code_m:
        code = _strip_fences(code_m.group(1).strip())
    elif "<converted>" in raw:
        # Truncated output — closing tag missing; extract everything after <converted>
        code = _strip_fences(raw[raw.index("<converted>") + len("<converted>"):].strip())
    else:
        code = _strip_fences(raw.strip())
    notes = [n.strip() for n in notes_m.group(1).splitlines() if n.strip()] if notes_m else []
    return code, notes


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

class ConvertRequest(BaseModel):
    connection_id:  int
    component_type: str
    component_name: str
    component_id:   Optional[str] = None
    code:           Optional[str] = None   # pass pre-fetched code to skip live SF call
    target:         str = "dynamics365"


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/orgs")
def list_orgs(db: Session = Depends(get_db)):
    rows = (
        db.query(Connection, OrgMetadata)
        .outerjoin(OrgMetadata, OrgMetadata.connection_id == Connection.id)
        .filter(Connection.type == "org")
        .order_by(Connection.created_at.desc())
        .all()
    )
    result = []
    for conn, meta in rows:
        summary = {}
        if meta and meta.summary_json:
            try:
                summary = json.loads(meta.summary_json)
            except Exception:
                pass
        try:
            cfg = json.loads(conn.config_json or "{}")
        except Exception:
            cfg = {}
        result.append({
            "id":           conn.id,
            "name":         conn.name,
            "has_metadata": meta is not None and meta.metadata_json is not None,
            "extracted_at": meta.extracted_at.isoformat() if meta and meta.extracted_at else None,
            "summary":      summary,
            "sf_status":    cfg.get("sf_status", "pending"),
        })
    return {"orgs": result}


@router.get("/components/{connection_id}")
def get_components(connection_id: int, db: Session = Depends(get_db)):
    """Return component list (no code) for the sidebar."""
    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found.")

    meta = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    if not meta or not meta.metadata_json:
        return {"org_name": conn.name, "components": {}, "counts": {}}

    components = _parse_components(meta.metadata_json)
    counts = {ct: len(items) for ct, items in components.items()}
    return {"org_name": conn.name, "components": components, "counts": counts}


@router.get("/source/{connection_id}/{comp_type}/{comp_id}")
def get_source(connection_id: int, comp_type: str, comp_id: str, db: Session = Depends(get_db)):
    """Fetch live source code for a component from Salesforce Tooling API."""
    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found.")

    cfg          = get_valid_sf_config(conn, db)   # validates + auto-refreshes on 401
    access_token = cfg["sf_access_token"]
    instance_url = cfg["sf_instance_url"]

    # Grab extra metadata fields from the stored metadata_json for context
    meta = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    comp_meta: dict = {}
    if meta and meta.metadata_json:
        parsed = _parse_components(meta.metadata_json)
        for item in parsed.get(comp_type, []):
            if item.get("id") == comp_id:
                comp_meta = item
                break

    def _do_fetch(token: str, iurl: str) -> str:
        if comp_type in ("apex_class", "apex_trigger"):
            return _fetch_apex_body(iurl, token, comp_id, comp_type)
        elif comp_type == "lwc":
            return _fetch_lwc_source(iurl, token, comp_id)
        elif comp_type == "aura":
            return _fetch_aura_source(iurl, token, comp_id)
        elif comp_type == "flow":
            return _fetch_flow_source(
                iurl, token, comp_id,
                name         = comp_meta.get("name", ""),
                label        = comp_meta.get("label", ""),
                process_type = comp_meta.get("process_type", ""),
                status       = comp_meta.get("status", ""),
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unknown component type: {comp_type}")

    try:
        code = _do_fetch(access_token, instance_url)
    except HTTPException:
        raise
    except requests.exceptions.HTTPError as exc:
        http_status = exc.response.status_code if exc.response is not None else 500
        if http_status in (401, 403):
            # Token expired mid-request — refresh once and retry
            cfg = refresh_sf_token(conn, db)
            try:
                code = _do_fetch(cfg["sf_access_token"], cfg["sf_instance_url"])
            except Exception as exc2:
                raise HTTPException(status_code=401, detail="Salesforce session expired. Please re-authorize from the Metadata Migration tab.")
        else:
            raise HTTPException(status_code=500, detail=f"Salesforce API error ({http_status}): {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch source from Salesforce: {exc}")

    # For flows, the code field contains __FLOW_META__:{json}
    # Return an extra `flow_meta` field for the frontend's visual viewer
    result: dict = {"code": code, "comp_id": comp_id, "comp_type": comp_type}
    if comp_type == "flow" and isinstance(code, str) and code.startswith("__FLOW_META__:"):
        try:
            parsed = json.loads(code[len("__FLOW_META__:"):])
            result["flow_meta"] = parsed
            result["code"] = parsed.get("text", "// No text representation")
        except Exception:
            pass
    return result


@router.get("/debug-flow/{connection_id}/{flow_id}")
def debug_flow(connection_id: int, flow_id: str, name: str = "", db: Session = Depends(get_db)):
    """Diagnostic endpoint — runs all Flow ID-resolution strategies and attempts Metadata fetch."""
    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found.")
    try:
        cfg = json.loads(conn.config_json or "{}")
    except Exception:
        raise HTTPException(status_code=500, detail="Invalid config.")

    access_token = cfg.get("sf_access_token", "")
    instance_url = cfg.get("sf_instance_url", "")
    if not access_token or not instance_url:
        raise HTTPException(status_code=400, detail="Salesforce not connected.")

    # Pull name from stored metadata if not passed
    if not name:
        try:
            from .models.org_metadata import OrgMetadata
            meta_row = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
            if meta_row and meta_row.metadata_json:
                parsed = _parse_components(meta_row.metadata_json)
                for item in parsed.get("flow", []):
                    if item.get("id") == flow_id:
                        name = item.get("name", "")
                        break
        except Exception:
            pass

    trace = _resolve_flow_version_id_debug(instance_url, access_token, flow_id, name)

    # Also attempt the metadata fetch directly
    version_id = _resolve_flow_version_id(instance_url, access_token, flow_id, name)
    meta_result = None
    meta_error = None
    if version_id:
        try:
            q = f"SELECT Metadata FROM Flow WHERE Id = '{version_id}'"
            raw = _sf_get(instance_url, access_token,
                          f"/services/data/{SF_API_VERSION}/tooling/query/?q={quote(q)}")
            meta_result = raw
        except Exception as exc:
            meta_error = str(exc)

    return {
        "flow_id": flow_id,
        "name": name,
        "resolved_version_id": version_id,
        "resolution_trace": trace,
        "metadata_soql_result": meta_result,
        "metadata_soql_error": meta_error,
    }


@router.post("/convert")
def convert_component(req: ConvertRequest, db: Session = Depends(get_db)):
    """Convert a Salesforce component to C# using the default LLM."""
    llm = get_default_llm(db)
    if not llm:
        raise HTTPException(status_code=400, detail="No LLM configured. Add an LLM provider in the LLM Connector first.")

    conn = db.query(Connection).filter(Connection.id == req.connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found.")

    # If no code was passed directly, try to fetch live from Salesforce
    code = req.code or ""
    if not code and req.component_id:
        def _fetch_for_convert(token: str, iurl: str) -> str:
            if req.component_type in ("apex_class", "apex_trigger"):
                return _fetch_apex_body(iurl, token, req.component_id, req.component_type)
            elif req.component_type == "lwc":
                return _fetch_lwc_source(iurl, token, req.component_id)
            elif req.component_type == "aura":
                return _fetch_aura_source(iurl, token, req.component_id)
            elif req.component_type == "flow":
                return _fetch_flow_source(iurl, token, req.component_id,
                                          req.component_name, req.component_name, "", "")
            return ""

        try:
            cfg = get_valid_sf_config(conn, db)   # validates + auto-refreshes on 401
            code = _fetch_for_convert(cfg["sf_access_token"], cfg["sf_instance_url"])
        except Exception:
            pass  # fall back to stub conversion (LLM will generate skeleton)

    # If code contains the flow meta marker, extract the text portion for the LLM
    if isinstance(code, str) and code.startswith("__FLOW_META__:"):
        try:
            parsed = json.loads(code[len("__FLOW_META__:"):])
            code = parsed.get("text", "")
        except Exception:
            code = ""

    rb              = _get_rulebook(db, req.component_type)
    field_map_ctx   = _get_field_mapping_context(db, req.connection_id)
    system_prompt   = rb["system_prompt"] or _FALLBACK_SYSTEM_PROMPT
    prompt          = _build_prompt(req.component_name, req.component_type, code,
                                    rules=rb["rules"], field_mapping_ctx=field_map_ctx)
    # Flows generate large JSON — use a higher token limit
    max_tokens = 16000 if req.component_type == "flow" else 4096
    t0 = time.time()
    in_tok = out_tok = 0
    conv_code = ""
    notes: list[str] = []
    err_msg = None
    status  = "success"

    try:
        raw, in_tok, out_tok = _call_llm(llm, prompt, system_prompt, max_tokens=max_tokens)
        conv_code, notes     = _parse_llm_response(raw)
    except Exception as exc:
        err_msg = str(exc)
        status  = "error"

    duration_ms  = int((time.time() - t0) * 1000)
    total_tokens = in_tok + out_tok
    cost         = _calc_cost(llm["model"], in_tok, out_tok)

    usage_row = LLMUsage(
        call_type      = "code_convert",
        provider       = llm["provider"],
        model          = llm["model"],
        connection_id  = req.connection_id,
        org_name       = conn.name,
        input_tokens   = in_tok,
        output_tokens  = out_tok,
        total_tokens   = total_tokens,
        cost_usd       = cost,
        duration_ms    = duration_ms,
        status         = status,
        error_message  = err_msg,
        component_name = req.component_name,
        component_type = req.component_type,
        created_at     = datetime.now(timezone.utc),
    )
    db.add(usage_row)
    db.commit()

    if status == "error":
        raise HTTPException(status_code=500, detail=err_msg)

    is_flow = req.component_type == "flow"
    return {
        "converted_code": conv_code,
        "notes":          notes,
        "target_language": "Power Automate JSON" if is_flow else "C#",
        "target_crm": "Power Automate" if is_flow else "Dynamics 365",
        "usage": {
            "input_tokens":  in_tok,
            "output_tokens": out_tok,
            "total_tokens":  total_tokens,
            "cost_usd":      cost,
            "duration_ms":   duration_ms,
            "model":         llm["model"],
            "provider":      llm["provider"],
        },
    }
