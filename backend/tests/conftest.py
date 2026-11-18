import json
import os
import re
import sys
import tempfile
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp(prefix="validador-test-"))
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'test.db'}"
os.environ["UPLOAD_DIR"] = str(_TMP / "uploads")
os.environ["JWT_SECRET"] = "teste-secret"
os.environ["PURGE_INTERVAL_SECONDS"] = "3600"
os.environ.setdefault(
    "RULES_FILE",
    str(_BACKEND.parent / "frontend" / "rules" / "ciclo_basico.json"),
)

from fastapi.testclient import TestClient  # noqa: E402

from .pdf_sintetico import pdf_com_texto  # noqa: E402,F401

from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def limpar_submissoes(client):
    """Isola os testes: limpa dados de negócio entre casos (mantém seeds)."""
    from app.db import SessionLocal
    from app.models import AuditLog, Decisao, Excecao, Submissao

    with SessionLocal() as db:
        for model in (Excecao, Decisao, Submissao, AuditLog):
            db.query(model).delete()
        db.commit()
    yield


DRE_ALUNO1 = "120000001"
DRE_ALUNO2 = "120000002"


def pdfs_do_payload(payload: dict) -> tuple[bytes, bytes]:
    """Boletim e BOA sintéticos coerentes com o payload.

    Contêm nome e DRE e, como os documentos reais, as disciplinas: as dos
    períodos letivos (AAAA/S) no Boletim e as do agrupamento "Aprovadas
    (BOA)" no BOA — exigência da conferência server-side de códigos.
    """
    meta = payload.get("metadata") or {}
    nome = str(meta.get("nome") or "")
    dre = str(meta.get("dre") or "")
    linhas_boletim, linhas_boa = [], []
    for periodo in payload.get("periodos") or []:
        rotulo = str(periodo.get("periodo") or "")
        destino = linhas_boletim if re.match(r"^\d{4}/\d$", rotulo) else linhas_boa
        for d in periodo.get("disciplinas") or []:
            destino.append(
                f"{rotulo} {d.get('codigo', '')} {d.get('nome', '')} "
                f"{d.get('grau', '')} {d.get('situacao', '')}"
            )
    boletim = pdf_com_texto(
        "UNIVERSIDADE FEDERAL DO RIO DE JANEIRO",
        "BOLETIM NAO OFICIAL",
        f"Nome: {nome}",
        f"DRE: {dre}",
        *linhas_boletim,
    )
    boa = pdf_com_texto(
        "BOLETIM DE ORIENTACAO ACADEMICA",
        f"{dre} - {nome}",
        *linhas_boa,
    )
    return boletim, boa


def login(client, username, senha):
    resp = client.post(
        "/api/auth/login", json={"username": username, "senha": senha}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def payload_apto(**overrides):
    """Histórico sintético: ciclo básico completo com CR 8.0."""
    from app.rules.ppc2022 import carregar_regras

    regras = carregar_regras(os.environ["RULES_FILE"])
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
            "nome": "Aluno Exemplo",
            "dre": DRE_ALUNO1,
            "curso": "Ciência da Computação",
            "tipoDocumento": "boa",
            "ingresso": "2023/1",
        },
        "periodos": [{"periodo": "2023/1", "disciplinas": disciplinas}],
        "pendencias": {"obrigatorias": [], "optativas": []},
        "diagnostico": {"apto": True, "criterios": []},
        "excecoes": [],
        "resumo_boa": {
            "extensao": {"exigido": 120, "cumpridas": 120, "faltantes": 0},
        },
    }
    payload.update(overrides)
    return payload


def submeter(client, payload=None, boletim_bytes=None, boa_bytes=None):
    payload = payload if payload is not None else payload_apto()
    boletim_padrao, boa_padrao = pdfs_do_payload(payload)
    boletim_bytes = boletim_bytes if boletim_bytes is not None else boletim_padrao
    boa_bytes = boa_bytes if boa_bytes is not None else boa_padrao
    return client.post(
        "/api/submissoes",
        files={
            "boletim": ("boletim.pdf", boletim_bytes, "application/pdf"),
            "boa": ("boa.pdf", boa_bytes, "application/pdf"),
        },
        data={"payload": json.dumps(payload)},
    )
