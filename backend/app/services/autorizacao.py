"""Autorização de estágio: data de concessão e validade (liberação + N dias).

A autorização emitida pela comissão ao deferir a submissão vale por
AUTORIZACAO_VALIDADE_DIAS a partir da conclusão do processo.
"""

from datetime import datetime, timedelta, timezone

from ..models import Submissao


def dados_autorizacao(
    sub: Submissao, validade_dias: int, janela_renovacao_dias: int | None = None
) -> dict | None:
    """Retorna os dados da autorização ou None se não aplicável.

    `renovavel` indica se o discente já pode iniciar um novo processo
    (autorização expirada ou a até `janela_renovacao_dias` do vencimento).
    """
    if janela_renovacao_dias is None:
        from ..config import settings

        janela_renovacao_dias = settings.renovacao_janela_dias
    if sub.status != "aprovada" or not sub.concluido_em:
        return None
    liberada = sub.concluido_em
    if liberada.tzinfo is None:  # SQLite devolve datetimes naive
        liberada = liberada.replace(tzinfo=timezone.utc)
    validade = liberada + timedelta(days=validade_dias)
    agora = datetime.now(timezone.utc)
    dias_para_vencer = (validade - agora).days
    expirada = validade < agora
    return {
        "liberadaEm": liberada.isoformat(),
        "validaAte": validade.isoformat(),
        "diasParaVencer": dias_para_vencer,
        "expirada": expirada,
        "renovavel": expirada or dias_para_vencer <= janela_renovacao_dias,
    }
