"""Portal público de autorizações — acesso a qualquer usuário logado."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..auth.jwt import get_current_user
from ..config import settings
from ..db import get_db
from ..models import Usuario
from ..services.metricas import calcular_metricas_autorizacoes
from .comissao import _listar_autorizacoes

router = APIRouter(prefix="/api/autorizacoes", tags=["autorizacoes"])


@router.get("")
def autorizacoes_publicas(
    ano: int | None = Query(None, ge=2000, le=2100),
    status: str | None = Query(None, pattern="^(vigente|expirada)$"),
    offset: int = Query(0, ge=0),
    limite: int = Query(10, ge=1, le=200),
    q: str | None = Query(None, max_length=100),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    """Lista deferimentos/autorizações para qualquer usuário autenticado."""
    return _listar_autorizacoes(db, ano, status, offset, limite, q)


@router.get("/metricas")
def autorizacoes_metricas_publicas(
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    """Métricas analíticas das autorizações para qualquer usuário autenticado."""
    return calcular_metricas_autorizacoes(db, settings)
