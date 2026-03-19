import requests
from typing import List, Dict, Optional


class SalesforceService:
    """
    Fetches Salesforce object metadata via the REST Describe API.
    Uses the OAuth2 client_credentials flow (Connected App).
    """

    def __init__(self, config: Dict):
        self.config = config
        self._token: Optional[str] = None
        self._api_base: Optional[str] = None

    def _get_token(self) -> str:
        """Acquire (and cache) a Salesforce OAuth access token."""
        if self._token and self._api_base:
            return self._token

        instance_url    = self.config.get("SF_INSTANCE_URL", "").rstrip("/")
        consumer_key    = self.config.get("SF_CONSUMER_KEY", "")
        consumer_secret = self.config.get("SF_CONSUMER_SECRET", "")

        if not all([instance_url, consumer_key, consumer_secret]):
            raise ValueError(
                "Missing Salesforce credentials — ensure SF_INSTANCE_URL, "
                "SF_CONSUMER_KEY, and SF_CONSUMER_SECRET are set."
            )

        resp = requests.post(
            f"{instance_url}/services/oauth2/token",
            data={
                "grant_type":    "client_credentials",
                "client_id":     consumer_key,
                "client_secret": consumer_secret,
            },
            timeout=15,
        )

        try:
            data = resp.json()
        except Exception:
            data = {}

        if resp.status_code != 200 or "access_token" not in data:
            raise ValueError(
                f"Salesforce OAuth failed ({resp.status_code}): "
                f"{data.get('error_description', resp.text[:200])}"
            )

        self._token    = data["access_token"]
        self._api_base = data.get("instance_url", instance_url).rstrip("/")
        return self._token

    def get_object_fields(self, object_name: str) -> List[Dict]:
        """
        Return all fields for a Salesforce object using the Describe endpoint.
        Each field is returned as {sf_label, sf_api, sf_type}.
        """
        token = self._get_token()
        url   = f"{self._api_base}/services/data/v59.0/sobjects/{object_name}/describe"
        resp  = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)

        # Retry once on 401 (expired token)
        if resp.status_code == 401:
            self._token    = None
            self._api_base = None
            token          = self._get_token()
            resp           = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)

        if not resp.ok:
            try:
                data = resp.json()
                if isinstance(data, list) and data:
                    msg = data[0].get("message", resp.text[:200])
                else:
                    msg = data.get("message", resp.text[:200])
            except Exception:
                msg = resp.text[:200]
            raise ValueError(f"Salesforce describe failed ({resp.status_code}): {msg}")

        payload = resp.json()
        return [
            {
                "sf_label": f.get("label") or f["name"],
                "sf_api":   f["name"],
                "sf_type":  f.get("type", ""),
            }
            for f in payload.get("fields", [])
            if f.get("name")
        ]
