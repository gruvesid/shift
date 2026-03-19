from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text
from datetime import datetime, timezone
from ..database import Base


class VectorConfig(Base):
    __tablename__ = "vector_configs"

    id                = Column(Integer, primary_key=True)
    provider          = Column(String(50),  nullable=False)   # qdrant | pinecone
    api_key_encrypted = Column(Text)
    url               = Column(String(500))
    display_name      = Column(String(200))
    embedding_model   = Column(String(200))
    vector_size       = Column(Integer)
    is_default        = Column(Boolean, default=False, nullable=False)
    created_at        = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at        = Column(DateTime, default=lambda: datetime.now(timezone.utc))
