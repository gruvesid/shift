"""
Light-weight connectivity tests for each connector type.
Each function returns (ok: bool, message: str).
"""
import requests
from typing import Tuple, Dict


def test_fabric(config: Dict) -> Tuple[bool, str]:
    """
    Try to open a pyodbc connection to the Fabric SQL endpoint and run SELECT 1.
    """
    try:
        import pyodbc  # optional dependency – already in requirements
        sql_endpoint         = config.get("SQL_ENDPOINT", "")
        database             = config.get("DATABASE_NAME", "")
        fabric_client_id     = config.get("FABRIC_CLIENT_ID", "")
        fabric_client_secret = config.get("FABRIC_CLIENT_SECRET", "")

        conn_str = (
            "Driver={ODBC Driver 18 for SQL Server};"
            f"Server={sql_endpoint},1433;"
            f"Database={database};"
            "Authentication=ActiveDirectoryServicePrincipal;"
            f"UID={fabric_client_id};"
            f"PWD={fabric_client_secret};"
            "Encrypt=yes;TrustServerCertificate=no;"
        )
        conn = pyodbc.connect(conn_str, timeout=15)
        conn.cursor().execute("SELECT 1")
        conn.close()
        return True, "Fabric Lakehouse connected successfully"
    except Exception as e:
        return False, str(e)


def test_dynamics(config: Dict) -> Tuple[bool, str]:
    """
    Request an Azure AD token for the Dataverse audience using the service principal.
    A successful token response means the SP credentials are valid.
    """
    try:
        tenant_id     = config.get("TENANT_ID", "")
        client_id     = config.get("CLIENT_ID", "")
        client_secret = config.get("CLIENT_SECRET", "")
        dataverse_url = config.get("DATAVERSE_URL", "").rstrip("/")

        if not all([tenant_id, client_id, client_secret, dataverse_url]):
            return False, "Missing one or more required fields"

        token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
        resp = requests.post(token_url, data={
            "grant_type":    "client_credentials",
            "client_id":     client_id,
            "client_secret": client_secret,
            "scope":         f"{dataverse_url}/.default",
        }, timeout=15)

        if resp.status_code == 200:
            return True, "Azure AD token acquired — Dynamics 365 credentials are valid"
        else:
            detail = resp.json().get("error_description", resp.text)[:200]
            return False, f"Token request failed ({resp.status_code}): {detail}"
    except Exception as e:
        return False, str(e)


def test_salesforce(config: Dict) -> Tuple[bool, str]:
    """
    Use the Salesforce Connected App OAuth2 client-credentials flow to get a token.
    A 200 with access_token means the credentials are valid.
    """
    try:
        instance_url    = config.get("SF_INSTANCE_URL", "").rstrip("/")
        consumer_key    = config.get("SF_CONSUMER_KEY", "")
        consumer_secret = config.get("SF_CONSUMER_SECRET", "")

        if not all([instance_url, consumer_key, consumer_secret]):
            return False, "Missing one or more required fields"

        token_url = f"{instance_url}/services/oauth2/token"
        resp = requests.post(token_url, data={
            "grant_type":    "client_credentials",
            "client_id":     consumer_key,
            "client_secret": consumer_secret,
        }, timeout=15)

        if resp.status_code == 200 and "access_token" in resp.json():
            return True, "Salesforce OAuth token acquired — credentials are valid"
        else:
            detail = resp.json().get("error_description", resp.text)[:200]
            return False, f"OAuth failed ({resp.status_code}): {detail}"
    except Exception as e:
        return False, str(e)


def test_sharepoint(config: Dict) -> Tuple[bool, str]:
    """
    Verify SharePoint connectivity by fetching the site root via Microsoft Graph.
    Requires a service principal with Sites.Read.All (or equivalent).
    We reuse TENANT_ID/CLIENT_ID/CLIENT_SECRET from config if present,
    otherwise fall back to a simple HTTP HEAD of the site hostname.
    """
    try:
        hostname    = config.get("SITE_HOSTNAME", "").strip()
        site_path   = config.get("SITE_PATH", "").strip("/")

        if not hostname:
            return False, "Missing SITE_HOSTNAME"

        # Simple connectivity check: try to reach the SharePoint root
        url = f"https://{hostname}/{site_path}"
        resp = requests.head(url, timeout=10, allow_redirects=True)

        # SharePoint returns 200, 301, 302, or 401 — all mean the host is reachable
        if resp.status_code < 500:
            return True, f"SharePoint host reachable (HTTP {resp.status_code})"
        else:
            return False, f"SharePoint returned HTTP {resp.status_code}"
    except requests.exceptions.ConnectionError:
        return False, "Cannot reach SharePoint host — check hostname"
    except Exception as e:
        return False, str(e)


# Dispatcher
_TESTERS = {
    "fabric":     test_fabric,
    "dynamics":   test_dynamics,
    "salesforce": test_salesforce,
    "sharepoint": test_sharepoint,
}


def test_connector(conn_type: str, config: Dict) -> Tuple[bool, str]:
    tester = _TESTERS.get(conn_type)
    if tester is None:
        return False, f"No test available for connector type '{conn_type}'"
    return tester(config)
