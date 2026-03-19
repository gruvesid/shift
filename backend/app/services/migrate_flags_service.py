"""
Local persistence for the Migrate flag on each Salesforce object.

The Fabric Lakehouse SQL endpoint is read-only (DML not supported on Delta
tables), so we cannot UPDATE raw.object_names directly. Instead we store the
user's selections in a local JSON file and merge them with the data read from
Fabric when serving the /objects endpoint.
"""
import json
import os
from typing import Dict

_FLAGS_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'migrate_flags.json')


def _load() -> Dict[str, bool]:
    try:
        with open(_FLAGS_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(data: Dict[str, bool]) -> None:
    with open(_FLAGS_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


def get_flag(object_name: str, default: bool = False) -> bool:
    return _load().get(object_name, default)


def set_flag(object_name: str, migrate: bool) -> None:
    flags = _load()
    flags[object_name] = migrate
    _save(flags)


def get_all_flags() -> Dict[str, bool]:
    return _load()


def set_all_flags(flags: Dict[str, bool]) -> None:
    """Bulk-set all flags at once (used by Select All / Unselect All)."""
    existing = _load()
    existing.update(flags)
    _save(existing)
