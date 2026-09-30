"""Rotas do discente: submissão do documento e acompanhamento."""

import hashlib
import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..auth.jwt import require_discente
from ..config import settings
from ..db import get_db
from ..models import Decisao, Excecao, Submissao, Usuario
from ..schemas import SubmissaoPayload
from ..services import saneamento, triagem
from ..services.auditoria import registrar
from ..services.autorizacao import dados_autorizacao
from .deps import get_regras

router = APIRouter(prefix="/api/submissoes", tags=["submissoes"])

STATUS_ATIVOS = ("fila_regular", "mesa_revisao")


def _serializar(sub: Submissao, decisao=None) -> dict:
    metadata = json.loads(sub.metadata_json)
    resultado = {
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
        "concluidoEm": sub.concluido_em.isoformat() if sub.concluido_em else None,
        "autorizacao": dados_autorizacao(sub, settings.autorizacao_validade_dias),
    }
    if decisao:
        resultado["decisao"] = {
            "decisao": decisao.decisao,
            "motivo": decisao.motivo,
            "decididoEm": decisao.decidido_em.isoformat()
            if decisao.decidido_em
            else None,
        }
    return resultado


@router.post("")
def criar_submissao(
    payload: str = Form(...),
    pdf: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_discente),
):
    """Recebe o PDF bruto + dados extraídos no cliente (multipart).

    O documento só chega ao servidor após a confirmação interativa do
    discente — o parsing roda inteiro no navegador antes disso.
    """
    ativa = (
        db.query(Submissao)
        .filter(
            Submissao.discente_id == user.id,
            Submissao.status.in_(STATUS_ATIVOS),
        )
        .first()
    )
    if ativa:
        raise HTTPException(409, "Já existe uma submissão em andamento.")

    if not (pdf.filename or "").lower().endswith(".pdf") and (
        pdf.content_type or ""
    ) != "application/pdf":
        raise HTTPException(400, "Envie um arquivo PDF válido.")

    try:
        body = SubmissaoPayload.model_validate_json(payload)
    except ValueError:
        raise HTTPException(400, "Payload JSON inválido.")

    pdf_bytes = pdf.file.read()
    if len(pdf_bytes) > settings.max_pdf_size:
        raise HTTPException(400, "Arquivo muito grande (máx. 10 MB).")

    dados = body.model_dump(exclude={"excecoes"})
    regras = get_regras()
    resultado = saneamento.analisar(dados, regras, user.username)

    diagnostico = body.diagnostico or resultado["diagnostico_recalculado"]
    status = triagem.rotear(
        diagnostico, body.excecoes, resultado["alertas"]
    )

    sub = Submissao(
        discente_id=user.id,
        status=status,
        tipo_documento=str(body.metadata.get("tipoDocumento") or "") or None,
        metadata_json=json.dumps(body.metadata, ensure_ascii=False),
        dados_extraidos_json=json.dumps(
            {"periodos": body.periodos, "pendencias": body.pendencias},
            ensure_ascii=False,
        ),
        diagnostico_json=json.dumps(diagnostico, ensure_ascii=False),
        alertas_saneamento_json=json.dumps(
            resultado["alertas"], ensure_ascii=False
        ),
        pdf_sha256=hashlib.sha256(pdf_bytes).hexdigest(),
    )
    db.add(sub)
    db.flush()  # garante sub.id para nomear o arquivo

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = upload_dir / f"{sub.id}.pdf"
    pdf_path.write_bytes(pdf_bytes)
    sub.pdf_path = str(pdf_path)

    for e in body.excecoes:
        db.add(
            Excecao(
                submissao_id=sub.id,
                codigo_requisito=e.codigo_requisito.upper(),
                tipo=e.tipo,
                codigo_cursada=(e.codigo_cursada or "").upper() or None,
                justificativa=e.justificativa,
            )
        )

    registrar(
        db,
        user,
        "submissao_criada",
        "submissao",
        sub.id,
        {"status": status, "alertas": len(resultado["alertas"])},
    )
    db.commit()
    db.refresh(sub)
    return _serializar(sub)


@router.get("/minha")
def minha_submissao(
    db: Session = Depends(get_db), user: Usuario = Depends(require_discente)
):
    sub = (
        db.query(Submissao)
        .filter(Submissao.discente_id == user.id)
        .order_by(Submissao.id.desc())
        .first()
    )
    if not sub:
        return {"submissao": None}
    decisao = (
        db.query(Decisao)
        .filter(Decisao.submissao_id == sub.id)
        .order_by(Decisao.id.desc())
        .first()
    )
    return {"submissao": _serializar(sub, decisao)}
