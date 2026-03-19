from fastapi import APIRouter, HTTPException
from .services.connection_service import ConnectionService
from .services.lakehouse_service  import LakehouseService
from .services.dataverse_service  import DataverseService
from .services.salesforce_service import SalesforceService
from .services.connector_test_service import test_connector
from .services import run_history_service
from typing import Dict, List
from pydantic import BaseModel


router             = APIRouter()
connection_service = ConnectionService()
_lk: LakehouseService | None  = None   # lazily created once config is saved
_dv: DataverseService | None  = None   # lazily created from dynamics config
_sf: SalesforceService | None = None   # lazily created from salesforce config


def get_lk() -> LakehouseService:
    """Return a LakehouseService wired to the Fabric config, or raise 503."""
    global _lk
    configs = connection_service.list_configs()
    if not configs:
        raise HTTPException(status_code=503,
                            detail="No connection profile saved. "
                                   "Fill the Connection tab and save first.")

    # Prefer a config explicitly typed as 'fabric'; fall back to the last saved one
    fabric_cfg = None
    for name in configs:
        cfg = connection_service.get_config(name)
        if cfg and cfg.get("_type") == "fabric":
            fabric_cfg = cfg
            break
    if fabric_cfg is None:
        fabric_cfg = connection_service.get_config(configs[-1])

    if _lk is None or _lk.config != fabric_cfg:
        _lk = LakehouseService(fabric_cfg)
    return _lk


def get_dv() -> DataverseService:
    """Return a DataverseService wired to the Dynamics config, or raise 503."""
    global _dv
    configs = connection_service.list_configs()
    dynamics_cfg = None
    for name in configs:
        cfg = connection_service.get_config(name)
        if cfg and cfg.get("_type") == "dynamics":
            dynamics_cfg = cfg
            break

    if dynamics_cfg is None:
        raise HTTPException(
            status_code=503,
            detail="No Dynamics 365 connection saved. "
                   "Add a Dynamics 365 connection in the Connections tab first.",
        )

    if _dv is None or _dv.config != dynamics_cfg:
        _dv = DataverseService(dynamics_cfg)
    return _dv


def get_sf() -> SalesforceService:
    """Return a SalesforceService wired to the Salesforce config, or raise 503."""
    global _sf
    configs = connection_service.list_configs()
    sf_cfg = None
    for name in configs:
        cfg = connection_service.get_config(name)
        if cfg and cfg.get("_type") == "salesforce":
            sf_cfg = cfg
            break

    if sf_cfg is None:
        raise HTTPException(
            status_code=503,
            detail="No Salesforce connection saved. "
                   "Add a Salesforce connection in the Connections tab first.",
        )

    if _sf is None or _sf.config != sf_cfg:
        _sf = SalesforceService(sf_cfg)
    return _sf


# ── Connection profiles ────────────────────────────────────────────────────

from fastapi import APIRouter, HTTPException, BackgroundTasks
import json

@router.post("/config")
def add_config(name: str, config: Dict, background_tasks: BackgroundTasks):
    global _lk, _dv, _sf
    connection_service.add_config(name, config)
    _lk = None   # force reconnect with new creds
    _dv = None
    _sf = None

    def upload_configs_bg():
        try:
            lk = get_lk()
            all_configs = {}
            for cfg_name in connection_service.list_configs():
                cfg_data = connection_service.get_config(cfg_name)
                if cfg_data:
                    # Strip secrets for safety — only upload non-secret fields
                    safe = {k: v for k, v in cfg_data.items()}
                    all_configs[cfg_name] = safe
            lk._upload_to_onelake(
                "config/configs.json",
                json.dumps(all_configs, indent=2).encode("utf-8"),
            )
            print(f"[Config] ✅ Uploaded configs.json to OneLake")
        except Exception as e:
            print(f"[Config] ⚠️ Failed to upload configs to OneLake (non-fatal): {e}")

    # Upload configs to OneLake asynchronously so pipeline/notebooks can access them
    background_tasks.add_task(upload_configs_bg)

    return {"status": "ok"}

@router.get("/config")
def get_config(name: str):
    cfg = connection_service.get_config(name)
    if not cfg:
        raise HTTPException(status_code=404, detail="Config not found")
    return cfg

@router.get("/configs")
def list_configs():
    return connection_service.list_configs()

@router.delete("/config")
def delete_config(name: str):
    global _lk, _dv, _sf
    deleted = connection_service.delete_config(name)
    if not deleted:
        raise HTTPException(status_code=404, detail="Config not found")
    _lk = None   # reset lakehouse connection
    _dv = None
    _sf = None
    return {"status": "ok"}

