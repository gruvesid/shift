from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text
from datetime import datetime, timezone
from ..database import Base


class LLMConfig(Base):
    __tablename__ = "llm_configs"

    id                = Column(Integer, primary_key=True)
    provider          = Column(String(50),  nullable=False)   # openai | anthropic | cohere
    api_key_encrypted = Column(Text,        nullable=False)
    model             = Column(String(100), nullable=False)
    display_name      = Column(String(200))
    is_default        = Column(Boolean, default=False, nullable=False)
    created_at        = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at        = Column(DateTime, default=lambda: datetime.now(timezone.utc))
