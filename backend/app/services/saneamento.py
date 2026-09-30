"""Saneamento server-side do payload extraído no cliente.

O JSON declarado pelo navegador não é autoritativo: aqui validamos
coerência estrutural e identidade, e recalculamos a elegibilidade com
o espelho Python das regras. Divergências viram alertas e forçam a
submissão para a Mesa de Revisão.
"""

import re
from typing import Any

from ..rules.ppc2022 import verificar_elegibilidade

CODIGO_UFRJ_REGEX = re.compile(r"^[A-Z]{3}\d{3}$|^[A-Z]{3}[A-Z0-9]\d{2}$")
DRE_REGEX = re.compile(r"^\d{9,10}$")


def analisar(dados: dict[str, Any], regras: dict, username_autenticado: str) -> dict:
    """Retorna {alertas: [...], diagnostico_recalculado: {...}}."""
    alertas: list[str] = []

    metadata = dados.get("metadata") or {}
    periodos = dados.get("periodos") or []

    # Identidade: DRE extraído do documento deve bater com o usuário logado
    # (quando o username se parece com um DRE).
    dre_extraido = str(metadata.get("dre") or "").strip()
    if DRE_REGEX.match(username_autenticado):
        if dre_extraido and dre_extraido != username_autenticado:
            alertas.append(
                f"DRE do documento ({dre_extraido}) difere do usuário autenticado."
            )
        elif not dre_extraido:
            alertas.append("DRE não identificado no documento.")

    tipo_doc = str(metadata.get("tipoDocumento") or "").lower()
    if tipo_doc == "historico":
        alertas.append(
            "Histórico Escolar omite reprovações — CR pode estar superestimado."
        )
    elif tipo_doc not in ("boletim", "boa"):
        alertas.append("Tipo de documento não reconhecido (esperado boletim/BOA).")

    # Coerência estrutural do payload.
    total = 0
    codigos_invalidos = 0
    for periodo in periodos:
        for d in periodo.get("disciplinas") or []:
            total += 1
            if not CODIGO_UFRJ_REGEX.match(str(d.get("codigo") or "").strip()):
                codigos_invalidos += 1
    if total == 0:
        alertas.append("Nenhuma disciplina extraída do documento.")
    elif codigos_invalidos:
        alertas.append(
            f"{codigos_invalidos} de {total} disciplinas com código fora do padrão UFRJ."
        )

    # Diagnóstico recalculado pelo espelho das regras (fonte única JSON).
    diagnostico_recalculado = verificar_elegibilidade(dados, regras)
    declarado = dados.get("diagnostico") or {}
    if "apto" in declarado and bool(declarado["apto"]) != diagnostico_recalculado["apto"]:
        alertas.append(
            "Diagnóstico declarado diverge do recálculo do servidor "
            f"(declarado apto={declarado['apto']}, recalculado apto="
            f"{diagnostico_recalculado['apto']})."
        )

    return {"alertas": alertas, "diagnostico_recalculado": diagnostico_recalculado}