@router.post("/config/test")
def test_connection():
    lk = get_lk()
    ok, msg = lk.test_connection()
    if not ok:
        raise HTTPException(status_code=503, detail=msg)
    return {"status": "ok", "message": msg}

@router.post("/config/test-named")
def test_connection_by_name(name: str):
    """Test a specific saved connection by name, using its stored _type."""
    cfg = connection_service.get_config(name)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Config not found")
    conn_type = cfg.get("_type", "fabric")
    ok, msg = test_connector(conn_type, cfg)
    if not ok:
        raise HTTPException(status_code=503, detail=msg)
    return {"status": "ok", "message": msg}


# ── SF Objects (read from raw.object_names) ────────────────────────────────

@router.get("/objects")
def get_objects():
    """Returns [{name, migrate}] from raw.object_names."""
    return get_lk().get_objects()

@router.post("/migrate/flag")
def set_migrate_flag(object_name: str, migrate: bool):
    """UPDATE raw.object_names SET Migrate = ? WHERE ObjectName = ?"""
    get_lk().set_migrate_flag(object_name, migrate)
    return {"status": "ok"}

@router.post("/migrate/flag/bulk")
def set_migrate_flags_bulk(flags: Dict[str, bool]):
    """Bulk-set all migrate flags at once (Select All / Unselect All)."""
    from app.services.migrate_flags_service import set_all_flags
    set_all_flags(flags)
    return {"status": "ok", "count": sum(1 for v in flags.values() if v)}

@router.post("/objects/confirm")
def confirm_object_flags():
    """Push locally-stored migrate flags to the Lakehouse via OneLake + Load Table API."""
    try:
        result = get_lk().confirm_object_flags()
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── Field mapping suggestions (raw.object_mapping + raw.field_mapping) ─────

@router.get("/field-suggestions/{object_name}")
def get_field_suggestions(object_name: str):
    """
    Returns:
      { fields: [...], no_mapping: false, dynamics_object: "..." }
      or
      { fields: [], no_mapping: true, publisher_prefix: "new_" }
    """
    return get_lk().get_suggestions_for_object(object_name)


class MappingSavePayload(BaseModel):
    d365_entity: str
    fields: List[Dict]


class BulkMappingItem(BaseModel):
    sf_object: str
    d365_entity: str
    fields: List[Dict]


from fastapi import BackgroundTasks

