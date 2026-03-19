"""
Dataverse (Dynamics 365) entity & field metadata service.
Authenticates via MSAL and queries the Dataverse Web API to retrieve
all entities and their attributes for use in field-mapping dropdowns.
"""
import msal
import requests
from typing import Dict, List, Optional


class DataverseService:
    """Talks to a Dynamics 365 / Dataverse environment via Web API."""

    def __init__(self, config: Dict):
        """config must have: TENANT_ID, CLIENT_ID, CLIENT_SECRET, DATAVERSE_URL"""
        self.config = config
        self._entities_cache: Optional[List[Dict]] = None

    # ── Auth ──────────────────────────────────────────────────

    def _get_token(self) -> str:
        tenant_id     = self.config.get("TENANT_ID", "")
        client_id     = self.config.get("CLIENT_ID", "")
        client_secret = self.config.get("CLIENT_SECRET", "")
        dataverse_url = self.config.get("DATAVERSE_URL", "").rstrip("/")

        app = msal.ConfidentialClientApplication(
            client_id,
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            client_credential=client_secret,
        )
        result = app.acquire_token_for_client(
            scopes=[f"{dataverse_url}/.default"]
        )
        if "access_token" not in result:
            raise ValueError(
                f"Failed to acquire Dataverse token: "
                f"{result.get('error_description', result)}"
            )
        return result["access_token"]

    def _api_url(self) -> str:
        return self.config.get("DATAVERSE_URL", "").rstrip("/") + "/api/data/v9.2"

    def _headers(self) -> Dict:
        return {
            "Authorization": f"Bearer {self._get_token()}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }

    # ── Entities ──────────────────────────────────────────────

    def get_entities(self, force_refresh: bool = False) -> List[Dict]:
        """Return all user-visible entities (tables) from Dataverse.
        Cached in memory for the lifetime of this service instance."""
        if self._entities_cache and not force_refresh:
            return self._entities_cache

        # $filter and $orderby are not reliably supported on the EntityDefinitions
        # metadata endpoint — apply them in Python after fetching.
        url = (
            f"{self._api_url()}/EntityDefinitions"
            f"?$select=LogicalName,SchemaName,DisplayName,IsCustomEntity,IsPrivate"
        )
        resp = requests.get(url, headers=self._headers(), timeout=30)
        resp.raise_for_status()

        entities = []
        for e in resp.json().get("value", []):
            # Skip truly private/internal entities
            if e.get("IsPrivate", False):
                continue

            display = ""
            dn = e.get("DisplayName")
            if dn and isinstance(dn, dict):
                localized = dn.get("UserLocalizedLabel")
                if localized and isinstance(localized, dict):
                    display = localized.get("Label", "")

            entities.append({
                "logical_name": e.get("LogicalName", ""),
                "schema_name": e.get("SchemaName", ""),
                "display_name": display or e.get("LogicalName", ""),
                "is_custom": e.get("IsCustomEntity", False),
            })

        entities.sort(key=lambda x: x["logical_name"])
        self._entities_cache = entities
        return entities

    # ── Fields / Attributes ───────────────────────────────────

    def get_entity_fields(self, logical_name: str) -> List[Dict]:
        """Return all attributes (columns) for a specific entity."""
        url = (
            f"{self._api_url()}/EntityDefinitions(LogicalName='{logical_name}')"
            f"/Attributes"
            f"?$select=LogicalName,SchemaName,DisplayName,AttributeTypeName"
        )
        resp = requests.get(url, headers=self._headers(), timeout=30)
        resp.raise_for_status()

        fields = []
        for a in resp.json().get("value", []):
            display = ""
            dn = a.get("DisplayName")
            if dn and isinstance(dn, dict):
                localized = dn.get("UserLocalizedLabel")
                if localized and isinstance(localized, dict):
                    display = localized.get("Label", "")

            type_name = a.get("AttributeTypeName", {})
            if isinstance(type_name, dict):
                type_name = type_name.get("Value", "Unknown")

            fields.append({
                "logical_name": a.get("LogicalName", ""),
                "schema_name": a.get("SchemaName", ""),
                "display_name": display or a.get("LogicalName", ""),
                "attribute_type": type_name,
            })

        fields.sort(key=lambda x: x["logical_name"])
        return fields
