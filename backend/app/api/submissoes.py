"""Rotas do discente: submissão do documento e acompanhamento."""

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session, selectinload

from ..auth.jwt import require_discente
from ..config import settings
from ..db import get_db
from ..models import Decisao, Excecao, Submissao, Usuario
from ..schemas import SubmissaoPayload
from ..services import saneamento, triagem
from ..services.auditoria import registrar
from ..services.autorizacao import dados_autorizacao
from ..services import crypto
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
        "documentos": {
            "boletim": {
                "sha256": sub.boletim_sha256,
                "disponivel": bool(sub.boletim_path),
            },
            "boa": {
                "sha256": sub.boa_sha256,
                "disponivel": bool(sub.boa_path),
            },
        },
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


PDF_MAGIC = b"%PDF-"


def _validar_pdf(upload: UploadFile | None, nome: str) -> bytes:
    if not upload or not (upload.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, f"Envie o PDF do {nome}.")
    if (upload.content_type or "") not in (
        "application/pdf",
        "application/octet-stream",
        "binary/octet-stream",
    ):
        raise HTTPException(400, f"O arquivo {nome} deve ser um PDF válido.")
    dados = upload.file.read()
    if len(dados) > settings.max_pdf_size:
        raise HTTPException(
            413,
            f"Arquivo {nome} excede o limite de "
            f"{settings.max_pdf_size // (1024 * 1024)} MB.",
        )
    if not dados.startswith(PDF_MAGIC):
        raise HTTPException(400, f"O arquivo {nome} não é um PDF válido.")
    return dados


def _sanitizar_dre(dre: str | None) -> str:
    """Remove qualquer caractere que possa gerar path traversal ou nomes estranhos."""
    if not dre:
        return "sem_dre"
    return re.sub(r"[^A-Za-z0-9]+", "_", str(dre))[:32]


def _salvar_pdf(
    upload: UploadFile,
    upload_dir: Path,
    tipo: str,
    dre: str,
    ts: str,
) -> tuple[Path, str]:
    nome_seguro = f"{tipo}_{dre}_{ts}.bin"
    caminho = upload_dir / nome_seguro
    dados = upload.file.read()
    cifrado = crypto.cifrar(dados)
    caminho.write_bytes(cifrado)
    return caminho, hashlib.sha256(dados).hexdigest()


@router.post("")
def criar_submissao(
    payload: str = Form(...),
    boletim: UploadFile | None = File(None),
    boa: UploadFile | None = File(None),
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_discente),
):
    """Recebe Boletim + BOA + dados extraídos no cliente (multipart).

    Ambos os documentos são obrigatórios. O parsing roda no navegador;
    o servidor faz saneamento, triagem e persistência dos dois PDFs.
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

    try:
        body = SubmissaoPayload.model_validate_json(payload)
    except ValueError:
        raise HTTPException(400, "Payload JSON inválido.")

    _validar_pdf(boletim, "boletim")
    _validar_pdf(boa, "BOA")

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
            {
                "periodos": body.periodos,
                "pendencias": body.pendencias,
                "resumo_boa": body.resumo_boa,
            },
            ensure_ascii=False,
        ),
        diagnostico_json=json.dumps(diagnostico, ensure_ascii=False),
        alertas_saneamento_json=json.dumps(
            resultado["alertas"], ensure_ascii=False
        ),
    )
    db.add(sub)
    db.flush()  # garante sub.id para auditoria

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    dre = _sanitizar_dre(body.metadata.get("dre") or user.username or str(user.id))

    boletim.file.seek(0)
    boa.file.seek(0)
    boletim_path, boletim_hash = _salvar_pdf(
        boletim, upload_dir, "boletim", dre, ts
    )
    boa_path, boa_hash = _salvar_pdf(boa, upload_dir, "boa", dre, ts)

    sub.boletim_path = str(boletim_path)
    sub.boletim_sha256 = boletim_hash
    sub.boa_path = str(boa_path)
    sub.boa_sha256 = boa_hash
    sub.pdf_path = sub.boletim_path
    sub.pdf_sha256 = sub.boletim_sha256

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


@router.get("/minhas")
def minhas_submissoes(
    db: Session = Depends(get_db), user: Usuario = Depends(require_discente)
):
    """Histórico de submissões do discente logado."""
    subs = (
        db.query(Submissao)
        .options(selectinload(Submissao.decisoes))
        .filter(Submissao.discente_id == user.id)
        .order_by(Submissao.id.desc())
        .all()
    )
    return {"submissoes": [_serializar_completo(sub) for sub in subs]}


@router.post("/{sub_id}/cancelar")
def cancelar_submissao(
    sub_id: int,
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_discente),
):
    """Cancela uma submissão ainda não deliberada e expurga os PDFs."""
    sub = db.query(Submissao).filter_by(id=sub_id, discente_id=user.id).first()
    if not sub:
        raise HTTPException(404, "Submissão não encontrada.")
    if sub.status not in ("fila_regular", "mesa_revisao"):
        raise HTTPException(409, "Submissão já foi deliberada e não pode ser cancelada.")

    for attr in ("boletim_path", "boa_path", "pdf_path"):
        path_str = getattr(sub, attr, None)
        if path_str:
            try:
                Path(path_str).unlink(missing_ok=True)
            except OSError:
                pass

    sub.status = "cancelada"
    sub.pdf_expurgado_em = datetime.now(timezone.utc)
    registrar(
        db,
        user,
        "submissao_cancelada",
        "submissao",
        sub.id,
        {
            "boletim_sha256": sub.boletim_sha256,
            "boa_sha256": sub.boa_sha256,
        },
    )
    db.commit()
    db.refresh(sub)
    return {"submissao": _serializar(sub)}


def _serializar_completo(sub: Submissao) -> dict:
    from ..models import Decisao  # import local para evitar ciclos

    metadata = json.loads(sub.metadata_json)
    decisao = (
        sub.decisoes[-1] if sub.decisoes else None
    )
    return {
        "id": sub.id,
        "status": sub.status,
        "tipoDocumento": sub.tipo_documento,
        "metadata": metadata,
        "documentos": {
            "boletim": {
                "nome": metadata.get("nomeArquivoBoletim") or "boletim.pdf",
                "sha256": sub.boletim_sha256,
            },
            "boa": {
                "nome": metadata.get("nomeArquivoBoa") or "boa.pdf",
                "sha256": sub.boa_sha256,
            },
        },
        "diagnostico": json.loads(sub.diagnostico_json) if sub.diagnostico_json else None,
        "criadoEm": sub.criado_em.isoformat() if sub.criado_em else None,
        "concluidoEm": sub.concluido_em.isoformat() if sub.concluido_em else None,
        "decisao": {
            "decisao": decisao.decisao,
            "motivo": decisao.motivo,
            "decididoEm": decisao.decidido_em.isoformat() if decisao.decidido_em else None,
        }
        if decisao
        else None,
    }
