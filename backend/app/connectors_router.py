"""
Connectors router — LLM Provider and Vector DB configuration management.

LLM:    Configure OpenAI, Anthropic, Cohere for Agent Chat and Code Converter.
Vector: Configure Qdrant, Pinecone for vector search / RAG.

API keys are encrypted with Fernet (AES-128) before storage and never returned
to the frontend after saving.
"""

import json
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .crypto import decrypt, encrypt
from .database import get_db
from .models.llm_config import LLMConfig
from .models.llm_routing import LLMRouting
from .models.vector_config import VectorConfig

router = APIRouter(prefix="/connectors", tags=["connectors"])


# ── Pydantic Schemas ──────────────────────────────────────────────────────────

class LLMCreate(BaseModel):
    provider: str               # openai | anthropic | cohere
    api_key: str
    model: str
    display_name: Optional[str] = None
    is_default: bool = False


class LLMUpdate(BaseModel):
    provider: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    display_name: Optional[str] = None


class LLMTestRequest(BaseModel):
    provider: str
    api_key: str
    model: str


class VectorCreate(BaseModel):
    provider: str               # qdrant | pinecone
    api_key: Optional[str] = ""
    url: Optional[str] = None
    display_name: Optional[str] = None
    embedding_model: Optional[str] = None
    vector_size: Optional[int] = None
    is_default: bool = False


class VectorUpdate(BaseModel):
    provider: Optional[str] = None
    api_key: Optional[str] = None
    url: Optional[str] = None
    display_name: Optional[str] = None
    embedding_model: Optional[str] = None
    vector_size: Optional[int] = None


class VectorTestRequest(BaseModel):
    provider: str
    api_key: Optional[str] = ""
    url: Optional[str] = None


# ── Serializers ───────────────────────────────────────────────────────────────

def _llm_to_dict(cfg: LLMConfig) -> dict:
    key_preview = None
    if cfg.api_key_encrypted:
        try:
            raw = decrypt(cfg.api_key_encrypted)
            key_preview = raw[:10] + "****" if len(raw) >= 10 else raw[:4] + "****"
        except Exception:
            pass
    return {
        "id":              cfg.id,
        "provider":        cfg.provider,
        "model":           cfg.model,
        "display_name":    cfg.display_name or f"{cfg.provider.title()} - {cfg.model}",
        "is_default":      bool(cfg.is_default),
        "api_key_preview": key_preview,
        "created_at":      cfg.created_at.isoformat() if cfg.created_at else None,
    }


def _vector_to_dict(cfg: VectorConfig) -> dict:
    return {
        "id":              cfg.id,
        "provider":        cfg.provider,
        "url":             cfg.url,
        "display_name":    cfg.display_name or cfg.provider.title(),
        "embedding_model": cfg.embedding_model,
        "vector_size":     cfg.vector_size,
        "is_default":      bool(cfg.is_default),
        "has_api_key":     bool(cfg.api_key_encrypted),
        "created_at":      cfg.created_at.isoformat() if cfg.created_at else None,
    }


# ── LLM Endpoints ─────────────────────────────────────────────────────────────

@router.get("/llm")
def list_llm_configs(db: Session = Depends(get_db)):
    configs = (
        db.query(LLMConfig)
        .order_by(LLMConfig.is_default.desc(), LLMConfig.created_at.desc())
        .all()
    )
    return {"configs": [_llm_to_dict(c) for c in configs]}


