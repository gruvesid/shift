"""
D365 Deploy Router — Save, edit, validate, and deploy individual converted components.

Endpoints:
  POST   /d365-deploy/save                         Save conversion to DB
  GET    /d365-deploy/saved/{connection_id}         List saved conversions for org
  GET    /d365-deploy/saved/{connection_id}/{id}    Get one saved conversion
  PUT    /d365-deploy/saved/{item_id}               Edit converted code
  POST   /d365-deploy/saved/{item_id}/validate      LLM validate code
  POST   /d365-deploy/saved/{item_id}/deploy        Deploy to D365
  GET    /d365-deploy/logs/{connection_id}           List deployment logs
  GET    /d365-deploy/logs/{connection_id}/{log_id}  Get log detail
  GET    /d365-deploy/log-download/{log_id}           Download full log file
"""

import json
import re
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .connectors_router import get_default_llm, get_llm_for_task, get_llm_for_escalation, get_fix_loop_settings
from .database import get_db
from .models.connections import Connection
from .models.deployment_log import DeploymentLog
from .models.converted_items import ConvertedItem
from .models.llm_usage import LLMUsage
from .models.user import User
from .services.auth_service import get_current_user
from .services.d365_deploy_service import (
    deploy_component,
    check_dotnet,
    DeployResult,
)

router = APIRouter(prefix="/d365-deploy", tags=["d365-deploy"])

MODEL_PRICING: dict[str, tuple[float, float]] = {
    "gpt-4o":                      (0.005,   0.015),
    "gpt-4o-mini":                 (0.00015, 0.0006),
    "gpt-4-turbo":                 (0.01,    0.03),
    "gpt-4":                       (0.03,    0.06),
    "gpt-3.5-turbo":               (0.0005,  0.0015),
    "claude-opus-4-6":             (0.015,   0.075),
    "claude-sonnet-4-6":           (0.003,   0.015),
    "claude-haiku-4-5":            (0.001,   0.005),
    "claude-3-5-sonnet-20241022":  (0.003,   0.015),
    "claude-3-5-haiku-20241022":   (0.001,   0.005),
    "claude-3-opus-20240229":      (0.015,   0.075),
    "claude-3-haiku-20240307":     (0.00025, 0.00125),
    "command-r-plus":              (0.003,   0.015),
    "command-r":                   (0.0005,  0.0015),
}


def _calc_cost(model: str, in_tok: int, out_tok: int) -> float:
    rates = MODEL_PRICING.get(model.lower(), (0.001, 0.003))
    return round((in_tok / 1000 * rates[0]) + (out_tok / 1000 * rates[1]), 6)


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class SaveConversionRequest(BaseModel):
    connection_id:  int
    component_type: str
    component_name: str
    component_id:   Optional[str] = None
    sf_source:      Optional[str] = None
    d365_output:    str
    llm_model:      Optional[str] = None
    input_tokens:   Optional[int] = 0
    output_tokens:  Optional[int] = 0
    cost_usd:       Optional[float] = 0.0


class EditCodeRequest(BaseModel):
    d365_output: str


class ValidateRequest(BaseModel):
    pass   # uses saved code from DB


# ── Serializers ───────────────────────────────────────────────────────────────

def _item_to_dict(item: ConvertedItem) -> dict:
    return {
        "id":             item.id,
        "connection_id":  item.run_id.split(":")[0] if ":" in item.run_id else item.run_id,
        "component_type": item.item_type,
        "component_name": item.item_name,
        "has_source":     bool(item.sf_source),
        "has_converted":  bool(item.d365_output),
        "d365_output":    item.d365_output,
        "status":         item.status,
        "llm_model":      item.llm_model,
        "input_tokens":   item.input_tokens,
        "output_tokens":  item.output_tokens,
        "cost_usd":       item.cost_usd,
        "created_at":     item.created_at.isoformat() if item.created_at else None,
        "updated_at":     item.updated_at.isoformat() if item.updated_at else None,
    }


