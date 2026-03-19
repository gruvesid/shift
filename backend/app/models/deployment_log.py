"""
DeploymentLog — one row per D365 deployment attempt (individual or bulk plan item).
Stores step-by-step log in DB (truncated) + full log file path for download.
"""

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime
from ..database import Base


class DeploymentLog(Base):
    __tablename__ = "deployment_logs"

    id               = Column(Integer, primary_key=True, index=True)

    # Owner (user who owns the connection this log belongs to)
    user_id          = Column(Integer, nullable=True, index=True)

    # Which org connection this belongs to
    connection_id    = Column(Integer, nullable=False, index=True)

    # Component info
    component_type   = Column(String(50), nullable=False)   # apex_class | apex_trigger | lwc | aura | flow
    component_name   = Column(String(255), nullable=False)

    # Source of the deploy: "converter" (individual) or "plan" (bulk)
    source           = Column(String(50), default="converter")
    source_item_id   = Column(Integer, nullable=True)   # DeploymentPlanItem.id or code_converter item_id
    plan_id          = Column(Integer, nullable=True, index=True)

    # Status: running | success | failed | partial | manual
    status           = Column(String(50), default="running", index=True)

    # Log stored in DB (capped at 50k chars for fast queries)
    log_text         = Column(Text, nullable=True)

    # Full log file path for download (may be larger than DB log_text)
    log_file_path    = Column(String(500), nullable=True)

    # D365 deployment results
    assembly_id      = Column(String(100), nullable=True)   # Plugin assembly GUID
    step_ids_json    = Column(Text, nullable=True)          # JSON array of step GUIDs
    web_resource_id  = Column(String(100), nullable=True)   # Web resource GUID

    error_message    = Column(Text, nullable=True)

    # Power Automate flow URL (for flow deployments)
    flow_url         = Column(Text, nullable=True)

    created_at       = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    completed_at     = Column(DateTime, nullable=True)

    def __repr__(self):
        return f"<DeploymentLog id={self.id} component={self.component_name!r} status={self.status!r}>"
