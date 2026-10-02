"""Smoke e2e manual: reenvio, métricas e auditoria contra http://localhost:8000."""

import json
import sys

import requests

BASE = "http://localhost:8000"


def main():
    aluno = requests.Session()
    r = aluno.post(
        f"{BASE}/api/auth/login",
        json={"username": "aluno2", "senha": "aluno123"},
    )
    assert r.status_code == 200, r.text

    # Payload mínimo: ciclo básico completo (códigos do JSON de regras)
    regras = json.load(open("frontend/rules/ciclo_basico.json", encoding="utf-8"))
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
    payload = {
        "metadata": {
            "nome": "Discente Dois",
            "dre": "aluno2",
            "tipoDocumento": "boa",
        },
        "periodos": [{"periodo": "2024/1", "disciplinas": disciplinas}],
        "pendencias": {"obrigatorias": [], "optativas": []},
        "diagnostico": {"apto": True, "criterios": []},
        "excecoes": [],
    }
    r = aluno.post(
        f"{BASE}/api/submissoes",
        files={
            "boletim": ("boletim.pdf", b"%PDF-1.4 fake boletim", "application/pdf"),
            "boa": ("boa.pdf", b"%PDF-1.4 fake boa", "application/pdf"),
        },
        data={"payload": json.dumps(payload)},
    )
    assert r.status_code == 200, r.text
    sub1 = r.json()
    print("submissao 1:", sub1["id"], sub1["status"])

    comissao = requests.Session()
    r = comissao.post(
        f"{BASE}/api/auth/login",
        json={"username": "comissao1", "senha": "comissao123"},
    )
    assert r.status_code == 200, r.text

    # Métricas antes da decisão
    m = comissao.get(f"{BASE}/api/comissao/metricas").json()
    print("metricas:", json.dumps(m, ensure_ascii=False))

    # Devolve a submissão
    r = comissao.post(
        f"{BASE}/api/comissao/submissoes/{sub1['id']}/decisao",
        json={"decisao": "devolvida", "motivo": "Reenviar documento legível."},
    )
    assert r.status_code == 200, r.text

    # Reenvio: nova submissão ativa após decisão terminal
    r = aluno.post(
        f"{BASE}/api/submissoes",
        files={
            "boletim": ("boletim2.pdf", b"%PDF-1.4 fake boletim v2", "application/pdf"),
            "boa": ("boa2.pdf", b"%PDF-1.4 fake boa v2", "application/pdf"),
        },
        data={"payload": json.dumps(payload)},
    )
    assert r.status_code == 200, r.text
    sub2 = r.json()
    assert sub2["id"] != sub1["id"] and sub2["status"] == "fila_regular"
    print("reenvio ok:", sub2["id"], sub2["status"])

    # Auditoria visível
    ev = comissao.get(f"{BASE}/api/comissao/auditoria?limite=10").json()["eventos"]
    print(f"auditoria ({len(ev)} eventos):")
    for e in ev[:6]:
        print(" ", e["ts"], e["ator"], e["papel"], e["acao"])

    m = comissao.get(f"{BASE}/api/comissao/metricas").json()
    assert m["pendentes"] == 1 and m["devolvidos"] == 1
    print("OK")


if __name__ == "__main__":
    main()
