"""
Tracks every LLM API call made by the application.
Used for the LLM Usage History page.
"""

from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer, String, Text
from app.database import Base


class LLMUsage(Base):
    __tablename__ = "llm_usage"

    id             = Column(Integer, primary_key=True)
    user_id        = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    call_type      = Column(String(50),  nullable=False)   # code_convert | agent_chat | indexing | sense
    provider       = Column(String(50),  nullable=True)    # openai | anthropic | cohere
    model          = Column(String(100), nullable=True)
    connection_id  = Column(Integer, ForeignKey("connections.id", ondelete="SET NULL"), nullable=True)
    org_name       = Column(String(255), nullable=True)
    input_tokens   = Column(Integer, default=0)
    output_tokens  = Column(Integer, default=0)
    total_tokens   = Column(Integer, default=0)
    cost_usd       = Column(Float,   default=0.0)
    duration_ms    = Column(Integer, nullable=True)
    status         = Column(String(20), default="success")  # success | error
    error_message  = Column(Text,    nullable=True)
    component_name = Column(String(255), nullable=True)
    component_type = Column(String(50),  nullable=True)
    extra_json     = Column(Text, nullable=True)
    created_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
