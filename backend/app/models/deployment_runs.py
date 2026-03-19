"""
Deployment runs — one row per deployment job to Dynamics 365.
Tracks what was deployed, in which order, and the result.
"""

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, Float
from app.database import Base


class DeploymentRun(Base):
    __tablename__ = "deployment_runs"

    id = Column(Integer, primary_key=True, index=True)

    # Unique deployment job identifier (UUID)
    run_id = Column(String(64), unique=True, nullable=False, index=True)

    # The extraction run that provided the converted items
    extraction_run_id = Column(String(64), nullable=True, index=True)

    # Which Dynamics 365 connection was used
    d365_connection_name = Column(String(255), nullable=False)

    # pending | running | completed | failed | partial
    status = Column(String(50), nullable=False, default="pending", index=True)

    # Deployment type: schema | plugins | webresources | full
    deployment_type = Column(String(50), nullable=False, default="full")

    # JSON array of deployed component summaries
    # e.g. [{"name": "AccountService", "type": "apex_class", "status": "deployed", "d365_id": "..."}]
    deployed_items_json = Column(Text, nullable=True)

    # Counts for quick display
    total_items = Column(Integer, default=0)
    deployed_count = Column(Integer, default=0)
    failed_count = Column(Integer, default=0)

    # Cumulative LLM cost for all conversions in this run
    total_cost_usd = Column(Float, default=0.0)

    error = Column(Text, nullable=True)

    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    def __repr__(self):
        return f"<DeploymentRun run_id={self.run_id!r} status={self.status!r}>"
