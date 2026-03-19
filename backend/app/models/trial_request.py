from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey
from datetime import datetime
from app.database import Base


class TrialRequest(Base):
    __tablename__ = "trial_requests"

    id              = Column(Integer, primary_key=True, index=True)
    email           = Column(String, nullable=False, index=True)
    name            = Column(String, nullable=False)
    company         = Column(String, nullable=True)
    message         = Column(Text, nullable=True)
    status          = Column(String, default="pending")   # pending / approved / rejected
    tenant_id       = Column(Integer, ForeignKey("tenants.id"), nullable=True)
    approved_by     = Column(Integer, ForeignKey("users.id"), nullable=True)
    approved_at     = Column(DateTime, nullable=True)
    rejected_at     = Column(DateTime, nullable=True)
    rejected_reason = Column(Text, nullable=True)
    trial_days      = Column(Integer, default=30)
    created_at      = Column(DateTime, default=datetime.utcnow)
