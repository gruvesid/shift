from sqlalchemy import Column, Integer, String, Text, DateTime
from datetime import datetime, timezone
from ..database import Base


class DeploymentPlanItem(Base):
    __tablename__ = "deployment_plan_items"

    id              = Column(Integer, primary_key=True, index=True)
    plan_id         = Column(Integer, nullable=False, index=True)
    item_type       = Column(String(50), nullable=False)   # apex_class | apex_trigger | lwc | aura | flow
    item_name       = Column(String(255), nullable=False)
    sf_id           = Column(String(100), nullable=True)
    source_code     = Column(Text, nullable=True)
    converted_code  = Column(Text, nullable=True)
    migration_notes = Column(Text, nullable=True)
    file_ext        = Column(String(20), nullable=True)

    # pending | converting | converted | failed
    convert_status  = Column(String(50), nullable=False, default="pending")
    error_message   = Column(Text, nullable=True)

    # D365 deployment: not_deployed | deploying | deployed | deploy_failed | manual
    deploy_status   = Column(String(50), nullable=True, default="not_deployed")
    deploy_log_id   = Column(Integer, nullable=True)   # FK to deployment_logs.id
    deploy_error    = Column(Text, nullable=True)
    deployed_at     = Column(DateTime, nullable=True)

    # Cost / run stats (JSON): { cost_usd, tokens_in, tokens_out, fix_attempts, deploy_attempts }
    stats_json      = Column(Text, nullable=True)

    created_at      = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at      = Column(DateTime, default=lambda: datetime.now(timezone.utc))
