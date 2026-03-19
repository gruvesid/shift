import pyodbc
import requests
import json
import msal
from typing import List, Dict, Optional, Tuple
from .migrate_flags_service import get_all_flags, set_flag


class LakehouseService:
    """
    Handles all interactions with the Fabric Lakehouse SQL endpoint via ODBC
    and Fabric REST API for pipeline triggering.
    """

    def __init__(self, config: Dict):
        self.config        = config
        self._conn         = None
        self._table_cache: Dict[str, str] = {}  # pattern → discovered table name

    # ── Connection ────────────────────────────────────────────

    def _build_conn_str(self) -> str:
        sql_endpoint         = self.config.get("SQL_ENDPOINT", "")
        database             = self.config.get("DATABASE_NAME", "")
        fabric_client_id     = self.config.get("FABRIC_CLIENT_ID", "")
        fabric_client_secret = self.config.get("FABRIC_CLIENT_SECRET", "")
        return (
            "Driver={ODBC Driver 18 for SQL Server};"
            f"Server={sql_endpoint},1433;"
            f"Database={database};"
            "Authentication=ActiveDirectoryServicePrincipal;"
            f"UID={fabric_client_id};"
            f"PWD={fabric_client_secret};"
            "Encrypt=yes;TrustServerCertificate=no;"
        )

    def _get_conn(self):
        """Return the cached connection, reconnecting if it has gone stale."""
        if self._conn is not None:
            try:
                self._conn.cursor().execute("SELECT 1")
                return self._conn
            except Exception:
                try:
                    self._conn.close()
                except Exception:
                    pass
                self._conn = None
        self._conn = pyodbc.connect(self._build_conn_str(), timeout=15)
        return self._conn

    def _fresh_conn(self):
        """Open a brand-new connection (used for write operations to avoid stale state)."""
        return pyodbc.connect(self._build_conn_str(), timeout=15)

    def test_connection(self) -> Tuple[bool, str]:
        try:
            conn = self._get_conn()
            conn.cursor().execute("SELECT 1")
            return True, "Connected successfully"
        except Exception as e:
            return False, str(e)

    # ── SF Objects ────────────────────────────────────────────

    def get_objects(self) -> List[Dict]:
        """SELECT all rows from raw.object_names and merge with locally-stored
        Migrate flags (Fabric SQL endpoint is read-only, no DML allowed)."""
        conn = self._fresh_conn()
        try:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT [ObjectName] FROM [raw].[object_names] ORDER BY [ObjectName]"
            )
            rows  = cursor.fetchall()
        finally:
            conn.close()
        flags = get_all_flags()
        return [
            {"name": r.ObjectName, "migrate": flags.get(r.ObjectName, False)}
            for r in rows
        ]

    def set_migrate_flag(self, object_name: str, migrate: bool) -> None:
        """Persist the Migrate flag locally (Fabric SQL endpoint is read-only)."""
        set_flag(object_name, migrate)

    # ── Object & Field Mapping ────────────────────────────────

    def _discover_raw_table(self, conn, pattern: str) -> Optional[str]:
        """Find a table in the raw schema matching a LIKE pattern.
        Caches the result so INFORMATION_SCHEMA is only queried once per pattern."""
        if pattern in self._table_cache:
            return self._table_cache[pattern]
        try:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
                "WHERE TABLE_SCHEMA = 'raw' AND TABLE_NAME LIKE ?",
                (pattern,)
            )
            row = cursor.fetchone()
            name = row[0] if row else None
        except Exception:
            name = None
        self._table_cache[pattern] = name
        return name

    def _get_all_sf_fields(self, conn, sf_object: str) -> List[Dict]:
        """Query the sf_to_dv_colum* or sf_object_meta* table for ALL Salesforce
        fields associated with sf_object.  Returns a list of field dicts using
        the same keys as field_mapping rows (sf_label, sf_api, sf_type,
        d365_name, d365_api, d365_type).  Returns [] if no table is found."""

        # Helper: map discovered column names (case-insensitive) to standard keys
        def _col(names: List[str], *fragments) -> Optional[str]:
            lower = [n.lower() for n in names]
            for frag in fragments:
                for i, n in enumerate(lower):
                    if frag in n:
                        return names[i]
            return None

        # Try sf_to_dv_columns first (has both SF + D365 sides), then sf_object_meta*
        for pat in ("sf_to_dv_colum%", "sf_object_meta%"):
            table = self._discover_raw_table(conn, pat)
            if not table:
                continue
            try:
                # Probe column names with a cheap query
                probe = conn.cursor()
                probe.execute(f"SELECT TOP 1 * FROM [raw].[{table}]")
                col_names = [d[0] for d in probe.description]

                # Identify the object-filter column
                obj_col = _col(col_names,
                               "salesforce_object", "sf_object", "objectname", "object_name",
                               "object")
                if not obj_col:
                    continue

                c = conn.cursor()
                c.execute(
                    f"SELECT * FROM [raw].[{table}] WHERE [{obj_col}] = ?",
                    (sf_object,)
                )
                rows = c.fetchall()
                if not rows:
                    continue

                # Map columns to standard field keys
                sf_label_col  = _col(col_names, "field_label", "sf_label", "fieldlabel",
                                     "salesforce_field_label", "label")
                sf_api_col    = _col(col_names, "salesforce_api", "sf_api", "sf_field",
                                     "salesforce_api_name", "fieldapiname", "api_name")
                sf_type_col   = _col(col_names, "salesforce_data_type", "sf_type",
                                     "salesforce_type", "datatype", "data_type", "type")
                d365_name_col = _col(col_names, "dynamics_field_name", "d365_name",
                                     "dv_field_name", "dynamics_name")
                d365_api_col  = _col(col_names, "dynamics_api_name", "d365_api",
                                     "dv_api_name", "dynamics_api")
                d365_type_col = _col(col_names, "dynamics_data_type", "d365_type",
                                     "dv_data_type", "dynamics_type")

                if not sf_api_col:
                    continue  # Can't identify SF fields without API name column

                def _val(row, col):
                    if not col:
                        return ""
                    try:
                        return getattr(row, col, None) or ""
                    except Exception:
                        return ""

                fields = []
                for row in rows:
                    sf_api = _val(row, sf_api_col)
                    if not sf_api:
                        continue
                    fields.append({
                        "sf_label":  _val(row, sf_label_col) or sf_api,
                        "sf_api":    sf_api,
                        "sf_type":   _val(row, sf_type_col),
                        "d365_name": _val(row, d365_name_col),
                        "d365_api":  _val(row, d365_api_col),
                        "d365_type": _val(row, d365_type_col),
                    })
                if fields:
                    return fields
            except Exception:
                continue

        return []

    def get_suggestions_for_object(self, sf_object: str) -> Dict:
        """Return ALL Salesforce fields for sf_object with their D365 mappings.

        Sources (merged, confirmed mapping wins over suggestion):
          1. raw.object_mapping + raw.field_mapping  — user-confirmed mappings
          2. raw.sf_to_dv_colum* or raw.sf_object_meta*  — full SF field catalogue

        Returns:
          {"fields": [...], "no_mapping": False, "dynamics_object": "..."}
          or {"fields": [...], "no_mapping": True, "publisher_prefix": "new_"}
        """
        conn = self._fresh_conn()
        try:
            cursor = conn.cursor()

            # 1. Confirmed mapping (object_mapping → field_mapping)
            cursor.execute(
                "SELECT [UID], [Dynamics_Object] FROM [raw].[object_mapping] "
                "WHERE [SalesForce_Object] = ?",
                (sf_object,)
            )
            obj_row = cursor.fetchone()

            dynamics_object  = obj_row.Dynamics_Object if obj_row else None
            uid              = obj_row.UID if obj_row else None
            confirmed_fields: Dict[str, Dict] = {}

            if uid:
                cursor2 = conn.cursor()
                cursor2.execute(
                    """
                    SELECT [Dynamics_Field_Name], [Dynamics_API_Name], [Dynamics_Data_Type],
                           [Salesforce_Field_Label], [Salesforce_API_Name], [Salesforce_Data_Type]
                    FROM   [raw].[field_mapping]
                    WHERE  [UID] = ?
                    """,
                    (uid,)
                )
                for r in cursor2.fetchall():
                    sf_api = r.Salesforce_API_Name or ""
                    if sf_api:
                        confirmed_fields[sf_api] = {
                            "sf_label":  r.Salesforce_Field_Label or sf_api,
                            "sf_api":    sf_api,
                            "sf_type":   r.Salesforce_Data_Type or "",
                            "d365_name": r.Dynamics_Field_Name or "",
                            "d365_api":  r.Dynamics_API_Name or "",
                            "d365_type": r.Dynamics_Data_Type or "",
                        }

            # 2. Full SF field catalogue from metadata tables
            all_suggestions = self._get_all_sf_fields(conn, sf_object)

        finally:
            conn.close()

        # 3. Merge — confirmed overrides suggestions for the same sf_api
        merged: Dict[str, Dict] = {f["sf_api"]: f for f in all_suggestions}
        merged.update(confirmed_fields)

        fields = [
            {
                **f,
                "edited_d365_name": f["d365_name"],
                "edited_d365_api":  f["d365_api"],
            }
            for f in sorted(merged.values(), key=lambda x: (x["sf_label"] or x["sf_api"]).lower())
        ]

        if not fields and not dynamics_object:
            return {"fields": [], "no_mapping": True, "publisher_prefix": "new_"}

        return {
            "fields":          fields,
            "no_mapping":      len(confirmed_fields) == 0,
            "dynamics_object": dynamics_object,
        }

    # ── OneLake File Uploads (Lakehouse SQL endpoint is read-only) ──
    #
    # Neither SQL DML nor the Load Table API work on this lakehouse
    # (schema-enabled + read-only SQL endpoint). Instead we upload JSON
    # config files to the OneLake Files area so the pipeline / notebook
    # can read them at runtime.

    def _get_onelake_token(self) -> str:
        """Acquire a token scoped to OneLake (Azure Storage)."""
        tenant_id            = self.config.get("TENANT_ID", "")
        fabric_client_id     = self.config.get("FABRIC_CLIENT_ID", "")
        fabric_client_secret = self.config.get("FABRIC_CLIENT_SECRET", "")

        app = msal.ConfidentialClientApplication(
            fabric_client_id,
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            client_credential=fabric_client_secret,
        )
        result = app.acquire_token_for_client(
            scopes=["https://storage.azure.com/.default"]
        )
        if "access_token" not in result:
            raise ValueError(
                f"Failed to acquire OneLake token: {result.get('error_description', result)}"
            )
        return result["access_token"]

    def _get_lakehouse_id(self) -> str:
        """Discover the Lakehouse Item ID by matching DATABASE_NAME."""
        workspace_id = self.config.get("FABRIC_WORKSPACE_ID", "")
        db_name      = self.config.get("DATABASE_NAME", "")
        token        = self._get_fabric_token()

        url = f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}/lakehouses"
        resp = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        resp.raise_for_status()

        for item in resp.json().get("value", []):
            if item.get("displayName", "").lower() == db_name.lower():
                return item["id"]

        available = [i["displayName"] for i in resp.json().get("value", [])]
        raise ValueError(f"Lakehouse '{db_name}' not found. Available: {available}")

    def _upload_to_onelake(self, relative_path: str, data: bytes) -> None:
        """Upload a file to the OneLake Files area via ADLS Gen2 / DFS REST API."""
        import time
        workspace_id = self.config.get("FABRIC_WORKSPACE_ID", "")
        lakehouse_id = self._get_lakehouse_id()
        base = f"https://onelake.dfs.fabric.microsoft.com/{workspace_id}/{lakehouse_id}/Files/{relative_path}"

        max_retries = 3
        for attempt in range(max_retries):
            try:
                # Refresh token in case it expired before the retry
                token = self._get_onelake_token()
                
                # Step 1: Create or overwrite the file resource
                requests.put(
                    f"{base}?resource=file&overwrite=true",
                    headers={"Authorization": f"Bearer {token}", "Content-Length": "0"},
                    timeout=30,
                ).raise_for_status()

                # Step 2: Append data
                requests.patch(
                    f"{base}?action=append&position=0",
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/octet-stream"},
                    data=data,
                    timeout=60,
                ).raise_for_status()

                # Step 3: Flush (finalize)
                requests.patch(
                    f"{base}?action=flush&position={len(data)}",
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=30,
                ).raise_for_status()

                # If successful, break out of retry loop
                break
            except Exception as e:
                if attempt == max_retries - 1:
                    raise  # re-raise the last exception if all retries fail
                print(f"[LakehouseService] ⚠️ OneLake upload failed (attempt {attempt + 1}/{max_retries}): {e}. Retrying...")
                time.sleep(2 ** attempt)  # Exponential backoff: 1s, 2s

    def _load_table(self, table_name: str, csv_relative_path: str,
                    mode: str = "Append") -> None:
        """Load a CSV from OneLake Files into a Lakehouse Delta table via REST API.

        table_name         – bare table name, no schema prefix (e.g. 'object_names')
        csv_relative_path  – path relative to the lakehouse Files root
        mode               – 'Overwrite' | 'Append'
        """
        import time
        workspace_id  = self.config.get("FABRIC_WORKSPACE_ID", "")
        lakehouse_id  = self._get_lakehouse_id()
        token         = self._get_fabric_token()

        url = (
            f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}"
            f"/lakehouses/{lakehouse_id}/tables/{table_name}/load"
        )
        payload = {
            "relativePath": f"Files/{csv_relative_path}",
            "pathType": "File",
            "mode": mode,
            "recursive": False,
            "formatOptions": {"format": "Csv", "header": True, "delimiter": ","},
        }
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
            timeout=30,
        )

        if resp.status_code == 202:
            status_url  = resp.headers.get("Location", "")
            retry_after = int(resp.headers.get("Retry-After", 2))
            for _ in range(30):
                time.sleep(retry_after)
                sr = requests.get(
                    status_url,
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=15,
                )
                if not sr.ok:
                    return  # can't poll — give up gracefully
                data  = sr.json()
                state = data.get("status", "")
                if state == "Succeeded":
                    return
                if state in ("Failed", "Cancelled", "Canceled"):
                    err_msg = (data.get("error") or {}).get("message", state)
                    print(f"[LakehouseService] Load table '{table_name}' FAILED: {err_msg}")
                    print(f"[LakehouseService] Full response: {data}")
                    raise ValueError(f"Load table '{table_name}' failed: {err_msg}")
                retry_after = 2
        elif not resp.ok:
            try:
                body = resp.json()
            except Exception:
                body = {}
            print(f"[LakehouseService] Load table '{table_name}' HTTP error ({resp.status_code}): {body}")
            raise ValueError(
                f"Load table '{table_name}' error ({resp.status_code}): "
                f"{body.get('message') or body.get('detail') or resp.text[:300]}"
            )

    def confirm_object_flags(self) -> Dict:
        """Push locally-stored migrate flags to raw.object_names by writing
        directly to the Delta table in OneLake via the `deltalake` library.

        The Lakehouse SQL analytics endpoint is read-only (no DML), and the
        Load Table API is not supported for schema-enabled lakehouses.
        `write_deltalake` bypasses both and writes Parquet + Delta log directly
        to OneLake storage via the ADLS Gen2 (DFS) API."""
        import pyarrow as pa
        from deltalake import write_deltalake

        flags = get_all_flags()
        if not flags:
            return {"status": "nothing_to_confirm", "count": 0}

        # 1. JSON upload to OneLake Files (pipeline / notebook compatibility)
        #    Non-fatal — the important write is the Delta table below.
        try:
            self._upload_to_onelake(
                "config/migrate_flags.json",
                json.dumps(flags, indent=2).encode("utf-8"),
            )
        except Exception as e:
            print(f"[LakehouseService] ⚠️ JSON upload to OneLake failed (non-fatal): {e}")

        # 2. Read ALL objects from SQL so we produce a complete replacement table
        conn = self._fresh_conn()
        try:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT [ObjectName] FROM [raw].[object_names] ORDER BY [ObjectName]"
            )
            all_objects = [r.ObjectName for r in cursor.fetchall()]
        finally:
            conn.close()

        # 3. Build a PyArrow table with ObjectName + Migrate
        object_names = []
        migrate_values = []
        for obj_name in all_objects:
            object_names.append(obj_name)
            migrate_values.append(flags.get(obj_name, False))

        arrow_table = pa.table({
            "ObjectName": pa.array(object_names, type=pa.string()),
            "Migrate":    pa.array(migrate_values, type=pa.bool_()),
        })

        # 4. Write directly to Delta table in OneLake
        workspace_id = self.config.get("FABRIC_WORKSPACE_ID", "")
        lakehouse_id = self._get_lakehouse_id()
        table_uri = (
            f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com"
            f"/{lakehouse_id}/Tables/raw/object_names"
        )
        storage_options = {
            "azure_storage_account_name": "onelake",
            "azure_storage_client_id":     self.config.get("FABRIC_CLIENT_ID", ""),
            "azure_storage_client_secret": self.config.get("FABRIC_CLIENT_SECRET", ""),
            "azure_storage_tenant_id":     self.config.get("TENANT_ID", ""),
            "azure_storage_use_fabric_endpoint": "true",
        }

        print(f"[LakehouseService] Writing {len(all_objects)} rows to Delta table via OneLake…")
        write_deltalake(
            table_uri,
            arrow_table,
            mode="overwrite",
            schema_mode="overwrite",
            storage_options=storage_options,
        )

        selected_count = sum(1 for v in flags.values() if v)
        print(f"[LakehouseService] ✅ Delta table raw.object_names overwritten — {selected_count} selected")

        return {
            "status": "confirmed",
            "count": selected_count,
            "updated_rows": len(all_objects),
        }

    def save_mapping_to_lakehouse(self, sf_object: str, d365_entity: str,
                                  field_rows: List[Dict]) -> Dict:
        """Upload mapping data to raw.object_mapping / raw.field_mapping Delta
        tables directly via write_deltalake (schema-enabled Lakehouse safe)."""
        import uuid
        import pyarrow as pa
        from deltalake import write_deltalake

        uid = str(uuid.uuid4())

        fields = [
            {
                "d365_name": r.get("edited_d365_name", r.get("d365_name", "")),
                "d365_api":  r.get("edited_d365_api",  r.get("d365_api",  "")),
                "d365_type": r.get("d365_type", ""),
                "sf_label":  r.get("sf_label",  ""),
                "sf_api":    r.get("sf_api",    ""),
                "sf_type":   r.get("sf_type",   ""),
            }
            for r in field_rows
        ]

        # ── JSON upload to OneLake Files (non-fatal) ──────────────────────
        mapping_data = {
            "uid": uid, "sf_object": sf_object,
            "d365_entity": d365_entity, "fields": fields,
        }
        safe_name = sf_object.replace(" ", "_").replace("/", "_")
        try:
            self._upload_to_onelake(
                f"config/mappings/{safe_name}.json",
                json.dumps(mapping_data, indent=2).encode("utf-8"),
            )
        except Exception as e:
            print(f"[LakehouseService] ⚠️ JSON upload failed (non-fatal): {e}")

        # ── Delta write setup ─────────────────────────────────────────────
        workspace_id = self.config.get("FABRIC_WORKSPACE_ID", "")
        lakehouse_id = self._get_lakehouse_id()
        storage_options = {
            "azure_storage_account_name": "onelake",
            "azure_storage_client_id":     self.config.get("FABRIC_CLIENT_ID", ""),
            "azure_storage_client_secret": self.config.get("FABRIC_CLIENT_SECRET", ""),
            "azure_storage_tenant_id":     self.config.get("TENANT_ID", ""),
            "azure_storage_use_fabric_endpoint": "true",
        }

        # ── Read existing object_mapping rows, merge, overwrite ───────────
        conn = self._fresh_conn()
        try:
            cursor = conn.cursor()

            # Object mapping: read existing, drop this sf_object, add new row
            existing_om = []
            try:
                cursor.execute("SELECT UID, SalesForce_Object, Dynamics_Object FROM raw.object_mapping")
                existing_om = [
                    {"UID": row[0], "SalesForce_Object": row[1], "Dynamics_Object": row[2]}
                    for row in cursor.fetchall()
                ]
            except Exception:
                pass  # table may not exist yet

            # Remove old entry for this sf_object
            merged_om = [r for r in existing_om if r["SalesForce_Object"] != sf_object]
            merged_om.append({"UID": uid, "SalesForce_Object": sf_object, "Dynamics_Object": d365_entity})

            om_table = pa.table({
                "UID":               pa.array([r["UID"] for r in merged_om], type=pa.string()),
                "SalesForce_Object": pa.array([r["SalesForce_Object"] for r in merged_om], type=pa.string()),
                "Dynamics_Object":   pa.array([r["Dynamics_Object"] for r in merged_om], type=pa.string()),
            })

            om_uri = (
                f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com"
                f"/{lakehouse_id}/Tables/raw/object_mapping"
            )
            print(f"[LakehouseService] Writing {len(merged_om)} rows to raw.object_mapping…")
            write_deltalake(om_uri, om_table, mode="overwrite", schema_mode="overwrite",
                            storage_options=storage_options)
            print(f"[LakehouseService] ✅ raw.object_mapping updated")

            # ── Field mapping: read existing, drop this UID-prefix, add new ──
            existing_fm = []
            try:
                cursor.execute(
                    "SELECT UID, Dynamics_Field_Name, Dynamics_API_Name, Dynamics_Data_Type, "
                    "Salesforce_Field_Label, Salesforce_API_Name, Salesforce_Data_Type "
                    "FROM raw.field_mapping"
                )
                existing_fm = [
                    {
                        "UID": row[0], "Dynamics_Field_Name": row[1],
                        "Dynamics_API_Name": row[2], "Dynamics_Data_Type": row[3],
                        "Salesforce_Field_Label": row[4], "Salesforce_API_Name": row[5],
                        "Salesforce_Data_Type": row[6],
                    }
                    for row in cursor.fetchall()
                ]
            except Exception:
                pass

            # Remove old entries for this sf_object's UID (find UID from object_mapping)
            old_uids = {r["UID"] for r in existing_om if r["SalesForce_Object"] == sf_object}
            merged_fm = [r for r in existing_fm if r["UID"] not in old_uids]
            for f in fields:
                merged_fm.append({
                    "UID": uid,
                    "Dynamics_Field_Name": f["d365_name"],
                    "Dynamics_API_Name": f["d365_api"],
                    "Dynamics_Data_Type": f["d365_type"],
                    "Salesforce_Field_Label": f["sf_label"],
                    "Salesforce_API_Name": f["sf_api"],
                    "Salesforce_Data_Type": f["sf_type"],
                })

            fm_table = pa.table({
                "UID":                    pa.array([r["UID"] for r in merged_fm], type=pa.string()),
                "Dynamics_Field_Name":    pa.array([r["Dynamics_Field_Name"] for r in merged_fm], type=pa.string()),
                "Dynamics_API_Name":      pa.array([r["Dynamics_API_Name"] for r in merged_fm], type=pa.string()),
                "Dynamics_Data_Type":     pa.array([r["Dynamics_Data_Type"] for r in merged_fm], type=pa.string()),
                "Salesforce_Field_Label": pa.array([r["Salesforce_Field_Label"] for r in merged_fm], type=pa.string()),
                "Salesforce_API_Name":    pa.array([r["Salesforce_API_Name"] for r in merged_fm], type=pa.string()),
                "Salesforce_Data_Type":   pa.array([r["Salesforce_Data_Type"] for r in merged_fm], type=pa.string()),
            })

            fm_uri = (
                f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com"
                f"/{lakehouse_id}/Tables/raw/field_mapping"
            )
            print(f"[LakehouseService] Writing {len(merged_fm)} rows to raw.field_mapping…")
            write_deltalake(fm_uri, fm_table, mode="overwrite", schema_mode="overwrite",
                            storage_options=storage_options)
            print(f"[LakehouseService] ✅ raw.field_mapping updated")

        finally:
            conn.close()

        return {
            "status": "saved", "uid": uid,
            "fields_saved": len(fields),
            "location": f"Files/config/mappings/{safe_name}.json",
        }

    def save_bulk_mappings_to_lakehouse(self, mappings: List[Dict], background_tasks) -> Dict:
        """Save all confirmed object mappings in a single Delta write.

        ``mappings`` is a list of dicts:
          [{"sf_object": str, "d365_entity": str, "fields": [...]}, ...]

        Reads existing rows ONCE, merges all incoming objects, then writes
        both raw.object_mapping and raw.field_mapping exactly once each.
        """
        import uuid
        import pyarrow as pa
        from deltalake import write_deltalake

        workspace_id = self.config.get("FABRIC_WORKSPACE_ID", "")
        lakehouse_id = self._get_lakehouse_id()
        storage_options = {
            "azure_storage_account_name": "onelake",
            "azure_storage_client_id":     self.config.get("FABRIC_CLIENT_ID", ""),
            "azure_storage_client_secret": self.config.get("FABRIC_CLIENT_SECRET", ""),
            "azure_storage_tenant_id":     self.config.get("TENANT_ID", ""),
            "azure_storage_use_fabric_endpoint": "true",
        }

        # Assign a UID per sf_object and normalise field rows
        prepared = []
        for m in mappings:
            uid = str(uuid.uuid4())
            fields = [
                {
                    "d365_name": r.get("edited_d365_name", r.get("d365_name", "")),
                    "d365_api":  r.get("edited_d365_api",  r.get("d365_api",  "")),
                    "d365_type": r.get("d365_type", ""),
                    "sf_label":  r.get("sf_label",  ""),
                    "sf_api":    r.get("sf_api",    ""),
                    "sf_type":   r.get("sf_type",   ""),
                }
                for r in (m.get("fields") or [])
            ]
            prepared.append({
                "uid": uid,
                "sf_object": m["sf_object"],
                "d365_entity": m["d365_entity"],
                "fields": fields,
            })

        # Upload JSON snapshots to OneLake Files (non-fatal)
        def upload_json_snapshots_bg():
            for p in prepared:
                safe_name = p["sf_object"].replace(" ", "_").replace("/", "_")
                try:
                    self._upload_to_onelake(
                        f"config/mappings/{safe_name}.json",
                        json.dumps({
                            "uid": p["uid"], "sf_object": p["sf_object"],
                            "d365_entity": p["d365_entity"], "fields": p["fields"],
                        }, indent=2).encode("utf-8"),
                    )
                except Exception as e:
                    print(f"[LakehouseService] ⚠️ JSON upload failed for {p['sf_object']} (non-fatal): {e}")

        if background_tasks:
            background_tasks.add_task(upload_json_snapshots_bg)
        else:
            upload_json_snapshots_bg()

        incoming_sf_objects = {p["sf_object"] for p in prepared}

        from deltalake import DeltaTable
        from concurrent.futures import ThreadPoolExecutor

        om_uri = (
            f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com"
            f"/{lakehouse_id}/Tables/raw/object_mapping"
        )
        fm_uri = (
            f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com"
            f"/{lakehouse_id}/Tables/raw/field_mapping"
        )

        def _read_table(uri):
            try:
                return DeltaTable(uri, storage_options=storage_options).to_pyarrow_table().to_pylist()
            except Exception:
                return []

        try:
            # ── Phase 1: read both tables in parallel ──
            print("[LakehouseService] Reading object_mapping + field_mapping in parallel…")
            with ThreadPoolExecutor(max_workers=2) as pool:
                fut_om = pool.submit(_read_table, om_uri)
                fut_fm = pool.submit(_read_table, fm_uri)
                existing_om = fut_om.result()
                existing_fm = fut_fm.result()

            # ── Merge object_mapping ──
            old_uids = {
                r.get("UID") for r in existing_om
                if r.get("SalesForce_Object") in incoming_sf_objects
            }
            merged_om = [r for r in existing_om if r.get("SalesForce_Object") not in incoming_sf_objects]
            for p in prepared:
                merged_om.append({
                    "UID": p["uid"],
                    "SalesForce_Object": p["sf_object"],
                    "Dynamics_Object": p["d365_entity"],
                })

            om_table = pa.table({
                "UID":               pa.array([r.get("UID", "") for r in merged_om], type=pa.string()),
                "SalesForce_Object": pa.array([r.get("SalesForce_Object", "") for r in merged_om], type=pa.string()),
                "Dynamics_Object":   pa.array([r.get("Dynamics_Object", "") for r in merged_om], type=pa.string()),
            })

            # ── Merge field_mapping ──
            merged_fm = [r for r in existing_fm if r.get("UID") not in old_uids]
            for p in prepared:
                for f in p["fields"]:
                    merged_fm.append({
                        "UID": p["uid"],
                        "Dynamics_Field_Name":    f["d365_name"],
                        "Dynamics_API_Name":      f["d365_api"],
                        "Dynamics_Data_Type":     f["d365_type"],
                        "Salesforce_Field_Label": f["sf_label"],
                        "Salesforce_API_Name":    f["sf_api"],
                        "Salesforce_Data_Type":   f["sf_type"],
                    })

            fm_table = pa.table({
                "UID":                    pa.array([r.get("UID", "") for r in merged_fm], type=pa.string()),
                "Dynamics_Field_Name":    pa.array([r.get("Dynamics_Field_Name", "") for r in merged_fm], type=pa.string()),
                "Dynamics_API_Name":      pa.array([r.get("Dynamics_API_Name", "") for r in merged_fm], type=pa.string()),
                "Dynamics_Data_Type":     pa.array([r.get("Dynamics_Data_Type", "") for r in merged_fm], type=pa.string()),
                "Salesforce_Field_Label": pa.array([r.get("Salesforce_Field_Label", "") for r in merged_fm], type=pa.string()),
                "Salesforce_API_Name":    pa.array([r.get("Salesforce_API_Name", "") for r in merged_fm], type=pa.string()),
                "Salesforce_Data_Type":   pa.array([r.get("Salesforce_Data_Type", "") for r in merged_fm], type=pa.string()),
            })

            # ── Phase 2: write both tables in parallel ──
            print(f"[LakehouseService] Writing {len(merged_om)} OM rows + {len(merged_fm)} FM rows in parallel…")
            def _write_om():
                write_deltalake(om_uri, om_table, mode="overwrite", schema_mode="overwrite",
                                storage_options=storage_options)
                print("[LakehouseService] ✅ raw.object_mapping updated")

            def _write_fm():
                write_deltalake(fm_uri, fm_table, mode="overwrite", schema_mode="overwrite",
                                storage_options=storage_options)
                print("[LakehouseService] ✅ raw.field_mapping updated")

            with ThreadPoolExecutor(max_workers=2) as pool:
                fut_wom = pool.submit(_write_om)
                fut_wfm = pool.submit(_write_fm)
                fut_wom.result()
                fut_wfm.result()

        except Exception as e:
            print(f"[LakehouseService] ⚠️ Bulk delta write failed: {e}")
            raise

        return {
            "status": "saved",
            "objects_saved": len(prepared),
            "total_fields_saved": sum(len(p["fields"]) for p in prepared),
            "uids": {p["sf_object"]: p["uid"] for p in prepared},
        }


    # ── Fabric Pipeline ───────────────────────────────────────

    def _get_fabric_token(self) -> str:
        """Acquire a Fabric service-principal token via MSAL (client-credentials flow)."""
        tenant_id            = self.config.get("TENANT_ID", "")
        fabric_client_id     = self.config.get("FABRIC_CLIENT_ID", "")
        fabric_client_secret = self.config.get("FABRIC_CLIENT_SECRET", "")

        app = msal.ConfidentialClientApplication(
            fabric_client_id,
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            client_credential=fabric_client_secret,
        )
        result = app.acquire_token_for_client(
            scopes=["https://api.fabric.microsoft.com/.default"]
        )
        if "access_token" not in result:
            raise ValueError(
                f"Failed to acquire Fabric token: {result.get('error_description', result)}"
            )
        return result["access_token"]

    def trigger_pipeline(self, pipeline_type: str = "data") -> Dict:
        """
        Trigger the Fabric Data Pipeline via REST API.
        `pipeline_type` can be 'schema' or 'data'.
        Returns {"job_id": "...", "status": "Accepted", "pipeline_id": "..."} on success.
        """
        workspace_id = self.config.get("FABRIC_WORKSPACE_ID", "")
        if pipeline_type == "schema":
            pipeline_id = self.config.get("SCHEMA_PIPELINE_ID", "")
        else:
            pipeline_id = self.config.get("DATA_PIPELINE_ID", "")

        if not pipeline_id:
            raise ValueError(f"Missing Pipeline ID for type: {pipeline_type}")

        token = self._get_fabric_token()
        url   = (
            f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}"
            f"/items/{pipeline_id}/jobs/instances?jobType=Pipeline"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type":  "application/json",
        }
        resp = requests.post(url, headers=headers, json={}, timeout=30)

        # Fabric returns 202 Accepted — anything else is an error
        if not resp.ok:
            try:
                body = resp.json()
            except Exception:
                body = {}

            error_code    = body.get("errorCode") or body.get("ErrorCode", "")
            error_message = body.get("message") or body.get("ErrorMessage", resp.text)

            # UserAccessTokenException: pipeline is configured to run as a user,
            # not as a service principal. Must be changed in the Fabric portal.
            if error_code == "UserAccessTokenException" or "user token" in error_message.lower():
                raise ValueError(
                    "Fabric pipeline requires user delegation tokens. "
                    "To fix: open the pipeline in the Fabric portal → Settings → "
                    "set 'Run on behalf of' to your Service Principal, then retry."
                )

            raise ValueError(f"Fabric API error ({resp.status_code}): {error_message}")

        location    = resp.headers.get("Location", "")
        retry_after = int(resp.headers.get("Retry-After", 5))
        job_id      = location.split("/")[-1] if location else "unknown"
        return {
            "job_id":      job_id,
            "status":      "Accepted",
            "status_url":  location,
            "retry_after": retry_after,   # seconds the client should wait before first poll
            "pipeline_id": pipeline_id,   # return the exact pipeline triggered for history tracking
        }


    def cancel_pipeline(self, job_id: str, pipeline_id: str) -> Dict:
        """
        Request cancellation of a running Fabric pipeline job.
        POST .../jobs/instances/{jobId}/cancel
        Fabric returns 200 with an empty body on acceptance.
        """
        workspace_id = self.config.get("FABRIC_WORKSPACE_ID", "")

        if not pipeline_id:
            raise ValueError("pipeline_id is required to cancel a job")

        token   = self._get_fabric_token()
        url     = (
            f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}"
            f"/items/{pipeline_id}/jobs/instances/{job_id}/cancel"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type":  "application/json",
        }
        resp = requests.post(url, headers=headers, json={}, timeout=15)
        if not resp.ok:
            try:
                body = resp.json()
            except Exception:
                body = {}
            raise ValueError(
                f"Cancel failed ({resp.status_code}): "
                f"{body.get('message') or body.get('ErrorMessage', resp.text)}"
            )
        return {"job_id": job_id, "status": "CancelRequested"}

    def get_pipeline_status(self, job_id: str, pipeline_id: str) -> Dict:
        """Poll the pipeline job status."""
        workspace_id = self.config.get("FABRIC_WORKSPACE_ID", "")

        if not pipeline_id:
            raise ValueError("pipeline_id is required to poll a job")

        token  = self._get_fabric_token()
        url    = (
            f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}"
            f"/items/{pipeline_id}/jobs/instances/{job_id}"
        )
        headers = {"Authorization": f"Bearer {token}"}
        resp    = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        data    = resp.json()
        raw_status = data.get("status", "Unknown")
        # Normalise Fabric terminal states: "Completed" is an alias for "Succeeded"
        # and "Canceled" (one 'l') is how Fabric spells it.
        TERMINAL = {"Succeeded", "Failed", "Cancelled", "Canceled", "Completed"}
        normalised = "Succeeded" if raw_status == "Completed" else raw_status
        return {
            "job_id":         job_id,
            "status":         normalised,
            "is_terminal":    normalised in TERMINAL,
            "start_time":     data.get("startTimeUtc"),
            "end_time":       data.get("endTimeUtc"),
            "failure_reason": data.get("failureReason"),
        }

    def get_activity_runs(self, job_id: str, pipeline_id: str) -> List[Dict]:
        """Query per-activity run details for a pipeline job.

        POST /v1/workspaces/{ws}/datapipelines/pipelineruns/{job_id}/queryactivityruns

        Returns a list of activity dicts sorted by start time (ASC).
        """
        from datetime import datetime, timezone

        workspace_id = self.config.get("FABRIC_WORKSPACE_ID", "")
        
        if not pipeline_id:
            raise ValueError("pipeline_id is required to get activity runs")
            
        token = self._get_fabric_token()

        url = (
            f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}"
            f"/datapipelines/pipelineruns/{job_id}/queryactivityruns"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        body = {
            "filters": [],
            "orderBy": [{"orderBy": "ActivityRunStart", "order": "ASC"}],
            "lastUpdatedAfter": "2020-01-01T00:00:00Z",
            "lastUpdatedBefore": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

        resp = requests.post(url, headers=headers, json=body, timeout=15)
        if not resp.ok:
            print(f"[LakehouseService] queryactivityruns failed ({resp.status_code}): {resp.text[:300]}")
            return []

        data = resp.json()
        raw_activities = data.get("value", data) if isinstance(data, dict) else data
        if not isinstance(raw_activities, list):
            raw_activities = []

        activities = []
        for a in raw_activities:
            start = a.get("activityRunStart") or a.get("ActivityRunStart")
            end = a.get("activityRunEnd") or a.get("ActivityRunEnd")
            status = a.get("status") or a.get("Status") or "Queued"

            # Calculate duration in seconds
            duration_sec = None
            if start:
                try:
                    t_start = datetime.fromisoformat(start.replace("Z", "+00:00"))
                    if end:
                        t_end = datetime.fromisoformat(end.replace("Z", "+00:00"))
                    else:
                        t_end = datetime.now(timezone.utc)
                    duration_sec = round((t_end - t_start).total_seconds())
                except Exception:
                    pass

            error_msg = None
            err_obj = a.get("error") or a.get("Error")
            if err_obj:
                if isinstance(err_obj, dict):
                    error_msg = err_obj.get("message") or err_obj.get("Message")
                else:
                    error_msg = str(err_obj)

            activities.append({
                "name": a.get("activityName") or a.get("ActivityName") or "Unknown",
                "type": a.get("activityType") or a.get("ActivityType") or "",
                "status": status,
                "start_time": start,
                "end_time": end,
                "duration_sec": duration_sec,
                "error": error_msg,
            })

        return activities
