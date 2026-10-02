"""Rotas da Comissão de Estágio: fila regular, mesa de revisão e decisão."""

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..auth.jwt import require_comissao
from ..config import settings
from ..db import get_db
from ..models import (
    STATUS_SUBMISSAO,
    AuditLog,
    Decisao,
    Excecao,
    Submissao,
    Usuario,
)
from ..schemas import DecisaoIn, RevogarIn
from ..services import crypto
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
    expurgado = sub.pdf_expurgado_em is not None
    dados["documentos"] = {
        "boletim": {
            "disponivel": bool(sub.boletim_path) and not expurgado,
            "sha256": sub.boletim_sha256,
            "url": f"/api/comissao/submissoes/{sub.id}/boletim",
        },
        "boa": {
            "disponivel": bool(sub.boa_path) and not expurgado,
            "sha256": sub.boa_sha256,
            "url": f"/api/comissao/submissoes/{sub.id}/boa",
        },
    }
    dados["pdfDisponivel"] = bool(sub.pdf_path) and not expurgado
    dados["pdfSha256"] = sub.pdf_sha256
    return dados


def _obter_submissao(db: Session, sub_id: int) -> Submissao:
    sub = db.query(Submissao).filter_by(id=sub_id).first()
    if not sub:
        raise HTTPException(404, "Submissão não encontrada.")
    return sub


@router.get("/fila")
def fila(
    tipo: str = Query("todos", pattern="^(regular|revisao|todos)$"),
    status: str = Query(
        "abertos",
        pattern="^(?i:abertos|todos|todas|fila_regular|mesa_revisao|aprovada|indeferida|devolvida|cancelada|revogada|arquivada)$",
    ),
    q: str = Query("", max_length=100),
    offset: int = Query(0, ge=0),
    limite: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    _=Depends(require_comissao),
):
    """Fila unificada de triagem com busca por nome/DRE, status e paginação."""
    # Normaliza variantes do cliente ("todas" → "todos", case-insensitive).
    status = status.lower()
    if status == "todas":
        status = "todos"

    if status == "todos":
        # "Todas" exclui arquivadas — elas só aparecem no filtro explícito.
        status_set = tuple(s for s in STATUS_SUBMISSAO if s != "arquivada")
    elif status == "abertos":
        tipo_map = {
            "regular": ("fila_regular",),
            "revisao": ("mesa_revisao",),
            "todos": STATUS_ABERTOS,
        }
        status_set = tipo_map.get(tipo, STATUS_ABERTOS)
    else:
        status_set = (status,)

    query = db.query(Submissao)
    if status_set is not None:
        query = query.filter(Submissao.status.in_(status_set))
    if q:
        like = f"%{q}%"
        query = query.filter(
            Submissao.metadata_json.ilike(like)
            | Submissao.dados_extraidos_json.ilike(like)
        )

    total = query.count()
    subs = (
        query.order_by(Submissao.criado_em.asc())
        .offset(offset)
        .limit(limite)
        .all()
    )
    return {
        "total": total,
        "offset": offset,
        "limite": limite,
        "submissoes": [_serializar_resumo(s) for s in subs],
    }


@router.get("/metricas")
def metricas(
    ano: int | None = Query(None, ge=2000, le=2100),
    db: Session = Depends(get_db),
    _=Depends(require_comissao),
):
    return calcular_metricas(db, settings, ano)


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
    ano: int | None = Query(None, ge=2000, le=2100),
    db: Session = Depends(get_db),
    _=Depends(require_comissao),
):
    """Liberações deferidas com validade (liberação + N dias)."""
    subs = (
        db.query(Submissao)
        .filter(Submissao.status == "aprovada")
        .order_by(Submissao.concluido_em.desc())
        .all()
    )
    anos = sorted(
        {s.concluido_em.year for s in subs if s.concluido_em}, reverse=True
    )
    if ano is not None:
        subs = [
            s for s in subs
            if s.concluido_em and s.concluido_em.year == ano
        ]
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
    return {"autorizacoes": linhas, "anos": anos}


@router.get("/submissoes/{sub_id}")
def detalhe(
    sub_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_comissao),
):
    return _serializar_completo(_obter_submissao(db, sub_id))


