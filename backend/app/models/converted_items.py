"""
Converted items — one row per component converted by the LLM.
Each row links back to an ExtractionRun and stores both the source
(Salesforce) and the converted (Dynamics 365) representation.
"""

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, Float, ForeignKey
from app.database import Base


class ConvertedItem(Base):
    __tablename__ = "converted_items"

    id = Column(Integer, primary_key=True, index=True)

    # Foreign key back to the extraction run
    run_id = Column(String(64), nullable=False, index=True)

    # Component classification
    # object | field | apex_class | apex_trigger | lwc | relationship | picklist
    item_type = Column(String(50), nullable=False, index=True)

    # Salesforce component name, e.g. "AccountService", "Account__c"
    item_name = Column(String(255), nullable=False, index=True)

    # Salesforce source code / metadata JSON (input to LLM)
    sf_source = Column(Text, nullable=True)

    # Converted D365 output — C# code, JSON metadata, or HTML web resource
    d365_output = Column(Text, nullable=True)

    # pending | converting | completed | failed | skipped
    status = Column(String(50), nullable=False, default="pending", index=True)

    # Which LLM model was used
    llm_model = Column(String(100), nullable=True)

    # Token usage and cost tracking (matches POC AI pattern)
    input_tokens = Column(Integer, default=0)
    output_tokens = Column(Integer, default=0)
    cost_usd = Column(Float, default=0.0)

    # Number of compile/fix retries needed
    retry_count = Column(Integer, default=0)

    error = Column(Text, nullable=True)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    def __repr__(self):
        return f"<ConvertedItem run_id={self.run_id!r} type={self.item_type!r} name={self.item_name!r} status={self.status!r}>"
