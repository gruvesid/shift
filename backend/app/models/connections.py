"""
Connection profiles — replaces the flat configs.json file.
Each row stores credentials for one integration
(Salesforce, Dynamics 365, Fabric, SharePoint).
"""

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from app.database import Base


class Connection(Base):
    __tablename__ = "connections"

    id = Column(Integer, primary_key=True, index=True)

    # Owner — nullable so existing rows aren't broken before migration
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)

    # Human-readable name, e.g. "prod-salesforce", "dev-dynamics"
    name = Column(String(255), unique=True, nullable=False, index=True)

    # One of: salesforce | dynamics | fabric | sharepoint
    type = Column(String(50), nullable=False, index=True)

    # JSON blob of all credential fields (never logged/exposed in responses)
    config_json = Column(Text, nullable=False)

    # Optional: last successful connection test result
    last_test_status = Column(String(50), nullable=True)   # ok | error
    last_test_message = Column(Text, nullable=True)
    last_tested_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    def __repr__(self):
        return f"<Connection name={self.name!r} type={self.type!r}>"
