"""
Run once to create the initial admin user.
Usage: python seed_admin.py
"""
import os
import sys
from datetime import datetime

# Must be run from the backend/ directory
sys.path.insert(0, os.path.dirname(__file__))

from app.database import SessionLocal, init_db
from app.models.user import User
from app.services.auth_service import get_password_hash

EMAIL    = "siddhrajsinh.atodaria@gruve.ai"
PASSWORD = "Test123"
NAME     = "Siddhrajsinh Atodaria"

init_db()
db = SessionLocal()

existing = db.query(User).filter(User.email == EMAIL).first()
if existing:
    existing.role             = "admin"
    existing.is_active        = True
    existing.email_verified   = True
    existing.approval_status  = "approved"
    existing.password_hash    = get_password_hash(PASSWORD)
    db.commit()
    print(f"Updated existing user {EMAIL} to admin.")
else:
    user = User(
        email             = EMAIL,
        name              = NAME,
        password_hash     = get_password_hash(PASSWORD),
        role              = "admin",
        is_active         = True,
        email_verified    = True,
        approval_status   = "approved",
        plan              = "enterprise",
        created_at        = datetime.utcnow(),
    )
    db.add(user)
    db.commit()
    print(f"Created admin user {EMAIL}")

db.close()
