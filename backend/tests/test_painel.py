"""Testes das novas rotas: métricas, auditoria, reenvio e arquivamento."""

from datetime import datetime, timedelta, timezone

from .conftest import login, payload_apto, submeter


def test_reenvio_apos_devolucao(client):
    """Discente devolvido pode criar nova submissão ativa."""
    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()

    login(client, "comissao1", "comissao123")
    client.post(
        f"/api/comissao/submissoes/{sub['id']}/decisao",
        json={"decisao": "devolvida", "motivo": "Refazer upload."},
    )

    login(client, "aluno1", "aluno123")
    resp = submeter(client)
    assert resp.status_code == 200
    assert resp.json()["id"] != sub["id"]
    assert resp.json()["status"] == "fila_regular"


def test_metricas(client):
    login(client, "aluno1", "aluno123")
    submeter(client)
    login(client, "aluno2", "aluno123")
    payload = payload_apto(
        metadata={"dre": "aluno2", "tipoDocumento": "boa"},
        excecoes=[
            {
                "codigo_requisito": "MAD243",
                "tipo": "dispensa",
                "justificativa": "Dispensa concedida pela coordenação.",
            }
        ],
    )
    submeter(client, payload)

    login(client, "comissao1", "comissao123")
    m = client.get("/api/comissao/metricas").json()
    assert m["total"] == 2
    assert m["total_semestre"] == 2
    assert m["pendentes"] == 2
    assert m["fila_regular"] == 1
    assert m["mesa_revisao"] == 1
    assert m["deferidos"] == 0
    assert m["semestre"]

    # Aprova o caso regular → deferidos=1, pendentes=1
    fila = client.get("/api/comissao/fila?tipo=regular").json()
    sub_id = fila["submissoes"][0]["id"]
    client.post(
        f"/api/comissao/submissoes/{sub_id}/decisao",
        json={"decisao": "aprovada"},
    )
    m = client.get("/api/comissao/metricas").json()
    assert m["deferidos"] == 1
    assert m["pendentes"] == 1
    assert m["relatorios"]["pendentes"] == 1


def test_auditoria_ultimos_eventos(client):
    login(client, "aluno1", "aluno123")
    submeter(client)
    login(client, "comissao1", "comissao123")

    resp = client.get("/api/comissao/auditoria?limite=10")
    assert resp.status_code == 200
    eventos = resp.json()["eventos"]
    assert len(eventos) >= 2
    acoes = {e["acao"] for e in eventos}
    assert "submissao_criada" in acoes
    assert "login" in acoes
    # Ator resolvido para username (DRE/UID)
    assert any(e["ator"] == "aluno1" for e in eventos)
    assert all(e["ts"] for e in eventos)

    # Auditoria é restrita à comissão
    login(client, "aluno1", "aluno123")
    assert client.get("/api/comissao/auditoria").status_code == 403


def test_arquivamento_preserva_cadeia(client, tmp_path):
    from app.config import settings
    from app.db import SessionLocal
    from app.models import AuditLog
    from app.services.arquivo import arquivar_antigos
    from app.services.auditoria import verificar_cadeia

    login(client, "aluno1", "aluno123")
    submeter(client)

    # Envelhece todos os logs além da retenção
    limite = (
        datetime.now(timezone.utc)
        - timedelta(days=settings.audit_retention_days + 1)
    ).replace(tzinfo=None)  # SQLite persiste datetimes naive
    with SessionLocal() as db:
        for reg in db.query(AuditLog).all():
            reg.ts = limite
        db.commit()

    with SessionLocal() as db:
        arquivados = arquivar_antigos(db, settings)
        assert arquivados >= 1
        # Resta apenas a âncora de continuidade
        restantes = db.query(AuditLog).all()
        assert len(restantes) == 1
        assert restantes[0].acao == "arquivamento"

    # Novos eventos continuam a cadeia a partir da âncora
    login(client, "comissao1", "comissao123")
    with SessionLocal() as db:
        assert db.query(AuditLog).count() >= 2
        assert verificar_cadeia(db)


