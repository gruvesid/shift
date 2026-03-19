"""
Fetches field mapping data from Fabric SQL and builds the
00_field_mapping.json structure.

Tables used:
  raw.sf_to_dv_column_mapping  — column-level SF → D365 mapping
  raw.sf_to_dv_picklist_mapping — picklist option labels & codes
"""
import time
import json
import pyodbc
from datetime import datetime, timezone
from typing import Optional


PICKLIST_TYPES = {"picklist", "optionset", "multipicklist", "multioptionset"}
MAX_RETRIES    = 3
RETRY_DELAY    = 5   # seconds


def _get_driver() -> Optional[str]:
    for candidate in ["ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server"]:
        if candidate in pyodbc.drivers():
            return candidate
    return None


def _build_conn_str(cfg: dict, driver: str) -> str:
    tenant_id  = cfg["fabric_tenant_id"]
    sp_id      = cfg["fabric_service_principal_id"]
    sp_secret  = cfg["fabric_service_principal_secret"]
    server     = cfg["fabric_server"]
    database   = cfg["fabric_database"]
    uid        = f"{sp_id}@{tenant_id}"
    return (
        f"Driver={{{driver}}};Server={server},1433;Database={database};"
        f"Encrypt=Yes;TrustServerCertificate=No;UID={uid};PWD={sp_secret};"
        "Authentication=ActiveDirectoryServicePrincipal"
    )


def _fetch_with_retry(conn_str: str, sql: str) -> list[dict]:
    """Run *sql* and return rows as list-of-dicts, retrying on OneLake staleness errors."""
    last_exc = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            conn   = pyodbc.connect(conn_str, timeout=30)
            cursor = conn.cursor()
            cursor.execute(sql)
            cols = [c[0] for c in cursor.description]
            rows = [dict(zip(cols, row)) for row in cursor.fetchall()]
            conn.close()
            return rows
        except Exception as exc:
            last_exc = exc
            msg = str(exc).lower()
            if "underlying location does not exist" in msg or "onelake" in msg.lower():
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_DELAY)
                    continue
            raise
    raise last_exc  # type: ignore[misc]


def fetch_field_mapping(config_json: str) -> dict:
    """
    Connect to Fabric SQL, fetch both mapping tables, build and return
    the structured field-mapping dict (to be JSON-serialised and stored).

    Raises ValueError if Fabric credentials are missing from config_json.
    Raises RuntimeError / pyodbc.Error on connection or query failures.
    """
    cfg = json.loads(config_json)

    required = [
        "fabric_tenant_id", "fabric_service_principal_id",
        "fabric_service_principal_secret", "fabric_server", "fabric_database",
    ]
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        raise ValueError(f"Fabric credentials missing from connection config: {missing}")

    driver = _get_driver()
    if not driver:
        raise RuntimeError("No suitable ODBC driver found (need ODBC Driver 17 or 18 for SQL Server).")

    conn_str = _build_conn_str(cfg, driver)

    # ── 1. Fetch column mapping ───────────────────────────────────────────
    col_rows = _fetch_with_retry(
        conn_str,
        "SELECT * FROM raw.sf_to_dv_column_mapping ORDER BY Salesforce_Object, Salesforce_Column",
    )

    # ── 2. Fetch picklist mapping ─────────────────────────────────────────
    pick_rows = _fetch_with_retry(
        conn_str,
        """
        SELECT SF_Object, Dynamics_Object, SF_Field, D365_Field, SF_picklist, DY_picklist
        FROM raw.sf_to_dv_picklist_mapping
        ORDER BY SF_Object, D365_Field, DY_picklist
        """,
    )

    # ── 3. Build picklist lookup ──────────────────────────────────────────
    # Key: (sf_object.lower(), sf_field.lower())  — SF_Field matches Salesforce_Column
    # Also index by d365_field as fallback
    picklist_lookup: dict[tuple, list] = {}
    for r in pick_rows:
        sf_obj_key  = str(r.get("SF_Object", "") or "").lower()
        sf_field_key = str(r.get("SF_Field", "") or "").lower()
        d365_field_key = str(r.get("D365_Field", "") or "").lower()

        # Parse numeric value — DY_picklist is stored as string e.g. '100000000'
        raw_val = r.get("DY_picklist")
        try:
            val = int(raw_val) if raw_val is not None else None
        except (ValueError, TypeError):
            val = raw_val

        entry = {
            "label":      str(r.get("SF_picklist") or "").strip(),
            "value":      val,
            "d365_field": r.get("D365_Field") or "",
        }

        # Primary key: (sf_object, sf_field) — joins on Salesforce_Column
        key_sf = (sf_obj_key, sf_field_key)
        picklist_lookup.setdefault(key_sf, []).append(entry)

        # Secondary key: (sf_object, d365_field) — fallback join on Dataverse_Column
        if d365_field_key and d365_field_key != sf_field_key:
            key_d365 = (sf_obj_key, d365_field_key)
            picklist_lookup.setdefault(key_d365, []).append(entry)

    # ── 4. Group column rows by Salesforce_Object ─────────────────────────
    objects: dict[str, dict] = {}
    for r in col_rows:
        sf_obj  = str(r.get("Salesforce_Object") or "").strip()
        if not sf_obj:
            continue

        if sf_obj not in objects:
            objects[sf_obj] = {
                "UID":             r.get("UID") or "",
                "Dynamics_Object": str(r.get("Dataverse_Object") or r.get("Dataverse_Table") or "").strip(),
                "fields":          [],
            }

        dv_type = str(r.get("Dataverse_Data_Type") or "").lower().strip()
        sf_col  = str(r.get("Salesforce_Column") or "").strip()
        d365_col = str(r.get("Dataverse_Column") or "").strip()

        field_entry: dict = {
            "Salesforce_Column":       sf_col,
            "Dataverse_Column":        d365_col,
            "Dataverse_Data_Type":     r.get("Dataverse_Data_Type") or "",
            "Dataverse_Display_Name":  r.get("Dataverse_Display_Name") or "",
            "Dataverse_Schema":        r.get("Dataverse_Schema") or "",
            "Dataverse_Object":        r.get("Dataverse_Object") or "",
        }

        # Enrich picklist/optionset fields with options
        # Try primary key (sf_object, salesforce_column) first, then fallback to (sf_object, d365_column)
        if dv_type in PICKLIST_TYPES:
            options = (
                picklist_lookup.get((sf_obj.lower(), sf_col.lower())) or
                picklist_lookup.get((sf_obj.lower(), d365_col.lower())) or
                []
            )
            # Deduplicate by (label, value)
            seen = set()
            unique_options = []
            for opt in options:
                k = (opt.get("label"), opt.get("value"))
                if k not in seen:
                    seen.add(k)
                    unique_options.append(opt)
            if unique_options:
                field_entry["options"] = unique_options

        objects[sf_obj]["fields"].append(field_entry)

    # ── 5. Wrap with timestamp metadata ───────────────────────────────────
    return {
        "_fetched_at": datetime.now(timezone.utc).isoformat(),
        "_total_objects": len(objects),
        "_total_fields": sum(len(v["fields"]) for v in objects.values()),
        "objects": objects,
    }
