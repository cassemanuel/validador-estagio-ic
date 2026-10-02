"""Expurgo do PDF bruto após conclusão do processo (LGPD/minimização).

Retido por PDF_RETENTION_DAYS após a decisão (janela de recurso) e
removido por job periódico; os dados extraídos, decisões e o audit_log
permanecem.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from .auditoria import registrar
from ..models import Submissao

STATUS_CONCLUIDOS = ("aprovada", "indeferida", "devolvida")


def executar_expurgo(db: Session, settings) -> int:
    """Expurga PDFs de processos concluídos fora da janela de recurso.

    Retorna o número de arquivos removidos.
    """
    limite = datetime.now(timezone.utc) - timedelta(days=settings.pdf_retention_days)
    candidatas = (
        db.query(Submissao)
        .filter(
            Submissao.status.in_(STATUS_CONCLUIDOS),
            Submissao.concluido_em.isnot(None),
            Submissao.concluido_em <= limite,
            Submissao.pdf_expurgado_em.is_(None),
            Submissao.boletim_path.isnot(None),
        )
        .all()
    )

    removidos = 0
    for sub in candidatas:
        for attr in ("boletim_path", "boa_path", "pdf_path"):
            path_str = getattr(sub, attr, None)
            if path_str:
                path = Path(path_str)
                if path.exists():
                    path.unlink()
        sub.pdf_expurgado_em = datetime.now(timezone.utc)
        registrar(
            db,
            ator=None,
            acao="expurgo_pdfs",
            entidade="submissao",
            entidade_id=sub.id,
            payload={
                "boletim_sha256": sub.boletim_sha256,
                "boa_sha256": sub.boa_sha256,
            },
        )
        removidos += 1
    db.commit()
    return removidos


async def purge_loop(settings, session_factory) -> None:
    """Loop periódico de expurgo e arquivamento — lifespan do FastAPI."""
    from .arquivo import arquivar_antigos

    while True:
        try:
            with session_factory() as db:
                executar_expurgo(db, settings)
                arquivar_antigos(db, settings)
        except Exception:  # noqa: BLE001 — o job nunca deve derrubar o app
            pass
        await asyncio.sleep(settings.purge_interval_seconds)