@router.post("/mapping/bulk")
def save_bulk_field_mappings(items: List[BulkMappingItem], background_tasks: BackgroundTasks):
    """Save all confirmed mappings to Lakehouse in a single Delta write."""
    if not items:
        raise HTTPException(status_code=422, detail="No mappings provided")
    try:
        result = get_lk().save_bulk_mappings_to_lakehouse(
            [{"sf_object": it.sf_object, "d365_entity": it.d365_entity, "fields": it.fields}
             for it in items],
            background_tasks
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/mapping/{object_name}")
def save_field_mapping(object_name: str, payload: MappingSavePayload):
    """Save mapping to lakehouse (raw.object_mapping + raw.field_mapping)."""
    try:
        result = get_lk().save_mapping_to_lakehouse(
            sf_object=object_name,
            d365_entity=payload.d365_entity,
            field_rows=payload.fields,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@router.get("/mapping/{object_name}")
def get_field_mapping(object_name: str):
    """Read existing mapping for an object from lakehouse."""
    return get_lk().get_suggestions_for_object(object_name)


# ── Salesforce object field browser ───────────────────────────────────────

@router.get("/salesforce/objects/{object_name}/fields")
def get_sf_object_fields(object_name: str):
    """Return all fields for a Salesforce object via the REST Describe API."""
    try:
        return get_sf().get_object_fields(object_name)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── Dataverse entity browser ───────────────────────────────────────────────

@router.get("/dataverse/entities")
def get_dataverse_entities():
    """Returns all Dataverse entity definitions (tables)."""
    try:
        return get_dv().get_entities()
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@router.get("/dataverse/entities/{logical_name}/fields")
def get_dataverse_entity_fields(logical_name: str):
    """Returns all attributes (columns) for a specific Dataverse entity."""
    try:
        return get_dv().get_entity_fields(logical_name)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@router.post("/dataverse/refresh")
def refresh_dataverse_cache():
    """Force-refresh the cached entity list from Dataverse."""
    try:
        entities = get_dv().get_entities(force_refresh=True)
        return {"status": "ok", "count": len(entities)}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ── Migration (trigger Fabric Data Pipeline) ───────────────────────────────

@router.post("/migration/{pipeline_type}/start")
def start_migration(pipeline_type: str):
    """Triggers the Fabric Data Pipeline. Returns {job_id, status, status_url, pipeline_id}."""
    if pipeline_type not in ("schema", "data"):
        raise HTTPException(status_code=400, detail="Invalid pipeline type")
        
    # Check that Dataverse (Dynamics 365) connection exists
    configs = connection_service.list_configs()
    has_dynamics = any(
        (connection_service.get_config(n) or {}).get("_type") == "dynamics"
        for n in configs
    )
    if not has_dynamics:
        raise HTTPException(
            status_code=422,
            detail="A Dynamics 365 connection is required before running the pipeline. "
                   "Add one in the Connections tab first.",
        )
    try:
        result = get_lk().trigger_pipeline(pipeline_type)
        # Save to run history
        run_history_service.add_run({
            "job_id": result.get("job_id"),
            "pipeline_type": pipeline_type,
            "pipeline_id": result.get("pipeline_id"),
            "status": result.get("status", "Accepted"),
            "triggered_at": result.get("status_url", ""),
        })
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@router.get("/migration/status/{job_id}")
def get_migration_status(job_id: str):
    """Poll pipeline run status."""
    history = run_history_service.get_history()
    run_record = next((r for r in history if r.get("job_id") == job_id), {})
    pipeline_id = run_record.get("pipeline_id")
    
    if not pipeline_id:
        # Fallback for old runs
        fabric_conns = [n for n in connection_service.list_configs() if (connection_service.get_config(n) or {}).get("_type") == "fabric"]
        if fabric_conns:
            pipeline_id = connection_service.get_config(fabric_conns[0]).get("fields", {}).get("DATA_PIPELINE_ID") or connection_service.get_config(fabric_conns[0]).get("fields", {}).get("FABRIC_PIPELINE_ID")

    try:
        data = get_lk().get_pipeline_status(job_id, pipeline_id)
        # Update the run in history if terminal
        if data.get("is_terminal"):
            for run in history:
                if run.get("job_id") == job_id:
                    run["status"] = data.get("status", run.get("status"))
                    run["start_time"] = data.get("start_time")
                    run["end_time"] = data.get("end_time")
                    run["failure_reason"] = data.get("failure_reason")
                    break
            run_history_service._save(history)
        return data
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@router.post("/migration/cancel/{job_id}")
def cancel_migration(job_id: str):
    """Request cancellation of a running Fabric pipeline job."""
    history = run_history_service.get_history()
    run_record = next((r for r in history if r.get("job_id") == job_id), {})
    pipeline_id = run_record.get("pipeline_id")
    
    if not pipeline_id:
        fabric_conns = [n for n in connection_service.list_configs() if (connection_service.get_config(n) or {}).get("_type") == "fabric"]
        if fabric_conns:
            pipeline_id = connection_service.get_config(fabric_conns[0]).get("fields", {}).get("DATA_PIPELINE_ID") or connection_service.get_config(fabric_conns[0]).get("fields", {}).get("FABRIC_PIPELINE_ID")

    try:
        return get_lk().cancel_pipeline(job_id, pipeline_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@router.get("/migration/history")
def get_migration_history(pipeline_type: str = None):
    """Return the last 50 pipeline runs, optionally filtered by type."""
    history = run_history_service.get_history()
    if pipeline_type:
        history = [r for r in history if r.get("pipeline_type") == pipeline_type]
    return history

@router.get("/migration/activities/{job_id}")
def get_activity_runs(job_id: str):
    """Return per-activity run details for a pipeline job."""
    history = run_history_service.get_history()
    run_record = next((r for r in history if r.get("job_id") == job_id), {})
    pipeline_id = run_record.get("pipeline_id")
    
    if not pipeline_id:
        fabric_conns = [n for n in connection_service.list_configs() if (connection_service.get_config(n) or {}).get("_type") == "fabric"]
        if fabric_conns:
            pipeline_id = connection_service.get_config(fabric_conns[0]).get("fields", {}).get("DATA_PIPELINE_ID") or connection_service.get_config(fabric_conns[0]).get("fields", {}).get("FABRIC_PIPELINE_ID")

    try:
        return get_lk().get_activity_runs(job_id, pipeline_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@router.post("/migration/history")
def save_run_to_history(run: Dict):
    """Manually save a run record."""
    run_history_service.add_run(run)
    return {"status": "ok"}