def test_filtro_por_ano_metricas_e_autorizacoes(client):
    """O parâmetro ?ano= restringe métricas e autorizações ao ano do processo."""
    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()

    login(client, "comissao1", "comissao123")
    client.post(
        f"/api/comissao/submissoes/{sub['id']}/decisao",
        json={"decisao": "aprovada"},
    )

    ano_atual = datetime.now(timezone.utc).year
    m = client.get(f"/api/comissao/metricas?ano={ano_atual}").json()
    assert m["total"] == 1
    assert ano_atual in m["anos"]

    m_vazio = client.get(f"/api/comissao/metricas?ano={ano_atual - 5}").json()
    assert m_vazio["total"] == 0
    assert ano_atual in m_vazio["anos"]  # seletor segue completo

    auts = client.get(f"/api/comissao/autorizacoes?ano={ano_atual}").json()
    assert len(auts["autorizacoes"]) == 1
    assert ano_atual in auts["anos"]

    auts_vazio = client.get(
        f"/api/comissao/autorizacoes?ano={ano_atual - 5}"
    ).json()
    assert auts_vazio["autorizacoes"] == []


def test_arquivamento_de_processo_concluido(client):
    """Arquivar remove o processo da fila ativa e das métricas de pendentes."""
    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()

    login(client, "comissao1", "comissao123")

    # Não arquiva processo ainda em análise
    resp = client.post(f"/api/comissao/submissoes/{sub['id']}/arquivar")
    assert resp.status_code == 409

    # Conclui (indefere) e arquiva
    client.post(
        f"/api/comissao/submissoes/{sub['id']}/decisao",
        json={"decisao": "indeferida", "motivo": "Documento ilegível."},
    )
    resp = client.post(f"/api/comissao/submissoes/{sub['id']}/arquivar")
    assert resp.status_code == 200
    assert resp.json()["status"] == "arquivada"

    # Idempotência proibida: já arquivado → 409
    assert client.post(
        f"/api/comissao/submissoes/{sub['id']}/arquivar"
    ).status_code == 409

    # Não aparece em "Aguardando Análise" nem nas contagens ativas
    fila_aberta = client.get("/api/comissao/fila?status=abertos").json()
    assert all(s["id"] != sub["id"] for s in fila_aberta["submissoes"])

    fila_arq = client.get("/api/comissao/fila?status=arquivada").json()
    assert [s["id"] for s in fila_arq["submissoes"]] == [sub["id"]]

    m = client.get("/api/comissao/metricas").json()
    assert m["pendentes"] == 0
    assert m["arquivadas"] == 1

    # Evento registrado no audit_log
    eventos = client.get("/api/comissao/auditoria?limite=20").json()["eventos"]
    assert "processo_arquivado" in {e["acao"] for e in eventos}

    # Discente não pode arquivar
    login(client, "aluno1", "aluno123")
    assert client.post(
        f"/api/comissao/submissoes/{sub['id']}/arquivar"
    ).status_code == 403


def test_autorizacoes_validade_90_dias(client):
    """Deferimento gera autorização com validade = liberação + 90 dias."""
    from datetime import datetime

    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()

    login(client, "comissao1", "comissao123")
    client.post(
        f"/api/comissao/submissoes/{sub['id']}/decisao",
        json={"decisao": "aprovada"},
    )

    resp = client.get("/api/comissao/autorizacoes")
    assert resp.status_code == 200
    auts = resp.json()["autorizacoes"]
    assert len(auts) == 1
    a = auts[0]
    assert a["status"] == "vigente"
    assert a["nome"] == "Aluno Exemplo"
    lib = datetime.fromisoformat(a["liberadaEm"])
    val = datetime.fromisoformat(a["validaAte"])
    assert (val - lib).days == 90

    # O discente também vê a autorização na própria submissão.
    login(client, "aluno1", "aluno123")
    minha = client.get("/api/submissoes/minha").json()["submissao"]
    assert minha["autorizacao"]["validaAte"] == a["validaAte"]
    assert not minha["autorizacao"]["expirada"]
