"""
Local authentication for ChefVoice.

Replaces Supabase Auth (GoTrue) with a small, self-contained implementation:
passwords are hashed with bcrypt and sessions are stateless JSON Web Tokens signed
with a server-side secret. The same JWT authenticates both REST requests
(Authorization: Bearer <token>) and the /ws/chat WebSocket (?token=<token>).
"""

import datetime
import os

import bcrypt
import jwt  # PyJWT

# Signing secret. MUST be overridden in production via the JWT_SECRET env var.
# The dev default is deliberately long (>= 32 bytes) so local runs are warning-free.
JWT_SECRET = os.getenv("JWT_SECRET", "chefvoice-local-dev-secret-change-me-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = int(os.getenv("JWT_EXPIRY_DAYS", "7"))

# bcrypt rejects inputs longer than 72 bytes; longer passwords are truncated.
_BCRYPT_MAX_BYTES = 72


def hash_password(password: str) -> str:
    """Return a bcrypt hash for the given plaintext password."""
    pw = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    return bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    """Check a plaintext password against a stored bcrypt hash."""
    try:
        pw = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
        return bcrypt.checkpw(pw, password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_token(user_id: str, username: str) -> str:
    """Issue a signed JWT for a user session."""
    now = datetime.datetime.now(datetime.timezone.utc)
    payload = {
        "sub": user_id,
        "username": username,
        "iat": now,
        "exp": now + datetime.timedelta(days=JWT_EXPIRY_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    """Decode and validate a JWT, returning its payload.

    Raises jwt.InvalidTokenError (or a subclass) if the token is missing,
    malformed, or expired.
    """
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
