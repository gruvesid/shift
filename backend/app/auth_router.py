"""
Auth router — login, forgot/reset password, OTP verify, trial request, activation.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.otp_token import OTPToken
from app.models.trial_request import TrialRequest
from app.models.tenant import Tenant
from app.services.auth_service import (
    verify_password, get_password_hash, create_access_token,
    generate_otp, generate_activation_token, get_current_user,
)
from app.services.email_service import (
    send_otp_email, send_activation_email,
    send_trial_request_admin, send_rejection_email,
    send_password_changed_email,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

OTP_EXPIRE_MINUTES = 10
OTP_MAX_ATTEMPTS   = 5


# ── Request / Response Models ─────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str

class ForgotPasswordRequest(BaseModel):
    email: str

class ResetPasswordRequest(BaseModel):
    email: str
    otp: str
    new_password: str

class VerifyEmailRequest(BaseModel):
    email: str
    otp: str

class ResendOTPRequest(BaseModel):
    email: str
    purpose: str  # verify-email / reset-password

class AskTrialRequest(BaseModel):
    name: str
    email: str
    company: Optional[str] = None
    message: Optional[str] = None

class ActivateRequest(BaseModel):
    token: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _user_dict(user: User) -> dict:
    return {
        "id":             user.id,
        "email":          user.email,
        "name":           user.name,
        "role":           user.role,
        "plan":           user.plan,
        "tenant_id":      user.tenant_id,
        "approval_status": user.approval_status,
        "is_active":      user.is_active,
        "email_verified": user.email_verified,
        "trial_ends_at":  user.trial_ends_at.isoformat() if user.trial_ends_at else None,
        "last_login_at":  user.last_login_at.isoformat() if user.last_login_at else None,
        "created_at":     user.created_at.isoformat() if user.created_at else None,
    }


def _create_otp(db: Session, email: str, purpose: str) -> str:
    # Delete existing OTPs for same email+purpose
    db.query(OTPToken).filter(
        OTPToken.email == email.lower(),
        OTPToken.purpose == purpose,
    ).delete()
    db.commit()

    code = generate_otp()
    otp = OTPToken(
        email=email.lower(),
        purpose=purpose,
        code=code,
        attempts=0,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=OTP_EXPIRE_MINUTES),
    )
    db.add(otp)
    db.commit()
    return code


def _verify_otp(db: Session, email: str, purpose: str, code: str) -> bool:
    otp = db.query(OTPToken).filter(
        OTPToken.email == email.lower(),
        OTPToken.purpose == purpose,
    ).first()

    if not otp:
        raise HTTPException(status_code=400, detail="OTP not found. Please request a new one.")

    now = datetime.now(timezone.utc)
    expires = otp.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)

    if now > expires:
        db.delete(otp)
        db.commit()
        raise HTTPException(status_code=400, detail="OTP has expired. Please request a new one.")

    if otp.attempts >= OTP_MAX_ATTEMPTS:
        db.delete(otp)
        db.commit()
        raise HTTPException(status_code=400, detail="Too many failed attempts. Please request a new OTP.")

    if otp.code != code:
        otp.attempts += 1
        db.commit()
        remaining = OTP_MAX_ATTEMPTS - otp.attempts
        raise HTTPException(status_code=400, detail=f"Invalid OTP. {remaining} attempts remaining.")

    # Valid — clean up
    db.delete(otp)
    db.commit()
    return True


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/login")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.lower()).first()
    if not user or not user.password_hash:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is deactivated. Contact support.")

    if user.approval_status == "pending":
        raise HTTPException(status_code=403, detail="Account pending approval. You will receive an email once approved.")

    if user.approval_status == "rejected":
        raise HTTPException(status_code=403, detail="Account access was denied. Contact support.")

    # Check trial expiry
    if user.plan == "trial" and user.trial_ends_at:
        ends = user.trial_ends_at
        if ends.tzinfo is None:
            ends = ends.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > ends:
            raise HTTPException(status_code=403, detail="Your trial has expired. Contact support to extend access.")

    # Update last login
    user.last_login_at = datetime.now(timezone.utc)
    db.commit()

    token = create_access_token({"sub": str(user.id), "role": user.role})
    return {"access_token": token, "token_type": "bearer", "user": _user_dict(user)}


@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    return _user_dict(current_user)


@router.post("/forgot-password")
def forgot_password(req: ForgotPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.lower()).first()
    # Always return success to prevent email enumeration
    if user and user.is_active:
        otp = _create_otp(db, req.email, "reset-password")
        send_otp_email(req.email, otp, "reset-password")
        log.info(f"[AUTH] Password reset OTP sent to {req.email}")
    return {"message": "If that email is registered, you will receive a reset code shortly."}


@router.post("/reset-password")
def reset_password(req: ResetPasswordRequest, db: Session = Depends(get_db)):
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    _verify_otp(db, req.email, "reset-password", req.otp)

    user = db.query(User).filter(User.email == req.email.lower()).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    user.password_hash = get_password_hash(req.new_password)
    user.updated_at    = datetime.now(timezone.utc)
    db.commit()

    send_password_changed_email(user.email, user.name)
    return {"message": "Password reset successfully. You can now log in."}


@router.post("/verify-email")
def verify_email(req: VerifyEmailRequest, db: Session = Depends(get_db)):
    _verify_otp(db, req.email, "verify-email", req.otp)

    user = db.query(User).filter(User.email == req.email.lower()).first()
    if user:
        user.email_verified = True
        user.updated_at     = datetime.now(timezone.utc)
        db.commit()

    return {"message": "Email verified successfully."}


@router.post("/resend-otp")
def resend_otp(req: ResendOTPRequest, db: Session = Depends(get_db)):
    if req.purpose not in ("verify-email", "reset-password"):
        raise HTTPException(status_code=400, detail="Invalid OTP purpose.")

    user = db.query(User).filter(User.email == req.email.lower()).first()
    if user:
        otp = _create_otp(db, req.email, req.purpose)
        send_otp_email(req.email, otp, req.purpose)

    return {"message": "OTP resent if email is registered."}


@router.post("/ask-trial")
def ask_trial(req: AskTrialRequest, db: Session = Depends(get_db)):
    email_lower = req.email.lower()

    # Check if already submitted
    existing = db.query(TrialRequest).filter(
        TrialRequest.email == email_lower,
        TrialRequest.status == "pending",
    ).first()
    if existing:
        return {"message": "A trial request for this email is already pending review.", "status": "pending"}

    # Check if user already exists
    user = db.query(User).filter(User.email == email_lower).first()
    if user:
        return {"message": "An account with this email already exists. Please log in.", "status": "exists"}

    tr = TrialRequest(
        email=email_lower,
        name=req.name,
        company=req.company,
        message=req.message,
        status="pending",
    )
    db.add(tr)
    db.commit()
    db.refresh(tr)

    # Notify admin
    send_trial_request_admin(req.name, req.email, req.company or "", req.message or "")

    return {"message": "Your trial request has been submitted. You will receive an email once reviewed.", "status": "submitted", "id": tr.id}


@router.get("/activate")
def get_activation(token: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.activation_token == token).first()
    if not user:
        raise HTTPException(status_code=404, detail="Activation link is invalid or has expired.")

    now = datetime.now(timezone.utc)
    expires = user.activation_expires_at
    if expires:
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if now > expires:
            raise HTTPException(status_code=400, detail="Activation link has expired. Contact support.")

    return {"email": user.email, "name": user.name, "plan": user.plan, "trial_days": _trial_days(user)}


def _trial_days(user: User) -> int:
    if not user.trial_ends_at:
        return 0
    now = datetime.now(timezone.utc)
    ends = user.trial_ends_at
    if ends.tzinfo is None:
        ends = ends.replace(tzinfo=timezone.utc)
    delta = ends - now
    return max(0, delta.days)


@router.post("/activate")
def activate_account(req: ActivateRequest, db: Session = Depends(get_db)):
    if len(req.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    user = db.query(User).filter(User.activation_token == req.token).first()
    if not user:
        raise HTTPException(status_code=404, detail="Activation link is invalid or has expired.")

    now = datetime.now(timezone.utc)
    expires = user.activation_expires_at
    if expires:
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if now > expires:
            raise HTTPException(status_code=400, detail="Activation link has expired. Contact support.")

    user.password_hash        = get_password_hash(req.password)
    user.email_verified       = True
    user.is_active            = True
    user.approval_status      = "approved"
    user.activation_token     = None
    user.activation_expires_at = None
    user.last_login_at        = now
    user.updated_at           = now
    db.commit()

    token = create_access_token({"sub": str(user.id), "role": user.role})
    return {"message": "Account activated successfully.", "access_token": token, "user": _user_dict(user)}


@router.post("/init-admin")
def init_admin(db: Session = Depends(get_db)):
    """One-time endpoint to create/reset the default admin user."""
    from app.models.tenant import Tenant
    from passlib.context import CryptContext
    pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

    tenant = db.query(Tenant).filter(Tenant.slug == "gruve").first()
    if not tenant:
        tenant = Tenant(name="Gruve AI", slug="gruve", plan="enterprise", is_active=True)
        db.add(tenant)
        db.commit()
        db.refresh(tenant)

    admin = db.query(User).filter(User.email == "siddhrajsinh.atodaria@gruve.ai").first()
    if not admin:
        admin = User(
            tenant_id=tenant.id,
            email="siddhrajsinh.atodaria@gruve.ai",
            name="Siddhrajsinh Atodaria",
            password_hash=pwd.hash("Test123"),
            role="admin", plan="enterprise",
            approval_status="approved",
            is_active=True, email_verified=True,
        )
        db.add(admin)
        db.commit()
        return {"message": "Admin created"}
    else:
        admin.password_hash  = pwd.hash("Test123")
        admin.role           = "admin"
        admin.is_active      = True
        admin.email_verified = True
        admin.approval_status = "approved"
        db.commit()
        return {"message": "Admin updated"}


@router.post("/change-password")
def change_password(
    req: ChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not verify_password(req.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")

    current_user.password_hash = get_password_hash(req.new_password)
    current_user.updated_at    = datetime.now(timezone.utc)
    db.commit()

    send_password_changed_email(current_user.email, current_user.name)
    return {"message": "Password changed successfully."}