def _stream_pdf(path: str, sub: Submissao, user: Usuario, db: Session, acao: str):
    if sub.pdf_expurgado_em is not None:
        raise HTTPException(410, "PDF expurgado por política de retenção.")
    if not path or not Path(path).exists():
        raise HTTPException(404, "Documento indisponível.")

    registrar(db, user, acao, "submissao", sub.id)
    db.commit()

    def iterfile():
        with open(path, "rb") as f:
            token = f.read()
        yield crypto.decifrar(token)

    return StreamingResponse(
        iterfile(), media_type="application/pdf", headers={"Content-Disposition": "inline"}
    )


@router.get("/submissoes/{sub_id}/boletim")
def boletim_pdf(
    sub_id: int,
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_comissao),
):
    sub = _obter_submissao(db, sub_id)
    return _stream_pdf(sub.boletim_path, sub, user, db, "acesso_boletim")


@router.get("/submissoes/{sub_id}/boa")
def boa_pdf(
    sub_id: int,
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_comissao),
):
    sub = _obter_submissao(db, sub_id)
    return _stream_pdf(sub.boa_path, sub, user, db, "acesso_boa")


@router.get("/submissoes/{sub_id}/pdf")
def pdf(
    sub_id: int,
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_comissao),
):
    """Endpoint legado: retorna o boletim."""
    return boletim_pdf(sub_id, db, user)


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


STATUS_ARQUIVAVEIS = ("indeferida", "devolvida", "cancelada", "revogada")


@router.post("/submissoes/{sub_id}/arquivar")
def arquivar(
    sub_id: int,
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_comissao),
):
    """Arquiva um processo concluído, tirando-o da fila ativa.

    Aprovadas não são arquiváveis: a autorização de estágio (e sua
    validade) depende do status 'aprovada'. Para encerrar uma aprovada,
    revogue-a antes.
    """
    sub = _obter_submissao(db, sub_id)
    if sub.status in STATUS_ABERTOS:
        raise HTTPException(409, "Submissão ainda está em análise.")
    if sub.status == "aprovada":
        raise HTTPException(
            409,
            "Processo aprovado possui autorização vigente — revogue antes de arquivar.",
        )
    if sub.status not in STATUS_ARQUIVAVEIS:
        raise HTTPException(409, "Submissão já está arquivada.")

    sub.status_anterior = sub.status
    sub.status = "arquivada"
    registrar(
        db, user, "processo_arquivado", "submissao", sub.id,
        {"status_anterior": sub.status_anterior},
    )
    db.commit()
    return {"ok": True, "status": sub.status}


@router.post("/submissoes/{sub_id}/desarquivar")
def desarquivar(
    sub_id: int,
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_comissao),
):
    """Restaura um processo arquivado ao status em que foi concluído."""
    sub = _obter_submissao(db, sub_id)
    if sub.status != "arquivada":
        raise HTTPException(409, "Submissão não está arquivada.")

    anterior = sub.status_anterior or "indeferida"
    if anterior not in STATUS_ARQUIVAVEIS:
        anterior = "indeferida"
    sub.status = anterior
    sub.status_anterior = None
    registrar(
        db, user, "processo_desarquivado", "submissao", sub.id,
        {"status_restaurado": anterior},
    )
    db.commit()
    return {"ok": True, "status": sub.status}


@router.post("/submissoes/{sub_id}/revogar")
def revogar(
    sub_id: int,
    body: RevogarIn,
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_comissao),
):
    """Revoga uma autorização previamente aprovada e invalida a licença."""
    sub = _obter_submissao(db, sub_id)
    if sub.status != "aprovada":
        raise HTTPException(409, "Só é possível revogar processos aprovados.")

    decisao = Decisao(
        submissao_id=sub.id,
        decisao="revogada",
        motivo=body.motivo,
        decidido_por=user.id,
    )
    db.add(decisao)

    sub.status = "revogada"
    sub.concluido_em = datetime.now(timezone.utc)

    registrar(
        db,
        user,
        "revogacao_autorizacao",
        "submissao",
        sub.id,
        {"motivo": body.motivo},
    )
    db.commit()
    return {"ok": True, "status": sub.status}
