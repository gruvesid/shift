"""
Deployment Plan router — Bulk LLM-convert Salesforce components and track deployment to D365.
"""

import json
import os
import re
import requests
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from .database import get_db
from .models.connections import Connection
from .models.org_metadata import OrgMetadata
from .models.deployment_plan import DeploymentPlan
from .models.deployment_plan_item import DeploymentPlanItem
from .models.deployment_log import DeploymentLog
from .models.rulebook import Rulebook, DEFAULT_RULEBOOKS
from .models.field_mapping import FieldMapping

router = APIRouter(prefix="/shift", tags=["deployment"])

# ── Type metadata ─────────────────────────────────────────────────────────────
TYPE_MAP = {
    "apex_class":   ("Apex Class",     "C# IPlugin / Service Class",          ".cs"),
    "apex_trigger": ("Apex Trigger",   "C# IPlugin (Pre/Post Operation)",     ".cs"),
    "lwc":          ("LWC Component",  "PCF TypeScript Component",            ".ts"),
    "aura":         ("Aura Component", "PCF TypeScript Component",            ".ts"),
    "flow":         ("Salesforce Flow","Power Automate / C# Workflow Activity",".json"),
}

TYPE_BADGE_LABEL = {
    "apex_class":   "CLS",
    "apex_trigger": "TRG",
    "lwc":          "LWC",
    "aura":         "AUR",
    "flow":         "FLW",
}


# ── Pydantic Schemas ──────────────────────────────────────────────────────────

class PlanCreate(BaseModel):
    name: str
    description: Optional[str] = ""


class PlanUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class PlanItemAdd(BaseModel):
    item_type:   str
    item_name:   str
    sf_id:       Optional[str] = None
    source_code: Optional[str] = ""


# ── Serializers ───────────────────────────────────────────────────────────────

def _plan_to_dict(plan: DeploymentPlan) -> dict:
    return {
        "id":             plan.id,
        "connection_id":  plan.connection_id,
        "name":           plan.name,
        "description":    plan.description or "",
        "status":         plan.status,
        "total_items":    plan.total_items,
        "converted_count": plan.converted_count,
        "failed_count":   plan.failed_count,
        "started_at":     plan.started_at.isoformat()   if plan.started_at   else None,
        "completed_at":   plan.completed_at.isoformat() if plan.completed_at else None,
        "created_at":     plan.created_at.isoformat()   if plan.created_at   else None,
        "updated_at":     plan.updated_at.isoformat()   if plan.updated_at   else None,
    }


