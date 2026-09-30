"""Registro transacional imutável de deliberações (audit_log).

Append-only: a aplicação nunca executa UPDATE/DELETE nesta tabela.
Cada registro encadeia o sha256 do anterior (tamper-evident).
"""

import hashlib
import json

from sqlalchemy.orm import Session

from ..models import AuditLog, Usuario

GENESIS = "GENESIS"


def registrar(
    db: Session,
    ator: Usuario | None,
    acao: str,
    entidade: str | None = None,
    entidade_id: int | None = None,
    payload: dict | None = None,
) -> AuditLog:
    """Insere um registro no audit_log dentro da transação corrente."""
    ultimo = db.query(AuditLog).order_by(AuditLog.id.desc()).first()
    hash_anterior = ultimo.hash_registro if ultimo else GENESIS

    payload_json = json.dumps(payload, ensure_ascii=False) if payload else None
    conteudo = json.dumps(
        {
            "ator_id": ator.id if ator else None,
            "ator_papel": ator.papel if ator else None,
            "acao": acao,
            "entidade": entidade,
            "entidade_id": entidade_id,
            "payload": payload,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    hash_registro = hashlib.sha256(
        (hash_anterior + "|" + conteudo).encode()
    ).hexdigest()

    registro = AuditLog(
        ator_id=ator.id if ator else None,
        ator_papel=ator.papel if ator else None,
        acao=acao,
        entidade=entidade,
        entidade_id=entidade_id,
        payload_json=payload_json,
        hash_anterior=hash_anterior,
        hash_registro=hash_registro,
    )
    db.add(registro)
    return registro


def verificar_cadeia(db: Session) -> bool:
    """Revalida a hash chain — usado em testes e auditoria.

    Linhas âncora (acao='arquivamento') marcam pontos de arquivamento:
    seu hash_registro replica o último hash arquivado e não é recomputado,
    mas serve de elo para os registros seguintes.
    """
    prev_hash = None
    for reg in db.query(AuditLog).order_by(AuditLog.id).all():
        if reg.acao == "arquivamento":
            if not reg.hash_registro:
                return False
            prev_hash = reg.hash_registro
            continue
        conteudo = json.dumps(
            {
                "ator_id": reg.ator_id,
                "ator_papel": reg.ator_papel,
                "acao": reg.acao,
                "entidade": reg.entidade,
                "entidade_id": reg.entidade_id,
                "payload": json.loads(reg.payload_json)
                if reg.payload_json
                else None,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        esperado = hashlib.sha256(
            (reg.hash_anterior + "|" + conteudo).encode()
        ).hexdigest()
        if reg.hash_registro != esperado:
            return False
        if prev_hash is not None and reg.hash_anterior != prev_hash:
            return False
        prev_hash = reg.hash_registro
    return True
