from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text
from datetime import datetime
from app.database import Base


class Tenant(Base):
    __tablename__ = "tenants"

    id           = Column(Integer, primary_key=True, index=True)
    name         = Column(String, nullable=False)          # "Gruve AI", "SecureCafe"
    slug         = Column(String, unique=True, nullable=False)  # "gruve", "securecafe"
    plan         = Column(String, default="trial")         # trial/starter/pro/enterprise
    is_active    = Column(Boolean, default=True)
    settings_json = Column(Text, default="{}")
    created_at   = Column(DateTime, default=datetime.utcnow)
    updated_at   = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