@router.post("/llm/test")
def test_llm_config(req: LLMTestRequest):
    """Test an LLM API key by making a minimal API call (no storage)."""
    try:
        if req.provider == "anthropic":
            import anthropic as _a
            _a.Anthropic(api_key=req.api_key).messages.create(
                model=req.model,
                max_tokens=5,
                messages=[{"role": "user", "content": "Hi"}],
            )
        elif req.provider == "cohere":
            import cohere as _c
            _c.Client(req.api_key).generate(model=req.model, prompt="Hi", max_tokens=5)
        else:  # openai
            from openai import OpenAI
            client = OpenAI(api_key=req.api_key)
            # o-series and newer models (o1, o3, o4, gpt-5, gpt-4.1) use max_completion_tokens
            _new_token_param = (
                req.model.startswith("o1") or
                req.model.startswith("o3") or
                req.model.startswith("o4") or
                req.model.startswith("gpt-5") or
                req.model.startswith("gpt-4.1")
            )
            kwargs = {"max_completion_tokens": 5} if _new_token_param else {"max_tokens": 5}
            client.chat.completions.create(
                model=req.model,
                messages=[{"role": "user", "content": "Hi"}],
                **kwargs,
            )
        return {"success": True, "message": "Connection successful"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/llm")
def create_llm_config(req: LLMCreate, db: Session = Depends(get_db)):
    if req.is_default:
        db.query(LLMConfig).update({"is_default": False})
    count = db.query(LLMConfig).count()
    is_default = req.is_default or count == 0

    cfg = LLMConfig(
        provider=req.provider,
        api_key_encrypted=encrypt(req.api_key),
        model=req.model,
        display_name=req.display_name or f"{req.provider.title()} - {req.model}",
        is_default=is_default,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return {"config": _llm_to_dict(cfg)}


@router.post("/llm/{config_id}/test")
def test_saved_llm_config(config_id: int, db: Session = Depends(get_db)):
    """Test a saved LLM config using the stored (decrypted) key."""
    cfg = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="LLM config not found.")
    try:
        api_key = decrypt(cfg.api_key_encrypted)
    except Exception:
        return {"success": False, "error": "Could not decrypt stored API key."}
    return test_llm_config(LLMTestRequest(provider=cfg.provider, api_key=api_key, model=cfg.model))


@router.put("/llm/{config_id}")
def update_llm_config(config_id: int, req: LLMUpdate, db: Session = Depends(get_db)):
    cfg = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="LLM config not found.")
    if req.provider is not None:
        cfg.provider = req.provider
    if req.api_key is not None:
        cfg.api_key_encrypted = encrypt(req.api_key)
    if req.model is not None:
        cfg.model = req.model
    if req.display_name is not None:
        cfg.display_name = req.display_name
    cfg.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(cfg)
    return {"config": _llm_to_dict(cfg)}


@router.post("/llm/{config_id}/set-default")
def set_llm_default(config_id: int, db: Session = Depends(get_db)):
    cfg = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="LLM config not found.")
    db.query(LLMConfig).update({"is_default": False})
    cfg.is_default = True
    cfg.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


@router.delete("/llm/{config_id}")
def delete_llm_config(config_id: int, db: Session = Depends(get_db)):
    cfg = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="LLM config not found.")
    was_default = cfg.is_default
    db.delete(cfg)
    db.commit()
    if was_default:
        nxt = db.query(LLMConfig).order_by(LLMConfig.created_at.desc()).first()
        if nxt:
            nxt.is_default = True
            db.commit()
    return {"ok": True}


# ── Vector Endpoints ───────────────────────────────────────────────────────────

@router.get("/vector")
def list_vector_configs(db: Session = Depends(get_db)):
    configs = (
        db.query(VectorConfig)
        .order_by(VectorConfig.is_default.desc(), VectorConfig.created_at.desc())
        .all()
    )
    return {"configs": [_vector_to_dict(c) for c in configs]}


