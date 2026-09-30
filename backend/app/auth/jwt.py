"""Sessões JWT em cookie httpOnly (SameSite=Lax)."""

from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Usuario

COOKIE_NAME = "session"
_ALGORITHM = "HS256"


def create_token(user: Usuario) -> str:
    agora = datetime.now(timezone.utc)
    payload = {
        "sub": user.username,
        "uid": user.id,
        "papel": user.papel,
        "iat": agora,
        "exp": agora + timedelta(minutes=settings.jwt_expire_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=_ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[_ALGORITHM])
    except jwt.PyJWTError:
        return None


def set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        max_age=settings.jwt_expire_minutes * 60,
        path="/",
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


def get_current_user(request: Request, db: Session = Depends(get_db)) -> Usuario:
    token = request.cookies.get(COOKIE_NAME)
    payload = decode_token(token) if token else None
    if not payload:
        raise HTTPException(401, "Sessão inválida ou expirada.")
    user = db.query(Usuario).filter_by(id=payload.get("uid"), ativo=1).first()
    if not user:
        raise HTTPException(401, "Usuário não encontrado ou inativo.")
    return user


def require_papel(*papeis: str):
    def dep(user: Usuario = Depends(get_current_user)) -> Usuario:
        if user.papel not in papeis:
            raise HTTPException(403, "Acesso restrito.")
        return user

    return dep


require_discente = require_papel("discente")
require_comissao = require_papel("comissao")
