from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, Integer, String, Text
from app.database import Base


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id             = Column(Integer, primary_key=True)
    title          = Column(String(255), nullable=False, default="New Conversation")
    connection_id  = Column(Integer, nullable=True)   # FK to connections (soft)
    org_name       = Column(String(255), nullable=True)
    created_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id          = Column(Integer, primary_key=True)
    session_id  = Column(Integer, nullable=False)   # FK to chat_sessions
    role        = Column(String(20), nullable=False)  # user | assistant
    content     = Column(Text, nullable=False, default="")
    sources_json = Column(Text, nullable=True)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
