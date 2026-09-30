"""Rotas de autenticação: login, logout, identidade da sessão."""

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from ..auth.jwt import (
    clear_session_cookie,
    create_token,
    get_current_user,
    set_session_cookie,
)
from ..auth.provider import get_auth_provider
from ..config import settings
from ..db import get_db
from ..models import Usuario
from ..schemas import LoginIn
from ..services.auditoria import registrar

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    provider = get_auth_provider(settings, db)
    info = provider.authenticate(body.username, body.senha)
    if not info:
        raise HTTPException(401, "Credenciais inválidas.")

    # Upsert do usuário (logins LDAP criam a conta sob demanda).
    user = db.query(Usuario).filter_by(username=info.username).first()
    if not user:
        papel = info.papel or "discente"
        user = Usuario(
            username=info.username,
            nome=info.nome,
            papel=papel,
            origem=settings.auth_provider,
        )
        db.add(user)
        db.flush()
    elif info.nome and not user.nome:
        user.nome = info.nome

    registrar(db, user, "login", "usuario", user.id)
    db.commit()

    set_session_cookie(response, create_token(user))
    return {"username": user.username, "nome": user.nome, "papel": user.papel}


@router.post("/logout")
def logout(response: Response):
    clear_session_cookie(response)
    return {"ok": True}


@router.get("/me")
def me(user: Usuario = Depends(get_current_user)):
    return {"username": user.username, "nome": user.nome, "papel": user.papel}


@router.get("/info")
def info():
    """Público: informa o provedor de auth ativo (ex.: ocultar atalhos de dev)."""
    return {"provider": settings.auth_provider}