def _item_to_dict(item: DeploymentPlanItem) -> dict:
    stats = {}
    if getattr(item, "stats_json", None):
        try:
            stats = json.loads(item.stats_json)
        except Exception:
            pass
    return {
        "id":              item.id,
        "plan_id":         item.plan_id,
        "item_type":       item.item_type,
        "item_name":       item.item_name,
        "sf_id":           item.sf_id,
        "has_source":      bool(item.source_code),
        "has_converted":   bool(item.converted_code),
        "converted_code":  item.converted_code,
        "migration_notes": item.migration_notes,
        "file_ext":        item.file_ext,
        "convert_status":  item.convert_status,
        "error_message":   item.error_message,
        "deploy_status":   item.deploy_status or "not_deployed",
        "deploy_error":    item.deploy_error,
        "deploy_log_id":   item.deploy_log_id,
        "deployed_at":     item.deployed_at.isoformat() if item.deployed_at else None,
        "badge":           TYPE_BADGE_LABEL.get(item.item_type, "?"),
        "cost_usd":        stats.get("cost_usd", 0),
        "tokens_in":       stats.get("tokens_in", 0),
        "tokens_out":      stats.get("tokens_out", 0),
        "fix_attempts":    stats.get("fix_attempts", 0),
        "model":           stats.get("model", ""),
        "provider":        stats.get("provider", ""),
        "created_at":      item.created_at.isoformat() if item.created_at else None,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _update_plan_counts(plan: DeploymentPlan, db: Session):
    items = db.query(DeploymentPlanItem).filter(DeploymentPlanItem.plan_id == plan.id).all()
    plan.total_items     = len(items)
    plan.converted_count = sum(1 for i in items if i.convert_status == "converted")
    plan.failed_count    = sum(1 for i in items if i.convert_status == "failed")
    plan.updated_at      = datetime.now(timezone.utc)


def _get_rulebook(db: Session, component_type: str) -> dict:
    row = db.query(Rulebook).filter(Rulebook.component_type == component_type).first()
    if row:
        return {"system_prompt": row.system_prompt, "rules": row.rules}
    default = DEFAULT_RULEBOOKS.get(component_type, {})
    return {"system_prompt": default.get("system_prompt", ""), "rules": default.get("rules", "")}


def _get_field_mapping_ctx(db: Session, connection_id: int) -> str:
    row = db.query(FieldMapping).filter(FieldMapping.connection_id == connection_id).first()
    if not row or not row.mapping_json:
        return ""
    try:
        mapping = json.loads(row.mapping_json)
        objects = mapping.get("objects", {})
        lines = ["FIELD MAPPING (Salesforce → Dataverse):"]
        for obj_name, obj_data in list(objects.items())[:5]:
            dv_obj = obj_data.get("Dynamics_Object", obj_name)
            lines.append(f"\n{obj_name} → {dv_obj}")
            for f in obj_data.get("fields", [])[:40]:
                sf_col  = f.get("Salesforce_Column", "")
                dv_col  = f.get("Dataverse_Column", "")
                dv_type = f.get("Dataverse_Data_Type", "")
                opts    = f.get("options", [])
                if sf_col and dv_col:
                    opt_str = (" | options: " + ", ".join(f"{o.get('label','?')}={o.get('value','?')}" for o in opts[:5])) if opts else ""
                    lines.append(f"  {sf_col} → {dv_col} ({dv_type}){opt_str}")
        return "\n".join(lines)
    except Exception:
        return ""


def _convert_with_llm(db: Session, connection_id: int, item_type: str, item_name: str, source_code: str) -> dict:
    from .shift_router import _call_llm

    src_label, tgt_label, file_ext = TYPE_MAP.get(item_type, ("Component", "D365 equivalent", ".txt"))
    rb      = _get_rulebook(db, item_type)
    fm_ctx  = _get_field_mapping_ctx(db, connection_id)

    system_prompt = rb["system_prompt"] or (
        f"You are an expert Salesforce to Microsoft Dynamics 365 migration engineer. "
        f"Convert the provided {src_label} to its {tgt_label} equivalent."
    )

    rules_block = f"\n\n{rb['rules']}" if rb.get("rules") else ""
    fm_block    = f"\n\n{fm_ctx}" if fm_ctx else ""

    prompt = (
        f'Convert this Salesforce {src_label} named "{item_name}" to {tgt_label} for Dynamics 365.'
        f"{rules_block}{fm_block}"
        f"\n\nReturn ONLY the converted code, then a \"## Migration Notes\" section."
        f"\n\nSOURCE ({src_label}):\n```\n{source_code}\n```"
    )

    result_text = _call_llm(system_prompt, [{"role": "user", "content": prompt}], max_tokens=4000, db=db)

    if "## Migration Notes" in result_text:
        parts = result_text.split("## Migration Notes", 1)
        code  = parts[0].strip()
        notes = "## Migration Notes" + parts[1]
    else:
        code  = result_text.strip()
        notes = ""

    # Strip markdown fences
    code = re.sub(r"^```[a-zA-Z]*\n?", "", code, flags=re.MULTILINE)
    code = re.sub(r"\n?```$", "", code, flags=re.MULTILINE)
    code = code.strip()

    return {"converted_code": code, "migration_notes": notes, "file_ext": file_ext}


def _fetch_sf_source(cfg: dict, item_type: str, sf_id: str) -> str:
    """Fetch Apex/LWC/Aura source from Salesforce using stored access token."""
    token    = cfg.get("sf_access_token", "")
    instance = cfg.get("sf_instance_url", "").rstrip("/")
    if not token or not instance or not sf_id:
        return ""

    headers = {"Authorization": f"Bearer {token}"}
    try:
        if item_type == "apex_class":
            resp = requests.get(
                f"{instance}/services/data/v59.0/query/?q=SELECT+Body+FROM+ApexClass+WHERE+Id='{sf_id}'",
                headers=headers, timeout=15,
            )
            if resp.ok:
                records = resp.json().get("records", [])
                return records[0].get("Body", "") if records else ""

        elif item_type == "apex_trigger":
            resp = requests.get(
                f"{instance}/services/data/v59.0/query/?q=SELECT+Body+FROM+ApexTrigger+WHERE+Id='{sf_id}'",
                headers=headers, timeout=15,
            )
            if resp.ok:
                records = resp.json().get("records", [])
                return records[0].get("Body", "") if records else ""

        elif item_type == "lwc":
            resp = requests.get(
                f"{instance}/services/data/v59.0/tooling/query/?q=SELECT+FilePath,Source+FROM+LightningComponentResource+WHERE+LightningComponentBundleId='{sf_id}'",
                headers=headers, timeout=20,
            )
            if resp.ok:
                records = resp.json().get("records", [])
                return "\n\n".join(
                    f"// === {r.get('FilePath','?')} ===\n{r.get('Source','')}"
                    for r in records if r.get("Source")
                )

        elif item_type == "aura":
            resp = requests.get(
                f"{instance}/services/data/v59.0/tooling/query/?q=SELECT+DefType,Source+FROM+AuraDefinitionBundleMember+WHERE+AuraDefinitionBundleId='{sf_id}'",
                headers=headers, timeout=20,
            )
            if resp.ok:
                records = resp.json().get("records", [])
                return "\n\n".join(
                    f"// === {r.get('DefType','?')} ===\n{r.get('Source','')}"
                    for r in records if r.get("Source")
                )
    except Exception:
        pass
    return ""


# ── Plan CRUD ─────────────────────────────────────────────────────────────────

@router.get("/connections/{connection_id}/plans")
def list_plans(connection_id: int, db: Session = Depends(get_db)):
    org = db.query(Connection).filter(Connection.id == connection_id, Connection.type == "org").first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")
    plans = (
        db.query(DeploymentPlan)
        .filter(DeploymentPlan.connection_id == connection_id)
        .order_by(DeploymentPlan.created_at.desc())
        .all()
    )
    stats = {
        "total":     len(plans),
        "completed": sum(1 for p in plans if p.status == "completed"),
        "draft":     sum(1 for p in plans if p.status == "draft"),
        "failed":    sum(1 for p in plans if p.status in ("failed", "partial")),
    }
    return {"plans": [_plan_to_dict(p) for p in plans], "stats": stats}


@router.post("/connections/{connection_id}/plans", status_code=201)
def create_plan(connection_id: int, body: PlanCreate, db: Session = Depends(get_db)):
    org = db.query(Connection).filter(Connection.id == connection_id, Connection.type == "org").first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")
    plan = DeploymentPlan(
        connection_id=connection_id,
        name=body.name.strip(),
        description=(body.description or "").strip(),
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return _plan_to_dict(plan)


@router.get("/connections/{connection_id}/plans/{plan_id}")
def get_plan(connection_id: int, plan_id: int, db: Session = Depends(get_db)):
    plan = db.query(DeploymentPlan).filter(
        DeploymentPlan.id == plan_id,
        DeploymentPlan.connection_id == connection_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    items = (
        db.query(DeploymentPlanItem)
        .filter(DeploymentPlanItem.plan_id == plan_id)
        .order_by(DeploymentPlanItem.created_at)
        .all()
    )
    return {**_plan_to_dict(plan), "items": [_item_to_dict(i) for i in items]}


@router.put("/connections/{connection_id}/plans/{plan_id}")
def update_plan(connection_id: int, plan_id: int, body: PlanUpdate, db: Session = Depends(get_db)):
    plan = db.query(DeploymentPlan).filter(
        DeploymentPlan.id == plan_id,
        DeploymentPlan.connection_id == connection_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    if body.name is not None:
        plan.name = body.name.strip()
    if body.description is not None:
        plan.description = body.description.strip()
    plan.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _plan_to_dict(plan)


@router.delete("/connections/{connection_id}/plans/{plan_id}")
def delete_plan(connection_id: int, plan_id: int, db: Session = Depends(get_db)):
    plan = db.query(DeploymentPlan).filter(
        DeploymentPlan.id == plan_id,
        DeploymentPlan.connection_id == connection_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    db.query(DeploymentPlanItem).filter(DeploymentPlanItem.plan_id == plan_id).delete()
    db.delete(plan)
    db.commit()
    return {"ok": True, "deleted": plan_id}


# ── Items ─────────────────────────────────────────────────────────────────────

@router.post("/connections/{connection_id}/plans/{plan_id}/items", status_code=201)
def add_plan_items(connection_id: int, plan_id: int, body: list[PlanItemAdd], db: Session = Depends(get_db)):
    plan = db.query(DeploymentPlan).filter(
        DeploymentPlan.id == plan_id,
        DeploymentPlan.connection_id == connection_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    if plan.status == "deploying":
        raise HTTPException(status_code=400, detail="Cannot add items while plan is running.")

    org = db.query(Connection).filter(Connection.id == connection_id, Connection.type == "org").first()
    cfg = json.loads(org.config_json or "{}") if org else {}

    added = 0
    for item_data in body:
        exists = db.query(DeploymentPlanItem).filter(
            DeploymentPlanItem.plan_id == plan_id,
            DeploymentPlanItem.item_name == item_data.item_name,
            DeploymentPlanItem.item_type == item_data.item_type,
        ).first()
        if exists:
            continue

        # Try to fetch source code from Salesforce if not provided
        source = item_data.source_code or ""
        if not source and item_data.sf_id:
            source = _fetch_sf_source(cfg, item_data.item_type, item_data.sf_id)

        item = DeploymentPlanItem(
            plan_id     = plan_id,
            item_type   = item_data.item_type,
            item_name   = item_data.item_name,
            sf_id       = item_data.sf_id,
            source_code = source,
            file_ext    = TYPE_MAP.get(item_data.item_type, ("", "", ".txt"))[2],
        )
        db.add(item)
        added += 1

    db.flush()
    _update_plan_counts(plan, db)
    db.commit()
    return {"ok": True, "added": added, "total_items": plan.total_items}


class PlanItemUpdate(BaseModel):
    converted_code: Optional[str] = None
    migration_notes: Optional[str] = None
    convert_status: Optional[str] = None   # allow resetting to "pending" for re-convert
    deploy_status: Optional[str] = None    # allow resetting deploy state
    deploy_error: Optional[str] = None


@router.put("/connections/{connection_id}/plans/{plan_id}/items/{item_id}")
def update_plan_item(connection_id: int, plan_id: int, item_id: int, body: PlanItemUpdate, db: Session = Depends(get_db)):
    """Update converted_code / migration_notes / statuses for a plan item."""
    item = db.query(DeploymentPlanItem).filter(
        DeploymentPlanItem.id == item_id,
        DeploymentPlanItem.plan_id == plan_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")
    if body.converted_code is not None:
        item.converted_code = body.converted_code
        if item.convert_status in ("pending", "failed") and body.convert_status is None:
            item.convert_status = "converted"
    if body.migration_notes is not None:
        item.migration_notes = body.migration_notes
    if body.convert_status is not None:
        item.convert_status = body.convert_status
    if body.deploy_status is not None:
        item.deploy_status = body.deploy_status
    if body.deploy_error is not None:
        item.deploy_error = body.deploy_error if body.deploy_error != "" else None
    item.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _item_to_dict(item)


@router.delete("/connections/{connection_id}/plans/{plan_id}/items/{item_id}")
def remove_plan_item(connection_id: int, plan_id: int, item_id: int, db: Session = Depends(get_db)):
    plan = db.query(DeploymentPlan).filter(
        DeploymentPlan.id == plan_id,
        DeploymentPlan.connection_id == connection_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    item = db.query(DeploymentPlanItem).filter(
        DeploymentPlanItem.id == item_id,
        DeploymentPlanItem.plan_id == plan_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")
    db.delete(item)
    _update_plan_counts(plan, db)
    db.commit()
    return {"ok": True}


# ── Bulk Deploy (LLM Convert All) ─────────────────────────────────────────────

@router.post("/connections/{connection_id}/plans/{plan_id}/deploy")
def deploy_plan(connection_id: int, plan_id: int, db: Session = Depends(get_db)):
    """Bulk-convert all pending items using LLM + rulebook + field mapping."""
    plan = db.query(DeploymentPlan).filter(
        DeploymentPlan.id == plan_id,
        DeploymentPlan.connection_id == connection_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    if plan.status not in ("draft", "partial", "failed"):
        raise HTTPException(status_code=400, detail=f"Plan is '{plan.status}' — only draft/partial/failed plans can be deployed.")

    items = db.query(DeploymentPlanItem).filter(DeploymentPlanItem.plan_id == plan_id).all()
    if not items:
        raise HTTPException(status_code=400, detail="Plan has no items.")

    plan.status     = "deploying"
    plan.started_at = datetime.now(timezone.utc)
    plan.updated_at = datetime.now(timezone.utc)
    db.commit()

    results = []
    for item in items:
        if item.convert_status == "converted":
            results.append({"id": item.id, "name": item.item_name, "status": "skipped"})
            continue

        if not item.source_code:
            item.convert_status = "failed"
            item.error_message  = "No source code available. Fetch source from Salesforce first."
            item.updated_at     = datetime.now(timezone.utc)
            db.commit()
            results.append({"id": item.id, "name": item.item_name, "status": "failed", "error": item.error_message})
            continue

        item.convert_status = "converting"
        item.updated_at     = datetime.now(timezone.utc)
        db.commit()

        try:
            out = _convert_with_llm(db, connection_id, item.item_type, item.item_name, item.source_code)
            item.converted_code  = out["converted_code"]
            item.migration_notes = out["migration_notes"]
            item.file_ext        = out["file_ext"]
            item.convert_status  = "converted"
            item.error_message   = None
            results.append({"id": item.id, "name": item.item_name, "status": "success"})
        except Exception as exc:
            item.convert_status = "failed"
            item.error_message  = str(exc)
            results.append({"id": item.id, "name": item.item_name, "status": "failed", "error": str(exc)})

        item.updated_at = datetime.now(timezone.utc)
        db.commit()

    _update_plan_counts(plan, db)
    if plan.failed_count == 0 and plan.converted_count > 0:
        plan.status = "completed"
    elif plan.converted_count == 0:
        plan.status = "failed"
    else:
        plan.status = "partial"

    plan.completed_at = datetime.now(timezone.utc)
    plan.updated_at   = datetime.now(timezone.utc)
    db.commit()

    return {
        "status":       plan.status,
        "total":        plan.total_items,
        "converted":    plan.converted_count,
        "failed":       plan.failed_count,
        "results":      results,
        "completed_at": plan.completed_at.isoformat(),
    }


@router.post("/connections/{connection_id}/plans/{plan_id}/items/{item_id}/convert")
def convert_single_item(connection_id: int, plan_id: int, item_id: int, db: Session = Depends(get_db)):
    """Convert (or retry) a single item."""
    plan = db.query(DeploymentPlan).filter(
        DeploymentPlan.id == plan_id,
        DeploymentPlan.connection_id == connection_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    item = db.query(DeploymentPlanItem).filter(
        DeploymentPlanItem.id == item_id,
        DeploymentPlanItem.plan_id == plan_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")
    if not item.source_code:
        raise HTTPException(status_code=400, detail="No source code for this item.")

    item.convert_status = "converting"
    item.updated_at     = datetime.now(timezone.utc)
    db.commit()

    try:
        out = _convert_with_llm(db, connection_id, item.item_type, item.item_name, item.source_code)
        item.converted_code  = out["converted_code"]
        item.migration_notes = out["migration_notes"]
        item.file_ext        = out["file_ext"]
        item.convert_status  = "converted"
        item.error_message   = None
    except Exception as exc:
        item.convert_status = "failed"
        item.error_message  = str(exc)
    finally:
        item.updated_at = datetime.now(timezone.utc)
        db.commit()

    _update_plan_counts(plan, db)
    db.commit()
    return _item_to_dict(item)


# ── D365 Deploy (single item) ─────────────────────────────────────────────────

@router.post("/connections/{connection_id}/plans/{plan_id}/items/{item_id}/d365-deploy")
def deploy_plan_item_to_d365(connection_id: int, plan_id: int, item_id: int, db: Session = Depends(get_db)):
    """Deploy a single converted plan item to Dynamics 365."""
    from .services.d365_deploy_service import deploy_component, check_dotnet, DeployResult

    plan = db.query(DeploymentPlan).filter(
        DeploymentPlan.id == plan_id,
        DeploymentPlan.connection_id == connection_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")

    item = db.query(DeploymentPlanItem).filter(
        DeploymentPlanItem.id == item_id,
        DeploymentPlanItem.plan_id == plan_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")
    if not item.converted_code:
        raise HTTPException(status_code=400, detail="Item has no converted code. Run LLM conversion first.")

    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    cfg  = json.loads(conn.config_json or "{}") if conn else {}

    if not cfg.get("d365_environment_url") or not cfg.get("d365_client_id"):
        raise HTTPException(status_code=400, detail="D365 not configured for this org.")

    if item.item_type in ("apex_class", "apex_trigger"):
        ok, ver = check_dotnet()
        if not ok:
            raise HTTPException(status_code=400, detail=f"dotnet CLI not found: {ver}")

    item.deploy_status = "deploying"
    item.updated_at    = datetime.now(timezone.utc)
    db.commit()

    deploy_log = DeploymentLog(
        connection_id  = connection_id,
        component_type = item.item_type,
        component_name = item.item_name,
        source         = "plan",
        source_item_id = item_id,
        plan_id        = plan_id,
        status         = "running",
        created_at     = datetime.now(timezone.utc),
    )
    db.add(deploy_log)
    db.commit()
    db.refresh(deploy_log)

    try:
        result: DeployResult = deploy_component(
            converted_code = item.converted_code,
            component_type = item.item_type,
            component_name = item.item_name,
            connection_id  = connection_id,
            d365_cfg       = cfg,
            source_code    = item.source_code or "",
        )
    except Exception as exc:
        deploy_log.status        = "failed"
        deploy_log.error_message = str(exc)
        deploy_log.completed_at  = datetime.now(timezone.utc)
        item.deploy_status = "deploy_failed"
        item.deploy_error  = str(exc)
        item.deploy_log_id = deploy_log.id
        item.updated_at    = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Deployment crashed: {exc}")

    deploy_log.log_text        = result.log_text
    deploy_log.log_file_path   = result.log_file_path
    deploy_log.assembly_id     = result.assembly_id
    deploy_log.step_ids_json   = json.dumps(result.step_ids)
    deploy_log.web_resource_id = result.web_resource_id
    deploy_log.status          = "manual" if result.is_manual else ("success" if result.success else "failed")
    deploy_log.error_message   = "; ".join(result.errors) if result.errors else None
    deploy_log.completed_at    = datetime.now(timezone.utc)

    item.deploy_status = "manual" if result.is_manual else ("deployed" if result.success else "deploy_failed")
    item.deploy_error  = "; ".join(result.errors) if result.errors else None
    item.deploy_log_id = deploy_log.id
    item.deployed_at   = datetime.now(timezone.utc) if result.success else None
    item.updated_at    = datetime.now(timezone.utc)
    db.commit()

    return {
        "success":    result.success,
        "is_manual":  result.is_manual,
        "assembly_id": result.assembly_id,
        "step_ids":   result.step_ids,
        "web_resource_id": result.web_resource_id,
        "errors":     result.errors,
        "log_id":     deploy_log.id,
        "status":     deploy_log.status,
        "manual_instructions": result.manual_instructions if result.is_manual else None,
    }


# ── D365 Deploy (bulk — all converted items in plan) ──────────────────────────

@router.post("/connections/{connection_id}/plans/{plan_id}/d365-deploy-all")
def deploy_plan_all_to_d365(connection_id: int, plan_id: int, db: Session = Depends(get_db)):
    """Deploy all converted items in a plan to Dynamics 365 sequentially."""
    from .services.d365_deploy_service import deploy_component, check_dotnet, DeployResult

    plan = db.query(DeploymentPlan).filter(
        DeploymentPlan.id == plan_id,
        DeploymentPlan.connection_id == connection_id,
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")

    conn = db.query(Connection).filter(Connection.id == connection_id).first()
    cfg  = json.loads(conn.config_json or "{}") if conn else {}

    if not cfg.get("d365_environment_url") or not cfg.get("d365_client_id"):
        raise HTTPException(status_code=400, detail="D365 not configured for this org.")

    items = db.query(DeploymentPlanItem).filter(
        DeploymentPlanItem.plan_id == plan_id,
        DeploymentPlanItem.convert_status == "converted",
        DeploymentPlanItem.deploy_status.in_(["not_deployed", "deploy_failed"]),
    ).all()

    if not items:
        raise HTTPException(status_code=400, detail="No converted items ready for deployment.")

    results = []
    for item in items:
        item.deploy_status = "deploying"
        item.updated_at    = datetime.now(timezone.utc)
        db.commit()

        deploy_log = DeploymentLog(
            connection_id  = connection_id,
            component_type = item.item_type,
            component_name = item.item_name,
            source         = "plan",
            source_item_id = item.id,
            plan_id        = plan_id,
            status         = "running",
            created_at     = datetime.now(timezone.utc),
        )
        db.add(deploy_log)
        db.commit()
        db.refresh(deploy_log)

        try:
            result: DeployResult = deploy_component(
                converted_code = item.converted_code,
                component_type = item.item_type,
                component_name = item.item_name,
                connection_id  = connection_id,
                d365_cfg       = cfg,
                source_code    = item.source_code or "",
            )
            deploy_log.log_text        = result.log_text
            deploy_log.log_file_path   = result.log_file_path
            deploy_log.assembly_id     = result.assembly_id
            deploy_log.step_ids_json   = json.dumps(result.step_ids)
            deploy_log.web_resource_id = result.web_resource_id
            deploy_log.status          = "manual" if result.is_manual else ("success" if result.success else "failed")
            deploy_log.error_message   = "; ".join(result.errors) if result.errors else None
            deploy_log.completed_at    = datetime.now(timezone.utc)

            item.deploy_status = "manual" if result.is_manual else ("deployed" if result.success else "deploy_failed")
            item.deploy_error  = "; ".join(result.errors) if result.errors else None
            item.deploy_log_id = deploy_log.id
            item.deployed_at   = datetime.now(timezone.utc) if result.success else None

            results.append({
                "id": item.id, "name": item.item_name,
                "status": item.deploy_status,
                "log_id": deploy_log.id,
                "errors": result.errors,
            })

        except Exception as exc:
            deploy_log.status        = "failed"
            deploy_log.error_message = str(exc)
            deploy_log.completed_at  = datetime.now(timezone.utc)
            item.deploy_status = "deploy_failed"
            item.deploy_error  = str(exc)
            item.deploy_log_id = deploy_log.id
            results.append({"id": item.id, "name": item.item_name, "status": "deploy_failed", "errors": [str(exc)]})

        item.updated_at = datetime.now(timezone.utc)
        db.commit()

    deployed  = sum(1 for r in results if r["status"] == "deployed")
    failed    = sum(1 for r in results if r["status"] == "deploy_failed")
    manual    = sum(1 for r in results if r["status"] == "manual")

    return {
        "total":    len(results),
        "deployed": deployed,
        "failed":   failed,
        "manual":   manual,
        "results":  results,
    }


# ── Plan deployment logs ───────────────────────────────────────────────────────

@router.get("/connections/{connection_id}/plans/{plan_id}/deployment-logs")
def list_plan_deployment_logs(connection_id: int, plan_id: int, db: Session = Depends(get_db)):
    """List all D365 deployment logs for a plan."""
    logs = (
        db.query(DeploymentLog)
        .filter(DeploymentLog.plan_id == plan_id, DeploymentLog.connection_id == connection_id)
        .order_by(DeploymentLog.created_at.desc())
        .all()
    )
    return {
        "logs": [
            {
                "id":             l.id,
                "component_type": l.component_type,
                "component_name": l.component_name,
                "status":         l.status,
                "source_item_id": l.source_item_id,
                "assembly_id":    l.assembly_id,
                "web_resource_id": l.web_resource_id,
                "error_message":  l.error_message,
                "has_log_file":   bool(l.log_file_path),
                "created_at":     l.created_at.isoformat() if l.created_at else None,
                "completed_at":   l.completed_at.isoformat() if l.completed_at else None,
            }
            for l in logs
        ],
        "total": len(logs),
    }


@router.get("/deployment-logs/{log_id}/download")
def download_plan_log(log_id: int, db: Session = Depends(get_db)):
    """Download full log file for a plan item deployment."""
    from pathlib import Path
    log = db.query(DeploymentLog).filter(DeploymentLog.id == log_id).first()
    if not log:
        raise HTTPException(status_code=404, detail="Log not found.")
    if log.log_file_path:
        p = Path(log.log_file_path)
        if p.exists():
            return FileResponse(str(p), media_type="text/plain",
                                filename=f"deploy_{log.component_name}_{log.id}.log")
    return PlainTextResponse(content=log.log_text or "No log available.", media_type="text/plain")


# ── Metadata component list (for Add Items modal) ─────────────────────────────

@router.get("/connections/{connection_id}/metadata-components")
def list_metadata_components(connection_id: int, db: Session = Depends(get_db)):
    """Return flat list of all extracted components for the Add Items modal."""
    om = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    if not om or not om.metadata_json:
        return {"components": [], "total": 0}

    raw = json.loads(om.metadata_json)
    components = []

    for c in raw.get("apex_classes", []):
        if c.get("Name"):
            components.append({"item_type": "apex_class",   "item_name": c.get("Name",""), "sf_id": c.get("Id",""), "label": c.get("Name","")})

    for t in raw.get("apex_triggers", []):
        if t.get("Name"):
            components.append({"item_type": "apex_trigger", "item_name": t.get("Name",""), "sf_id": t.get("Id",""), "label": f"{t.get('Name','')} (on {t.get('TableEnumOrId','')})"})

    for f in raw.get("flows", []):
        name = f.get("ApiName", f.get("DeveloperName", ""))
        if name:
            components.append({"item_type": "flow", "item_name": name, "sf_id": f.get("Id",""), "label": f.get("Label", name)})

    for l in raw.get("lwc_components", []):
        name = l.get("DeveloperName", "")
        if name:
            components.append({"item_type": "lwc",  "item_name": name, "sf_id": l.get("Id",""), "label": l.get("MasterLabel", name)})

    for a in raw.get("aura_components", []):
        name = a.get("DeveloperName", "")
        if name:
            components.append({"item_type": "aura", "item_name": name, "sf_id": a.get("Id",""), "label": a.get("MasterLabel", name)})

    return {"components": components, "total": len(components)}


# ── SSE helpers ───────────────────────────────────────────────────────────────

def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _call_llm_with_cost(system_prompt: str, messages: list, max_tokens: int = 4000, db=None):
    """Like _call_llm but also returns { tokens_in, tokens_out, cost_usd, model, provider }."""
    provider = api_key = model = None

    if db is not None:
        try:
            from .connectors_router import get_default_llm
            cfg = get_default_llm(db)
            if cfg:
                provider = cfg["provider"]; api_key = cfg["api_key"]; model = cfg["model"]
        except Exception:
            pass

    if not provider:
        provider = os.environ.get("LLM_PROVIDER", "openai").lower()
    if not api_key:
        api_key = os.environ.get("ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY", "")
    if not model:
        model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6") if provider == "anthropic" \
            else os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    if not api_key:
        raise ValueError(f"No LLM API key found. Configure a provider in the LLM Connector page.")

    tokens_in = tokens_out = 0
    cost_usd  = 0.0

    if provider == "anthropic":
        import anthropic as _sdk
        resp = _sdk.Anthropic(api_key=api_key).messages.create(
            model=model, max_tokens=max_tokens, system=system_prompt, messages=messages,
        )
        text = resp.content[0].text
        tokens_in  = resp.usage.input_tokens
        tokens_out = resp.usage.output_tokens
        # Claude Sonnet 4.6 pricing: $3/1M in, $15/1M out
        cost_usd = round((tokens_in * 3 + tokens_out * 15) / 1_000_000, 6)
    else:
        from openai import OpenAI
        full = [{"role": "system", "content": system_prompt}] + messages
        resp = OpenAI(api_key=api_key).chat.completions.create(
            model=model, messages=full, max_tokens=max_tokens,
        )
        text = resp.choices[0].message.content
        if resp.usage:
            tokens_in  = resp.usage.prompt_tokens
            tokens_out = resp.usage.completion_tokens
            # gpt-4o-mini pricing: $0.15/1M in, $0.60/1M out
            cost_usd = round((tokens_in * 0.15 + tokens_out * 0.60) / 1_000_000, 6)

    usage = {"tokens_in": tokens_in, "tokens_out": tokens_out, "cost_usd": cost_usd, "model": model, "provider": provider}
    return text, usage


_FIX_PROMPT = """You are an expert Salesforce → Microsoft Dynamics 365 migration engineer.
A converted component failed to deploy to D365. You will be given:
1. A short error summary
2. The FULL deployment log showing every step that was attempted (read this carefully)
3. The current converted code
4. The original Salesforce source

Your job: read the full log to understand exactly WHICH step failed and WHY, then fix the code.

Common D365 plugin deployment errors and fixes:
- "PluginType [X] not found in PluginAssembly" → The typename registered must EXACTLY match the fully-qualified class name in the DLL. Check the namespace declaration in the code and ensure typename = "Namespace.ClassName". Never use just "ClassName" without the namespace.
- "A record with matching key values already exists" (412) → A plugin type with this name already exists from a previous attempt. Change the namespace or class name so the fully-qualified typename is unique.
- "Compilation failed / Unexpected character" → The code has syntax errors. Look for markdown backticks, smart quotes, or invalid C# syntax introduced by a previous fix attempt.
- "referenced by N other components" on assembly DELETE → Steps/types referencing the assembly must be deleted first. This is handled by the deployment system — your fix should ensure the code compiles and the typename is correct.
- "Assembly fullnames must be unique" → Two assemblies with the same name+culture+publicKeyToken exist. Handled by system cleanup — focus on making the typename correct.

Rules:
- Read the FULL DEPLOYMENT LOG to understand the root cause, not just the error summary.
- For plugin typename errors: extract the exact namespace from your code and use "Namespace.ClassName" as the typename — the system will read it from your code automatically.
- Preserve all business logic. Fix only what the error indicates.
- Return ONLY valid compilable C# (or TypeScript for LWC) — no markdown fences, no backticks.
- Respond in EXACTLY this format:
<fixed_code>[complete corrected code here]</fixed_code>
<explanation>[what was wrong, what exact change you made, and why it will fix the deployment]</explanation>"""


def _fix_item_with_llm(item: "DeploymentPlanItem", deploy_error: str, db,
                       connection_id: int = None, deploy_log_text: str = "") -> dict:
    """Ask LLM to fix converted code based on deploy error + full log. Returns { ok, fixed_code, explanation, usage }."""
    src_label = TYPE_MAP.get(item.item_type, ("Component", "D365 equivalent", ".txt"))[0]

    # Inject rulebook rules and field mapping so LLM fixes with full context
    rb = _get_rulebook(db, item.item_type)
    rules_block = f"\n\nRULES FOR {item.item_type.upper()}:\n{rb['rules']}" if rb.get("rules") else ""
    fm_ctx = _get_field_mapping_ctx(db, connection_id) if connection_id else ""
    fm_block = f"\n\n{fm_ctx}" if fm_ctx else ""

    # Pass ALL attempt logs so LLM sees the full history: what was tried, what changed, what still fails.
    # Each entry is labelled "=== Attempt N ===" so the LLM can compare attempts.
    # Truncate from the end if very long (keep most recent ~5000 chars total).
    log_block = ""
    if deploy_log_text:
        log_tail = deploy_log_text[-5000:] if len(deploy_log_text) > 5000 else deploy_log_text
        log_block = f"\n\nFULL DEPLOYMENT HISTORY (all {deploy_log_text.count('=== Attempt')} attempt(s)):\n{log_tail}"

    prompt = (
        f'Component: {item.item_name} ({src_label})\n\n'
        f'DEPLOY ERROR SUMMARY:\n{deploy_error[:1000]}\n'
        f'{log_block}\n\n'
        f'CURRENT CONVERTED CODE:\n```\n{(item.converted_code or "")[:6000]}\n```\n\n'
        f'ORIGINAL SOURCE:\n```\n{(item.source_code or "")[:3000]}\n```'
        f'{rules_block}{fm_block}'
    )
    try:
        text, usage = _call_llm_with_cost(_FIX_PROMPT, [{"role": "user", "content": prompt}], max_tokens=4000, db=db)
        fc_match  = re.search(r"<fixed_code>(.*?)</fixed_code>", text, re.DOTALL)
        exp_match = re.search(r"<explanation>(.*?)</explanation>", text, re.DOTALL)
        fixed_code  = fc_match.group(1).strip()  if fc_match  else ""
        explanation = exp_match.group(1).strip() if exp_match else text[:500]
        if not fixed_code:
            return {"ok": False, "error": "LLM did not return fixed_code block.", "usage": usage}
        return {"ok": True, "fixed_code": fixed_code, "explanation": explanation, "usage": usage}
    except Exception as e:
        return {"ok": False, "error": str(e), "usage": {}}


# ── SSE: Run Plan Stream ───────────────────────────────────────────────────────

@router.post("/connections/{connection_id}/plans/{plan_id}/run-stream")
def run_plan_stream(
    connection_id:   int,
    plan_id:         int,
    mode:            str  = Query("convert_and_deploy", enum=["convert_only", "deploy_only", "convert_and_deploy"]),
    force_reconvert: bool = Query(False),
):
    """Stream plan execution as SSE: convert → deploy → auto-fix (3 retries) per item."""
    from .database import SessionLocal

    def event_stream():
        db = SessionLocal()
        try:
            plan = db.query(DeploymentPlan).filter(
                DeploymentPlan.id == plan_id,
                DeploymentPlan.connection_id == connection_id,
            ).first()
            if not plan:
                yield _sse({"event": "error", "message": "Plan not found."})
                return

            items = (
                db.query(DeploymentPlanItem)
                .filter(DeploymentPlanItem.plan_id == plan_id)
                .order_by(DeploymentPlanItem.id)
                .all()
            )
            if not items:
                yield _sse({"event": "error", "message": "Plan has no items."})
                return

            conn = db.query(Connection).filter(Connection.id == connection_id).first()
            cfg  = json.loads(conn.config_json or "{}") if conn else {}

            total = len(items)
            yield _sse({"event": "plan_start", "total": total, "mode": mode})

            plan.status     = "deploying"
            plan.started_at = datetime.now(timezone.utc)
            plan.updated_at = datetime.now(timezone.utc)
            db.commit()

            total_cost_usd = 0.0
            plan_stats = {"total": total, "converted": 0, "deployed": 0,
                          "failed_convert": 0, "failed_deploy": 0, "manual": 0, "skipped": 0}

            for idx, item in enumerate(items):
                # ── force re-convert: reset status so LLM runs again ──────
                if force_reconvert and mode in ("convert_only", "convert_and_deploy"):
                    item.convert_status = "pending"
                    item.error_message  = None
                    db.commit()

                # ── skip logic ────────────────────────────────────────────
                if mode == "convert_only" and item.convert_status == "converted":
                    plan_stats["skipped"] += 1
                    yield _sse({"event": "item_skip", "id": item.id, "name": item.item_name, "reason": "already_converted"})
                    continue
                if mode == "deploy_only" and item.convert_status != "converted":
                    plan_stats["skipped"] += 1
                    yield _sse({"event": "item_skip", "id": item.id, "name": item.item_name, "reason": "not_converted"})
                    continue
                if mode == "deploy_only" and item.deploy_status in ("deployed", "manual"):
                    plan_stats["skipped"] += 1
                    yield _sse({"event": "item_skip", "id": item.id, "name": item.item_name, "reason": "already_deployed"})
                    continue

                item_cost = 0.0
                item_stats = json.loads(item.stats_json or "{}") if getattr(item, "stats_json", None) else {}

                # ── Phase 1: Convert ──────────────────────────────────────
                if mode in ("convert_only", "convert_and_deploy") and item.convert_status != "converted":
                    yield _sse({"event": "item_start", "id": item.id, "name": item.item_name,
                                "type": item.item_type, "index": idx + 1, "total": total, "phase": "converting"})

                    if not item.source_code:
                        item.convert_status = "failed"
                        item.error_message  = "No source code available."
                        item.updated_at     = datetime.now(timezone.utc)
                        db.commit()
                        yield _sse({"event": "item_phase_done", "id": item.id, "phase": "converting",
                                    "status": "fail", "error": item.error_message})
                        plan_stats["failed_convert"] += 1
                        continue

                    item.convert_status = "converting"
                    item.updated_at     = datetime.now(timezone.utc)
                    db.commit()

                    yield _sse({"event": "item_log", "id": item.id, "log": f"Calling LLM to convert {item.item_name}…"})
                    try:
                        rb  = _get_rulebook(db, item.item_type)
                        fm  = _get_field_mapping_ctx(db, connection_id)
                        src_label, tgt_label, file_ext = TYPE_MAP.get(item.item_type, ("Component", "D365 equivalent", ".txt"))
                        sys_p = rb["system_prompt"] or f"You are an expert SF→D365 engineer. Convert {src_label} to {tgt_label}."
                        rules_block = f"\n\n{rb['rules']}" if rb.get("rules") else ""
                        fm_block    = f"\n\n{fm}" if fm else ""
                        prompt = (f'Convert Salesforce {src_label} "{item.item_name}" to {tgt_label} for Dynamics 365.'
                                  f'{rules_block}{fm_block}'
                                  f'\n\nReturn ONLY converted code then "## Migration Notes" section.'
                                  f'\n\nSOURCE:\n```\n{item.source_code}\n```')

                        result_text, usage = _call_llm_with_cost(sys_p, [{"role": "user", "content": prompt}],
                                                                   max_tokens=4000, db=db)

                        if "## Migration Notes" in result_text:
                            parts = result_text.split("## Migration Notes", 1)
                            code  = parts[0].strip()
                            notes = "## Migration Notes" + parts[1]
                        else:
                            code  = result_text.strip()
                            notes = ""
                        code = re.sub(r"^```[a-zA-Z]*\n?", "", code, flags=re.MULTILINE)
                        code = re.sub(r"\n?```$",          "", code, flags=re.MULTILINE)
                        code = code.strip()

                        item.converted_code  = code
                        item.migration_notes = notes
                        item.file_ext        = file_ext
                        item.convert_status  = "converted"
                        item.error_message   = None
                        item_cost += usage.get("cost_usd", 0)
                        item_stats.update({"tokens_in": usage.get("tokens_in", 0),
                                           "tokens_out": usage.get("tokens_out", 0),
                                           "model": usage.get("model", ""),
                                           "provider": usage.get("provider", "")})
                        item.updated_at = datetime.now(timezone.utc)
                        db.commit()

                        yield _sse({"event": "item_log", "id": item.id,
                                    "log": f"  ✓ Converted ({usage.get('tokens_in',0)} in / {usage.get('tokens_out',0)} out tokens, ${usage.get('cost_usd',0):.4f})"})
                        yield _sse({"event": "item_phase_done", "id": item.id, "phase": "converting",
                                    "status": "ok", "cost_usd": usage.get("cost_usd", 0),
                                    "tokens_in": usage.get("tokens_in", 0), "tokens_out": usage.get("tokens_out", 0),
                                    "model": usage.get("model", ""), "provider": usage.get("provider", "")})
                        plan_stats["converted"] += 1

                    except Exception as exc:
                        item.convert_status = "failed"
                        item.error_message  = str(exc)
                        item.updated_at     = datetime.now(timezone.utc)
                        db.commit()
                        yield _sse({"event": "item_log", "id": item.id, "log": f"  ✗ Conversion failed: {exc}"})
                        yield _sse({"event": "item_phase_done", "id": item.id, "phase": "converting",
                                    "status": "fail", "error": str(exc)})
                        plan_stats["failed_convert"] += 1
                        continue

                # ── Phase 2: Deploy ───────────────────────────────────────
                if mode in ("convert_and_deploy", "deploy_only") and item.convert_status == "converted":
                    from .services.d365_deploy_service import deploy_component, DeployResult

                    if not cfg.get("d365_environment_url") or not cfg.get("d365_client_id"):
                        yield _sse({"event": "item_phase_done", "id": item.id, "phase": "deploying",
                                    "status": "fail", "error": "D365 not configured.", "fix_attempts": 0})
                        plan_stats["failed_deploy"] += 1
                        continue

                    fix_attempts = 0
                    deploy_error = ""
                    all_deploy_logs = []   # accumulates ALL attempt logs so LLM sees full history
                    final_deploy_status = "deploy_failed"
                    log_id = None

                    for attempt in range(4):  # attempt 0 = first try, 1-3 = after fix
                        if attempt > 0:
                            # Fix the code — pass FULL log so LLM understands every step that failed
                            yield _sse({"event": "item_fixing", "id": item.id, "attempt": attempt,
                                        "error": deploy_error[:300]})
                            yield _sse({"event": "item_log", "id": item.id,
                                        "log": f"  ↻ Fix attempt {attempt}/3 — asking LLM to repair…"})
                            fix_res = _fix_item_with_llm(item, deploy_error, db,
                                                         connection_id=connection_id,
                                                         deploy_log_text="\n\n".join(all_deploy_logs))
                            fix_cost = fix_res.get("usage", {}).get("cost_usd", 0)
                            item_cost += fix_cost
                            fix_attempts += 1
                            if fix_res.get("ok") and fix_res.get("fixed_code"):
                                item.converted_code = fix_res["fixed_code"]
                                item.updated_at     = datetime.now(timezone.utc)
                                db.commit()
                                yield _sse({"event": "item_log", "id": item.id,
                                            "log": f"  ✓ LLM fix applied. {fix_res.get('explanation','')[:200]}"})
                            else:
                                yield _sse({"event": "item_log", "id": item.id,
                                            "log": f"  ✗ LLM fix failed: {fix_res.get('error','')}"})
                                break

                        yield _sse({"event": "item_start", "id": item.id, "name": item.item_name,
                                    "type": item.item_type, "index": idx + 1, "total": total,
                                    "phase": "deploying", "attempt": attempt + 1})

                        item.deploy_status = "deploying"
                        item.updated_at    = datetime.now(timezone.utc)
                        db.commit()

                        deploy_log = DeploymentLog(
                            connection_id  = connection_id,
                            component_type = item.item_type,
                            component_name = item.item_name,
                            source         = "plan",
                            source_item_id = item.id,
                            plan_id        = plan_id,
                            status         = "running",
                            created_at     = datetime.now(timezone.utc),
                        )
                        db.add(deploy_log)
                        db.commit()
                        db.refresh(deploy_log)
                        log_id = deploy_log.id

                        try:
                            result: DeployResult = deploy_component(
                                converted_code = item.converted_code,
                                component_type = item.item_type,
                                component_name = item.item_name,
                                connection_id  = connection_id,
                                d365_cfg       = cfg,
                                source_code    = item.source_code or "",
                            )
                        except Exception as exc:
                            deploy_error = str(exc)
                            all_deploy_logs.append(f"=== Attempt {attempt + 1} (exception) ===\n{deploy_error}")
                            deploy_log.status        = "failed"
                            deploy_log.error_message = deploy_error
                            deploy_log.log_text      = deploy_error
                            deploy_log.completed_at  = datetime.now(timezone.utc)
                            item.deploy_status = "deploy_failed"
                            item.deploy_error  = deploy_error
                            item.deploy_log_id = log_id
                            item.updated_at    = datetime.now(timezone.utc)
                            db.commit()
                            yield _sse({"event": "item_log", "id": item.id, "log": f"  ✗ Deploy crashed: {deploy_error}"})
                            if attempt >= 3:
                                break
                            continue

                        # Append this attempt's full log to history so LLM sees all attempts cumulatively
                        all_deploy_logs.append(f"=== Attempt {attempt + 1} ===\n{result.log_text or ''}")
                        deploy_log.log_text        = result.log_text
                        deploy_log.log_file_path   = result.log_file_path
                        deploy_log.assembly_id     = result.assembly_id
                        deploy_log.step_ids_json   = json.dumps(result.step_ids)
                        deploy_log.web_resource_id = result.web_resource_id
                        deploy_log.status          = "manual" if result.is_manual else ("success" if result.success else "failed")
                        deploy_log.error_message   = "; ".join(result.errors) if result.errors else None
                        deploy_log.completed_at    = datetime.now(timezone.utc)
                        db.commit()

                        # Emit log lines
                        for log_line in (result.log_text or "").splitlines()[-20:]:
                            if log_line.strip():
                                yield _sse({"event": "item_log", "id": item.id, "log": f"  {log_line}"})

                        if result.success or result.is_manual:
                            final_deploy_status = "manual" if result.is_manual else "deployed"
                            item.deploy_status = final_deploy_status
                            item.deploy_error  = None
                            item.deploy_log_id = log_id
                            item.deployed_at   = datetime.now(timezone.utc)
                            item.updated_at    = datetime.now(timezone.utc)
                            db.commit()
                            yield _sse({"event": "item_log", "id": item.id,
                                        "log": f"  ✓ Deploy {'succeeded' if result.success else 'needs manual activation'}"})
                            if result.is_manual:
                                plan_stats["manual"] += 1
                            else:
                                plan_stats["deployed"] += 1
                            break
                        else:
                            # Keep full error list — LLM needs to see all errors, not just the last one
                            deploy_error = "\n".join(result.errors) if result.errors else "Deploy failed"
                            item.deploy_status = "deploy_failed"
                            item.deploy_error  = deploy_error
                            item.deploy_log_id = log_id
                            item.updated_at    = datetime.now(timezone.utc)
                            db.commit()
                            yield _sse({"event": "item_log", "id": item.id, "log": f"  ✗ Deploy failed: {deploy_error[:200]}"})
                            if attempt >= 3:
                                plan_stats["failed_deploy"] += 1

                    # Store stats
                    item_stats.update({"cost_usd": round(item_cost, 6), "fix_attempts": fix_attempts})
                    if hasattr(item, "stats_json"):
                        item.stats_json = json.dumps(item_stats)
                        db.commit()
                    total_cost_usd += item_cost

                    yield _sse({"event": "item_phase_done", "id": item.id, "phase": "deploying",
                                "status": "ok" if final_deploy_status in ("deployed", "manual") else "fail",
                                "deploy_status": final_deploy_status, "fix_attempts": fix_attempts,
                                "log_id": log_id})
                else:
                    # convert_only mode or deploy skipped — store cost
                    item_stats["cost_usd"] = round(item_cost, 6)
                    if hasattr(item, "stats_json"):
                        item.stats_json = json.dumps(item_stats)
                        db.commit()
                    total_cost_usd += item_cost

                yield _sse({"event": "item_done", "id": item.id,
                            "convert_status": item.convert_status,
                            "deploy_status": item.deploy_status or "not_deployed",
                            "cost_usd": round(item_cost, 6),
                            "fix_attempts": item_stats.get("fix_attempts", 0),
                            "model": item_stats.get("model", ""),
                            "provider": item_stats.get("provider", ""),
                            "tokens_in": item_stats.get("tokens_in", 0),
                            "tokens_out": item_stats.get("tokens_out", 0),
                            "log_id": log_id if mode != "convert_only" else None})

            # Final plan status
            _update_plan_counts(plan, db)
            if plan_stats["failed_convert"] == 0 and plan_stats["failed_deploy"] == 0 and plan_stats["manual"] == 0:
                plan.status = "completed"
            elif plan_stats["converted"] > 0 or plan_stats["deployed"] > 0 or plan_stats["manual"] > 0:
                plan.status = "partial"
            else:
                plan.status = "failed"
            plan.completed_at = datetime.now(timezone.utc)
            plan.updated_at   = datetime.now(timezone.utc)
            db.commit()

            yield _sse({"event": "plan_done", "status": plan.status, "stats": plan_stats,
                        "total_cost_usd": round(total_cost_usd, 4)})

        except Exception as outer:
            yield _sse({"event": "error", "message": str(outer)})
        finally:
            db.close()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
