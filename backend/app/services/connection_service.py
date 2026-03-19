import json
import os
from typing import Dict

# Configs are persisted to a local JSON file so they survive server restarts.
# ⚠️  This file contains plaintext secrets — ensure it is gitignored and the
#     directory is access-controlled. For production use a secrets manager
#     (Azure Key Vault, HashiCorp Vault, etc.)
_CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'configs.json')


def _load() -> Dict[str, Dict]:
    try:
        with open(_CONFIG_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(data: Dict[str, Dict]) -> None:
    with open(_CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


class ConnectionService:
    def __init__(self):
        self.configs: Dict[str, Dict] = _load()

    def add_config(self, name: str, config: Dict):
        self.configs[name] = config
        _save(self.configs)

    def get_config(self, name: str):
        return self.configs.get(name)

    def list_configs(self):
        return list(self.configs.keys())

    def delete_config(self, name: str) -> bool:
        if name not in self.configs:
            return False
        del self.configs[name]
        _save(self.configs)
        return True
