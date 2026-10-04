"""Espelho server-side do motor de regras do PPC 2022.

Lê a mesma fonte única do frontend (`frontend/rules/ciclo_basico.json`)
para o sanity check das submissões — evita divergência JS↔Python.
"""

import json
from functools import lru_cache
from pathlib import Path

SITUACOES_COM_GRAU = {"AP", "RM", "RF", "RFM"}
SITUACOES_SEM_GRAU = {"NCG", "NCC", "T", "CURSANDO"}
GRAUS_TEXTUAIS_SEM_GRAU = {"T", "NCG", "NCC", "*****"}


@lru_cache(maxsize=1)
def carregar_regras(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _num(valor) -> float | None:
    try:
        return float(valor)
    except (TypeError, ValueError):
        return None


def disciplina_confere_grau(d: dict) -> bool:
    situacao = str(d.get("situacao") or "").upper()
    grau = str(d.get("grau") if d.get("grau") is not None else "").upper()
    if situacao in SITUACOES_SEM_GRAU or grau in GRAUS_TEXTUAIS_SEM_GRAU:
        return False
    return situacao in SITUACOES_COM_GRAU and _num(d.get("grau")) is not None


def disciplina_concluida(d: dict) -> bool:
    situacao = str(d.get("situacao") or "").upper()
    grau = str(d.get("grau") or "").upper()
    return situacao in ("AP", "T") or grau == "T"


def cr_acumulado(disciplinas: list[dict]) -> tuple[float, float, float]:
    """Retorna (crR_com_grau, pontos_totais, cr)."""
    cr_r = 0.0
    pontos = 0.0
    for d in disciplinas:
        if not disciplina_confere_grau(d):
            continue
        peso = _num(d.get("crR")) or 0.0
        cr_r += peso
        pontos += _num(d.get("pontos")) or (_num(d.get("grau")) or 0.0) * peso
    return cr_r, pontos, (pontos / cr_r if cr_r else 0.0)


def _todas_disciplinas(historico: dict) -> list[dict]:
    return [
        d
        for p in (historico.get("periodos") or [])
        for d in (p.get("disciplinas") or [])
    ]


def disciplinas_faltantes(historico: dict, regras: dict) -> list[dict]:
    concluidos = {
        str(d.get("codigo") or "").strip().upper()
        for d in _todas_disciplinas(historico)
        if disciplina_concluida(d)
    }
    def cumprido(req: dict) -> bool:
        direta = any(
            cod in concluidos for cod in (req.get("aceitos") or [req["codigo"]])
        )
        # Equivalência combinada: todos os códigos do grupo precisam constar
        # como concluídos (ex.: MAB121 + CMT012 equivalem a MAB120).
        combinada = any(
            all(cod in concluidos for cod in grupo)
            for grupo in (req.get("aceitos_conjunto") or [])
        )
        return direta or combinada

    return [
        req for req in (regras.get("ciclo_basico") or []) if not cumprido(req)
    ]


def _ingresso_apos_ou_igual(ingresso: str | None, referencia: str) -> bool:
    if not ingresso or not referencia:
        return False
    try:
        a1, s1 = (int(p) for p in ingresso.split("/"))
        a2, s2 = (int(p) for p in referencia.split("/"))
    except ValueError:
        return False
    return a1 > a2 or (a1 == a2 and s1 >= s2)


def verificar_elegibilidade(historico: dict, regras: dict) -> dict:
    """Reavalia a elegibilidade declarada pelo cliente (sanity check)."""
    periodos = historico.get("periodos") or []
    faltantes = disciplinas_faltantes(historico, regras)
    cr_minimo = regras.get("cr_minimo", 6.0)
    max_periodos = regras.get("max_periodos_integralizacao", 14)
    extensao_minima = regras.get("extensao_minima_horas", 120)
    extensao_a_partir = regras.get("extensao_ingresso_a_partir", "2025/1")

    cr_r, pontos, cr = cr_acumulado(_todas_disciplinas(historico))
    periodos_cursados = len(
        {str(p.get("periodo") or "").strip() for p in periodos if p.get("periodo")}
    )

    metadata = historico.get("metadata") or {}
    ingresso = metadata.get("ingresso")
    resumo_boa = historico.get("resumo_boa") or {}
    extensao = resumo_boa.get("extensao") or {}
    horas_cumpridas = _num(extensao.get("cumpridas")) or 0.0
    horas_faltantes = _num(extensao.get("faltantes")) or 0.0

    extensao_aplicavel = _ingresso_apos_ou_igual(ingresso, extensao_a_partir)

    criterios = [
        {
            "rotulo": "Ciclo básico concluído (1º–4º período)",
            "ok": not faltantes,
            "detalhe": (
                "Faltam disciplinas do ciclo básico: "
                + ", ".join(f["codigo"] for f in faltantes)
                if faltantes
                else "Todas as obrigatórias do ciclo básico foram concluídas."
            ),
        },
        {
            "rotulo": f"CR acumulado mínimo de {cr_minimo:.3f}",
            "ok": cr >= cr_minimo,
            "detalhe": f"CR recalculado {cr:.3f} (mínimo {cr_minimo:.3f})",
        },
        {
            "rotulo": f"Tempo de curso dentro de {max_periodos} períodos",
            "ok": periodos_cursados <= max_periodos,
            "detalhe": f"{periodos_cursados} períodos cursados (máx. {max_periodos})",
        },
    ]

    if extensao_aplicavel:
        criterios.append(
            {
                "rotulo": f"Carga Horária de Extensão (mínimo {extensao_minima}h)",
                "ok": horas_cumpridas >= extensao_minima,
                "detalhe": (
                    f"{horas_cumpridas:.0f}h cumpridas (mínimo {extensao_minima}h)"
                    if horas_cumpridas >= extensao_minima
                    else f"{horas_cumpridas:.0f}h cumpridas — faltam "
                    f"{horas_faltantes or (extensao_minima - horas_cumpridas):.0f}h "
                    f"(mínimo {extensao_minima}h)"
                ),
            }
        )

    return {"apto": all(c["ok"] for c in criterios), "criterios": criterios}
