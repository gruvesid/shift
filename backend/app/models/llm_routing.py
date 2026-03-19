from sqlalchemy import Column, DateTime, Integer, Text
from datetime import datetime, timezone
from ..database import Base


class LLMRouting(Base):
    __tablename__ = "llm_routing"

    id          = Column(Integer, primary_key=True)   # always row id=1
    config_json = Column(Text, default="{}")
    updated_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))
