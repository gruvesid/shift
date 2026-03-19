from sqlalchemy import Column, Integer, String, DateTime
from datetime import datetime
from app.database import Base


class OTPToken(Base):
    __tablename__ = "otp_tokens"

    id         = Column(Integer, primary_key=True, index=True)
    email      = Column(String, nullable=False, index=True)
    purpose    = Column(String, nullable=False)   # verify-email / reset-password
    code       = Column(String, nullable=False)
    attempts   = Column(Integer, default=0)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
