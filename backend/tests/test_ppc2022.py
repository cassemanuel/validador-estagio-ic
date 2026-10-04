"""Testes do motor de regras server-side (espelho Python do PPC 2022)."""

import os

import pytest

from app.rules.ppc2022 import carregar_regras, verificar_elegibilidade


@pytest.fixture
def regras():
    return carregar_regras(os.environ["RULES_FILE"])


def _historico(regras, ingresso="2023/1", extensao_cumpridas=120):
    disciplinas = [
        {
            "codigo": req["codigo"],
            "nome": req["nome"],
            "ch": 60,
            "crR": 4,
            "grau": 8.0,
            "pontos": 32.0,
            "situacao": "AP",
        }
        for req in regras["ciclo_basico"]
    ]
    return {
        "metadata": {"ingresso": ingresso},
        "periodos": [{"periodo": ingresso, "disciplinas": disciplinas}],
        "resumo_boa": {
            "extensao": {
                "exigido": 120,
                "cumpridas": extensao_cumpridas,
                "faltantes": 120 - extensao_cumpridas,
            }
        },
    }


def test_extensao_obrigatoria_para_ingresso_2025_1(regras):
    h = _historico(regras, ingresso="2025/1", extensao_cumpridas=60)
    resultado = verificar_elegibilidade(h, regras)
    assert resultado["apto"] is False
    ext = next(c for c in resultado["criterios"] if "Extensão" in c["rotulo"])
    assert ext["ok"] is False


def test_extensao_cumprida_para_ingresso_2025_1(regras):
    h = _historico(regras, ingresso="2025/1", extensao_cumpridas=120)
    resultado = verificar_elegibilidade(h, regras)
    assert resultado["apto"] is True
    ext = next(c for c in resultado["criterios"] if "Extensão" in c["rotulo"])
    assert ext["ok"] is True


def test_extensao_isenta_para_ingresso_anterior_a_2025(regras):
    h = _historico(regras, ingresso="2024/2", extensao_cumpridas=0)
    del h["resumo_boa"]
    resultado = verificar_elegibilidade(h, regras)
    assert resultado["apto"] is True
    assert not any("Extensão" in c["rotulo"] for c in resultado["criterios"])
