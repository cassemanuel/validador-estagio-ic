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

# Paginação máxima do portal público (reduz extração em massa).
LIMITE_PUBLICO_MAX = 50


@router.get("")
def autorizacoes_publicas(
    ano: int | None = Query(None, ge=2000, le=2100),
    status: str | None = Query(None, pattern="^(vigente|expirada)$"),
    offset: int = Query(0, ge=0),
    limite: int = Query(10, ge=1, le=LIMITE_PUBLICO_MAX),
    q: str | None = Query(None, max_length=100),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    """Lista deferimentos para qualquer usuário autenticado (DRE mascarado)."""
    return _listar_autorizacoes(db, ano, status, offset, limite, q, publico=True)


@router.get("/metricas")
def autorizacoes_metricas_publicas(
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    """Métricas analíticas das autorizações para qualquer usuário autenticado."""
    return calcular_metricas_autorizacoes(db, settings)
