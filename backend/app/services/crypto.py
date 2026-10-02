"""Criptografia simétrica at-rest para PDFs armazenados temporariamente."""

from cryptography.fernet import Fernet

from ..config import settings


def _fernet() -> Fernet:
    return Fernet(settings.fernet_key)


def cifrar(dados: bytes) -> bytes:
    """Cifra um payload de bytes com Fernet (AES-128-CBC + HMAC-SHA256)."""
    return _fernet().encrypt(dados)


def decifrar(token: bytes) -> bytes:
    """Decifra um payload previamente cifrado."""
    return _fernet().decrypt(token)
