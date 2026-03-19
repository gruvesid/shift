from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from datetime import datetime
from app.database import Base


class User(Base):
    __tablename__ = "users"

    id                   = Column(Integer, primary_key=True, index=True)
    tenant_id            = Column(Integer, ForeignKey("tenants.id"), nullable=True)
    email                = Column(String, unique=True, nullable=False, index=True)
    name                 = Column(String, nullable=False)
    password_hash        = Column(String, nullable=True)
    role                 = Column(String, default="user")       # admin / user
    approval_status      = Column(String, default="approved")   # pending / approved / rejected
    is_active            = Column(Boolean, default=True)
    email_verified       = Column(Boolean, default=False)
    plan                 = Column(String, default="trial")      # trial/starter/pro/enterprise
    trial_ends_at        = Column(DateTime, nullable=True)
    activation_token     = Column(String, nullable=True)
    activation_expires_at = Column(DateTime, nullable=True)
    last_login_at        = Column(DateTime, nullable=True)
    created_at           = Column(DateTime, default=datetime.utcnow)
    updated_at           = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
