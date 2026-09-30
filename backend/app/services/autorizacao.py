"""Autorização de estágio: data de concessão e validade (liberação + N dias).

A autorização emitida pela comissão ao deferir a submissão vale por
AUTORIZACAO_VALIDADE_DIAS a partir da conclusão do processo.
"""

from datetime import datetime, timedelta, timezone

from ..models import Submissao


def dados_autorizacao(sub: Submissao, validade_dias: int) -> dict | None:
    """Retorna os dados da autorização ou None se não aplicável."""
    if sub.status != "aprovada" or not sub.concluido_em:
        return None
    liberada = sub.concluido_em
    if liberada.tzinfo is None:  # SQLite devolve datetimes naive
        liberada = liberada.replace(tzinfo=timezone.utc)
    validade = liberada + timedelta(days=validade_dias)
    agora = datetime.now(timezone.utc)
    return {
        "liberadaEm": liberada.isoformat(),
        "validaAte": validade.isoformat(),
        "diasParaVencer": (validade - agora).days,
        "expirada": validade < agora,
    }
