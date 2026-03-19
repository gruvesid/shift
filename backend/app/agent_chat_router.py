"""
Agent Chat router — tool-calling AI agent for Salesforce → Dynamics 365 migration.

Tools:  get_metadata_summary | search_metadata | get_component_source
        convert_component | deploy_component

No hallucination: every metadata answer is grounded in the real database.
"""

import json
import re
import time
import requests
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .connectors_router import get_default_llm
from .crypto import decrypt
from .database import get_db
from .models.chat_session import ChatMessage, ChatSession

router = APIRouter(prefix="/chat", tags=["chat"])

SUGGESTIONS = [
    "What metadata do I have in this org?",
    "List all Apex triggers",
    "Convert AccountService class to C#",
    "Show migration complexity summary",
]

SYSTEM_PROMPT = """You are an expert Salesforce → Dynamics 365 migration agent with access to real org tools.

CRITICAL RULES — follow always:
1. NEVER make up metadata. For ANY question about org components (classes, triggers, flows, etc.) → ALWAYS call get_metadata_summary or search_metadata FIRST.
2. For "convert X to C#/D365" → call get_component_source first to get real code, then convert_component.
3. For "deploy X" → call deploy_component with actual converted code.
4. If a tool returns an error, explain it clearly and suggest next steps.
5. For general migration strategy questions (not specific to an org) → answer directly, no tools needed.
6. Always cite actual numbers and names from tool results.

Response format: use markdown. Tables for component lists. Be concise and actionable."""


# ── Schemas ──────────────────────────────────────────────────────────────────

class ChatStreamRequest(BaseModel):
    message: str
    session_id: Optional[int] = None
    connection_id: Optional[int] = None
    org_name: Optional[str] = None


class NewSessionRequest(BaseModel):
    connection_id: Optional[int] = None
    org_name: Optional[str] = None


# ── Session Helpers ───────────────────────────────────────────────────────────

def _session_dict(s: ChatSession) -> dict:
    return {
        "id": s.id,
        "title": s.title,
        "org_name": s.org_name,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }


