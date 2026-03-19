"""
Simple symmetric encryption for storing API keys in SQLite.
Uses Fernet (AES-128-CBC + HMAC-SHA256) from the cryptography package.
Key is derived from SECRET_KEY env var via SHA-256.
"""
import base64
import hashlib
import os

from cryptography.fernet import Fernet


def _get_fernet() -> Fernet:
    secret = os.environ.get("SECRET_KEY", "sf2dynamics-dev-secret-key-32ch!")
    key_bytes = hashlib.sha256(secret.encode()).digest()        # always 32 bytes
    fernet_key = base64.urlsafe_b64encode(key_bytes)           # Fernet needs URL-safe b64
    return Fernet(fernet_key)


def encrypt(text: str) -> str:
    if not text:
        return ""
    return _get_fernet().encrypt(text.encode()).decode()


def decrypt(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    return _get_fernet().decrypt(ciphertext.encode()).decode()
