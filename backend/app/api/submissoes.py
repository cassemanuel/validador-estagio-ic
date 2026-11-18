"""Rotas do discente: submissão do documento e acompanhamento."""

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session, selectinload

from ..auth.jwt import require_discente
from ..config import settings
from ..db import get_db, travar_escrita
from ..models import Decisao, Excecao, Submissao, Usuario
from ..schemas import SubmissaoPayload
from ..services import saneamento, triagem
from ..services.auditoria import registrar
from ..services.autorizacao import dados_autorizacao
from ..services import crypto, documento
from .deps import get_regras

router = APIRouter(prefix="/api/submissoes", tags=["submissoes"])

STATUS_ATIVOS = ("fila_regular", "mesa_revisao")
MAX_PAYLOAD_CHARS = 250_000

logger = logging.getLogger(__name__)


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
                "disponivel": bool(sub.boletim_path) and sub.pdf_expurgado_em is None,
            },
            "boa": {
                "sha256": sub.boa_sha256,
                "disponivel": bool(sub.boa_path) and sub.pdf_expurgado_em is None,
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


def _remover_arquivos(caminhos) -> None:
    """Remove arquivos do disco sem propagar erro (melhor esforço, logado)."""
    for caminho in caminhos:
        if not caminho:
            continue
        try:
            Path(caminho).unlink(missing_ok=True)
        except OSError:
            logger.exception("Falha ao remover arquivo %s", caminho)


def _salvar_pdf(dados: bytes, upload_dir: Path, tipo: str) -> tuple[Path, str]:
    """Cifra e grava o PDF com nome aleatório (uuid4): sem colisões entre
    submissões simultâneas e sem dados pessoais no nome do arquivo."""
    caminho = upload_dir / f"{tipo}_{uuid.uuid4().hex}.bin"
    caminho.write_bytes(crypto.cifrar(dados))
    return caminho, hashlib.sha256(dados).hexdigest()


def _autorizacao_bloqueante(db: Session, user: Usuario) -> dict | None:
    """Autorização vigente que ainda não está na janela de renovação."""
    aprovadas = (
        db.query(Submissao)
        .filter(Submissao.discente_id == user.id, Submissao.status == "aprovada")
        .all()
    )
    for sub in aprovadas:
        aut = dados_autorizacao(
            sub, settings.autorizacao_validade_dias, settings.renovacao_janela_dias
        )
        if aut and not aut["renovavel"]:
            return aut
    return None


@router.post("")
def criar_submissao(
    payload: str = Form(...),
    boletim: UploadFile | None = File(None),
    boa: UploadFile | None = File(None),
    db: Session = Depends(get_db),
    user: Usuario = Depends(require_discente),
):
    """Recebe Boletim + BOA + dados extraídos no cliente (multipart).

    Ambos os documentos são obrigatórios. O parsing roda no navegador; o
    servidor confere a identidade (nome/DRE) no texto dos PDFs, recalcula o
    diagnóstico, faz saneamento, triagem e persistência.
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

    vigente = _autorizacao_bloqueante(db, user)
    if vigente:
        raise HTTPException(
            409,
            "Você já possui autorização de estágio vigente "
            f"({vigente['diasParaVencer']} dias restantes). A renovação é liberada "
            f"a partir de {settings.renovacao_janela_dias} dias do vencimento.",
        )

    if len(payload) > MAX_PAYLOAD_CHARS:
        raise HTTPException(413, "Payload muito grande.")

    try:
        body = SubmissaoPayload.model_validate_json(payload)
    except ValueError:
        raise HTTPException(400, "Payload JSON inválido.")

    # Lidos uma única vez: os mesmos bytes são conferidos, hasheados e cifrados.
    dados_boletim = _validar_pdf(boletim, "boletim")
    dados_boa = _validar_pdf(boa, "BOA")

    divergencias = documento.conferir_identidade(
        {"Boletim": dados_boletim, "BOA": dados_boa},
        body.metadata.get("nome"),
        body.metadata.get("dre"),
    )
    if divergencias:
        raise HTTPException(
            422,
            "Os documentos não conferem com os dados informados: "
            + " ".join(divergencias),
        )

    dados = body.model_dump(exclude={"excecoes"})
    regras = get_regras()
    try:
        resultado = saneamento.analisar(dados, regras, user.username)
        # Somente o diagnóstico recalculado pelo servidor é persistido; o
        # declarado pelo cliente serve apenas para o alerta de divergência.
        diagnostico = resultado["diagnostico_recalculado"]
        status = triagem.rotear(
            diagnostico, body.excecoes, resultado["alertas"]
        )
    except Exception:
        # Fallback seguro: evita 500 e garante que a submissão vá para revisão
        # humana caso o processamento das regras falhe inesperadamente.
        logger.exception("Erro no saneamento/triagem da submissão")
        resultado = {
            "alertas": [
                "Falha no recálculo automático — conferência manual obrigatória."
            ]
        }
        diagnostico = {}
        status = "mesa_revisao"

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
    db.flush()  # garante sub.id para auditoria (e adquire o lock de escrita)

    # Re-checagem sob o lock de escrita: duas requisições simultâneas passam
    # pela verificação inicial, mas só a primeira a gravar sobrevive aqui.
    concorrente = (
        db.query(Submissao.id)
        .filter(
            Submissao.discente_id == user.id,
            Submissao.status.in_(STATUS_ATIVOS),
            Submissao.id != sub.id,
        )
        .first()
    )
    if concorrente:
        db.rollback()
        raise HTTPException(409, "Já existe uma submissão em andamento.")

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)

    gravados: list[Path] = []
    try:
        boletim_path, boletim_hash = _salvar_pdf(dados_boletim, upload_dir, "boletim")
        gravados.append(boletim_path)
        boa_path, boa_hash = _salvar_pdf(dados_boa, upload_dir, "boa")
        gravados.append(boa_path)

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
    except BaseException:
        # Sem commit, nada referencia os arquivos: remove-os para não deixar
        # PDFs órfãos (que o expurgo, guiado pelo banco, nunca alcançaria).
        db.rollback()
        _remover_arquivos(gravados)
        raise
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
    return {"submissao": _serializar_completo(sub)}


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
    travar_escrita(db)  # não cancela algo que a comissão acabou de decidir
    sub = db.query(Submissao).filter_by(id=sub_id, discente_id=user.id).first()
    if not sub:
        raise HTTPException(404, "Submissão não encontrada.")
    if sub.status not in ("fila_regular", "mesa_revisao"):
        raise HTTPException(409, "Submissão já foi deliberada e não pode ser cancelada.")

    caminhos = [sub.boletim_path, sub.boa_path, sub.pdf_path]
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
    # Commit antes de apagar: se a transação falhar, os PDFs continuam
    # disponíveis para a submissão que segue ativa.
    db.commit()
    _remover_arquivos(caminhos)
    db.refresh(sub)
    return {"submissao": _serializar(sub)}


def _serializar_completo(sub: Submissao) -> dict:
    from ..models import Decisao  # import local para evitar ciclos

    metadata = json.loads(sub.metadata_json)
    extraidos = json.loads(sub.dados_extraidos_json) if sub.dados_extraidos_json else {}
    decisao = sub.decisoes[-1] if sub.decisoes else None
    return {
        "id": sub.id,
        "status": sub.status,
        "tipoDocumento": sub.tipo_documento,
        "metadata": metadata,
        "autorizacao": dados_autorizacao(sub, settings.autorizacao_validade_dias),
        "periodos": extraidos.get("periodos") or [],
        "pendencias": extraidos.get("pendencias") or {},
        "resumoBoa": extraidos.get("resumo_boa") or {},
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
