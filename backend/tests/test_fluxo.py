"""Testes do fluxo ponta-a-ponta: auth, submissão, triagem, decisão, expurgo."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .conftest import login, payload_apto, submeter


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True}


def test_me_sem_login(client):
    assert client.get("/api/auth/me").status_code == 401


def test_login_invalido(client):
    resp = client.post(
        "/api/auth/login", json={"username": "aluno1", "senha": "errada"}
    )
    assert resp.status_code == 401


def test_caso_regular_um_clique(client):
    login(client, "aluno1", "aluno123")
    resp = submeter(client)
    assert resp.status_code == 200, resp.text
    sub = resp.json()
    assert sub["status"] == "fila_regular"
    assert sub["documentos"]["boletim"]["disponivel"] is True
    assert sub["documentos"]["boa"]["disponivel"] is True

    # Discente não acessa rotas da comissão
    assert client.get("/api/comissao/fila").status_code == 403

    login(client, "comissao1", "comissao123")
    fila = client.get("/api/comissao/fila?tipo=regular").json()
    assert [s["id"] for s in fila["submissoes"]] == [sub["id"]]

    detalhe = client.get(f"/api/comissao/submissoes/{sub['id']}").json()
    assert detalhe["pdfDisponivel"] is True
    assert detalhe["documentos"]["boletim"]["disponivel"] is True
    assert detalhe["documentos"]["boa"]["disponivel"] is True
    assert detalhe["periodos"][0]["disciplinas"]

    pdf = client.get(f"/api/comissao/submissoes/{sub['id']}/boletim")
    assert pdf.status_code == 200
    boa = client.get(f"/api/comissao/submissoes/{sub['id']}/boa")
    assert boa.status_code == 200

    decisao = client.post(
        f"/api/comissao/submissoes/{sub['id']}/decisao",
        json={"decisao": "aprovada", "motivo": "ok"},
    )
    assert decisao.status_code == 200

    # Fila esvaziada; decisão registrada
    assert client.get("/api/comissao/fila?tipo=regular").json()["submissoes"] == []

    login(client, "aluno1", "aluno123")
    minha = client.get("/api/submissoes/minha").json()["submissao"]
    assert minha["status"] == "aprovada"
    assert minha["decisao"]["decisao"] == "aprovada"


def test_upload_duplo_obrigatorio(client):
    login(client, "aluno1", "aluno123")

    payload = payload_apto()
    # Só boletim → erro
    resp = client.post(
        "/api/submissoes",
        files={"boletim": ("boletim.pdf", b"%PDF-1.4", "application/pdf")},
        data={"payload": json.dumps(payload)},
    )
    assert resp.status_code == 400

    # Só BOA → erro
    resp = client.post(
        "/api/submissoes",
        files={"boa": ("boa.pdf", b"%PDF-1.4", "application/pdf")},
        data={"payload": json.dumps(payload)},
    )
    assert resp.status_code == 400


def test_excecao_vai_para_mesa(client):
    login(client, "aluno1", "aluno123")
    payload = payload_apto(
        diagnostico={"apto": False, "criterios": []},
        excecoes=[
            {
                "codigo_requisito": "MAD243",
                "tipo": "equivalencia",
                "codigo_cursada": "MAD999",
                "justificativa": "Aproveitamento de disciplina externa.",
            }
        ],
    )
    sub = submeter(client, payload).json()
    assert sub["status"] == "mesa_revisao"

    login(client, "comissao1", "comissao123")
    mesa = client.get("/api/comissao/fila?tipo=revisao").json()
    assert [s["id"] for s in mesa["submissoes"]] == [sub["id"]]
    assert mesa["submissoes"][0]["excecoes"][0]["status"] == "pendente"

    exc_id = mesa["submissoes"][0]["excecoes"][0]["id"]
    resp = client.post(
        f"/api/comissao/submissoes/{sub['id']}/decisao",
        json={
            "decisao": "devolvida",
            "motivo": "Enviar resolução de equivalência.",
            "excecoes": [{"id": exc_id, "status": "recusada"}],
        },
    )
    assert resp.json()["status"] == "devolvida"


def test_submissao_dupla_bloqueada(client):
    login(client, "aluno1", "aluno123")
    assert submeter(client).status_code == 200
    assert submeter(client).status_code == 409


def test_audit_log_cadeia_integra(client):
    from app.db import SessionLocal
    from app.models import AuditLog
    from app.services.auditoria import verificar_cadeia

    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()
    login(client, "comissao1", "comissao123")
    client.post(
        f"/api/comissao/submissoes/{sub['id']}/decisao",
        json={"decisao": "aprovada"},
    )

    with SessionLocal() as db:
        assert db.query(AuditLog).count() >= 3
        assert verificar_cadeia(db)


def test_expurgo_apos_retencao(client):
    import os

    from app.config import settings
    from app.db import SessionLocal
    from app.models import Submissao
    from app.services.expurgo import executar_expurgo

    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()
    login(client, "comissao1", "comissao123")
    client.post(
        f"/api/comissao/submissoes/{sub['id']}/decisao",
        json={"decisao": "aprovada"},
    )

    with SessionLocal() as db:
        s = db.get(Submissao, sub["id"])
        pdf_path = s.boletim_path
        assert pdf_path and os.path.exists(pdf_path)

    # Fora da janela de retenção → ainda retido
    with SessionLocal() as db:
        assert executar_expurgo(db, settings) == 0
        assert os.path.exists(pdf_path)

    # Retroativa a conclusão para além da janela → expurga
    with SessionLocal() as db:
        s = db.get(Submissao, sub["id"])
        s.concluido_em = datetime.now(timezone.utc) - timedelta(
            days=settings.pdf_retention_days + 1
        )
        db.commit()

    with SessionLocal() as db:
        assert executar_expurgo(db, settings) == 1
        s = db.get(Submissao, sub["id"])
        assert s.pdf_expurgado_em is not None
        assert not os.path.exists(pdf_path)

    # PDF expurgado → 410
    resp = client.get(f"/api/comissao/submissoes/{sub['id']}/boletim")
    assert resp.status_code == 410
