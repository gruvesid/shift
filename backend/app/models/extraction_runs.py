"""
Extraction runs — one row per extraction job triggered from the UI.
Stores the full extracted metadata JSON from Salesforce so it can be
referenced by conversion and deployment steps.
"""

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, JSON
from app.database import Base


class ExtractionRun(Base):
    __tablename__ = "extraction_runs"

    id = Column(Integer, primary_key=True, index=True)

    # Unique job identifier (UUID), shared across extract → convert → deploy chain
    run_id = Column(String(64), unique=True, nullable=False, index=True)

    # Which Salesforce connection was used
    sf_connection_name = Column(String(255), nullable=False)

    # pending | running | completed | failed
    status = Column(String(50), nullable=False, default="pending", index=True)

    # What was requested to extract (JSON list of component types + names)
    # e.g. {"apex_classes": ["AccountService"], "objects": ["Account"], ...}
    config_json = Column(Text, nullable=True)

    # Full extracted metadata output (01_extracted_metadata.json equivalent)
    # Stored as JSON text; can be large
    result_json = Column(Text, nullable=True)

    # Summary counts for quick display
    objects_count = Column(Integer, default=0)
    fields_count = Column(Integer, default=0)
    apex_classes_count = Column(Integer, default=0)
    apex_triggers_count = Column(Integer, default=0)
    lwc_count = Column(Integer, default=0)

    error = Column(Text, nullable=True)

    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    def __repr__(self):
        return f"<ExtractionRun run_id={self.run_id!r} status={self.status!r}>"
