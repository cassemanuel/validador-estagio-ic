"""Métricas agregadas para o painel analítico da Comissão de Estágio."""

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import Submissao
from .autorizacao import dados_autorizacao


def semestre_letivo(dt: datetime | None = None) -> dict:
    """Retorna {rotulo, inicio, fim} do semestre letivo corrente.

    Convenção: semestre 1 ≈ 01/mar–31/jul; semestre 2 ≈ 01/ago–31/dez.
    Jan/fev (entressafra) apontam para o semestre 1 do ano corrente.
    """
    dt = dt or datetime.now(timezone.utc)
    if 3 <= dt.month <= 7:
        ano, sem = dt.year, 1
    elif dt.month >= 8:
        ano, sem = dt.year, 2
    else:
        ano, sem = dt.year, 1
    inicio = datetime(ano, 3 if sem == 1 else 8, 1, tzinfo=timezone.utc)
    fim = datetime(ano, 7 if sem == 1 else 12, 31, 23, 59, 59, tzinfo=timezone.utc)
    return {"rotulo": f"{ano}/{sem}", "inicio": inicio, "fim": fim}


def calcular_metricas(db: Session, settings, ano: int | None = None) -> dict:
    sem = semestre_letivo()
    todas = db.query(Submissao).all()
    anos = sorted(
        {_aware(s.criado_em).year for s in todas if s.criado_em},
        reverse=True,
    )
    subs = (
        todas
        if ano is None
        else [s for s in todas if s.criado_em and _aware(s.criado_em).year == ano]
    )

    por_status = {}
    for status in ("fila_regular", "mesa_revisao", "aprovada",
                   "indeferida", "devolvida", "arquivada"):
        por_status[status] = sum(1 for x in subs if x.status == status)

    total_semestre = sum(
        1 for s in subs if s.criado_em and sem["inicio"] <= _aware(s.criado_em) <= sem["fim"]
    )

    # Autorizações próximas do vencimento: aprovadas cuja validade
    # (liberação + AUTORIZACAO_VALIDADE_DIAS) termina dentro da janela
    # de alerta configurada.
    agora = datetime.now(timezone.utc)
    dias_para_fim = (sem["fim"] - agora).days
    aprovadas = [s for s in subs if s.status == "aprovada"]
    vencendo = sum(
        1
        for s in aprovadas
        if (aut := dados_autorizacao(s, settings.autorizacao_validade_dias))
        and not aut["expirada"]
        and aut["diasParaVencer"] <= settings.vencimento_alerta_dias
    )

    pendentes = por_status["fila_regular"] + por_status["mesa_revisao"]

    return {
        "anos": anos,
        "ano": ano,
        "semestre": sem["rotulo"],
        "fim_periodo": sem["fim"].date().isoformat(),
        "dias_para_fim_periodo": max(dias_para_fim, 0),
        "total": len(subs),
        "total_semestre": total_semestre,
        "deferidos": por_status["aprovada"],
        "indeferidos": por_status["indeferida"],
        "devolvidos": por_status["devolvida"],
        "pendentes": pendentes,
        "fila_regular": por_status["fila_regular"],
        "mesa_revisao": por_status["mesa_revisao"],
        "arquivadas": por_status["arquivada"],
        "autorizacoes_vencendo": vencendo,
        "autorizacoes_vigentes": len(aprovadas)
        - sum(
            1
            for s in aprovadas
            if (aut := dados_autorizacao(s, settings.autorizacao_validade_dias))
            and aut["expirada"]
        ),
        "janela_vencimento_dias": settings.vencimento_alerta_dias,
        "validade_autorizacao_dias": settings.autorizacao_validade_dias,
        # Indicativo: todo deferido deve relatório de estágio ao fim do período.
        "relatorios": {"entregues": 0, "pendentes": por_status["aprovada"]},
    }


def _aware(dt: datetime) -> datetime:
    """SQLite devolve datetimes naive; normaliza para UTC."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
