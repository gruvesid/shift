"""
Stores extracted Salesforce metadata per connected org.
- metadata_json  : raw extraction stored in SQLite (used by code converter, etc.)
- summary_json   : object/field/apex counts for dashboard display
- vector_indexed : whether Qdrant has been populated (used for AI chat search)
"""

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from app.database import Base


class OrgMetadata(Base):
    __tablename__ = "org_metadata"

    id            = Column(Integer, primary_key=True, index=True)
    connection_id = Column(Integer, ForeignKey("connections.id", ondelete="CASCADE"), nullable=False, unique=True)

    # Which metadata types are selected for extraction (JSON list)
    extract_config_json = Column(Text, nullable=True)

    # Full raw metadata blob from Salesforce (can be large)
    metadata_json = Column(Text, nullable=True)

    # Aggregated counts: { objects, fields, apex_classes, triggers, flows, lwc, aura, validation_rules }
    summary_json  = Column(Text, nullable=True)

    # When was the last extraction run
    extracted_at  = Column(DateTime, nullable=True)

    # Qdrant indexing state
    vector_indexed_at = Column(DateTime, nullable=True)
    vector_status     = Column(String(50), nullable=True)  # pending | indexed | error | not_indexed

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