def _message_dict(m: ChatMessage) -> dict:
    sources = None
    if m.sources_json:
        try:
            sources = json.loads(m.sources_json)
        except Exception:
            pass
    return {
        "id": m.id,
        "session_id": m.session_id,
        "role": m.role,
        "content": m.content,
        "sources": sources,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _derive_title(text: str) -> str:
    t = text.strip().replace("\n", " ")
    return t[:60] + ("…" if len(t) > 60 else "")


# ── DB Helpers ────────────────────────────────────────────────────────────────

def _first_org(db: Session):
    from .models.connections import Connection
    return db.query(Connection).filter(Connection.type == "org").first()


def _log_usage(db, call_type, provider, model, in_tok, out_tok, duration_ms,
               connection_id=None, org_name=None, component_name=None,
               component_type=None, status="success", error=None):
    from .models.llm_usage import LLMUsage
    PRICE = {
        "gpt-4o": (0.005, 0.015), "gpt-4o-mini": (0.00015, 0.0006),
        "gpt-5": (0.01, 0.03), "gpt-4.1": (0.002, 0.008),
        "claude-opus": (0.015, 0.075), "claude-sonnet": (0.003, 0.015),
        "claude-haiku": (0.001, 0.005),
    }
    price = next((v for k, v in PRICE.items() if k in model), (0.01, 0.03))
    cost = (in_tok * price[0] + out_tok * price[1]) / 1000
    try:
        db.add(LLMUsage(
            call_type=call_type, provider=provider, model=model,
            connection_id=connection_id, org_name=org_name,
            input_tokens=in_tok, output_tokens=out_tok,
            total_tokens=in_tok + out_tok, cost_usd=cost,
            duration_ms=duration_ms, status=status, error_message=error,
            component_name=component_name, component_type=component_type,
            created_at=datetime.now(timezone.utc),
        ))
        db.commit()
    except Exception:
        pass


# ── Tool Definitions ──────────────────────────────────────────────────────────

TOOLS_OPENAI = [
    {
        "type": "function",
        "function": {
            "name": "get_metadata_summary",
            "description": (
                "Get a complete summary of ALL extracted Salesforce metadata: "
                "counts and names of Apex classes, triggers, flows, LWC, Aura. "
                "Call this first for any general question about what is in the org."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "connection_id": {"type": "integer", "description": "Optional org connection ID."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_metadata",
            "description": "Search extracted Salesforce metadata by name or topic. Returns matching components.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "e.g. 'Account', 'email', 'payment'"},
                    "metadata_type": {
                        "type": "string",
                        "enum": ["apex_classes", "apex_triggers", "flows",
                                 "lwc_components", "aura_components", "all"],
                        "description": "Filter by type. Default: all",
                    },
                    "limit": {"type": "integer", "description": "Max results (default 20)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_component_source",
            "description": "Fetch the full source code of a specific Salesforce component. Call before converting.",
            "parameters": {
                "type": "object",
                "properties": {
                    "component_type": {
                        "type": "string",
                        "enum": ["apex_classes", "apex_triggers", "flows",
                                 "lwc_components", "aura_components"],
                    },
                    "component_name": {"type": "string", "description": "API name e.g. 'AccountService'"},
                    "component_id": {"type": "string", "description": "Optional Salesforce 18-char ID"},
                    "connection_id": {"type": "integer"},
                },
                "required": ["component_type", "component_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "convert_component",
            "description": "Convert a Salesforce component to Dynamics 365 C# using AI. Saves result to DB.",
            "parameters": {
                "type": "object",
                "properties": {
                    "component_type": {"type": "string", "description": "e.g. apex_classes, apex_triggers"},
                    "component_name": {"type": "string"},
                    "source_code": {"type": "string", "description": "The Salesforce source code"},
                    "connection_id": {"type": "integer"},
                    "instructions": {"type": "string", "description": "Extra conversion instructions"},
                },
                "required": ["component_type", "component_name", "source_code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "deploy_component",
            "description": "Deploy a converted C# component to the Dynamics 365 environment.",
            "parameters": {
                "type": "object",
                "properties": {
                    "component_name": {"type": "string"},
                    "component_type": {"type": "string"},
                    "converted_code": {"type": "string", "description": "C# code to deploy"},
                    "connection_id": {"type": "integer"},
                },
                "required": ["component_name", "converted_code"],
            },
        },
    },
]

TOOLS_ANTHROPIC = [
    {
        "name": "get_metadata_summary",
        "description": "Get a complete summary of all extracted Salesforce metadata: counts and names.",
        "input_schema": {
            "type": "object",
            "properties": {"connection_id": {"type": "integer"}},
        },
    },
    {
        "name": "search_metadata",
        "description": "Search extracted Salesforce metadata by name or topic.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "metadata_type": {
                    "type": "string",
                    "enum": ["apex_classes", "apex_triggers", "flows",
                             "lwc_components", "aura_components", "all"],
                },
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_component_source",
        "description": "Fetch the full source code of a Salesforce component.",
        "input_schema": {
            "type": "object",
            "properties": {
                "component_type": {
                    "type": "string",
                    "enum": ["apex_classes", "apex_triggers", "flows",
                             "lwc_components", "aura_components"],
                },
                "component_name": {"type": "string"},
                "component_id": {"type": "string"},
                "connection_id": {"type": "integer"},
            },
            "required": ["component_type", "component_name"],
        },
    },
    {
        "name": "convert_component",
        "description": "Convert a Salesforce component to Dynamics 365 C# code using AI.",
        "input_schema": {
            "type": "object",
            "properties": {
                "component_type": {"type": "string"},
                "component_name": {"type": "string"},
                "source_code": {"type": "string"},
                "connection_id": {"type": "integer"},
                "instructions": {"type": "string"},
            },
            "required": ["component_type", "component_name", "source_code"],
        },
    },
    {
        "name": "deploy_component",
        "description": "Deploy a converted component to Dynamics 365.",
        "input_schema": {
            "type": "object",
            "properties": {
                "component_name": {"type": "string"},
                "component_type": {"type": "string"},
                "converted_code": {"type": "string"},
                "connection_id": {"type": "integer"},
            },
            "required": ["component_name", "converted_code"],
        },
    },
]


# ── Tool Implementations ──────────────────────────────────────────────────────

def _tool_get_metadata_summary(connection_id: Optional[int], db: Session) -> str:
    from .models.org_metadata import OrgMetadata
    from .models.connections import Connection

    if connection_id:
        conn = db.query(Connection).filter(Connection.id == connection_id).first()
        meta = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    else:
        conn = _first_org(db)
        if not conn:
            return json.dumps({"error": "No Salesforce org connected. Connect an org in Metadata Migration first."})
        meta = db.query(OrgMetadata).filter(OrgMetadata.connection_id == conn.id).first()

    if not meta:
        name = conn.name if conn else "unknown"
        return json.dumps({"error": f"No metadata extracted for '{name}'. Run extraction from Metadata Migration."})

    out: dict = {
        "org": conn.name if conn else "Unknown",
        "extracted_at": meta.extracted_at.isoformat() if meta.extracted_at else None,
        "vector_status": meta.vector_status or "not_indexed",
    }
    if meta.summary_json:
        try:
            out["summary"] = json.loads(meta.summary_json)
        except Exception:
            pass
    if meta.metadata_json:
        try:
            data = json.loads(meta.metadata_json)
            counts: dict = {}
            components: dict = {}
            for key in ["apex_classes", "apex_triggers", "flows", "lwc_components", "aura_components"]:
                items = data.get(key, [])
                counts[key] = len(items)
                names = [
                    item.get("Name") or item.get("DeveloperName") or item.get("ApiName") or ""
                    for item in items
                ]
                names = [n for n in names if n]
                if names:
                    components[key] = names
            out["counts"] = counts
            out["components"] = components
        except Exception as exc:
            out["parse_error"] = str(exc)
    return json.dumps(out, indent=2)


def _tool_search_metadata(query: str, metadata_type: str, limit: int, db: Session) -> str:
    from .models.org_metadata import OrgMetadata

    conn = _first_org(db)
    if not conn:
        return json.dumps({"error": "No org connection found."})
    meta = db.query(OrgMetadata).filter(OrgMetadata.connection_id == conn.id).first()
    if not meta or not meta.metadata_json:
        return json.dumps({"error": "No metadata extracted yet. Extract metadata first."})

    try:
        data = json.loads(meta.metadata_json)
    except Exception:
        return json.dumps({"error": "Error reading metadata."})

    ql = query.lower()
    results = []
    types = (
        [metadata_type] if (metadata_type and metadata_type != "all")
        else ["apex_classes", "apex_triggers", "flows", "lwc_components", "aura_components"]
    )
    for mtype in types:
        for item in data.get(mtype, []):
            name = item.get("Name") or item.get("DeveloperName") or item.get("ApiName") or ""
            label = item.get("Label") or item.get("MasterLabel") or ""
            if ql in name.lower() or (label and ql in label.lower()):
                entry: dict = {"type": mtype, "id": item.get("Id", ""), "name": name}
                if label and label != name:
                    entry["label"] = label
                for f in ("TableEnumOrId", "ProcessType", "Status", "ApiVersion"):
                    if item.get(f):
                        entry[f.lower()] = item[f]
                results.append(entry)
                if len(results) >= limit:
                    break
        if len(results) >= limit:
            break

    if not results:
        return json.dumps({"query": query, "results": [],
                           "message": f"No components found matching '{query}'."})
    return json.dumps({"org": conn.name, "query": query, "total": len(results), "results": results},
                      indent=2)


def _tool_get_component_source(component_type: str, component_name: str,
                                component_id: Optional[str], connection_id: Optional[int],
                                db: Session) -> str:
    from .models.org_metadata import OrgMetadata
    from .models.connections import Connection

    conn = (db.query(Connection).filter(Connection.id == connection_id).first()
            if connection_id else _first_org(db))
    if not conn:
        return json.dumps({"error": "No org connection found."})
    try:
        cfg = json.loads(conn.config_json or "{}")
    except Exception:
        return json.dumps({"error": "Invalid connection config."})

    if not component_id:
        meta = db.query(OrgMetadata).filter(OrgMetadata.connection_id == conn.id).first()
        if meta and meta.metadata_json:
            try:
                data = json.loads(meta.metadata_json)
                for item in data.get(component_type, []):
                    n = item.get("Name") or item.get("DeveloperName") or item.get("ApiName") or ""
                    if n.lower() == component_name.lower():
                        component_id = item.get("Id")
                        break
            except Exception:
                pass

    if not component_id:
        return json.dumps({"error": f"'{component_name}' not found. Extract metadata first."})

    sf_token = cfg.get("sf_access_token", "")
    sf_url = cfg.get("sf_instance_url", "")
    if not sf_token or not sf_url:
        return json.dumps({"error": "Salesforce not connected. Reconnect the org."})

    try:
        from .shift_router import refresh_sf_token
        updated = refresh_sf_token(conn, db)
        if updated:
            sf_token = updated.get("sf_access_token", sf_token)
            sf_url = updated.get("sf_instance_url", sf_url)
    except Exception:
        pass

    type_map = {
        "apex_classes": "ApexClass", "apex_triggers": "ApexTrigger",
        "flows": "Flow", "lwc_components": "LightningComponentBundle",
        "aura_components": "AuraDefinitionBundle",
    }
    tooling_type = type_map.get(component_type, "ApexClass")

    try:
        url = f"{sf_url}/services/data/v59.0/tooling/sobjects/{tooling_type}/{component_id}"
        resp = requests.get(url, headers={"Authorization": f"Bearer {sf_token}"}, timeout=30)
        if resp.status_code == 200:
            raw = resp.json()
            code = raw.get("Body") or raw.get("Markup") or raw.get("Source") or ""
            if not code:
                code = json.dumps(raw, indent=2)[:6000]
            return json.dumps({"component": component_name, "type": component_type,
                               "id": component_id, "source_code": code})
        elif resp.status_code == 401:
            return json.dumps({"error": "Salesforce token expired. Reconnect the org."})
        else:
            return json.dumps({"error": f"Salesforce API error: HTTP {resp.status_code}"})
    except Exception as e:
        return json.dumps({"error": f"Failed to fetch source: {str(e)}"})


def _tool_convert_component(component_type: str, component_name: str, source_code: str,
                             connection_id: Optional[int], instructions: Optional[str],
                             db: Session, llm_cfg: dict) -> str:
    from .models.connections import Connection
    from .models.converted_items import ConvertedItem
    from .models.rulebook import Rulebook, DEFAULT_RULEBOOKS

    conn = (db.query(Connection).filter(Connection.id == connection_id).first()
            if connection_id else _first_org(db))
    conn_id = conn.id if conn else None
    conn_name = conn.name if conn else "Unknown"

    rb = db.query(Rulebook).filter(Rulebook.component_type == component_type).first()
    if rb:
        system_prompt, rules = rb.system_prompt, rb.rules or ""
    else:
        key = (component_type.replace("_classes", "_class")
               .replace("_triggers", "_trigger")
               .replace("_components", ""))
        defaults = DEFAULT_RULEBOOKS.get(key, DEFAULT_RULEBOOKS.get("apex_class", {}))
        system_prompt = defaults.get("system_prompt", "You are a Salesforce to Dynamics 365 expert.")
        rules = defaults.get("rules", "")

    field_ctx = ""
    if conn_id:
        try:
            from .code_converter_router import _get_field_mapping_context
            field_ctx = _get_field_mapping_context(db, conn_id)
        except Exception:
            pass

    extra = f"\nEXTRA: {instructions}" if instructions else ""
    prompt = (
        f"Convert this Salesforce {component_type} to Dynamics 365 C#:\n"
        f"Component: {component_name}\n{field_ctx}\n\n"
        f"SOURCE:\n```\n{source_code[:8000]}\n```\n\n"
        f"{rules}{extra}\n\n"
        "Wrap converted code in <converted>...</converted>\n"
        "Wrap migration notes in <notes>...</notes>"
    )

    start = time.time()
    try:
        provider, api_key, model = llm_cfg["provider"], llm_cfg["api_key"], llm_cfg["model"]

        if provider == "anthropic":
            import anthropic as _a
            client = _a.Anthropic(api_key=api_key)
            resp = client.messages.create(
                model=model, max_tokens=4096, system=system_prompt,
                messages=[{"role": "user", "content": prompt}]
            )
            raw = resp.content[0].text
            in_tok, out_tok = resp.usage.input_tokens, resp.usage.output_tokens
        else:
            from openai import OpenAI
            client = OpenAI(api_key=api_key)
            _new = any(model.startswith(p) for p in ("o1", "o3", "o4", "gpt-5", "gpt-4.1"))
            kw = {"max_completion_tokens": 4096} if _new else {"max_tokens": 4096}
            r = client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system_prompt},
                          {"role": "user", "content": prompt}],
                **kw,
            )
            raw = r.choices[0].message.content or ""
            in_tok = r.usage.prompt_tokens if r.usage else 0
            out_tok = r.usage.completion_tokens if r.usage else 0

        duration_ms = int((time.time() - start) * 1000)
        cm = re.search(r"<converted>(.*?)</converted>", raw, re.DOTALL)
        nm = re.search(r"<notes>(.*?)</notes>", raw, re.DOTALL)
        converted_code = cm.group(1).strip() if cm else raw.strip()
        notes = nm.group(1).strip() if nm else ""

        item = ConvertedItem(
            run_id=f"agent-{int(time.time())}",
            item_type=component_type, item_name=component_name,
            sf_source=source_code, d365_output=converted_code,
            status="completed", llm_model=model,
            input_tokens=in_tok, output_tokens=out_tok, cost_usd=0.0,
            created_at=datetime.now(timezone.utc),
        )
        db.add(item)
        db.commit()
        _log_usage(db, "agent_chat", provider, model, in_tok, out_tok, duration_ms,
                   conn_id, conn_name, component_name, component_type)

        return json.dumps({
            "status": "converted", "component": component_name,
            "item_id": item.id, "converted_code": converted_code,
            "migration_notes": notes,
            "tokens": {"input": in_tok, "output": out_tok}, "duration_ms": duration_ms,
        })
    except Exception as e:
        return json.dumps({"status": "error", "error": str(e)})


def _tool_deploy_component(component_name: str, component_type: str, converted_code: str,
                            connection_id: Optional[int], db: Session) -> str:
    from .models.connections import Connection
    from .models.deployment_log import DeploymentLog

    conn = (db.query(Connection).filter(Connection.id == connection_id).first()
            if connection_id else _first_org(db))
    if not conn:
        return json.dumps({"status": "error", "error": "No org connection found."})
    try:
        cfg = json.loads(conn.config_json or "{}")
    except Exception:
        return json.dumps({"status": "error", "error": "Invalid connection config."})

    d365_url = cfg.get("d365_environment_url", "")
    if not d365_url:
        return json.dumps({"status": "error", "error": "D365 not configured for this org."})

    d365_cfg = {
        "environment_url": d365_url,
        "tenant_id": cfg.get("d365_tenant_id", ""),
        "client_id": cfg.get("d365_client_id", ""),
        "client_secret": (decrypt(cfg["d365_client_secret_encrypted"])
                          if cfg.get("d365_client_secret_encrypted") else ""),
    }
    try:
        from .services.d365_deploy_service import deploy_component as d365_deploy
        result = d365_deploy(
            converted_code=converted_code,
            component_type=component_type or "apex_classes",
            component_name=component_name,
            connection_id=conn.id,
            d365_cfg=d365_cfg,
            source_code="",
        )
        log = DeploymentLog(
            connection_id=conn.id,
            component_type=component_type or "apex_classes",
            component_name=component_name,
            source="agent",
            status="success" if result.success else "failed",
            log_text=(result.log_text or "")[:50000],
            assembly_id=getattr(result, "assembly_id", None),
            step_ids_json=(json.dumps(result.step_ids)
                           if getattr(result, "step_ids", None) else None),
            error_message=("\n".join(result.errors)
                           if getattr(result, "errors", None) else None),
            created_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
        )
        db.add(log)
        db.commit()
        return json.dumps({
            "status": "deployed" if result.success else "failed",
            "component": component_name,
            "is_manual": getattr(result, "is_manual", False),
            "assembly_id": getattr(result, "assembly_id", None),
            "errors": getattr(result, "errors", []),
            "log_id": log.id,
        })
    except Exception as e:
        return json.dumps({"status": "error", "error": str(e)})


def _execute_tool(name: str, args: dict, db: Session, llm_cfg: dict) -> str:
    try:
        if name == "get_metadata_summary":
            return _tool_get_metadata_summary(args.get("connection_id"), db)
        elif name == "search_metadata":
            return _tool_search_metadata(
                args.get("query", ""), args.get("metadata_type", "all"),
                args.get("limit", 20), db)
        elif name == "get_component_source":
            return _tool_get_component_source(
                args.get("component_type", "apex_classes"),
                args.get("component_name", ""),
                args.get("component_id"), args.get("connection_id"), db)
        elif name == "convert_component":
            return _tool_convert_component(
                args.get("component_type", "apex_classes"),
                args.get("component_name", ""),
                args.get("source_code", ""),
                args.get("connection_id"), args.get("instructions"), db, llm_cfg)
        elif name == "deploy_component":
            return _tool_deploy_component(
                args.get("component_name", ""),
                args.get("component_type", "apex_classes"),
                args.get("converted_code", ""),
                args.get("connection_id"), db)
        else:
            return json.dumps({"error": f"Unknown tool: {name}"})
    except Exception as e:
        return json.dumps({"error": f"Tool error: {str(e)}"})


def _tool_display(name: str, result: dict) -> str:
    if "error" in result:
        return f"Error: {result['error']}"
    if name == "get_metadata_summary":
        counts = result.get("counts", {})
        total = sum(counts.values()) if counts else 0
        parts = [f"{v} {k.replace('_', ' ')}" for k, v in counts.items() if v > 0]
        return f"{total} components — {', '.join(parts[:4])}" if parts else f"Org: {result.get('org', '')}"
    if name == "search_metadata":
        t = result.get("total", 0)
        return f"Found {t} matching component{'s' if t != 1 else ''}"
    if name == "get_component_source":
        lines = len((result.get("source_code") or "").splitlines())
        return f"Retrieved {lines} lines of source code"
    if name == "convert_component":
        if result.get("status") == "converted":
            lines = len((result.get("converted_code") or "").splitlines())
            return f"Converted — {lines} lines of C# (item #{result.get('item_id')})"
        return f"Status: {result.get('status')}"
    if name == "deploy_component":
        if result.get("status") == "deployed":
            return f"Deployed successfully (Log #{result.get('log_id')})"
        errs = result.get("errors", [])
        return f"Deploy failed: {errs[0][:80] if errs else 'unknown error'}"
    return "Done"


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


# ── Agent Loops ───────────────────────────────────────────────────────────────

def _openai_agent(messages: list, llm_cfg: dict, db: Session, stats: dict):
    """OpenAI tool-calling agent loop. Yields SSE strings."""
    from openai import OpenAI

    client = OpenAI(api_key=llm_cfg["api_key"])
    model = llm_cfg["model"]
    _new = any(model.startswith(p) for p in ("o1", "o3", "o4", "gpt-5", "gpt-4.1"))
    max_tok = {"max_completion_tokens": 2048} if _new else {"max_tokens": 2048}
    full_text = ""

    for _ in range(8):
        text_buf = ""
        tc_buf: dict = {}
        finish_reason = None

        stream = client.chat.completions.create(
            model=model, messages=messages,
            tools=TOOLS_OPENAI, tool_choice="auto",
            stream=True, **max_tok,
        )
        for chunk in stream:
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            finish_reason = choice.finish_reason or finish_reason
            delta = choice.delta
            if delta.content:
                text_buf += delta.content
                full_text += delta.content
                yield _sse({"type": "chunk", "content": delta.content})
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    i = tc.index
                    if i not in tc_buf:
                        tc_buf[i] = {"id": "", "name": "", "args": ""}
                    if tc.id:
                        tc_buf[i]["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            tc_buf[i]["name"] = tc.function.name
                        if tc.function.arguments:
                            tc_buf[i]["args"] += tc.function.arguments
            if hasattr(chunk, "usage") and chunk.usage:
                stats["in"] += getattr(chunk.usage, "prompt_tokens", 0) or 0
                stats["out"] += getattr(chunk.usage, "completion_tokens", 0) or 0

        if not tc_buf or finish_reason == "stop":
            break

        tc_list = [
            {"id": tc_buf[i]["id"] or f"call_{i}", "type": "function",
             "function": {"name": tc_buf[i]["name"], "arguments": tc_buf[i]["args"]}}
            for i in sorted(tc_buf)
        ]
        messages.append({"role": "assistant", "content": text_buf or None, "tool_calls": tc_list})

        for tc in tc_list:
            name = tc["function"]["name"]
            call_id = tc["id"]
            try:
                args = json.loads(tc["function"]["arguments"])
            except Exception:
                args = {}
            yield _sse({"type": "tool_call", "name": name, "args": args, "call_id": call_id})
            t0 = time.time()
            result_str = _execute_tool(name, args, db, llm_cfg)
            elapsed = int((time.time() - t0) * 1000)
            try:
                display = _tool_display(name, json.loads(result_str))
            except Exception:
                display = result_str[:120]
            yield _sse({"type": "tool_result", "name": name, "result": result_str,
                        "display": display, "call_id": call_id, "duration_ms": elapsed})
            messages.append({"role": "tool", "tool_call_id": call_id, "content": result_str})

    stats["full_text"] = full_text


def _anthropic_agent(messages: list, llm_cfg: dict, db: Session, stats: dict):
    """Anthropic tool-calling agent loop. Yields SSE strings."""
    import anthropic as _a

    client = _a.Anthropic(api_key=llm_cfg["api_key"])
    model = llm_cfg["model"]
    chat_msgs = [m for m in messages if m.get("role") != "system"]
    full_text = ""

    for _ in range(8):
        with client.messages.stream(
            model=model, max_tokens=2048, system=SYSTEM_PROMPT,
            messages=chat_msgs, tools=TOOLS_ANTHROPIC,
        ) as stream:
            for text in stream.text_stream:
                full_text += text
                yield _sse({"type": "chunk", "content": text})
            final = stream.get_final_message()
            stats["in"] += final.usage.input_tokens
            stats["out"] += final.usage.output_tokens
            stop_reason = final.stop_reason

        if stop_reason != "tool_use":
            break

        tool_uses = [b for b in final.content if b.type == "tool_use"]
        if not tool_uses:
            break

        chat_msgs.append({"role": "assistant", "content": final.content})
        tool_results = []
        for tu in tool_uses:
            yield _sse({"type": "tool_call", "name": tu.name, "args": tu.input, "call_id": tu.id})
            t0 = time.time()
            result_str = _execute_tool(tu.name, tu.input, db, llm_cfg)
            elapsed = int((time.time() - t0) * 1000)
            try:
                display = _tool_display(tu.name, json.loads(result_str))
            except Exception:
                display = result_str[:120]
            yield _sse({"type": "tool_result", "name": tu.name, "result": result_str,
                        "display": display, "call_id": tu.id, "duration_ms": elapsed})
            tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": result_str})

        chat_msgs.append({"role": "user", "content": tool_results})

    stats["full_text"] = full_text


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/sessions")
def list_sessions(db: Session = Depends(get_db)):
    sessions = (db.query(ChatSession)
                .order_by(ChatSession.updated_at.desc())
                .limit(50).all())
    return {"sessions": [_session_dict(s) for s in sessions]}


@router.post("/sessions")
def create_session(req: NewSessionRequest, db: Session = Depends(get_db)):
    s = ChatSession(
        title="New Conversation",
        connection_id=req.connection_id,
        org_name=req.org_name,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return {"session": _session_dict(s)}


@router.get("/sessions/{session_id}/messages")
def get_messages(session_id: int, db: Session = Depends(get_db)):
    s = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")
    msgs = (db.query(ChatMessage)
            .filter(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at.asc()).all())
    return {"messages": [_message_dict(m) for m in msgs]}


@router.delete("/sessions/{session_id}")
def delete_session(session_id: int, db: Session = Depends(get_db)):
    db.query(ChatMessage).filter(ChatMessage.session_id == session_id).delete()
    db.query(ChatSession).filter(ChatSession.id == session_id).delete()
    db.commit()
    return {"ok": True}


@router.get("/suggestions")
def get_suggestions():
    return {"suggestions": SUGGESTIONS}


@router.post("/stream")
async def chat_stream(req: ChatStreamRequest, db: Session = Depends(get_db)):
    """SSE streaming tool-calling agent endpoint."""
    llm_cfg = get_default_llm(db)
    if not llm_cfg:
        async def _no_llm():
            yield _sse({"type": "error",
                        "message": "No LLM configured. Go to LLM Connector to add one."})
        return StreamingResponse(_no_llm(), media_type="text/event-stream")

    # Resolve / create session
    session = None
    if req.session_id:
        session = db.query(ChatSession).filter(ChatSession.id == req.session_id).first()
    if not session:
        session = ChatSession(
            title=_derive_title(req.message),
            connection_id=req.connection_id,
            org_name=req.org_name,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(session)
        db.commit()
        db.refresh(session)
    session_id = session.id

    # Save user message
    db.add(ChatMessage(
        session_id=session_id, role="user", content=req.message,
        created_at=datetime.now(timezone.utc),
    ))
    db.commit()

    # Build history (last 20)
    history = (db.query(ChatMessage)
               .filter(ChatMessage.session_id == session_id)
               .order_by(ChatMessage.created_at.asc())
               .limit(20).all())
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history:
        messages.append({"role": m.role, "content": m.content})

    # Placeholder for assistant reply
    asst_msg = ChatMessage(
        session_id=session_id, role="assistant", content="",
        created_at=datetime.now(timezone.utc),
    )
    db.add(asst_msg)
    db.commit()
    db.refresh(asst_msg)

    provider = llm_cfg["provider"]
    start_t = time.time()

    async def generate() -> AsyncGenerator[str, None]:
        stats: dict = {"in": 0, "out": 0, "full_text": ""}
        try:
            yield _sse({"type": "session", "session_id": session_id})

            agent_fn = _anthropic_agent if provider == "anthropic" else _openai_agent
            for event_str in agent_fn(messages, llm_cfg, db, stats):
                yield event_str

            full_content = stats.get("full_text", "")
            asst_msg.content = full_content
            session.updated_at = datetime.now(timezone.utc)
            db.commit()

            _log_usage(db, "agent_chat", provider, llm_cfg["model"],
                       stats["in"], stats["out"],
                       int((time.time() - start_t) * 1000),
                       req.connection_id, req.org_name)

            yield _sse({"type": "done", "full_content": full_content})

        except Exception as exc:
            err = str(exc)
            yield _sse({"type": "error", "message": err})
            try:
                asst_msg.content = f"Error: {err}"
                db.commit()
            except Exception:
                pass

    return StreamingResponse(
        generate(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
