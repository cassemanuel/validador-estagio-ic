"""Autenticação local (desenvolvimento) com hash PBKDF2-SHA256 (stdlib)."""

import hashlib
import hmac
import os

from ..models import Usuario
from .provider import AuthProvider, UserInfo

_ITERATIONS = 260_000


def hash_password(password: str) -> str:
    salt = os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), _ITERATIONS
    ).hex()
    return f"pbkdf2${_ITERATIONS}${salt}${digest}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, iterations, salt, digest = stored.split("$")
        candidato = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt), int(iterations)
        ).hex()
        return hmac.compare_digest(candidato, digest)
    except (ValueError, TypeError):
        return False


class LocalAuthProvider(AuthProvider):
    def __init__(self, db):
        self.db = db

    def authenticate(self, username: str, password: str) -> UserInfo | None:
        user = (
            self.db.query(Usuario)
            .filter_by(username=username.strip(), origem="local", ativo=1)
            .first()
        )
        if not user or not verify_password(password, user.senha_hash):
            return None
        return UserInfo(username=user.username, nome=user.nome, papel=user.papel)
