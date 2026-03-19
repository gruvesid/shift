"""
Shift router — Org connection management for the Metadata Migration pipeline.

Salesforce: OAuth2 Authorization Code + PKCE (popup flow, same as GAI Cursor).
Dynamics 365: Direct HTTP client_credentials to Azure AD + WhoAmI validation.
"""

import base64
import hashlib
import json
import os
import secrets
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .database import get_db
from .models.connections import Connection
from .models.org_metadata import OrgMetadata
from .models.field_mapping import FieldMapping
from .models.rulebook import Rulebook, DEFAULT_RULEBOOKS
from .services.auth_service import get_current_user

router = APIRouter(prefix="/shift", tags=["shift"])

# ── In-memory PKCE store (state → {verifier, org_id, created_at}) ────────────
# For production use Redis instead.
_pkce_store: dict = {}
_PKCE_TTL = 600  # 10 minutes


def _cleanup_pkce():
    now = time.time()
    expired = [k for k, v in _pkce_store.items() if now - v["created_at"] > _PKCE_TTL]
    for k in expired:
        del _pkce_store[k]


def _generate_pkce():
    verifier = secrets.token_urlsafe(32)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    return verifier, challenge


# ── Pydantic Schemas ──────────────────────────────────────────────────────────

class OrgCreate(BaseModel):
    name: str
    sf_client_id: str
    sf_client_secret: Optional[str] = ""
    sf_instance_url: str
    target_crm: str = "dynamics365"
    d365_tenant_id: Optional[str] = None
    d365_client_id: Optional[str] = None
    d365_client_secret: Optional[str] = None
    d365_environment_url: Optional[str] = None
    power_platform_env_id: Optional[str] = None   # GUID from make.powerautomate.com URL
    sf_status: str = "pending"
    d365_status: str = "pending"
    # Fabric Data Lake (optional)
    fabric_enabled: bool = False
    fabric_tenant_id: Optional[str] = None
    fabric_service_principal_id: Optional[str] = None
    fabric_service_principal_secret: Optional[str] = None
    fabric_server: Optional[str] = None
    fabric_database: Optional[str] = None
    fabric_status: str = "pending"


class SalesforceAuthorizeRequest(BaseModel):
    org_id: int
    client_id: str
    instance_url: str
    client_secret: Optional[str] = ""


class D365TestRequest(BaseModel):
    org_id: Optional[int] = None   # if provided, updates DB status on success
    tenant_id: str
    client_id: str
    client_secret: str
    environment_url: str


class FabricTestRequest(BaseModel):
    tenant_id: str
    service_principal_id: str
    service_principal_secret: str
    server: str
    database: str


class UpdateStatusRequest(BaseModel):
    sf_status: Optional[str] = None
    d365_status: Optional[str] = None


# ── Shared helpers ────────────────────────────────────────────────────────────

def _backend_url() -> str:
    return os.environ.get("BACKEND_URL", "http://localhost:8000").rstrip("/")

def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL", "http://localhost:3000").rstrip("/")


def _derive_overall_status(sf_status: str, d365_status: str) -> str:
    if sf_status == "connected" and d365_status == "connected":
        return "connected"
    if sf_status == "connected":
        return "partial"
    if sf_status == "error":
        return "needs_reauth"
    return "pending"


def _org_to_dict(org: Connection) -> dict:
    cfg = json.loads(org.config_json or "{}")
    sf_status = cfg.get("sf_status", "pending")
    d365_status = cfg.get("d365_status", "pending")
    return {
        "id": org.id,
        "name": org.name,
        "sf_instance_url": cfg.get("sf_instance_url", ""),
        "sf_username": cfg.get("sf_username", ""),
        "target_crm": cfg.get("target_crm", "dynamics365"),
        "sf_status": sf_status,
        "d365_status": d365_status,
        "overall_status": _derive_overall_status(sf_status, d365_status),
        "metadata_sync_at": cfg.get("metadata_sync_at"),
        "data_sync_at": cfg.get("data_sync_at"),
        "created_at": org.created_at.isoformat() if org.created_at else None,
    }


