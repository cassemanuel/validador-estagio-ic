"""Rotas da Comissão de Estágio: fila regular, mesa de revisão e decisão."""

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..auth.jwt import require_comissao
from ..config import settings
from ..db import get_db
from ..models import AuditLog, Decisao, Excecao, Submissao, Usuario
from ..schemas import DecisaoIn
from ..services.auditoria import registrar
from ..services.autorizacao import dados_autorizacao
from ..services.metricas import calcular_metricas

router = APIRouter(prefix="/api/comissao", tags=["comissao"])

STATUS_ABERTOS = ("fila_regular", "mesa_revisao")


def _serializar_resumo(sub: Submissao) -> dict:
    metadata = json.loads(sub.metadata_json)
    return {
        "id": sub.id,
        "status": sub.status,
        "tipoDocumento": sub.tipo_documento,
        "metadata": metadata,
        "diagnostico": json.loads(sub.diagnostico_json)
        if sub.diagnostico_json
        else None,
        "alertas": json.loads(sub.alertas_saneamento_json)
        if sub.alertas_saneamento_json
        else [],
        "excecoes": [
            {
                "id": e.id,
                "codigoRequisito": e.codigo_requisito,
                "tipo": e.tipo,
                "codigoCursada": e.codigo_cursada,
                "justificativa": e.justificativa,
                "status": e.status,
            }
            for e in sub.excecoes
        ],
        "criadoEm": sub.criado_em.isoformat() if sub.criado_em else None,
        "autorizacao": dados_autorizacao(sub, settings.autorizacao_validade_dias),
    }


def _serializar_completo(sub: Submissao) -> dict:
    dados = _serializar_resumo(sub)
    extraidos = json.loads(sub.dados_extraidos_json)
    dados["periodos"] = extraidos.get("periodos") or []
    dados["pendencias"] = extraidos.get("pendencias") or {}
    dados["pdfDisponivel"] = bool(sub.pdf_path) and sub.pdf_expurgado_em is None
    dados["pdfSha256"] = sub.pdf_sha256
    return dados


def _obter_submissao(db: Session, sub_id: int) -> Submissao:
    sub = db.query(Submissao).filter_by(id=sub_id).first()
    if not sub:
        raise HTTPException(404, "Submissão não encontrada.")
    return sub


@router.get("/fila")
def fila(
    tipo: str = Query("regular", pattern="^(regular|revisao)$"),
    db: Session = Depends(get_db),
    _=Depends(require_comissao),
):
    status = "fila_regular" if tipo == "regular" else "mesa_revisao"
    subs = (
        db.query(Submissao)
        .filter(Submissao.status == status)
        .order_by(Submissao.criado_em.asc())
        .all()
    )
    return {"submissoes": [_serializar_resumo(s) for s in subs]}


@router.get("/metricas")
def metricas(
    db: Session = Depends(get_db), _=Depends(require_comissao)
):
    return calcular_metricas(db, settings)


@router.get("/auditoria")
def auditoria(
    limite: int = Query(10, ge=1, le=100),
    db: Session = Depends(get_db),
    _=Depends(require_comissao),
):
    """Últimos eventos do audit_log (o registro é imutável no banco)."""
    rows = (
        db.query(AuditLog, Usuario.username)
        .outerjoin(Usuario, AuditLog.ator_id == Usuario.id)
        .order_by(AuditLog.id.desc())
        .limit(limite)
        .all()
    )
    return {
        "eventos": [
            {
                "ts": reg.ts.isoformat() if reg.ts else None,
                "ator": username or "sistema",
                "papel": reg.ator_papel,
                "acao": reg.acao,
                "entidade": reg.entidade,
                "entidade_id": reg.entidade_id,
            }
            for reg, username in rows
        ]
    }


@router.get("/autorizacoes")
def autorizacoes(
    db: Session = Depends(get_db), _=Depends(require_comissao)
):
    """Liberações deferidas com validade (liberação + N dias)."""
    subs = (
        db.query(Submissao)
        .filter(Submissao.status == "aprovada")
        .order_by(Submissao.concluido_em.desc())
        .all()
    )
    linhas = []
    for s in subs:
        aut = dados_autorizacao(s, settings.autorizacao_validade_dias)
        if not aut:
            continue
        metadata = json.loads(s.metadata_json)
        linhas.append(
            {
                "id": s.id,
                "nome": metadata.get("nome"),
                "dre": metadata.get("dre"),
                "liberadaEm": aut["liberadaEm"],
                "validaAte": aut["validaAte"],
                "diasParaVencer": aut["diasParaVencer"],
                "status": "expirada" if aut["expirada"] else "vigente",
            }
        )
    return {"autorizacoes": linhas}


@router.get("/submissoes/{sub_id}")
def detalhe(
    sub_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_comissao),
):
    return _serializar_completo(_obter_submissao(db, sub_id))


@router.get("/submissoes/{sub_id}/pdf")
def pdf(
    sub_id: int,
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_comissao),
):
    sub = _obter_submissao(db, sub_id)
    if sub.pdf_expurgado_em is not None:
        raise HTTPException(410, "PDF expurgado por política de retenção.")
    if not sub.pdf_path or not Path(sub.pdf_path).exists():
        raise HTTPException(404, "PDF indisponível.")

    registrar(db, user, "acesso_pdf", "submissao", sub.id)
    db.commit()
    return FileResponse(sub.pdf_path, media_type="application/pdf")


@router.post("/submissoes/{sub_id}/decisao")
def decidir(
    sub_id: int,
    body: DecisaoIn,
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_comissao),
):
    """Deliberação transacional: decisão + exceções + status + auditoria."""
    sub = _obter_submissao(db, sub_id)
    if sub.status not in STATUS_ABERTOS:
        raise HTTPException(409, "Submissão já concluída.")

    decisao = Decisao(
        submissao_id=sub.id,
        decisao=body.decisao,
        motivo=body.motivo,
        decidido_por=user.id,
    )
    db.add(decisao)

    agora = datetime.now(timezone.utc)
    for e_in in body.excecoes:
        exc = db.query(Excecao).filter_by(
            id=e_in.id, submissao_id=sub.id
        ).first()
        if exc and exc.status == "pendente":
            exc.status = e_in.status
            exc.decidida_por = user.id
            exc.decidida_em = agora

    sub.status = body.decisao
    sub.concluido_em = agora

    registrar(
        db,
        user,
        "decisao",
        "submissao",
        sub.id,
        {"decisao": body.decisao, "motivo": body.motivo},
    )
    db.commit()
    return {"ok": True, "status": sub.status}
