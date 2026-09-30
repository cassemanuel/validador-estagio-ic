import json
import os
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
            "dre": "aluno1",
            "curso": "Ciência da Computação",
            "tipoDocumento": "boa",
        },
        "periodos": [{"periodo": "2023/1", "disciplinas": disciplinas}],
        "pendencias": {"obrigatorias": [], "optativas": []},
        "diagnostico": {"apto": True, "criterios": []},
        "excecoes": [],
    }
    payload.update(overrides)
    return payload


def submeter(client, payload=None, pdf_bytes=b"%PDF-1.4 fake test fixture"):
    payload = payload if payload is not None else payload_apto()
    return client.post(
        "/api/submissoes",
        files={"pdf": ("boa.pdf", pdf_bytes, "application/pdf")},
        data={"payload": json.dumps(payload)},
    )