def _oauth_result_html(success: bool, error_message: str = None) -> str:
    """Returns an HTML page that sends postMessage to opener and closes itself."""
    data = json.dumps({
        "type": "sf-oauth-result",
        "success": success,
        "error": error_message,
    })
    msg = "Connected successfully! This window will close..." if success else f"Connection failed: {error_message or 'Unknown error'}"
    fe = _frontend_url()
    return f"""<!DOCTYPE html>
<html><head><title>Salesforce OAuth</title>
<style>body{{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#f5f5f5}}</style>
</head><body>
  <p>{msg}</p>
  <script>
    (function(){{
      var data = {data};
      if (window.opener) {{
        window.opener.postMessage(data, '{fe}');
        setTimeout(function(){{ window.close(); }}, 1200);
      }} else {{
        window.location.href = '{fe}';
      }}
    }})();
  </script>
</body></html>"""


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
def get_stats(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    orgs = db.query(Connection).filter(Connection.type == "org", Connection.user_id == current_user.id).all()
    connected = sum(
        1 for o in orgs
        if json.loads(o.config_json or "{}").get("sf_status") == "connected"
    )
    metadata_extracted = sum(
        1 for o in orgs
        if json.loads(o.config_json or "{}").get("metadata_sync_at") is not None
    )
    return {
        "connected_orgs": connected,
        "total_orgs": len(orgs),
        "metadata_extracted": metadata_extracted,
        "agent_chat_sessions": 0,
    }


# ── Connection CRUD ───────────────────────────────────────────────────────────

@router.get("/connections")
def list_connections(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    orgs = (
        db.query(Connection)
        .filter(Connection.type == "org", Connection.user_id == current_user.id)
        .order_by(Connection.created_at.desc())
        .all()
    )
    return [_org_to_dict(o) for o in orgs]


@router.post("/connections", status_code=201)
def create_connection(payload: OrgCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """Save a new org connection. Called when user first clicks 'Authorize Salesforce'."""
    if db.query(Connection).filter(
        Connection.name == payload.name, Connection.type == "org"
    ).first():
        raise HTTPException(status_code=409, detail=f"Connection '{payload.name}' already exists.")

    cfg = {
        "sf_client_id": payload.sf_client_id,
        "sf_client_secret": payload.sf_client_secret,
        "sf_instance_url": payload.sf_instance_url.rstrip("/"),
        "target_crm": payload.target_crm,
        "d365_tenant_id": payload.d365_tenant_id,
        "d365_client_id": payload.d365_client_id,
        "d365_client_secret": payload.d365_client_secret,
        "d365_environment_url": (payload.d365_environment_url or "").rstrip("/"),
        "power_platform_env_id": (payload.power_platform_env_id or "").strip(),
        "sf_status": "pending",
        "d365_status": "pending",
        "metadata_sync_at": None,
        "data_sync_at": None,
        # Fabric Data Lake
        "fabric_enabled": payload.fabric_enabled,
        "fabric_tenant_id": payload.fabric_tenant_id,
        "fabric_service_principal_id": payload.fabric_service_principal_id,
        "fabric_service_principal_secret": payload.fabric_service_principal_secret,
        "fabric_server": payload.fabric_server,
        "fabric_database": payload.fabric_database,
        "fabric_status": payload.fabric_status if payload.fabric_enabled else "pending",
    }

    org = Connection(
        name=payload.name,
        type="org",
        config_json=json.dumps(cfg),
        last_test_status="pending",
        last_tested_at=datetime.now(timezone.utc),
        user_id=current_user.id,
    )
    db.add(org)
    db.commit()
    db.refresh(org)
    return _org_to_dict(org)


@router.get("/connections/{connection_id}")
def get_connection(connection_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org", Connection.user_id == current_user.id
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")
    return _org_to_dict(org)


@router.patch("/connections/{connection_id}/status")
def update_connection_status(
    connection_id: int,
    payload: UpdateStatusRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org", Connection.user_id == current_user.id
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    cfg = json.loads(org.config_json or "{}")
    if payload.sf_status is not None:
        cfg["sf_status"] = payload.sf_status
    if payload.d365_status is not None:
        cfg["d365_status"] = payload.d365_status

    org.config_json = json.dumps(cfg)
    org.last_test_status = _derive_overall_status(
        cfg.get("sf_status", "pending"), cfg.get("d365_status", "pending")
    )
    org.last_tested_at = datetime.now(timezone.utc)
    db.commit()
    return _org_to_dict(org)


@router.get("/connections/{connection_id}/config")
def get_connection_config(connection_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """Return full config including credentials — used to pre-populate the edit modal."""
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org", Connection.user_id == current_user.id
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")
    cfg = json.loads(org.config_json or "{}")
    return {
        "id": org.id,
        "name": org.name,
        "sf_client_id": cfg.get("sf_client_id", ""),
        "sf_client_secret": cfg.get("sf_client_secret", ""),
        "sf_instance_url": cfg.get("sf_instance_url", ""),
        "sf_status": cfg.get("sf_status", "pending"),
        "target_crm": cfg.get("target_crm", "dynamics365"),
        "d365_tenant_id": cfg.get("d365_tenant_id", ""),
        "d365_client_id": cfg.get("d365_client_id", ""),
        "d365_client_secret": cfg.get("d365_client_secret", ""),
        "d365_environment_url": cfg.get("d365_environment_url", ""),
        "power_platform_env_id": cfg.get("power_platform_env_id", ""),
        "d365_status": cfg.get("d365_status", "pending"),
        "fabric_enabled": cfg.get("fabric_enabled", False),
        "fabric_tenant_id": cfg.get("fabric_tenant_id", ""),
        "fabric_service_principal_id": cfg.get("fabric_service_principal_id", ""),
        "fabric_service_principal_secret": cfg.get("fabric_service_principal_secret", ""),
        "fabric_server": cfg.get("fabric_server", ""),
        "fabric_database": cfg.get("fabric_database", ""),
        "fabric_status": cfg.get("fabric_status", "pending"),
    }


@router.put("/connections/{connection_id}")
def update_connection(connection_id: int, payload: OrgCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """Update an existing org connection — used by the Edit modal."""
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org", Connection.user_id == current_user.id
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    # Check name uniqueness only if name changed
    if org.name != payload.name:
        existing = db.query(Connection).filter(
            Connection.name == payload.name, Connection.type == "org", Connection.user_id == current_user.id
        ).first()
        if existing:
            raise HTTPException(status_code=409, detail=f"Connection '{payload.name}' already exists.")

    cfg = json.loads(org.config_json or "{}")
    cfg.update({
        "sf_client_id": payload.sf_client_id,
        "sf_client_secret": payload.sf_client_secret,
        "sf_instance_url": payload.sf_instance_url.rstrip("/"),
        "target_crm": payload.target_crm,
        "d365_tenant_id": payload.d365_tenant_id,
        "d365_client_id": payload.d365_client_id,
        "d365_client_secret": payload.d365_client_secret,
        "d365_environment_url": (payload.d365_environment_url or "").rstrip("/"),
        "power_platform_env_id": (payload.power_platform_env_id or "").strip(),
        "fabric_enabled": payload.fabric_enabled,
        "fabric_tenant_id": payload.fabric_tenant_id,
        "fabric_service_principal_id": payload.fabric_service_principal_id,
        "fabric_service_principal_secret": payload.fabric_service_principal_secret,
        "fabric_server": payload.fabric_server,
        "fabric_database": payload.fabric_database,
        "fabric_status": payload.fabric_status if payload.fabric_enabled else cfg.get("fabric_status", "pending"),
    })
    # Only overwrite connection statuses if explicitly passed (non-default)
    if payload.sf_status != "pending":
        cfg["sf_status"] = payload.sf_status
    if payload.d365_status != "pending":
        cfg["d365_status"] = payload.d365_status

    org.name = payload.name
    org.config_json = json.dumps(cfg)
    org.last_test_status = _derive_overall_status(cfg.get("sf_status", "pending"), cfg.get("d365_status", "pending"))
    org.last_tested_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(org)
    return _org_to_dict(org)


@router.delete("/connections/{connection_id}")
def delete_connection(connection_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org", Connection.user_id == current_user.id
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")
    db.delete(org)
    db.commit()
    return {"status": "deleted", "id": connection_id}


# ── Salesforce OAuth2 PKCE flow ───────────────────────────────────────────────

@router.post("/salesforce/authorize")
def salesforce_authorize(payload: SalesforceAuthorizeRequest, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """
    Authorize Salesforce. Strategy:
    1. If client_secret provided, try client_credentials grant first (instant, no popup).
    2. If client_credentials fails or no secret, fall back to PKCE popup flow.
    Returns either { authorized: true, ... } for direct auth,
    or { auth_url, state } for popup flow.
    """
    org = db.query(Connection).filter(
        Connection.id == payload.org_id, Connection.type == "org", Connection.user_id == current_user.id
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    instance = payload.instance_url.strip().rstrip("/")
    if not instance.startswith("http"):
        instance = f"https://{instance}"

    # Try client_credentials first if secret is provided
    client_secret = payload.client_secret or json.loads(org.config_json or "{}").get("sf_client_secret", "")
    if client_secret:
        try:
            token_resp = requests.post(
                f"{instance}/services/oauth2/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": payload.client_id,
                    "client_secret": client_secret,
                },
                timeout=15,
            )
            token_data = token_resp.json()
            if "access_token" in token_data:
                # Fetch user info
                sf_instance = token_data.get("instance_url", instance)
                userinfo_resp = requests.get(
                    f"{sf_instance}/services/oauth2/userinfo",
                    headers={"Authorization": f"Bearer {token_data['access_token']}"},
                    timeout=10,
                )
                userinfo = userinfo_resp.json() if userinfo_resp.ok else {}

                # If userinfo didn't return org info, try the identity URL
                if not userinfo.get("organization_id") and token_data.get("id"):
                    id_resp = requests.get(
                        token_data["id"],
                        headers={"Authorization": f"Bearer {token_data['access_token']}"},
                        timeout=10,
                    )
                    userinfo = id_resp.json() if id_resp.ok else userinfo

                # Persist tokens + mark connected
                cfg = json.loads(org.config_json or "{}")
                cfg["sf_status"] = "connected"
                cfg["sf_access_token"] = token_data["access_token"]
                cfg["sf_instance_url"] = sf_instance
                cfg["sf_org_id"] = userinfo.get("organization_id", "")
                cfg["sf_username"] = userinfo.get("preferred_username") or userinfo.get("username", "")
                org.config_json = json.dumps(cfg)
                org.last_test_status = _derive_overall_status("connected", cfg.get("d365_status", "pending"))
                org.last_tested_at = datetime.now(timezone.utc)
                db.commit()

                return {
                    "authorized": True,
                    "method": "client_credentials",
                    "message": f"Salesforce connected as {cfg['sf_username'] or 'service account'}",
                    "org_id": cfg.get("sf_org_id"),
                    "username": cfg.get("sf_username"),
                    "instance_url": sf_instance,
                }
        except Exception:
            pass  # Fall through to PKCE popup

    # Fall back to PKCE popup flow
    _cleanup_pkce()
    verifier, challenge = _generate_pkce()
    state = secrets.token_urlsafe(16)
    _pkce_store[state] = {
        "verifier": verifier,
        "org_id": payload.org_id,
        "created_at": time.time(),
    }

    redirect_uri = f"{_backend_url()}/shift/oauth/callback/salesforce"
    params = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": payload.client_id,
        "redirect_uri": redirect_uri,
        "scope": "api refresh_token offline_access full",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    auth_url = f"{instance}/services/oauth2/authorize?{params}"

    return {"authorized": False, "auth_url": auth_url, "state": state}


@router.get("/oauth/callback/salesforce")
def salesforce_oauth_callback(
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Salesforce redirects here after user authorises.
    Exchanges the code for tokens, updates the DB, then returns an HTML page
    that sends postMessage('sf-oauth-result') to the opener popup.

    Add this URL to your Salesforce Connected App's OAuth Callback URLs:
      http://localhost:8000/shift/oauth/callback/salesforce
    """
    if error:
        return HTMLResponse(_oauth_result_html(False, error_description or error))

    if not code or not state:
        return HTMLResponse(_oauth_result_html(False, "Missing authorization code or state."))

    pkce_data = _pkce_store.pop(state, None)
    if not pkce_data:
        return HTMLResponse(_oauth_result_html(False, "Invalid or expired OAuth state. Please try again."))

    org_id = pkce_data["org_id"]
    verifier = pkce_data["verifier"]

    org = db.query(Connection).filter(
        Connection.id == org_id, Connection.type == "org"
    ).first()
    if not org:
        return HTMLResponse(_oauth_result_html(False, "Connection not found."))

    cfg = json.loads(org.config_json or "{}")
    instance_url = cfg.get("sf_instance_url", "").rstrip("/")
    client_id = cfg.get("sf_client_id", "")
    client_secret = cfg.get("sf_client_secret", "")
    redirect_uri = f"{_backend_url()}/shift/oauth/callback/salesforce"

    try:
        # Exchange code for tokens (with PKCE code_verifier)
        token_resp = requests.post(
            f"{instance_url}/services/oauth2/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            },
            timeout=15,
        )

        if not token_resp.ok:
            err = token_resp.json()
            msg = err.get("error_description", err.get("error", "Token exchange failed"))
            cfg["sf_status"] = "error"
            org.config_json = json.dumps(cfg)
            db.commit()
            return HTMLResponse(_oauth_result_html(False, msg))

        token_data = token_resp.json()

        # Fetch user info for display
        userinfo_resp = requests.get(
            f"{token_data['instance_url']}/services/oauth2/userinfo",
            headers={"Authorization": f"Bearer {token_data['access_token']}"},
            timeout=10,
        )
        userinfo = userinfo_resp.json() if userinfo_resp.ok else {}

        # Persist tokens + mark connected
        cfg["sf_status"] = "connected"
        cfg["sf_access_token"] = token_data["access_token"]
        cfg["sf_refresh_token"] = token_data.get("refresh_token", "")
        cfg["sf_instance_url"] = token_data.get("instance_url", instance_url)
        cfg["sf_org_id"] = userinfo.get("organization_id", "")
        cfg["sf_username"] = userinfo.get("preferred_username", "")

        org.config_json = json.dumps(cfg)
        org.last_test_status = _derive_overall_status("connected", cfg.get("d365_status", "pending"))
        org.last_tested_at = datetime.now(timezone.utc)
        db.commit()

        return HTMLResponse(_oauth_result_html(True))

    except Exception as exc:
        cfg["sf_status"] = "error"
        org.config_json = json.dumps(cfg)
        db.commit()
        return HTMLResponse(_oauth_result_html(False, str(exc)))


# ── Dynamics 365 — direct HTTP + WhoAmI ──────────────────────────────────────

@router.post("/dynamics/authorize")
def dynamics_authorize(payload: D365TestRequest, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """
    Validates D365 credentials using direct Azure AD client_credentials flow.
    Confirms with a WhoAmI call (same pattern as GAI Cursor dynamics.ts).
    If org_id is supplied, updates sf_status in the DB on success.
    """
    env_url = payload.environment_url.rstrip("/")

    # Step 1: Acquire token from Azure AD
    token_url = f"https://login.microsoftonline.com/{payload.tenant_id}/oauth2/v2.0/token"
    try:
        token_resp = requests.post(
            token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": payload.client_id,
                "client_secret": payload.client_secret,
                "scope": f"{env_url}/.default",
            },
            timeout=15,
        )
        token_data = token_resp.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not reach Azure AD: {exc}")

    if "access_token" not in token_data:
        raise HTTPException(
            status_code=401,
            detail=token_data.get("error_description", token_data.get("error", "Azure AD authentication failed.")),
        )

    # Step 2: Validate with WhoAmI
    try:
        whoami_resp = requests.get(
            f"{env_url}/api/data/v9.2/WhoAmI",
            headers={
                "Authorization": f"Bearer {token_data['access_token']}",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
                "Accept": "application/json",
            },
            timeout=15,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not reach Dynamics 365: {exc}")

    if not whoami_resp.ok:
        raise HTTPException(
            status_code=400,
            detail=f"Dynamics 365 WhoAmI failed ({whoami_resp.status_code}). Check environment URL and app permissions.",
        )

    whoami = whoami_resp.json()

    # Step 3: Persist status if org_id given
    if payload.org_id is not None:
        org = db.query(Connection).filter(
            Connection.id == payload.org_id, Connection.type == "org", Connection.user_id == current_user.id
        ).first()
        if org:
            cfg = json.loads(org.config_json or "{}")
            cfg["d365_status"] = "connected"
            cfg["d365_tenant_id"] = payload.tenant_id
            cfg["d365_client_id"] = payload.client_id
            cfg["d365_client_secret"] = payload.client_secret
            cfg["d365_environment_url"] = env_url
            cfg["d365_org_id"] = whoami.get("OrganizationId", "")
            org.config_json = json.dumps(cfg)
            org.last_test_status = _derive_overall_status(
                cfg.get("sf_status", "pending"), "connected"
            )
            org.last_tested_at = datetime.now(timezone.utc)
            db.commit()

    return {
        "status": "ok",
        "message": "Dynamics 365 connected successfully.",
        "organization_id": whoami.get("OrganizationId"),
        "user_id": whoami.get("UserId"),
        "business_unit_id": whoami.get("BusinessUnitId"),
        "environment_url": env_url,
    }


# ── Fabric Data Lake — Test connection ───────────────────────────────────────

@router.post("/fabric/test")
def test_fabric_connection(payload: FabricTestRequest):
    """
    Test a Microsoft Fabric SQL connection using Service Principal auth.
    Uses ActiveDirectoryServicePrincipal ODBC auth (same approach as POC AI project).
    Requires: ODBC Driver 18 (or 17) for SQL Server installed on the host.
    """
    try:
        import pyodbc  # type: ignore
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="pyodbc is not installed. Run: pip install pyodbc",
        )

    # Auto-detect available ODBC driver (prefer 18, fall back to 17)
    driver = None
    for candidate in ["ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server"]:
        if candidate in pyodbc.drivers():
            driver = candidate
            break
    if not driver:
        available = pyodbc.drivers()
        raise HTTPException(
            status_code=500,
            detail=(
                f"No suitable ODBC driver found. Install 'ODBC Driver 18 for SQL Server'. "
                f"Available drivers: {available or ['(none)']}"
            ),
        )

    # Build connection string — ActiveDirectoryServicePrincipal auth
    # Format: UID={client_id}@{tenant_id}  (same as POC AI project)
    uid = f"{payload.service_principal_id}@{payload.tenant_id}"
    conn_str = (
        f"Driver={{{driver}}};"
        f"Server={payload.server},1433;"
        f"Database={payload.database};"
        f"Encrypt=Yes;TrustServerCertificate=No;"
        f"UID={uid};PWD={payload.service_principal_secret};"
        "Authentication=ActiveDirectoryServicePrincipal"
    )

    try:
        conn = pyodbc.connect(conn_str, timeout=20)
        cursor = conn.cursor()
        cursor.execute("SELECT DB_NAME() AS db")
        row = cursor.fetchone()
        db_name = row[0] if row else payload.database
        conn.close()
        return {"status": "connected", "message": f"Connected to Fabric database '{db_name}' successfully."}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Fabric SQL connection failed: {str(exc)}")


# ── Org Detail — Reconnect Salesforce (using stored credentials) ──────────────

@router.post("/connections/{connection_id}/reconnect-sf")
def reconnect_salesforce(connection_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """
    Re-authorize Salesforce using the credentials already stored for this org.
    Uses client_credentials grant (instant, no popup needed).
    """
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org", Connection.user_id == current_user.id
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    cfg = json.loads(org.config_json or "{}")
    client_id     = cfg.get("sf_client_id", "")
    client_secret = cfg.get("sf_client_secret", "")
    instance_url  = cfg.get("sf_instance_url", "").rstrip("/")

    if not client_id or not instance_url:
        raise HTTPException(
            status_code=400,
            detail="Stored Salesforce credentials are incomplete. Please edit the connection."
        )
    if not client_secret:
        raise HTTPException(
            status_code=400,
            detail="No client secret stored. Please edit the connection and re-enter your credentials."
        )

    try:
        token_resp = requests.post(
            f"{instance_url}/services/oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            },
            timeout=15,
        )
        token_data = token_resp.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot reach Salesforce: {exc}")

    if "access_token" not in token_data:
        raise HTTPException(
            status_code=401,
            detail=token_data.get("error_description", token_data.get("error", "Salesforce authentication failed. Check your Client ID and Secret."))
        )

    # Fetch identity info
    sf_instance = token_data.get("instance_url", instance_url)
    try:
        id_resp = requests.get(
            token_data.get("id", f"{sf_instance}/services/oauth2/userinfo"),
            headers={"Authorization": f"Bearer {token_data['access_token']}"},
            timeout=10,
        )
        userinfo = id_resp.json() if id_resp.ok else {}
    except Exception:
        userinfo = {}

    cfg["sf_status"]       = "connected"
    cfg["sf_access_token"] = token_data["access_token"]
    cfg["sf_instance_url"] = sf_instance
    cfg["sf_org_id"]       = userinfo.get("organization_id", cfg.get("sf_org_id", ""))
    cfg["sf_username"]     = userinfo.get("preferred_username") or userinfo.get("username", cfg.get("sf_username", ""))

    org.config_json      = json.dumps(cfg)
    org.last_test_status = _derive_overall_status("connected", cfg.get("d365_status", "pending"))
    org.last_tested_at   = datetime.now(timezone.utc)
    db.commit()

    return {
        "status": "ok",
        "message": f"Salesforce reconnected as {cfg['sf_username'] or 'service account'}",
        "instance_url": sf_instance,
        "org_id": cfg.get("sf_org_id"),
        "username": cfg.get("sf_username"),
    }


# ── Org Detail — Extract Config ───────────────────────────────────────────────

ALL_METADATA_TYPES = [
    "apex_classes", "apex_triggers", "flows", "lwc_components", "aura_components",
]

class ExtractConfigPayload(BaseModel):
    metadata_types: list


def _get_or_create_metadata(db: Session, connection_id: int) -> OrgMetadata:
    om = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    if not om:
        om = OrgMetadata(
            connection_id=connection_id,
            extract_config_json=json.dumps(ALL_METADATA_TYPES),
            vector_status="not_indexed",
        )
        db.add(om)
        db.commit()
        db.refresh(om)
    return om


def _org_detail_dict(org: Connection, om: Optional[OrgMetadata]) -> dict:
    """Returns full org detail including metadata state."""
    cfg = json.loads(org.config_json or "{}")
    sf_status   = cfg.get("sf_status", "pending")
    d365_status = cfg.get("d365_status", "pending")
    summary = json.loads(om.summary_json or "{}") if om else {}
    extract_config = json.loads(om.extract_config_json or "[]") if om else ALL_METADATA_TYPES
    return {
        "id": org.id,
        "name": org.name,
        "sf_instance_url": cfg.get("sf_instance_url", ""),
        "sf_username": cfg.get("sf_username", ""),
        "sf_org_id": cfg.get("sf_org_id", ""),
        "target_crm": cfg.get("target_crm", "dynamics365"),
        "sf_status": sf_status,
        "d365_status": d365_status,
        "overall_status": _derive_overall_status(sf_status, d365_status),
        "metadata_status": "completed" if (om and om.extracted_at) else "pending",
        "extracted_at": om.extracted_at.isoformat() if (om and om.extracted_at) else None,
        "vector_status": om.vector_status if om else "not_indexed",
        "vector_indexed_at": om.vector_indexed_at.isoformat() if (om and om.vector_indexed_at) else None,
        "extract_config": extract_config,
        "summary": summary,
        "created_at": org.created_at.isoformat() if org.created_at else None,
    }


@router.get("/connections/{connection_id}/detail")
def get_org_detail(connection_id: int, db: Session = Depends(get_db)):
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org"
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")
    om = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    return _org_detail_dict(org, om)


@router.patch("/connections/{connection_id}/extract-config")
def save_extract_config(connection_id: int, payload: ExtractConfigPayload, db: Session = Depends(get_db)):
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org"
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    valid = [t for t in payload.metadata_types if t in ALL_METADATA_TYPES]
    om = _get_or_create_metadata(db, connection_id)
    om.extract_config_json = json.dumps(valid)
    om.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "ok", "metadata_types": valid}


# ── Org Detail — Extract Metadata ─────────────────────────────────────────────

def _sf_client(cfg: dict):
    """Build a simple_salesforce Salesforce client from stored tokens."""
    try:
        from simple_salesforce import Salesforce as SF
        return SF(
            instance_url=cfg["sf_instance_url"],
            session_id=cfg["sf_access_token"],
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot connect to Salesforce: {exc}")


def get_valid_sf_config(conn: Connection, db: Session) -> dict:
    """
    Return a cfg dict with a valid SF access token, auto-refreshing if expired.
    Raises HTTPException(401) if the session cannot be recovered.
    Raises HTTPException(400) if Salesforce is not connected at all.
    """
    cfg = json.loads(conn.config_json or "{}")
    access_token = cfg.get("sf_access_token", "")
    instance_url = cfg.get("sf_instance_url", "")

    if not access_token or not instance_url:
        raise HTTPException(status_code=400, detail="Salesforce not connected. Please authorize from the Metadata Migration tab.")

    # Quick session validation — if expired, refresh once
    try:
        _validate_sf_session(access_token, instance_url)
    except HTTPException as exc:
        if exc.status_code == 401:
            cfg = refresh_sf_token(conn, db)   # raises HTTPException(401) if un-refreshable
        else:
            raise
    return cfg


def _validate_sf_session(access_token: str, instance_url: str) -> None:
    """Validate Salesforce session with a direct HTTP call (most reliable method)."""
    try:
        resp = requests.get(
            f"{instance_url.rstrip('/')}/services/data/v59.0/",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot reach Salesforce: {exc}")

    if resp.status_code in (401, 403):
        raise HTTPException(
            status_code=401,
            detail="Salesforce session expired. Please re-authorize the connection.",
        )
    if not resp.ok:
        raise HTTPException(
            status_code=400,
            detail=f"Salesforce returned {resp.status_code}. Check connection settings.",
        )


def refresh_sf_token(conn: Connection, db: Session) -> dict:
    """
    Exchange the stored refresh_token for a new access_token from Salesforce.
    Falls back to client_credentials re-auth if no refresh_token is stored.
    Saves the updated token to DB and returns the refreshed cfg dict.
    Raises HTTPException(401) if all re-auth attempts fail.
    """
    cfg = json.loads(conn.config_json or "{}")
    refresh_token = cfg.get("sf_refresh_token", "")
    client_id     = cfg.get("sf_client_id", "")
    client_secret = cfg.get("sf_client_secret", "")
    instance_url  = cfg.get("sf_instance_url", "").rstrip("/")

    if not refresh_token:
        # No refresh token — try client_credentials re-auth if we have client_id + client_secret
        if client_id and client_secret and instance_url:
            try:
                token_resp = requests.post(
                    f"{instance_url}/services/oauth2/token",
                    data={
                        "grant_type":    "client_credentials",
                        "client_id":     client_id,
                        "client_secret": client_secret,
                    },
                    timeout=15,
                )
                token_data = token_resp.json()
                if "access_token" in token_data:
                    cfg["sf_access_token"] = token_data["access_token"]
                    cfg["sf_instance_url"]  = token_data.get("instance_url", instance_url)
                    cfg["sf_status"] = "connected"
                    conn.config_json = json.dumps(cfg)
                    db.commit()
                    return cfg
            except Exception:
                pass
        cfg["sf_status"] = "needs_reauth"
        conn.config_json = json.dumps(cfg)
        db.commit()
        raise HTTPException(
            status_code=401,
            detail="Salesforce session expired and no refresh token is stored. Please re-authorize from the Metadata Migration tab.",
        )

    try:
        resp = requests.post(
            f"{instance_url}/services/oauth2/token",
            data={
                "grant_type":    "refresh_token",
                "client_id":     client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
            },
            timeout=15,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot reach Salesforce to refresh token: {exc}")

    if not resp.ok:
        cfg["sf_status"] = "needs_reauth"
        conn.config_json = json.dumps(cfg)
        db.commit()
        raise HTTPException(
            status_code=401,
            detail="Salesforce refresh token expired. Please re-authorize from the Metadata Migration tab.",
        )

    token_data = resp.json()
    cfg["sf_access_token"] = token_data["access_token"]
    # Salesforce may rotate the refresh token on each use
    if token_data.get("refresh_token"):
        cfg["sf_refresh_token"] = token_data["refresh_token"]
    cfg["sf_status"] = "connected"
    conn.config_json = json.dumps(cfg)
    db.commit()
    return cfg


def _soql_all(sf, query: str) -> tuple:
    """Paginate through all SOQL results. Returns (records, totalSize)."""
    records = []
    result = sf.query(query)
    records.extend(result.get("records", []))
    while not result.get("done", True):
        result = sf.query_more(result["nextRecordsUrl"], identifier_is_url=True)
        records.extend(result.get("records", []))
    return records, result.get("totalSize", len(records))


def _tooling_query(access_token: str, instance_url: str, soql: str) -> dict:
    """Direct HTTP call to Salesforce Tooling API."""
    import urllib.parse as up
    url = f"{instance_url.rstrip('/')}/services/data/v59.0/tooling/query/?q={up.quote(soql)}"
    resp = requests.get(url, headers={"Authorization": f"Bearer {access_token}"}, timeout=20)
    resp.raise_for_status()
    return resp.json()


def _extract_salesforce_metadata(sf, metadata_types: list, cfg: dict = None) -> tuple:
    """
    Extract selected metadata types.
    Returns (raw_data dict, summary counts dict, errors list).
    Errors are surfaced instead of silently swallowed.
    """
    data: dict = {}
    summary: dict = {}
    errors: list = []

    sf_token    = (cfg or {}).get("sf_access_token", "")
    sf_instance = (cfg or {}).get("sf_instance_url", "").rstrip("/")

    # ── Apex Classes (exclude managed & unmanaged package components) ──────────
    if "apex_classes" in metadata_types:
        ok = False
        for q in [
            "SELECT Id, Name, LengthWithoutComments FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name",
            "SELECT Id, Name FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name",
        ]:
            try:
                records, total = _soql_all(sf, q)
                data["apex_classes"] = records
                summary["apex_classes"] = total
                ok = True
                break
            except Exception as exc:
                last_exc = exc
        if not ok:
            data["apex_classes"] = []
            summary["apex_classes"] = 0
            errors.append(f"apex_classes: {last_exc}")

    # ── Apex Triggers (exclude package components) ────────────────────────────
    if "apex_triggers" in metadata_types:
        try:
            records, total = _soql_all(
                sf,
                "SELECT Id, Name, TableEnumOrId FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name",
            )
            data["apex_triggers"] = records
            summary["triggers"] = total
        except Exception as exc:
            data["apex_triggers"] = []
            summary["triggers"] = 0
            errors.append(f"apex_triggers: {exc}")

    # ── Flows (exclude managed & installed package flows) ─────────────────────
    if "flows" in metadata_types:
        ok = False
        for q in [
            "SELECT Id, ApiName, Label, ProcessType, Status FROM FlowDefinitionView WHERE ManageableState NOT IN ('installed', 'released') ORDER BY ApiName",
            "SELECT Id, ApiName, Label, ProcessType FROM FlowDefinitionView WHERE ManageableState NOT IN ('installed', 'released') ORDER BY ApiName",
            "SELECT Id, ApiName FROM FlowDefinitionView WHERE ManageableState NOT IN ('installed', 'released') ORDER BY ApiName",
            # Fallback without ManageableState filter (older API versions)
            "SELECT Id, ApiName, Label, ProcessType FROM FlowDefinitionView ORDER BY ApiName",
            "SELECT Id, ApiName FROM FlowDefinitionView ORDER BY ApiName",
        ]:
            try:
                records, total = _soql_all(sf, q)
                data["flows"] = records
                summary["flows"] = total
                ok = True
                break
            except Exception as exc:
                last_exc = exc
        if not ok:
            data["flows"] = []
            summary["flows"] = 0
            errors.append(f"flows: {last_exc}")

    # ── LWC Components (exclude package components) ───────────────────────────
    if "lwc_components" in metadata_types:
        if not sf_token or not sf_instance:
            errors.append("lwc_components: missing sf_access_token or sf_instance_url in config")
            data["lwc_components"] = []; summary["lwc"] = 0
        else:
            try:
                result = _tooling_query(sf_token, sf_instance,
                    "SELECT Id, DeveloperName, MasterLabel FROM LightningComponentBundle WHERE NamespacePrefix = null ORDER BY DeveloperName")
                records = result.get("records", [])
                data["lwc_components"] = records
                summary["lwc"] = result.get("size", len(records))
            except Exception as exc:
                data["lwc_components"] = []
                summary["lwc"] = 0
                errors.append(f"lwc_components: {exc}")

    # ── Aura Components (exclude package components) ──────────────────────────
    if "aura_components" in metadata_types:
        if not sf_token or not sf_instance:
            errors.append("aura_components: missing sf_access_token or sf_instance_url in config")
            data["aura_components"] = []; summary["aura"] = 0
        else:
            try:
                result = _tooling_query(sf_token, sf_instance,
                    "SELECT Id, DeveloperName, MasterLabel FROM AuraDefinitionBundle WHERE NamespacePrefix = null ORDER BY DeveloperName")
                records = result.get("records", [])
                data["aura_components"] = records
                summary["aura"] = result.get("size", len(records))
            except Exception as exc:
                data["aura_components"] = []
                summary["aura"] = 0
                errors.append(f"aura_components: {exc}")

    return data, summary, errors


@router.post("/connections/{connection_id}/extract")
def extract_metadata(connection_id: int, db: Session = Depends(get_db)):
    """
    Extract Salesforce metadata and store in SQLite (org_metadata table).
    Uses access token from config_json. Stores raw JSON + summary counts.
    """
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org"
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    cfg = get_valid_sf_config(org, db)   # validates + auto-refreshes on 401

    om = _get_or_create_metadata(db, connection_id)
    metadata_types = json.loads(om.extract_config_json or "[]") or ALL_METADATA_TYPES

    try:
        sf = _sf_client(cfg)
        raw_data, summary, extraction_errors = _extract_salesforce_metadata(sf, metadata_types, cfg)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Extraction failed: {exc}")

    # Only save if at least some data was extracted
    total_extracted = sum(summary.values())
    if total_extracted == 0 and extraction_errors:
        # Everything failed — surface the first real error
        raise HTTPException(
            status_code=500,
            detail=f"Extraction failed for all selected types. First error: {extraction_errors[0]}"
        )

    om.metadata_json  = json.dumps(raw_data)
    om.summary_json   = json.dumps(summary)
    om.extracted_at   = datetime.now(timezone.utc)
    om.vector_status  = "not_indexed"
    om.updated_at     = datetime.now(timezone.utc)

    # Update connection's metadata_sync_at in config_json
    cfg["metadata_sync_at"] = om.extracted_at.isoformat()
    org.config_json = json.dumps(cfg)
    db.commit()

    return {
        "status": "ok" if not extraction_errors else "partial",
        "message": "Metadata extracted successfully." if not extraction_errors else f"Partial extraction — {len(extraction_errors)} type(s) failed.",
        "extracted_at": om.extracted_at.isoformat(),
        "summary": summary,
        "errors": extraction_errors,
    }


# ── Org Detail — Vector Index ─────────────────────────────────────────────────

@router.post("/connections/{connection_id}/index-vector")
def index_to_vector(connection_id: int, db: Session = Depends(get_db)):
    """
    Index extracted metadata into Qdrant for AI/semantic search (Agent Chat).
    Requires metadata to be extracted first.
    """
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org"
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    om = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    if not om or not om.metadata_json:
        raise HTTPException(status_code=400, detail="No metadata extracted yet. Run extraction first.")

    try:
        from qdrant_client.models import PointStruct, VectorParams, Distance
        from .connectors_router import get_default_qdrant_client

        # Use DB-configured Qdrant (default vector config), fallback to local file.
        client     = get_default_qdrant_client(db)
        collection = f"org_{connection_id}_metadata"

        raw = json.loads(om.metadata_json)
        documents = []

        # Build text chunks for indexing
        for obj in raw.get("objects", []):
            if obj.get("custom"):
                documents.append({"id": f"obj_{obj['name']}", "text": f"Salesforce Object: {obj['label']} ({obj['name']})"})
                for f in obj.get("fields", []):
                    documents.append({"id": f"field_{obj['name']}_{f['name']}", "text": f"Field {f['label']} ({f['name']}) on {obj['name']} — type: {f['type']}"})

        for cls in raw.get("apex_classes", []):
            documents.append({"id": f"apex_{cls.get('Id','')}", "text": f"Apex Class: {cls.get('Name','')}"})

        for trig in raw.get("apex_triggers", []):
            documents.append({"id": f"trigger_{trig.get('Id','')}", "text": f"Apex Trigger: {trig.get('Name','')} on {trig.get('TableEnumOrId','')}"})

        for flow in raw.get("flows", []):
            documents.append({"id": f"flow_{flow.get('Id','')}", "text": f"Flow: {flow.get('Label', flow.get('DeveloperName',''))} — type: {flow.get('ProcessType','')}"})

        for lwc in raw.get("lwc_components", []):
            documents.append({"id": f"lwc_{lwc.get('Id','')}", "text": f"LWC Component: {lwc.get('MasterLabel', lwc.get('DeveloperName',''))}"})

        for aura in raw.get("aura_components", []):
            documents.append({"id": f"aura_{aura.get('Id','')}", "text": f"Aura Component: {aura.get('MasterLabel', aura.get('DeveloperName',''))}"})

        if not documents:
            raise HTTPException(status_code=400, detail="No indexable content found in extracted metadata.")

        # Create or recreate collection (dim=384 for sentence-transformers all-MiniLM-L6-v2 or use 1536 for OpenAI)
        vector_size = 384
        existing = [c.name for c in client.get_collections().collections]
        if collection not in existing:
            client.create_collection(
                collection_name=collection,
                vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE),
            )

        # Simple TF-based "embedding" via hashing (no LLM needed for basic indexing)
        # For production, replace with OpenAI or sentence-transformers
        import hashlib
        import struct

        def _simple_vector(text: str, dim: int = 384) -> list:
            """Deterministic pseudo-vector from text hash. Uses unsigned int → float in [-1,1]."""
            seed = text.encode()
            vecs = []
            for i in range(dim):
                h   = hashlib.md5(seed + i.to_bytes(4, "big")).digest()
                val = struct.unpack(">I", h[:4])[0]   # unsigned 32-bit int
                vecs.append((val / 2_147_483_647.0) - 1.0)   # normalise to [-1, 1]
            return vecs

        points = [
            PointStruct(
                id=abs(hash(doc["id"])) % (10**15),
                vector=_simple_vector(doc["text"]),
                payload={"text": doc["text"], "doc_id": doc["id"], "org_id": connection_id},
            )
            for doc in documents
        ]

        client.upsert(collection_name=collection, points=points)

        om.vector_status     = "indexed"
        om.vector_indexed_at = datetime.now(timezone.utc)
        om.updated_at        = datetime.now(timezone.utc)
        db.commit()

        return {
            "status": "ok",
            "message": f"Indexed {len(points)} documents to Qdrant.",
            "collection": collection,
            "document_count": len(points),
            "indexed_at": om.vector_indexed_at.isoformat(),
        }

    except HTTPException:
        raise
    except Exception as exc:
        if om:
            om.vector_status = "error"
            db.commit()
        raise HTTPException(status_code=500, detail=f"Vector indexing failed: {exc}")


@router.get("/connections/{connection_id}/vector-status")
def get_vector_status(connection_id: int, db: Session = Depends(get_db)):
    om = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    if not om:
        return {"status": "not_indexed", "indexed_at": None, "document_count": 0}

    doc_count = 0
    try:
        from .connectors_router import get_default_qdrant_client
        client     = get_default_qdrant_client(db)
        collection = f"org_{connection_id}_metadata"
        existing    = [c.name for c in client.get_collections().collections]
        if collection in existing:
            info      = client.get_collection(collection)
            doc_count = info.points_count or 0
    except Exception:
        pass

    return {
        "status": om.vector_status or "not_indexed",
        "indexed_at": om.vector_indexed_at.isoformat() if om.vector_indexed_at else None,
        "document_count": doc_count,
    }


@router.delete("/connections/{connection_id}/metadata")
def clear_metadata(connection_id: int, db: Session = Depends(get_db)):
    """Clear extracted metadata from SQLite and remove Qdrant collection."""
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org"
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    om = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    if om:
        om.metadata_json     = None
        om.summary_json      = None
        om.extracted_at      = None
        om.vector_status     = "not_indexed"
        om.vector_indexed_at = None
        om.updated_at        = datetime.now(timezone.utc)

    # Remove from config_json
    cfg = json.loads(org.config_json or "{}")
    cfg.pop("metadata_sync_at", None)
    org.config_json = json.dumps(cfg)
    db.commit()

    # Remove Qdrant collection
    try:
        from .connectors_router import get_default_qdrant_client
        client     = get_default_qdrant_client(db)
        collection = f"org_{connection_id}_metadata"
        existing    = [c.name for c in client.get_collections().collections]
        if collection in existing:
            client.delete_collection(collection)
    except Exception:
        pass

    return {"status": "ok", "message": "Metadata cleared."}


# ── LLM helper ────────────────────────────────────────────────────────────────

def _call_llm(system_prompt: str, messages: list, max_tokens: int = 2048, db=None) -> str:
    """Call the configured LLM provider and return the response text.

    Resolution order:
    1. Default LLMConfig row from SQLite (if db session provided)
    2. LLM_PROVIDER / OPENAI_API_KEY / ANTHROPIC_API_KEY env vars (legacy fallback)
    """
    provider = None
    api_key  = None
    model    = None

    # 1. Try DB-stored config
    if db is not None:
        try:
            from .connectors_router import get_default_llm
            llm_cfg = get_default_llm(db)
            if llm_cfg:
                provider = llm_cfg["provider"]
                api_key  = llm_cfg["api_key"]
                model    = llm_cfg["model"]
        except Exception:
            pass

    # 2. Fall back to environment variables
    if not provider:
        provider = os.environ.get("LLM_PROVIDER", "openai").lower()
    if not api_key:
        if provider == "anthropic":
            api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        else:
            api_key = os.environ.get("OPENAI_API_KEY", "")
    if not model:
        if provider == "anthropic":
            model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
        else:
            model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    if not api_key:
        raise ValueError(
            f"No LLM API key found. Add a provider in the LLM Connector page "
            f"or set {provider.upper()}_API_KEY in the environment."
        )

    if provider == "anthropic":
        import anthropic as anthropic_sdk
        client = anthropic_sdk.Anthropic(api_key=api_key)
        resp   = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=messages,
        )
        return resp.content[0].text

    else:  # default: openai
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        full_messages = [{"role": "system", "content": system_prompt}] + messages
        resp = client.chat.completions.create(
            model=model, messages=full_messages, max_tokens=max_tokens
        )
        return resp.choices[0].message.content


def _build_metadata_context(metadata: dict, query: str, max_items: int = 40) -> str:
    """Build a compact text context from extracted metadata, filtered by query keywords."""
    keywords = set(query.lower().split())
    lines = []

    def score(name: str) -> int:
        n = name.lower()
        return sum(1 for k in keywords if k in n)

    def add_section(title: str, items: list, fmt):
        if not items:
            return
        scored = sorted(items, key=lambda x: score(fmt(x)), reverse=True)
        subset = scored[:max_items]
        lines.append(f"\n### {title} ({len(items)} total, showing {len(subset)})")
        for item in subset:
            lines.append(f"  - {fmt(item)}")

    add_section("Apex Classes",     metadata.get("apex_classes", []),     lambda x: x.get("Name", "?"))
    add_section("Apex Triggers",    metadata.get("apex_triggers", []),    lambda x: f"{x.get('Name','?')} on {x.get('TableEnumOrId','?')}")
    add_section("Flows",            metadata.get("flows", []),            lambda x: f"{x.get('Label', x.get('DeveloperName','?'))} ({x.get('ProcessType','?')})")
    add_section("LWC Components",   metadata.get("lwc_components", []),   lambda x: x.get("MasterLabel", x.get("DeveloperName","?")))
    add_section("Aura Components",  metadata.get("aura_components", []),  lambda x: x.get("MasterLabel", x.get("DeveloperName","?")))
    add_section("Validation Rules", metadata.get("validation_rules", []), lambda x: f"{x.get('Name','?')} on {x.get('EntityDefinition',{}).get('QualifiedApiName','?')}")

    return "\n".join(lines) if lines else "No metadata available."


# ── Agent Chat ────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str    # "user" | "assistant"
    content: str

class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []

@router.post("/connections/{connection_id}/agent-chat")
def agent_chat(connection_id: int, req: ChatRequest, db: Session = Depends(get_db)):
    """
    AI agent chat about the org's extracted Salesforce metadata.
    Uses local Qdrant (if indexed) or raw metadata from SQLite for context.
    """
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org"
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    om = db.query(OrgMetadata).filter(OrgMetadata.connection_id == connection_id).first()
    if not om or not om.metadata_json:
        raise HTTPException(status_code=400, detail="No metadata extracted yet. Run extraction first.")

    try:
        cfg      = json.loads(org.config_json or "{}")
        raw_meta = json.loads(om.metadata_json)
        context  = _build_metadata_context(raw_meta, req.message)

        org_name     = org.name
        sf_instance  = cfg.get("sf_instance_url", "")
        summary      = json.loads(om.summary_json or "{}") if om.summary_json else {}
        summary_text = ", ".join(f"{v} {k.replace('_',' ')}" for k, v in summary.items() if v)

        system_prompt = f"""You are an expert Salesforce-to-Dynamics 365 migration assistant for the org "{org_name}" ({sf_instance}).

You have access to the extracted Salesforce metadata for this org:
{summary_text}

Relevant metadata context for this query:
{context}

Your role:
- Answer questions about this org's Salesforce metadata (Apex code, triggers, flows, components)
- Provide migration guidance: how each Salesforce component maps to Dynamics 365 equivalents
- Suggest migration strategies, risks, and best practices
- Be concise and practical. Use markdown formatting.

Salesforce → Dynamics 365 equivalents:
- Apex Classes → C# Plugins / Custom Workflow Activities
- Apex Triggers → Pre/Post Operation Plugins
- Flows → Power Automate Flows / Business Process Flows
- LWC Components → PCF (Power Apps Component Framework) Controls
- Aura Components → PCF Controls (legacy, prioritize LWC→PCF migration)
- Validation Rules → Business Rules / Plugins
"""

        messages = [{"role": m.role, "content": m.content} for m in req.history]
        messages.append({"role": "user", "content": req.message})

        response_text = _call_llm(system_prompt, messages, max_tokens=1500, db=db)

        return {"response": response_text, "status": "ok"}

    except ValueError as ve:
        raise HTTPException(status_code=503, detail=str(ve))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Agent chat error: {exc}")


# ── Code Converter ────────────────────────────────────────────────────────────

class ConvertRequest(BaseModel):
    source_code: str
    source_type: str   # apex_class | apex_trigger | lwc | aura | flow | validation_rule
    notes: str = ""    # optional context/notes from user

@router.post("/connections/{connection_id}/convert-code")
def convert_code(connection_id: int, req: ConvertRequest, db: Session = Depends(get_db)):
    """
    Convert Salesforce code/metadata to Dynamics 365 equivalent using LLM.
    """
    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org"
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    TYPE_MAP = {
        "apex_class":       ("Apex Class",       "C# Dynamics 365 Plugin",              "IPlugin", ".cs"),
        "apex_trigger":     ("Apex Trigger",      "C# Pre/Post Operation Plugin",        "IPlugin", ".cs"),
        "lwc":              ("LWC Component",     "PCF (Power Apps Component Framework) TypeScript Control", "StandardControl", ".ts"),
        "aura":             ("Aura Component",    "PCF TypeScript Control",              "StandardControl", ".ts"),
        "flow":             ("Salesforce Flow",   "Power Automate Flow (JSON definition)", "CloudFlow", ".json"),
        "validation_rule":  ("Validation Rule",   "Dynamics 365 Business Rule / Plugin", "BusinessRule", ".md"),
    }

    src_label, tgt_label, tgt_interface, ext = TYPE_MAP.get(
        req.source_type, ("Salesforce Code", "Dynamics 365 equivalent", "", "")
    )
    extra_notes = f"\nUser notes: {req.notes}" if req.notes else ""

    system_prompt = f"""You are an expert Salesforce-to-Dynamics 365 migration engineer.
Convert the provided {src_label} to its {tgt_label} equivalent for Microsoft Dynamics 365.

Guidelines:
- Preserve all business logic faithfully
- Use proper Dynamics 365 SDK patterns (e.g., {tgt_interface})
- Add inline comments explaining migration decisions
- If the source uses Salesforce-specific APIs, map them to D365 equivalents
- Output only the converted code/definition, followed by a short "## Migration Notes" section

{extra_notes}
"""

    try:
        messages = [{"role": "user", "content": f"Convert this {src_label}:\n\n```\n{req.source_code}\n```"}]
        result = _call_llm(system_prompt, messages, max_tokens=3000, db=db)

        # Split result into code and notes at "## Migration Notes"
        if "## Migration Notes" in result:
            parts  = result.split("## Migration Notes", 1)
            code   = parts[0].strip()
            mnotes = "## Migration Notes" + parts[1]
        else:
            code   = result
            mnotes = ""

        return {
            "status":        "ok",
            "converted_code": code,
            "migration_notes": mnotes,
            "source_type":   src_label,
            "target_type":   tgt_label,
            "file_ext":      ext,
        }

    except ValueError as ve:
        raise HTTPException(status_code=503, detail=str(ve))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Code conversion error: {exc}")


# ── Fabric Field Mapping ───────────────────────────────────────────────────────

@router.post("/connections/{connection_id}/fetch-field-mapping")
def fetch_field_mapping(connection_id: int, db: Session = Depends(get_db)):
    """
    Connect to Fabric SQL, pull sf_to_dv_column_mapping + sf_to_dv_picklist_mapping,
    build the structured JSON, and upsert it into the field_mappings table.
    Returns the full mapping dict.
    """
    from .services.fabric_field_mapping import fetch_field_mapping as _fetch

    org = db.query(Connection).filter(
        Connection.id == connection_id, Connection.type == "org"
    ).first()
    if not org:
        raise HTTPException(status_code=404, detail="Connection not found.")

    try:
        mapping = _fetch(org.config_json)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Fabric field mapping error: {exc}")

    mapping_str = json.dumps(mapping, default=str)

    row = db.query(FieldMapping).filter(FieldMapping.connection_id == connection_id).first()
    if row:
        row.mapping_json = mapping_str
        row.fetched_at   = datetime.now(timezone.utc)
    else:
        row = FieldMapping(connection_id=connection_id, mapping_json=mapping_str)
        db.add(row)
    db.commit()
    db.refresh(row)

    return {
        "status":          "ok",
        "fetched_at":      row.fetched_at.isoformat(),
        "total_objects":   mapping.get("_total_objects", 0),
        "total_fields":    mapping.get("_total_fields", 0),
        "mapping":         mapping,
    }


@router.get("/connections/{connection_id}/field-mapping")
def get_field_mapping(connection_id: int, db: Session = Depends(get_db)):
    """Return the last stored field mapping for this connection."""
    row = db.query(FieldMapping).filter(FieldMapping.connection_id == connection_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="No field mapping found. Run 'Fetch Field Mapping' first.")
    return {
        "fetched_at":    row.fetched_at.isoformat(),
        "mapping":       json.loads(row.mapping_json),
    }


# ── Rulebook ───────────────────────────────────────────────────────────────────

class RulebookUpdate(BaseModel):
    title:         Optional[str] = None
    system_prompt: Optional[str] = None
    rules:         Optional[str] = None


class RulebookCreate(BaseModel):
    component_type: str
    title:          str
    system_prompt:  str = ""
    rules:          str = ""


def _seed_rulebooks(db: Session):
    """Seed default rulebook rows if table is empty."""
    for ct, content in DEFAULT_RULEBOOKS.items():
        exists = db.query(Rulebook).filter(Rulebook.component_type == ct).first()
        if not exists:
            db.add(Rulebook(
                component_type=ct,
                title=content["title"],
                system_prompt=content["system_prompt"],
                rules=content["rules"],
            ))
    db.commit()


@router.get("/rulebook")
def get_rulebook(db: Session = Depends(get_db)):
    """Return all rulebook entries (seeding defaults on first call)."""
    _seed_rulebooks(db)
    rows = db.query(Rulebook).order_by(Rulebook.component_type).all()
    return {
        "rulebook": [
            {
                "id":             r.id,
                "component_type": r.component_type,
                "title":          r.title,
                "system_prompt":  r.system_prompt,
                "rules":          r.rules,
                "updated_at":     r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ]
    }


@router.put("/rulebook/{component_type}")
def update_rulebook(component_type: str, body: RulebookUpdate, db: Session = Depends(get_db)):
    """Update a single rulebook entry."""
    _seed_rulebooks(db)
    row = db.query(Rulebook).filter(Rulebook.component_type == component_type).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Rulebook '{component_type}' not found.")
    if body.title         is not None: row.title         = body.title
    if body.system_prompt is not None: row.system_prompt = body.system_prompt
    if body.rules         is not None: row.rules         = body.rules
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True, "component_type": component_type}


@router.post("/rulebook")
def create_rulebook(body: RulebookCreate, db: Session = Depends(get_db)):
    """Create a new custom rulebook entry."""
    _seed_rulebooks(db)
    # Normalize slug: lowercase, spaces → underscores, strip special chars
    slug = body.component_type.strip().lower().replace(" ", "_")
    if not slug:
        raise HTTPException(status_code=400, detail="component_type is required.")
    existing = db.query(Rulebook).filter(Rulebook.component_type == slug).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Rulebook '{slug}' already exists.")
    row = Rulebook(
        component_type=slug,
        title=body.title.strip(),
        system_prompt=body.system_prompt,
        rules=body.rules,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "ok": True,
        "rulebook": {
            "id":             row.id,
            "component_type": row.component_type,
            "title":          row.title,
            "system_prompt":  row.system_prompt,
            "rules":          row.rules,
            "updated_at":     row.updated_at.isoformat() if row.updated_at else None,
        }
    }


@router.delete("/rulebook/{component_type}")
def delete_rulebook(component_type: str, db: Session = Depends(get_db)):
    """Delete a custom rulebook entry. Default entries cannot be deleted."""
    if component_type in DEFAULT_RULEBOOKS:
        raise HTTPException(status_code=400, detail="Cannot delete a default rulebook entry.")
    row = db.query(Rulebook).filter(Rulebook.component_type == component_type).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Rulebook '{component_type}' not found.")
    db.delete(row)
    db.commit()
    return {"ok": True, "deleted": component_type}
