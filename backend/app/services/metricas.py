"""Métricas agregadas para o painel analítico da Comissão de Estágio."""

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import Submissao


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


def calcular_metricas(db: Session, settings) -> dict:
    sem = semestre_letivo()
    subs = db.query(Submissao).all()

    por_status = {}
    for status in ("fila_regular", "mesa_revisao", "aprovada",
                   "indeferida", "devolvida"):
        por_status[status] = sum(1 for x in subs if x.status == status)

    total_semestre = sum(
        1 for s in subs if s.criado_em and sem["inicio"] <= _aware(s.criado_em) <= sem["fim"]
    )

    # Autorizações próximas do vencimento: processos aprovados cujo semestre
    # letivo corrente termina dentro da janela de alerta configurada.
    agora = datetime.now(timezone.utc)
    dias_para_fim = (sem["fim"] - agora).days
    aprovadas = [s for s in subs if s.status == "aprovada"]
    vencendo = (
        len(aprovadas)
        if 0 <= dias_para_fim <= settings.vencimento_alerta_dias
        else 0
    )

    pendentes = por_status["fila_regular"] + por_status["mesa_revisao"]

    return {
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
        "autorizacoes_vencendo": vencendo,
        # Indicativo: todo deferido deve relatório de estágio ao fim do período.
        "relatorios": {"entregues": 0, "pendentes": por_status["aprovada"]},
    }


def _aware(dt: datetime) -> datetime:
    """SQLite devolve datetimes naive; normaliza para UTC."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
