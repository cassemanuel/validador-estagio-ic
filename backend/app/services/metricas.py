"""Métricas agregadas para o painel analítico da Comissão de Estágio."""

import json
from collections import Counter
from datetime import datetime, timedelta, timezone

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


def calcular_metricas_autorizacoes(db: Session, settings) -> dict:
    """Métricas analíticas para a tela de Autorizações/Autorizados.

    - Tempo médio de resposta (últimos 3 meses) em dias.
    - Totais históricos de deferidos e expirados.
    - Moda do período estimado dos deferidos recentes.
    """
    agora = datetime.now(timezone.utc)
    tres_meses = agora - timedelta(days=90)

    decididos_recentes = (
        db.query(Submissao)
        .filter(Submissao.concluido_em.isnot(None))
        .filter(Submissao.concluido_em >= tres_meses)
        .all()
    )
    tempos = [
        (_aware(s.concluido_em) - _aware(s.criado_em)).days
        for s in decididos_recentes
        if s.criado_em and s.concluido_em
    ]
    tempo_medio = sum(tempos) / len(tempos) if tempos else 0.0

    todas_aprovadas = (
        db.query(Submissao)
        .filter(Submissao.status == "aprovada")
        .all()
    )
    total_autorizados = len(todas_aprovadas)
    total_expirados = sum(
        1
        for s in todas_aprovadas
        if (aut := dados_autorizacao(s, settings.autorizacao_validade_dias))
        and aut["expirada"]
    )

    deferidos_recentes = (
        db.query(Submissao)
        .filter(Submissao.status == "aprovada")
        .filter(Submissao.concluido_em.isnot(None))
        .filter(Submissao.concluido_em >= tres_meses)
        .all()
    )
    periodos = []
    for s in deferidos_recentes:
        metadata = json.loads(s.metadata_json or "{}")
        ingresso = metadata.get("ingresso")
        periodo = _estimar_periodo_atual(ingresso)
        if periodo:
            periodos.append(periodo)

    contagem = Counter(periodos).most_common()
    moda = {
        "primeiro": (
            {"periodo": contagem[0][0], "ocorrencias": contagem[0][1]}
            if contagem
            else None
        ),
        "segundo": (
            {"periodo": contagem[1][0], "ocorrencias": contagem[1][1]}
            if len(contagem) > 1
            else None
        ),
    }

    return {
        "tempo_medio_resposta_dias": round(tempo_medio, 1),
        "total_autorizados": total_autorizados,
        "total_expirados": total_expirados,
        "moda_periodo": moda,
    }


def _estimar_periodo_atual(ingresso: str | None, data: datetime | None = None) -> int | None:
    """Estima o período atual do aluno a partir do ingresso (AAAA/S)."""
    if not ingresso:
        return None
    try:
        ano_str, sem_str = ingresso.split("/")
        ano_ingresso = int(ano_str)
        sem_ingresso = int(sem_str)
    except (ValueError, AttributeError):
        return None

    data = data or datetime.now(timezone.utc)
    if 3 <= data.month <= 7:
        ano_atual, sem_atual = data.year, 1
    elif data.month >= 8:
        ano_atual, sem_atual = data.year, 2
    else:
        ano_atual, sem_atual = data.year, 1

    diff_semestres = (ano_atual - ano_ingresso) * 2 + (sem_atual - sem_ingresso)
    return max(diff_semestres + 1, 1)
