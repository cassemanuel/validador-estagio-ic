"""Criptografia simétrica at-rest para PDFs armazenados temporariamente."""

from functools import lru_cache

from cryptography.fernet import Fernet

from ..config import settings


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    # Cacheado: sem STORAGE_ENCRYPTION_KEY (só em dev), a chave é derivada
    # via PBKDF2 (100k iterações) — caro demais para refazer a cada PDF.
    return Fernet(settings.fernet_key)


def cifrar(dados: bytes) -> bytes:
    """Cifra um payload de bytes com Fernet (AES-128-CBC + HMAC-SHA256)."""
    return _fernet().encrypt(dados)


def decifrar(token: bytes) -> bytes:
    """Decifra um payload previamente cifrado."""
    return _fernet().decrypt(token)
