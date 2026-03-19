"""
Admin router — user management, trial request approval, tenant management.
Requires admin role.
"""
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.tenant import Tenant
from app.models.trial_request import TrialRequest
from app.services.auth_service import get_password_hash, require_admin
from app.services.email_service import (
    send_activation_email, send_rejection_email,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/admin", tags=["admin"])


# ── Request Models ────────────────────────────────────────────────────────────

class CreateUserRequest(BaseModel):
    email: str
    name: str
    password: Optional[str] = None
    role: str = "user"
    plan: str = "trial"
    trial_days: int = 30
    tenant_id: Optional[int] = None
    send_invite: bool = False  # if True: generate activation token + email instead of setting password

class UpdateUserRequest(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    plan: Optional[str] = None
    is_active: Optional[bool] = None
    approval_status: Optional[str] = None
    trial_days: Optional[int] = None
    tenant_id: Optional[int] = None

class ApproveTrialRequest(BaseModel):
    trial_days: int = 30
    tenant_id: Optional[int] = None

class RejectTrialRequest(BaseModel):
    reason: Optional[str] = None

class CreateTenantRequest(BaseModel):
    name: str
    slug: str
    plan: str = "trial"

class UpdateTenantRequest(BaseModel):
    name: Optional[str] = None
    plan: Optional[str] = None
    is_active: Optional[bool] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _user_dict(user: User, db: Session) -> dict:
    tenant_name = None
    if user.tenant_id:
        t = db.query(Tenant).filter(Tenant.id == user.tenant_id).first()
        tenant_name = t.name if t else None
    return {
        "id":             user.id,
        "email":          user.email,
        "name":           user.name,
        "role":           user.role,
        "plan":           user.plan,
        "tenant_id":      user.tenant_id,
        "tenant_name":    tenant_name,
        "approval_status": user.approval_status,
        "is_active":      user.is_active,
        "email_verified": user.email_verified,
        "trial_ends_at":  user.trial_ends_at.isoformat() if user.trial_ends_at else None,
        "last_login_at":  user.last_login_at.isoformat() if user.last_login_at else None,
        "created_at":     user.created_at.isoformat() if user.created_at else None,
    }


def _tr_dict(tr: TrialRequest, db: Session) -> dict:
    approved_by_name = None
    if tr.approved_by:
        u = db.query(User).filter(User.id == tr.approved_by).first()
        approved_by_name = u.name if u else None
    tenant_name = None
    if tr.tenant_id:
        t = db.query(Tenant).filter(Tenant.id == tr.tenant_id).first()
        tenant_name = t.name if t else None
    return {
        "id":               tr.id,
        "email":            tr.email,
        "name":             tr.name,
        "company":          tr.company,
        "message":          tr.message,
        "status":           tr.status,
        "trial_days":       tr.trial_days,
        "tenant_id":        tr.tenant_id,
        "tenant_name":      tenant_name,
        "approved_by":      tr.approved_by,
        "approved_by_name": approved_by_name,
        "approved_at":      tr.approved_at.isoformat() if tr.approved_at else None,
        "rejected_at":      tr.rejected_at.isoformat() if tr.rejected_at else None,
        "rejected_reason":  tr.rejected_reason,
        "created_at":       tr.created_at.isoformat() if tr.created_at else None,
    }


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
def get_stats(db: Session = Depends(get_db), _=Depends(require_admin)):
    return {
        "total_users":      db.query(User).count(),
        "active_users":     db.query(User).filter(User.is_active == True).count(),
        "pending_trials":   db.query(TrialRequest).filter(TrialRequest.status == "pending").count(),
        "total_tenants":    db.query(Tenant).count(),
        "trial_users":      db.query(User).filter(User.plan == "trial").count(),
    }


# ── User Management ───────────────────────────────────────────────────────────

@router.get("/users")
def list_users(
    search: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    plan: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    tenant_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    q = db.query(User)
    if search:
        q = q.filter((User.email.ilike(f"%{search}%")) | (User.name.ilike(f"%{search}%")))
    if role:
        q = q.filter(User.role == role)
    if plan:
        q = q.filter(User.plan == plan)
    if status:
        q = q.filter(User.approval_status == status)
    if tenant_id:
        q = q.filter(User.tenant_id == tenant_id)
    users = q.order_by(User.created_at.desc()).all()
    return [_user_dict(u, db) for u in users]


@router.post("/users")
def create_user(req: CreateUserRequest, db: Session = Depends(get_db), admin=Depends(require_admin)):
    existing = db.query(User).filter(User.email == req.email.lower()).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered.")

    if not req.send_invite and not req.password:
        raise HTTPException(status_code=400, detail="Provide a password or enable Send Invite.")

    trial_ends = None
    if req.plan == "trial":
        trial_ends = datetime.now(timezone.utc) + timedelta(days=req.trial_days)

    activation_token = None
    if req.send_invite:
        activation_token = secrets.token_hex(32)

    user = User(
        email=req.email.lower(),
        name=req.name,
        password_hash=get_password_hash(req.password) if req.password else None,
        role=req.role,
        plan=req.plan,
        tenant_id=req.tenant_id,
        approval_status="approved",
        is_active=True,
        email_verified=not req.send_invite,
        activation_token=activation_token,
        activation_expires_at=datetime.now(timezone.utc) + timedelta(hours=72) if activation_token else None,
        trial_ends_at=trial_ends,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    if req.send_invite:
        send_activation_email(user.email, user.name, activation_token, req.trial_days)
        log.info(f"[ADMIN] User created + invite sent: {user.email} by {admin.email}")
    else:
        log.info(f"[ADMIN] User created: {user.email} by admin {admin.email}")

    return _user_dict(user, db)


@router.post("/users/{user_id}/resend-invite")
def resend_invite(user_id: int, db: Session = Depends(get_db), admin=Depends(require_admin)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.last_login_at:
        raise HTTPException(status_code=400, detail="User has already logged in.")

    activation_token = secrets.token_hex(32)
    user.activation_token      = activation_token
    user.activation_expires_at = datetime.now(timezone.utc) + timedelta(hours=72)
    user.email_verified        = False
    user.updated_at            = datetime.now(timezone.utc)
    db.commit()

    trial_days = 30
    if user.trial_ends_at:
        remaining = (user.trial_ends_at - datetime.now(timezone.utc)).days
        trial_days = max(remaining, 1)

    send_activation_email(user.email, user.name, activation_token, trial_days)
    log.info(f"[ADMIN] Invite resent to {user.email} by {admin.email}")
    return {"message": f"Activation email resent to {user.email}."}


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    req: UpdateUserRequest,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    if req.name is not None:
        user.name = req.name
    if req.role is not None:
        user.role = req.role
    if req.plan is not None:
        user.plan = req.plan
        if req.plan == "trial" and req.trial_days:
            user.trial_ends_at = datetime.now(timezone.utc) + timedelta(days=req.trial_days)
    if req.is_active is not None:
        user.is_active = req.is_active
    if req.approval_status is not None:
        user.approval_status = req.approval_status
    if req.trial_days is not None and user.plan == "trial":
        user.trial_ends_at = datetime.now(timezone.utc) + timedelta(days=req.trial_days)
    if req.tenant_id is not None:
        user.tenant_id = req.tenant_id

    user.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _user_dict(user, db)


@router.delete("/users/{user_id}")
def deactivate_user(user_id: int, db: Session = Depends(get_db), admin=Depends(require_admin)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account.")
    user.is_active  = False
    user.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": f"User {user.email} deactivated."}


# ── Trial Requests ────────────────────────────────────────────────────────────

@router.get("/trial-requests")
def list_trial_requests(
    status: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    q = db.query(TrialRequest)
    if status:
        q = q.filter(TrialRequest.status == status)
    items = q.order_by(TrialRequest.created_at.desc()).all()
    return [_tr_dict(tr, db) for tr in items]


@router.post("/trial-requests/{tr_id}/approve")
def approve_trial(
    tr_id: int,
    req: ApproveTrialRequest,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    tr = db.query(TrialRequest).filter(TrialRequest.id == tr_id).first()
    if not tr:
        raise HTTPException(status_code=404, detail="Trial request not found.")
    if tr.status != "pending":
        raise HTTPException(status_code=400, detail=f"Request is already {tr.status}.")

    # Check user doesn't exist yet
    existing = db.query(User).filter(User.email == tr.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="User with this email already exists.")

    # Create activation token
    activation_token = secrets.token_hex(32)
    trial_ends = datetime.now(timezone.utc) + timedelta(days=req.trial_days)

    # Create user account (inactive until they set password)
    user = User(
        email=tr.email,
        name=tr.name,
        role="user",
        plan="trial",
        tenant_id=req.tenant_id or tr.tenant_id,
        approval_status="approved",
        is_active=True,
        email_verified=False,
        activation_token=activation_token,
        activation_expires_at=datetime.now(timezone.utc) + timedelta(hours=72),
        trial_ends_at=trial_ends,
    )
    db.add(user)

    # Update trial request
    tr.status      = "approved"
    tr.approved_by = admin.id
    tr.approved_at = datetime.now(timezone.utc)
    tr.trial_days  = req.trial_days
    if req.tenant_id:
        tr.tenant_id = req.tenant_id

    db.commit()

    # Send activation email
    send_activation_email(tr.email, tr.name, activation_token, req.trial_days)
    log.info(f"[ADMIN] Trial approved: {tr.email} by {admin.email}")

    return {"message": f"Trial approved. Activation email sent to {tr.email}.", "trial_days": req.trial_days}


@router.post("/trial-requests/{tr_id}/reject")
def reject_trial(
    tr_id: int,
    req: RejectTrialRequest,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    tr = db.query(TrialRequest).filter(TrialRequest.id == tr_id).first()
    if not tr:
        raise HTTPException(status_code=404, detail="Trial request not found.")
    if tr.status != "pending":
        raise HTTPException(status_code=400, detail=f"Request is already {tr.status}.")

    tr.status          = "rejected"
    tr.rejected_at     = datetime.now(timezone.utc)
    tr.rejected_reason = req.reason
    tr.approved_by     = admin.id
    db.commit()

    send_rejection_email(tr.email, tr.name, req.reason or "")
    log.info(f"[ADMIN] Trial rejected: {tr.email} by {admin.email}")
    return {"message": f"Request rejected. Notification sent to {tr.email}."}


# ── Tenant Management ─────────────────────────────────────────────────────────

@router.get("/tenants")
def list_tenants(db: Session = Depends(get_db), _=Depends(require_admin)):
    tenants = db.query(Tenant).order_by(Tenant.created_at.desc()).all()
    return [
        {
            "id":         t.id,
            "name":       t.name,
            "slug":       t.slug,
            "plan":       t.plan,
            "is_active":  t.is_active,
            "user_count": db.query(User).filter(User.tenant_id == t.id).count(),
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t in tenants
    ]


@router.post("/tenants")
def create_tenant(req: CreateTenantRequest, db: Session = Depends(get_db), _=Depends(require_admin)):
    existing = db.query(Tenant).filter(Tenant.slug == req.slug.lower()).first()
    if existing:
        raise HTTPException(status_code=400, detail="Tenant slug already exists.")
    t = Tenant(name=req.name, slug=req.slug.lower(), plan=req.plan)
    db.add(t)
    db.commit()
    db.refresh(t)
    return {"id": t.id, "name": t.name, "slug": t.slug, "plan": t.plan}


@router.patch("/tenants/{tenant_id}")
def update_tenant(
    tenant_id: int,
    req: UpdateTenantRequest,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    t = db.query(Tenant).filter(Tenant.id == tenant_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Tenant not found.")
    if req.name is not None:
        t.name = req.name
    if req.plan is not None:
        t.plan = req.plan
    if req.is_active is not None:
        t.is_active = req.is_active
    t.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"id": t.id, "name": t.name, "slug": t.slug, "plan": t.plan, "is_active": t.is_active}
