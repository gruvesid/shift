from sqlalchemy import Column, Integer, String, Text, DateTime
from datetime import datetime, timezone
from ..database import Base


class DeploymentPlan(Base):
    __tablename__ = "deployment_plans"

    id              = Column(Integer, primary_key=True, index=True)
    connection_id   = Column(Integer, nullable=False, index=True)
    name            = Column(String(200), nullable=False)
    description     = Column(Text, nullable=True)
    # draft | deploying | completed | partial | failed
    status          = Column(String(50), nullable=False, default="draft", index=True)
    total_items     = Column(Integer, default=0)
    converted_count = Column(Integer, default=0)
    failed_count    = Column(Integer, default=0)
    started_at      = Column(DateTime, nullable=True)
    completed_at    = Column(DateTime, nullable=True)
    created_at      = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at      = Column(DateTime, default=lambda: datetime.now(timezone.utc))
