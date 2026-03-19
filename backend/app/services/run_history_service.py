"""
Local persistence for migration pipeline run history.
Stores completed runs in a JSON file so they survive backend restarts.
"""
import json
import os
from typing import Dict, List
from datetime import datetime

_HISTORY_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'run_history.json')
_MAX_RUNS = 50  # keep last N runs


def _load() -> List[Dict]:
    try:
        with open(_HISTORY_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save(data: List[Dict]) -> None:
    with open(_HISTORY_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


def add_run(run: Dict) -> None:
    """Append a run record. Keeps only the last _MAX_RUNS entries."""
    history = _load()
    run["saved_at"] = datetime.utcnow().isoformat() + "Z"
    history.insert(0, run)  # newest first
    _save(history[:_MAX_RUNS])


def get_history() -> List[Dict]:
    """Return all stored runs, newest first."""
    return _load()
