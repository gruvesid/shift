"""
Stores the field mapping JSON fetched from Fabric SQL.
One row per connection — overwritten on each fetch.
"""
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, ForeignKey, Text, DateTime
from app.database import Base


class FieldMapping(Base):
    __tablename__ = "field_mappings"

    id            = Column(Integer, primary_key=True, index=True)
    connection_id = Column(Integer, ForeignKey("connections.id", ondelete="CASCADE"), unique=True, nullable=False, index=True)
    fetched_at    = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    mapping_json  = Column(Text, nullable=False)   # full JSON string

    def __repr__(self):
        return f"<FieldMapping connection_id={self.connection_id!r}>"
