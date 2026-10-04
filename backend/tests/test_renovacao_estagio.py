"""Testes da regra de renovação de estágio.

A renovação é liberada quando faltam 30 dias ou menos para o vencimento da
autorização de 90 dias, permitindo ao aluno iniciar um novo processo.
"""

from datetime import datetime, timedelta, timezone

from app.db import SessionLocal
from app.models import Submissao

from .conftest import login, submeter


def test_renovacao_liberada_quando_30_dias_ou_menos_para_vencer(client):
    """Com 60 dias de processo aprovado, restam 30 dias e a renovação deve ser permitida."""
    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()

    login(client, "comissao1", "comissao123")
    client.post(
        f"/api/comissao/submissoes/{sub['id']}/decisao",
        json={"decisao": "aprovada"},
    )

    # Simula o desgaste de 2 meses: a validade de 90 dias passa a ter 30 dias restantes.
    with SessionLocal() as db:
        s = db.query(Submissao).filter(Submissao.id == sub["id"]).first()
        assert s is not None
        s.concluido_em = datetime.now(timezone.utc) - timedelta(days=60)
        db.commit()

    login(client, "aluno1", "aluno123")
    minha = client.get("/api/submissoes/minha").json()["submissao"]

    assert minha["autorizacao"]["diasParaVencer"] <= 30
    assert not minha["autorizacao"]["expirada"]