def _log_to_dict(log: DeploymentLog, include_text: bool = False) -> dict:
    d = {
        "id":             log.id,
        "connection_id":  log.connection_id,
        "component_type": log.component_type,
        "component_name": log.component_name,
        "source":         log.source,
        "source_item_id": log.source_item_id,
        "plan_id":        log.plan_id,
        "status":         log.status,
        "assembly_id":    log.assembly_id,
        "step_ids":       json.loads(log.step_ids_json or "[]"),
        "web_resource_id": log.web_resource_id,
        "flow_url":       getattr(log, "flow_url", None),
        "error_message":  log.error_message,
        "has_log_file":   bool(log.log_file_path),
        "created_at":     log.created_at.isoformat() if log.created_at else None,
        "completed_at":   log.completed_at.isoformat() if log.completed_at else None,
    }
    if include_text:
        d["log_text"] = log.log_text or ""
    return d


# ── Save conversion ───────────────────────────────────────────────────────────

@router.post("/save", status_code=201)
def save_conversion(req: SaveConversionRequest, db: Session = Depends(get_db)):
    """Save a converted component to DB for later editing / deployment."""
    conn = db.query(Connection).filter(Connection.id == req.connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found.")

    # Use connection_id as run_id prefix so we can filter by org
    run_id = f"{req.connection_id}:{req.component_type}:{req.component_name}"

    # Upsert — replace any existing conversion for same component
    existing = db.query(ConvertedItem).filter(
        ConvertedItem.run_id == run_id,
        ConvertedItem.item_type == req.component_type,
        ConvertedItem.item_name == req.component_name,
    ).first()

    if existing:
        existing.d365_output   = req.d365_output
        existing.sf_source     = req.sf_source or existing.sf_source
        existing.llm_model     = req.llm_model
        existing.input_tokens  = req.input_tokens or 0
        existing.output_tokens = req.output_tokens or 0
        existing.cost_usd      = req.cost_usd or 0.0
        existing.status        = "converted"
        existing.updated_at    = datetime.now(timezone.utc)
        db.commit()
        db.refresh(existing)
        return {"saved": True, "id": existing.id, "updated": True}

    item = ConvertedItem(
        run_id       = run_id,
        item_type    = req.component_type,
        item_name    = req.component_name,
        sf_source    = req.sf_source,
        d365_output  = req.d365_output,
        status       = "converted",
        llm_model    = req.llm_model,
        input_tokens = req.input_tokens or 0,
        output_tokens= req.output_tokens or 0,
        cost_usd     = req.cost_usd or 0.0,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"saved": True, "id": item.id, "updated": False}


# ── List saved conversions ────────────────────────────────────────────────────

@router.get("/saved/{connection_id}")
def list_saved(
    connection_id: int,
    component_type: Optional[str] = Query(None),
    component_name: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """List all saved conversions for an org connection."""
    q = db.query(ConvertedItem).filter(
        ConvertedItem.run_id.like(f"{connection_id}:%")
    )
    if component_type:
        q = q.filter(ConvertedItem.item_type == component_type)
    if component_name:
        q = q.filter(ConvertedItem.item_name == component_name)
    if status:
        q = q.filter(ConvertedItem.status == status)

    total = q.count()
    items = q.order_by(ConvertedItem.updated_at.desc()).offset(offset).limit(limit).all()
    return {
        "items":  [_item_to_dict(i) for i in items],
        "total":  total,
        "limit":  limit,
        "offset": offset,
    }


# ── Get single saved conversion ───────────────────────────────────────────────

@router.get("/saved/{connection_id}/{item_id}")
def get_saved(connection_id: int, item_id: int, db: Session = Depends(get_db)):
    item = db.query(ConvertedItem).filter(
        ConvertedItem.id == item_id,
        ConvertedItem.run_id.like(f"{connection_id}:%"),
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Saved conversion not found.")
    d = _item_to_dict(item)
    d["sf_source"] = item.sf_source or ""
    return d


# ── Edit converted code ───────────────────────────────────────────────────────

@router.put("/saved/{item_id}")
def edit_saved(item_id: int, body: EditCodeRequest, db: Session = Depends(get_db)):
    """Update the D365 converted code (user edits before deployment)."""
    item = db.query(ConvertedItem).filter(ConvertedItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Saved conversion not found.")
    item.d365_output = body.d365_output
    item.status      = "converted"   # reset to converted (not yet validated/deployed)
    item.updated_at  = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True, "id": item_id}


# ── LLM Validate ─────────────────────────────────────────────────────────────

_VALIDATE_SYSTEM_PROMPT = """You are a senior Dynamics 365 / C# code reviewer.
Review the provided C# IPlugin code for correctness and best practices.
Check for: missing recursion guard, missing Contains() checks before field access,
incorrect DML patterns, missing usings, compilation errors.

Respond ONLY in this format:
<verdict>PASS</verdict> or <verdict>FAIL</verdict>
<issues>
[one issue per line — empty if none]
</issues>
<fixed_code>
[corrected C# code if FAIL, empty string if PASS]
</fixed_code>"""

_VALIDATE_SYSTEM_PROMPT_WR = """You are a senior Dynamics 365 PCF / Web Resource developer.
Review the provided HTML/TypeScript code for D365 web resource deployment.
Check for: XRM API usage, missing _resolveXrm() helper, hardcoded SF field names,
integer picklist values vs string labels, correct Xrm.WebApi calls.

Respond ONLY in this format:
<verdict>PASS</verdict> or <verdict>FAIL</verdict>
<issues>
[one issue per line — empty if none]
</issues>
<fixed_code>
[corrected code if FAIL, empty string if PASS]
</fixed_code>"""


def _call_llm_validate(llm: dict, sys_prompt: str, prompt: str) -> tuple[str, list, str, int, int, str | None]:
    """Run one LLM validation call. Returns (verdict, issues, fixed_code, in_tok, out_tok, err)."""
    provider = llm["provider"]
    model    = llm["model"]
    api_key  = llm["api_key"]
    in_tok = out_tok = 0
    err_msg = None
    raw = ""
    try:
        if provider == "openai":
            from openai import OpenAI
            client = OpenAI(api_key=api_key)
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": sys_prompt}, {"role": "user", "content": prompt}],
                max_tokens=2048,
            )
            raw = resp.choices[0].message.content or ""
            in_tok, out_tok = resp.usage.prompt_tokens, resp.usage.completion_tokens
        elif provider == "anthropic":
            import anthropic as _a
            client = _a.Anthropic(api_key=api_key)
            resp = client.messages.create(
                model=model, system=sys_prompt,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=2048,
            )
            raw = resp.content[0].text if resp.content else ""
            in_tok, out_tok = resp.usage.input_tokens, resp.usage.output_tokens
        elif provider == "cohere":
            import cohere as _c
            client = _c.Client(api_key)
            resp = client.chat(model=model, preamble=sys_prompt, message=prompt)
            raw = resp.text or ""
            try:
                in_tok  = resp.meta.billed_units.input_tokens
                out_tok = resp.meta.billed_units.output_tokens
            except Exception:
                pass
        else:
            raise ValueError(f"Unknown provider: {provider}")
    except Exception as exc:
        err_msg = str(exc)

    vm = re.search(r"<verdict>(.*?)</verdict>", raw, re.DOTALL)
    im = re.search(r"<issues>(.*?)</issues>", raw, re.DOTALL)
    fm = re.search(r"<fixed_code>(.*?)</fixed_code>", raw, re.DOTALL)
    verdict    = (vm.group(1).strip() if vm else ("ERROR" if err_msg else "UNKNOWN")).upper()
    issues     = [l.strip() for l in (im.group(1).splitlines() if im else []) if l.strip()]
    fixed_code = fm.group(1).strip() if fm else ""
    return verdict, issues, fixed_code, in_tok, out_tok, err_msg


@router.post("/saved/{item_id}/validate")
def validate_saved(item_id: int, db: Session = Depends(get_db)):
    """Run LLM code review with fix loop (retries up to max_retries, escalating model)."""
    item = db.query(ConvertedItem).filter(ConvertedItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Saved conversion not found.")
    if not item.d365_output:
        raise HTTPException(status_code=400, detail="No converted code to validate.")

    base_llm = get_llm_for_task(db, "validate")
    if not base_llm:
        raise HTTPException(status_code=400, detail="No LLM configured. Add one in LLM Connector.")

    esc_llm   = get_llm_for_escalation(db)
    loop_cfg  = get_fix_loop_settings(db)
    max_retries    = loop_cfg["max_retries"]
    escalate_after = loop_cfg["escalate_after"]

    conn = db.query(Connection).filter(
        Connection.id == int(item.run_id.split(":")[0])
    ).first()
    org_name = conn.name if conn else "unknown"

    is_plugin  = item.item_type in ("apex_class", "apex_trigger")
    sys_prompt = _VALIDATE_SYSTEM_PROMPT if is_plugin else _VALIDATE_SYSTEM_PROMPT_WR

    current_code = item.d365_output
    total_in_tok = total_out_tok = 0
    t0 = time.time()
    final_verdict = "UNKNOWN"
    all_issues: list[str] = []
    last_err = None
    attempts_log: list[dict] = []

    for attempt in range(1, max_retries + 1):
        # Pick LLM: escalate on attempts beyond escalate_after (if escalation LLM configured)
        llm = (esc_llm or base_llm) if (esc_llm and attempt > escalate_after) else base_llm

        prompt = (
            f'Validate this Dynamics 365 {"C# IPlugin" if is_plugin else "web resource"} code'
            + (f' (fix attempt {attempt}/{max_retries})' if attempt > 1 else '')
            + f':\n\n```\n{current_code}\n```'
        )
        if attempt > 1 and all_issues:
            prompt += f'\n\nPrevious issues to fix:\n' + '\n'.join(f'- {i}' for i in all_issues[-5:])

        verdict, issues, fixed_code, in_tok, out_tok, err_msg = _call_llm_validate(llm, sys_prompt, prompt)
        total_in_tok  += in_tok
        total_out_tok += out_tok
        last_err = err_msg

        cost_attempt = _calc_cost(llm["model"], in_tok, out_tok)
        attempts_log.append({
            "attempt": attempt,
            "model": llm["model"],
            "verdict": verdict,
            "issues_count": len(issues),
            "cost_usd": cost_attempt,
        })

        # Log usage per attempt
        db.add(LLMUsage(
            call_type     = "validate",
            provider      = llm["provider"],
            model         = llm["model"],
            connection_id = int(item.run_id.split(":")[0]),
            org_name      = org_name,
            input_tokens  = in_tok,
            output_tokens = out_tok,
            total_tokens  = in_tok + out_tok,
            cost_usd      = cost_attempt,
            duration_ms   = 0,
            status        = "success" if not err_msg else "error",
            error_message = err_msg,
            component_name= item.item_name,
            component_type= item.item_type,
            created_at    = datetime.now(timezone.utc),
        ))

        final_verdict = verdict
        all_issues = issues

        if verdict == "PASS":
            item.status = "validated"
            break

        if verdict in ("ERROR", "UNKNOWN") or not fixed_code:
            break  # cannot fix — stop loop

        # Apply fix for next iteration
        current_code = fixed_code

    # Save final (possibly fixed) code
    if current_code != item.d365_output:
        item.d365_output = current_code
        item.status      = "validated" if final_verdict == "PASS" else "converted"
    elif final_verdict == "PASS":
        item.status = "validated"

    item.updated_at = datetime.now(timezone.utc)
    total_cost = _calc_cost(base_llm["model"], total_in_tok, total_out_tok)
    db.commit()

    return {
        "verdict":    final_verdict,
        "issues":     all_issues,
        "fixed_code": current_code if current_code != item.d365_output else "",
        "auto_fixed": current_code != item.d365_output,
        "attempts":   len(attempts_log),
        "attempts_log": attempts_log,
        "usage": {
            "input_tokens":  total_in_tok,
            "output_tokens": total_out_tok,
            "cost_usd":      total_cost,
            "duration_ms":   int((time.time() - t0) * 1000),
        },
        "error": last_err,
    }


# ── LLM Fix ───────────────────────────────────────────────────────────────────

_FIX_SYSTEM_PROMPT = """You are an expert Salesforce → Microsoft Dynamics 365 migration engineer.
A converted component failed to deploy. Your job is to analyse the error and produce a corrected version.

You will receive:
- COMPONENT TYPE and NAME
- ORIGINAL SOURCE CODE (Salesforce Apex / Flow / LWC / Aura)
- CURRENT CONVERTED CODE (the D365 / C# / JSON version that failed)
- DEPLOY ERROR (the exact error message from the deployment attempt)

Rules:
1. Fix ONLY the issues described in the error. Do not refactor unrelated code.
2. For C# plugins: keep IPlugin structure, recursion guard, Contains() guards, all using statements.
3. For Flow JSON: keep the same JSON structure, fix field names / action types / expressions.
4. For PCF TypeScript: keep StandardControl<IInputs,IOutputs> structure.
5. Return the COMPLETE fixed code — not a diff or partial snippet.

Respond ONLY in this format:
<fixed_code>
[complete fixed code here]
</fixed_code>
<explanation>
[one-paragraph explanation of what was wrong and what you changed]
</explanation>"""


class FixRequest(BaseModel):
    error_context: str = ""   # error from last deploy attempt


@router.post("/saved/{item_id}/fix")
def fix_saved(item_id: int, req: FixRequest, db: Session = Depends(get_db)):
    """
    Send current code + deploy error to LLM and return fixed code.
    Automatically updates the saved conversion on success.
    """
    item = db.query(ConvertedItem).filter(ConvertedItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Saved conversion not found.")
    if not item.d365_output:
        raise HTTPException(status_code=400, detail="No converted code to fix.")

    llm = get_llm_for_task(db, "convert")  # use conversion LLM (best quality)
    if not llm:
        llm = get_default_llm(db)
    if not llm:
        raise HTTPException(status_code=400, detail="No LLM configured. Add one in LLM Connector.")

    connection_id = int(item.run_id.split(":")[0])
    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    org_name = conn.name if conn else "unknown"

    # Build the fix prompt
    source_section = f"\n\nORIGINAL SOURCE CODE:\n```\n{item.sf_source or '(not available)'}\n```" if item.sf_source else ""
    error_section  = f"\n\nDEPLOY ERROR:\n{req.error_context}" if req.error_context.strip() else "\n\nDEPLOY ERROR: No specific error provided — perform a general correctness review and fix any issues."

    prompt = (
        f"COMPONENT TYPE: {item.item_type}\n"
        f"COMPONENT NAME: {item.item_name}"
        f"{source_section}"
        f"\n\nCURRENT CONVERTED CODE (failed):\n```\n{item.d365_output}\n```"
        f"{error_section}"
        "\n\nPlease fix the code."
    )

    provider   = llm["provider"]
    model      = llm["model"]
    api_key    = llm["api_key"]
    raw        = ""
    in_tok = out_tok = 0
    err_msg = None

    import time as _time
    t0 = _time.time()
    try:
        if provider == "openai":
            from openai import OpenAI
            client = OpenAI(api_key=api_key)
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": _FIX_SYSTEM_PROMPT},
                    {"role": "user",   "content": prompt},
                ],
                max_tokens=4096,
            )
            raw     = resp.choices[0].message.content or ""
            in_tok  = resp.usage.prompt_tokens
            out_tok = resp.usage.completion_tokens
        elif provider == "anthropic":
            import anthropic as _a
            client = _a.Anthropic(api_key=api_key)
            resp = client.messages.create(
                model=model, system=_FIX_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=4096,
            )
            raw     = resp.content[0].text if resp.content else ""
            in_tok  = resp.usage.input_tokens
            out_tok = resp.usage.output_tokens
        elif provider == "cohere":
            import cohere as _c
            client = _c.Client(api_key)
            resp = client.chat(model=model, preamble=_FIX_SYSTEM_PROMPT, message=prompt)
            raw = resp.text or ""
            try:
                in_tok  = resp.meta.billed_units.input_tokens
                out_tok = resp.meta.billed_units.output_tokens
            except Exception:
                pass
        else:
            raise ValueError(f"Unknown provider: {provider}")
    except Exception as exc:
        err_msg = str(exc)

    duration_ms = int((_time.time() - t0) * 1000)
    cost_usd    = _calc_cost(model, in_tok, out_tok)

    # Log LLM usage
    db.add(LLMUsage(
        call_type      = "fix",
        provider       = provider,
        model          = model,
        connection_id  = connection_id,
        org_name       = org_name,
        input_tokens   = in_tok,
        output_tokens  = out_tok,
        total_tokens   = in_tok + out_tok,
        cost_usd       = cost_usd,
        duration_ms    = duration_ms,
        status         = "success" if not err_msg else "error",
        error_message  = err_msg,
        component_name = item.item_name,
        component_type = item.item_type,
        created_at     = datetime.now(timezone.utc),
    ))
    db.commit()

    if err_msg:
        return {"ok": False, "error": err_msg, "fixed_code": "", "explanation": ""}

    import re as _re
    fm = _re.search(r"<fixed_code>(.*?)</fixed_code>", raw, _re.DOTALL)
    em = _re.search(r"<explanation>(.*?)</explanation>", raw, _re.DOTALL)
    fixed_code  = fm.group(1).strip() if fm else ""
    explanation = em.group(1).strip() if em else ""

    if not fixed_code:
        # Fallback: whole response is the code if no tags found
        fixed_code = raw.strip()

    # Auto-update the saved item
    if fixed_code and fixed_code != item.d365_output:
        item.d365_output = fixed_code
        item.status      = "converted"   # reset so user can redeploy
        item.updated_at  = datetime.now(timezone.utc)
        db.commit()

    return {
        "ok":          True,
        "fixed_code":  fixed_code,
        "explanation": explanation,
        "changed":     fixed_code != "" and fixed_code != item.d365_output,
        "model":       model,
        "usage": {
            "input_tokens":  in_tok,
            "output_tokens": out_tok,
            "cost_usd":      cost_usd,
            "duration_ms":   duration_ms,
        },
    }


# ── Deploy to D365 ────────────────────────────────────────────────────────────

@router.post("/saved/{item_id}/deploy")
def deploy_saved(item_id: int, db: Session = Depends(get_db)):
    """Deploy saved + (optionally validated) converted code to Dynamics 365."""
    item = db.query(ConvertedItem).filter(ConvertedItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Saved conversion not found.")
    if not item.d365_output:
        raise HTTPException(status_code=400, detail="No converted code to deploy.")

    connection_id = int(item.run_id.split(":")[0])
    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Org connection not found.")

    try:
        cfg = json.loads(conn.config_json or "{}")
    except Exception:
        raise HTTPException(status_code=500, detail="Invalid connection config.")

    # Check D365 credentials
    if not cfg.get("d365_environment_url") or not cfg.get("d365_client_id"):
        raise HTTPException(
            status_code=400,
            detail="D365 not configured for this org. Please add D365 credentials in the Metadata Migration tab."
        )

    # Check dotnet for plugin types
    if item.item_type in ("apex_class", "apex_trigger"):
        ok, ver = check_dotnet()
        if not ok:
            raise HTTPException(
                status_code=400,
                detail=f"dotnet CLI required for C# compilation but not found: {ver}. Install .NET SDK 6+ to deploy plugins."
            )

    # Mark as deploying
    item.status     = "deploying"
    item.updated_at = datetime.now(timezone.utc)
    db.commit()

    # Create deployment log entry
    deploy_log = DeploymentLog(
        connection_id  = connection_id,
        component_type = item.item_type,
        component_name = item.item_name,
        source         = "converter",
        source_item_id = item_id,
        status         = "running",
        created_at     = datetime.now(timezone.utc),
    )
    db.add(deploy_log)
    db.commit()
    db.refresh(deploy_log)

    # Run deployment
    try:
        result: DeployResult = deploy_component(
            converted_code = item.d365_output,
            component_type = item.item_type,
            component_name = item.item_name,
            connection_id  = connection_id,
            d365_cfg       = cfg,
            source_code    = item.sf_source or "",
        )
    except Exception as exc:
        # Unexpected crash — log it
        deploy_log.status        = "failed"
        deploy_log.error_message = str(exc)
        deploy_log.log_text      = str(exc)
        deploy_log.completed_at  = datetime.now(timezone.utc)
        item.status              = "failed"
        item.updated_at          = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Deployment crashed: {exc}")

    # Update deployment log
    deploy_log.log_text       = result.log_text
    deploy_log.log_file_path  = result.log_file_path
    deploy_log.assembly_id    = result.assembly_id
    deploy_log.step_ids_json  = json.dumps(result.step_ids)
    deploy_log.web_resource_id= result.web_resource_id
    deploy_log.status         = "manual" if result.is_manual else ("success" if result.success else "failed")
    deploy_log.error_message  = "; ".join(result.errors) if result.errors else None
    deploy_log.completed_at   = datetime.now(timezone.utc)

    # Update converted item status
    if result.is_manual:
        item.status = "manual"
    elif result.success:
        item.status = "deployed"
    else:
        item.status = "failed"
    item.updated_at = datetime.now(timezone.utc)
    db.commit()

    return {
        "success":        result.success,
        "is_manual":      result.is_manual,
        "manual_instructions": result.manual_instructions if result.is_manual else None,
        "assembly_id":    result.assembly_id,
        "step_ids":       result.step_ids,
        "web_resource_id": result.web_resource_id,
        "errors":         result.errors,
        "log_id":         deploy_log.id,
        "status":         deploy_log.status,
    }


# ── Deployment logs ───────────────────────────────────────────────────────────

@router.get("/all-logs")
def list_all_logs(
    limit:          int           = Query(50, ge=1, le=200),
    offset:         int           = Query(0, ge=0),
    status:         Optional[str] = Query(None),
    component_name: Optional[str] = Query(None),
    component_type: Optional[str] = Query(None),
    user_id:        Optional[int] = Query(None),
    db:             Session       = Depends(get_db),
    current_user:   User          = Depends(get_current_user),
):
    """All deployment logs scoped by user. Admin can filter by user_id."""
    q = db.query(DeploymentLog)
    if current_user.role == "admin":
        if user_id is not None:
            q = q.filter(DeploymentLog.user_id == user_id)
    else:
        q = q.filter(DeploymentLog.user_id == current_user.id)
    if status:
        q = q.filter(DeploymentLog.status == status)
    if component_name:
        q = q.filter(DeploymentLog.component_name == component_name)
    if component_type:
        q = q.filter(DeploymentLog.component_type == component_type)
    total = q.count()
    logs  = q.order_by(DeploymentLog.created_at.desc()).offset(offset).limit(limit).all()
    return {"logs": [_log_to_dict(l) for l in logs], "total": total, "limit": limit, "offset": offset}


@router.get("/log-users")
def log_users(
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Admin only — list users who have deployment log records."""
    if current_user.role != "admin":
        return {"users": []}
    rows = (
        db.query(User.id, User.name, User.email)
        .join(DeploymentLog, DeploymentLog.user_id == User.id)
        .distinct()
        .all()
    )
    return {"users": [{"id": r.id, "name": r.name, "email": r.email} for r in rows]}


@router.get("/logs/{connection_id}")
def list_logs(
    connection_id: int,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: Optional[str] = Query(None),
    component_name: Optional[str] = Query(None),
    component_type: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List deployment logs for an org (scoped to current user unless admin)."""
    q = db.query(DeploymentLog).filter(DeploymentLog.connection_id == connection_id)
    if current_user.role != "admin":
        q = q.filter(DeploymentLog.user_id == current_user.id)
    if status:
        q = q.filter(DeploymentLog.status == status)
    if component_name:
        q = q.filter(DeploymentLog.component_name == component_name)
    if component_type:
        q = q.filter(DeploymentLog.component_type == component_type)
    total = q.count()
    logs  = q.order_by(DeploymentLog.created_at.desc()).offset(offset).limit(limit).all()
    return {
        "logs":   [_log_to_dict(l) for l in logs],
        "total":  total,
        "limit":  limit,
        "offset": offset,
    }


@router.get("/logs/{connection_id}/{log_id}")
def get_log(connection_id: int, log_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Get full log detail including log_text."""
    q = db.query(DeploymentLog).filter(
        DeploymentLog.id == log_id,
        DeploymentLog.connection_id == connection_id,
    )
    if current_user.role != "admin":
        q = q.filter(DeploymentLog.user_id == current_user.id)
    log = q.first()
    if not log:
        raise HTTPException(status_code=404, detail="Deployment log not found.")
    return _log_to_dict(log, include_text=True)


@router.get("/log-download/{log_id}")
def download_log(log_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Download the full log file for a deployment."""
    q = db.query(DeploymentLog).filter(DeploymentLog.id == log_id)
    if current_user.role != "admin":
        q = q.filter(DeploymentLog.user_id == current_user.id)
    log = q.first()
    if not log:
        raise HTTPException(status_code=404, detail="Deployment log not found.")

    if log.log_file_path:
        from pathlib import Path
        p = Path(log.log_file_path)
        if p.exists():
            filename = f"deploy_{log.component_name}_{log.id}.log"
            return FileResponse(str(p), media_type="text/plain", filename=filename)

    # Fall back to DB text
    text = log.log_text or "No log available."
    return PlainTextResponse(content=text, media_type="text/plain")


# ── dotnet status check ───────────────────────────────────────────────────────

@router.get("/dotnet-status")
def dotnet_status():
    """Check whether dotnet CLI is available for C# compilation."""
    ok, version = check_dotnet()
    return {"available": ok, "version": version}
