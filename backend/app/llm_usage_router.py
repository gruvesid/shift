"""
LLM Usage router — history and aggregate stats for the LLM Usage History page.
Regular users see only their own records.
Admin users can see all records and filter by user_id.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from .database import get_db
from .models.llm_usage import LLMUsage
from .models.user import User
from .services.auth_service import get_current_user

router = APIRouter(prefix="/llm-usage", tags=["llm-usage"])


def _row_to_dict(row: LLMUsage) -> dict:
    return {
        "id":             row.id,
        "user_id":        row.user_id,
        "call_type":      row.call_type,
        "provider":       row.provider,
        "model":          row.model,
        "connection_id":  row.connection_id,
        "org_name":       row.org_name,
        "input_tokens":   row.input_tokens  or 0,
        "output_tokens":  row.output_tokens or 0,
        "total_tokens":   row.total_tokens  or 0,
        "cost_usd":       row.cost_usd      or 0.0,
        "duration_ms":    row.duration_ms,
        "status":         row.status,
        "error_message":  row.error_message,
        "component_name": row.component_name,
        "component_type": row.component_type,
        "created_at":     row.created_at.isoformat() if row.created_at else None,
    }


def _apply_user_scope(q, current_user, filter_user_id: Optional[int]):
    """Scope query to user. Admin can optionally filter by a specific user_id."""
    if current_user.role == "admin":
        if filter_user_id is not None:
            q = q.filter(LLMUsage.user_id == filter_user_id)
    else:
        q = q.filter(LLMUsage.user_id == current_user.id)
    return q


@router.get("/users")
def llm_usage_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Admin only — returns list of users who have LLM usage records."""
    if current_user.role != "admin":
        return {"users": []}
    rows = (
        db.query(User.id, User.name, User.email)
        .join(LLMUsage, LLMUsage.user_id == User.id)
        .distinct()
        .all()
    )
    return {"users": [{"id": r.id, "name": r.name, "email": r.email} for r in rows]}


@router.get("/models")
def llm_usage_models(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    user_id: Optional[int] = Query(None),
):
    """Return distinct model names that have usage records."""
    q = db.query(LLMUsage.model).distinct()
    q = _apply_user_scope(q, current_user, user_id)
    models = sorted([r.model for r in q.all() if r.model])
    return {"models": models}


@router.get("/stats")
def llm_usage_stats(
    call_type: Optional[str] = Query(None),
    model:     Optional[str] = Query(None),
    user_id:   Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Aggregate totals (total calls, tokens, cost)."""
    q = db.query(LLMUsage)
    q = _apply_user_scope(q, current_user, user_id)
    if call_type:
        q = q.filter(LLMUsage.call_type == call_type)
    if model:
        q = q.filter(LLMUsage.model == model)

    rows = q.all()
    return {
        "total_calls":    len(rows),
        "input_tokens":   sum(r.input_tokens  or 0 for r in rows),
        "output_tokens":  sum(r.output_tokens or 0 for r in rows),
        "total_tokens":   sum(r.total_tokens  or 0 for r in rows),
        "total_cost_usd": round(sum(r.cost_usd or 0 for r in rows), 6),
    }


@router.get("/history")
def llm_usage_history(
    call_type: Optional[str] = Query(None),
    model:     Optional[str] = Query(None),
    user_id:   Optional[int] = Query(None),
    limit:     int           = Query(100, le=500),
    offset:    int           = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Paginated history list, newest first."""
    q = db.query(LLMUsage)
    q = _apply_user_scope(q, current_user, user_id)
    if call_type:
        q = q.filter(LLMUsage.call_type == call_type)
    if model:
        q = q.filter(LLMUsage.model == model)

    total = q.count()
    rows  = q.order_by(LLMUsage.created_at.desc()).offset(offset).limit(limit).all()

    return {
        "total":   total,
        "offset":  offset,
        "limit":   limit,
        "history": [_row_to_dict(r) for r in rows],
    }
