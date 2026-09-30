"""Arquivamento de registros antigos (retenção de 6 meses).

Deliberações (decisoes) e eventos (audit_log) mais velhos que
AUDIT_RETENTION_DAYS são exportados para JSONL em ARCHIVE_DIR e removidos
da tabela ativa. Para preservar a integridade tamper-evident do
audit_log, insere-se uma linha âncora (acao='arquivamento') cujo
`hash_registro` replica o último hash arquivado — assim a cadeia dos
registros restantes continua válida e o arquivo exportado referencia o
elo preservado.
"""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import AuditLog, Decisao

ACAO_ANCORA = "arquivamento"


def arquivar_antigos(db: Session, settings) -> int:
    """Arquiva registros além da janela de retenção. Retorna nº arquivado."""
    limite = datetime.now(timezone.utc) - timedelta(
        days=settings.audit_retention_days
    )

    decisoes = (
        db.query(Decisao)
        .filter(Decisao.decidido_em < limite)
        .order_by(Decisao.id)
        .all()
    )
    logs = (
        db.query(AuditLog)
        .filter(AuditLog.ts < limite, AuditLog.acao != ACAO_ANCORA)
        .order_by(AuditLog.id)
        .all()
    )
    if not decisoes and not logs:
        return 0

    archive_dir = Path(settings.archive_dir)
    archive_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    total = 0
    if decisoes:
        arquivo = archive_dir / f"decisoes_{stamp}.jsonl"
        with arquivo.open("w", encoding="utf-8") as f:
            for d in decisoes:
                f.write(
                    json.dumps(
                        {
                            "id": d.id,
                            "submissao_id": d.submissao_id,
                            "decisao": d.decisao,
                            "motivo": d.motivo,
                            "decidido_por": d.decidido_por,
                            "decidido_em": _iso(d.decidido_em),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        for d in decisoes:
            db.delete(d)
        total += len(decisoes)

    if logs:
        ultimo_hash = logs[-1].hash_registro
        arquivo = archive_dir / f"audit_log_{stamp}.jsonl"
        with arquivo.open("w", encoding="utf-8") as f:
            for r in logs:
                f.write(
                    json.dumps(
                        {
                            "id": r.id,
                            "ts": _iso(r.ts),
                            "ator_id": r.ator_id,
                            "ator_papel": r.ator_papel,
                            "acao": r.acao,
                            "entidade": r.entidade,
                            "entidade_id": r.entidade_id,
                            "payload_json": r.payload_json,
                            "hash_anterior": r.hash_anterior,
                            "hash_registro": r.hash_registro,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        for r in logs:
            db.delete(r)
        # Flush antes do INSERT da âncora: o flush do SQLAlchemy executa
        # INSERTs antes de DELETEs, e a âncora reutiliza um id recém-liberado.
        db.flush()

        # Linha âncora: ocupa o primeiro id arquivado e replica o último
        # hash arquivado — a cadeia dos registros remanescentes segue
        # verificável em ordem de id.
        db.add(
            AuditLog(
                id=logs[0].id,
                ator_id=None,
                ator_papel="sistema",
                acao=ACAO_ANCORA,
                entidade="audit_log",
                payload_json=json.dumps(
                    {
                        "arquivo": arquivo.name,
                        "registros": len(logs),
                        "ultimo_hash_arquivado": ultimo_hash,
                    },
                    ensure_ascii=False,
                ),
                hash_anterior=logs[0].hash_anterior,
                hash_registro=ultimo_hash,
            )
        )
        total += len(logs)

    db.commit()
    return total


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None
