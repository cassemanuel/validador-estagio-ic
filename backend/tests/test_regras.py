"""Testes do espelho Python das regras do PPC 2022 (mesma fonte JSON do JS)."""

import os

from app.rules.ppc2022 import disciplinas_faltantes, verificar_elegibilidade


def _regras():
    from app.rules.ppc2022 import carregar_regras

    return carregar_regras(os.environ["RULES_FILE"])


def _historico_completo(regras):
    disciplinas = [
        {
            "codigo": req["codigo"],
            "nome": req["nome"],
            "crR": 4,
            "grau": 8.0,
            "pontos": 32.0,
            "situacao": "AP",
        }
        for req in regras["ciclo_basico"]
    ]
    return {"periodos": [{"periodo": "2023/1", "disciplinas": disciplinas}]}


def test_equivalencia_combinada_mab121_cmt012():
    regras = _regras()
    h = _historico_completo(regras)
    disc = h["periodos"][0]["disciplinas"]
    # Substitui ICP131/ICP141 pelo par combinado que equivale a MAB120.
    h["periodos"][0]["disciplinas"] = [
        d for d in disc if d["codigo"] not in ("ICP131", "ICP141")
    ] + [
        {"codigo": "MAB121", "situacao": "AP", "crR": 4, "grau": 7.0},
        {"codigo": "CMT012", "situacao": "AP", "crR": 4, "grau": 7.0},
    ]
    assert not disciplinas_faltantes(h, regras)


def test_metade_do_par_nao_cobre_requisito():
    regras = _regras()
    h = _historico_completo(regras)
    disc = h["periodos"][0]["disciplinas"]
    h["periodos"][0]["disciplinas"] = [
        d for d in disc if d["codigo"] != "ICP131"
    ] + [{"codigo": "MAB121", "situacao": "AP", "crR": 4, "grau": 7.0}]
    faltantes = [f["codigo"] for f in disciplinas_faltantes(h, regras)]
    assert "ICP131" in faltantes
    assert "ICP141" not in faltantes


def test_equivalencias_diretas_mac():
    regras = _regras()
    h = _historico_completo(regras)
    for d in h["periodos"][0]["disciplinas"]:
        if d["codigo"] == "MAE111":
            d["codigo"] = "MAC118"
        if d["codigo"] == "MAE992":
            d["codigo"] = "MAC128"
    assert verificar_elegibilidade(h, regras)["apto"]


def test_icp133_aceita_legados_icp111_mab111():
    regras = _regras()
    for legado in ("ICP111", "MAB111"):
        h = _historico_completo(regras)
        for d in h["periodos"][0]["disciplinas"]:
            if d["codigo"] == "ICP133":
                d["codigo"] = legado
        assert verificar_elegibilidade(h, regras)["apto"], (
            f"{legado} deveria cobrir ICP133"
        )


def test_icp249_tecnologia_sociedade_com_icp354():
    regras = _regras()
    codigos = [r["codigo"] for r in regras["ciclo_basico"]]
    for removido in ("ICP251", "ICP252", "ICP253"):
        assert removido not in codigos
    assert "ICP249" in codigos

    h = _historico_completo(regras)
    for d in h["periodos"][0]["disciplinas"]:
        if d["codigo"] == "ICP249":
            d["codigo"] = "ICP354"
    assert verificar_elegibilidade(h, regras)["apto"]