@router.post("/vector/test")
def test_vector_config(req: VectorTestRequest):
    """Test a vector DB connection without saving."""
    try:
        if req.provider == "qdrant":
            from qdrant_client import QdrantClient
            if req.url:
                client = QdrantClient(url=req.url, api_key=req.api_key or None)
            else:
                local_path = os.path.join(
                    os.path.dirname(__file__), "..", "data", "qdrant_storage"
                )
                client = QdrantClient(path=local_path)
            collections = [c.name for c in client.get_collections().collections]
            return {
                "success": True,
                "message": f"Connected — {len(collections)} collection(s) found.",
                "collections": collections,
            }
        elif req.provider == "pinecone":
            try:
                from pinecone import Pinecone
                pc = Pinecone(api_key=req.api_key)
                indexes = list(pc.list_indexes().names())
                return {
                    "success": True,
                    "message": f"Connected — {len(indexes)} index(es) found.",
                    "indexes": indexes,
                }
            except ImportError:
                return {"success": False, "error": "pinecone-client not installed."}
        else:
            return {"success": False, "error": f"Unknown provider: {req.provider}"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/vector")
def create_vector_config(req: VectorCreate, db: Session = Depends(get_db)):
    if req.is_default:
        db.query(VectorConfig).update({"is_default": False})
    count = db.query(VectorConfig).count()
    is_default = req.is_default or count == 0

    cfg = VectorConfig(
        provider=req.provider,
        api_key_encrypted=encrypt(req.api_key or ""),
        url=req.url,
        display_name=req.display_name or req.provider.title(),
        embedding_model=req.embedding_model,
        vector_size=req.vector_size,
        is_default=is_default,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return {"config": _vector_to_dict(cfg)}


@router.put("/vector/{config_id}")
def update_vector_config(config_id: int, req: VectorUpdate, db: Session = Depends(get_db)):
    cfg = db.query(VectorConfig).filter(VectorConfig.id == config_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="Vector config not found.")
    update_data = req.model_dump(exclude_unset=True)
    if req.provider is not None:
        cfg.provider = req.provider
    if "api_key" in update_data and req.api_key is not None:
        cfg.api_key_encrypted = encrypt(req.api_key)
    if "url" in update_data:
        cfg.url = req.url          # allows clearing to None
    if req.display_name is not None:
        cfg.display_name = req.display_name
    if req.embedding_model is not None:
        cfg.embedding_model = req.embedding_model
    if req.vector_size is not None:
        cfg.vector_size = req.vector_size
    cfg.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(cfg)
    return {"config": _vector_to_dict(cfg)}


@router.post("/vector/{config_id}/set-default")
def set_vector_default(config_id: int, db: Session = Depends(get_db)):
    cfg = db.query(VectorConfig).filter(VectorConfig.id == config_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="Vector config not found.")
    db.query(VectorConfig).update({"is_default": False})
    cfg.is_default = True
    cfg.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


@router.post("/vector/{config_id}/test")
def test_saved_vector_config(config_id: int, db: Session = Depends(get_db)):
    """Test a saved vector config by its DB id."""
    cfg = db.query(VectorConfig).filter(VectorConfig.id == config_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="Vector config not found.")
    api_key = decrypt(cfg.api_key_encrypted) if cfg.api_key_encrypted else ""
    return test_vector_config(VectorTestRequest(provider=cfg.provider, api_key=api_key, url=cfg.url))


@router.delete("/vector/{config_id}")
def delete_vector_config(config_id: int, db: Session = Depends(get_db)):
    cfg = db.query(VectorConfig).filter(VectorConfig.id == config_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="Vector config not found.")
    was_default = cfg.is_default
    db.delete(cfg)
    db.commit()
    if was_default:
        nxt = db.query(VectorConfig).order_by(VectorConfig.created_at.desc()).first()
        if nxt:
            nxt.is_default = True
            db.commit()
    return {"ok": True}


# ── LLM Routing (task-based model assignment + fix loop) ──────────────────────

_TASK_KEYS = {
    "code_convert": "code_convert_llm_id",
    "validate":     "validate_llm_id",
    "agent_chat":   "agent_chat_llm_id",
    "indexing":     "indexing_llm_id",
}

_DEFAULT_ROUTING = {
    "code_convert_llm_id":    None,
    "validate_llm_id":        None,
    "agent_chat_llm_id":      None,
    "indexing_llm_id":        None,
    "fix_loop_max_retries":   3,
    "fix_loop_escalate_after": 2,
    "fix_loop_escalate_llm_id": None,
}


@router.get("/llm-routing")
def get_llm_routing(db: Session = Depends(get_db)):
    """Return current task routing + fix loop config."""
    row = db.query(LLMRouting).filter(LLMRouting.id == 1).first()
    stored = json.loads(row.config_json or "{}") if row else {}
    return {**_DEFAULT_ROUTING, **stored}


@router.put("/llm-routing")
def save_llm_routing(body: dict, db: Session = Depends(get_db)):
    """Save task routing + fix loop config."""
    row = db.query(LLMRouting).filter(LLMRouting.id == 1).first()
    if row:
        row.config_json = json.dumps(body)
        row.updated_at  = datetime.now(timezone.utc)
    else:
        row = LLMRouting(id=1, config_json=json.dumps(body))
        db.add(row)
    db.commit()
    return {"ok": True}


# ── Helpers used by shift_router (LLM + Vector resolution) ───────────────────

def _cfg_to_dict(cfg: LLMConfig) -> dict:
    return {
        "id":       cfg.id,
        "provider": cfg.provider,
        "api_key":  decrypt(cfg.api_key_encrypted),
        "model":    cfg.model,
    }


def _routing_cfg(db: Session) -> dict:
    row = db.query(LLMRouting).filter(LLMRouting.id == 1).first()
    stored = json.loads(row.config_json or "{}") if row else {}
    return {**_DEFAULT_ROUTING, **stored}


def get_llm_for_task(db: Session, task_type: Optional[str] = None) -> Optional[dict]:
    """
    Return {id, provider, api_key, model} for a task type.
    Falls back to the default LLM if no specific assignment is set.
    task_type: 'code_convert' | 'validate' | 'agent_chat' | 'indexing' | None
    """
    routing = _routing_cfg(db)
    cfg_id = routing.get(_TASK_KEYS.get(task_type or "", ""), None) if task_type else None

    if cfg_id:
        cfg = db.query(LLMConfig).filter(LLMConfig.id == cfg_id).first()
    else:
        cfg = db.query(LLMConfig).filter(LLMConfig.is_default == True).first()  # noqa: E712
        if not cfg:
            cfg = db.query(LLMConfig).order_by(LLMConfig.created_at.asc()).first()

    return _cfg_to_dict(cfg) if cfg else None


def get_llm_for_escalation(db: Session) -> Optional[dict]:
    """Return the escalation LLM config (used on final fix-loop attempts)."""
    routing = _routing_cfg(db)
    esc_id = routing.get("fix_loop_escalate_llm_id")
    if esc_id:
        cfg = db.query(LLMConfig).filter(LLMConfig.id == esc_id).first()
        return _cfg_to_dict(cfg) if cfg else None
    return None


def get_fix_loop_settings(db: Session) -> dict:
    """Return {max_retries, escalate_after} from routing config."""
    routing = _routing_cfg(db)
    return {
        "max_retries":    int(routing.get("fix_loop_max_retries", 3)),
        "escalate_after": int(routing.get("fix_loop_escalate_after", 2)),
    }


def get_default_llm(db: Session) -> Optional[dict]:
    """Backward-compat alias → uses default LLM."""
    return get_llm_for_task(db, None)


def get_default_qdrant_client(db: Session):
    """Return a QdrantClient configured from DB default (Qdrant provider), or local file fallback."""
    from qdrant_client import QdrantClient

    cfg = (
        db.query(VectorConfig)
        .filter(VectorConfig.provider == "qdrant", VectorConfig.is_default == True)  # noqa: E712
        .first()
    )
    if not cfg:
        cfg = (
            db.query(VectorConfig)
            .filter(VectorConfig.provider == "qdrant")
            .order_by(VectorConfig.created_at.asc())
            .first()
        )

    if cfg and cfg.url:
        api_key = decrypt(cfg.api_key_encrypted) if cfg.api_key_encrypted else None
        return QdrantClient(url=cfg.url, api_key=api_key or None)

    # Fallback: local file-based Qdrant
    local_path = os.path.join(os.path.dirname(__file__), "..", "data", "qdrant_storage")
    os.makedirs(local_path, exist_ok=True)
    return QdrantClient(path=local_path)
