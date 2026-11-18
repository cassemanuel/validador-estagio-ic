"""Conferência server-side leve dos PDFs submetidos (Boletim e BOA).

O parsing completo roda no navegador; aqui o servidor extrai o texto bruto
dos PDFs (pypdf) e confirma que:

1. a identidade declarada no JSON (nome e DRE) consta em cada documento;
2. as disciplinas declaradas como concluídas existem no documento de origem
   — períodos letivos (AAAA/S) no Boletim; o agrupamento "Aprovadas (BOA)"
   no BOA.

A comparação é tolerante a diferenças de extração entre pdf.js e pypdf:
acentos, caixa, espaços e pontuação são ignorados.

Limitação conhecida: confere a *presença* dos códigos, não as notas. A
conferência humana do PDF original continua obrigatória para aprovar.
"""

import io
import logging
import re
import unicodedata
from dataclasses import dataclass, field

from pypdf import PdfReader
from pypdf.errors import PyPdfError

from ..rules.ppc2022 import PERIODO_LETIVO_REGEX, disciplina_concluida

# Teto de páginas lidas por documento: históricos longos passam de 3
# páginas, mas um PDF com centenas de páginas não é um Boletim/BOA legítimo
# (o parser do navegador também limita o BOA a 25 páginas).
MAX_PAGINAS = 60

# pypdf emite warnings ruidosos para PDFs levemente malformados.
logging.getLogger("pypdf").setLevel(logging.ERROR)


class DocumentoIlegivel(Exception):
    """O PDF não pôde ser lido/extraído."""


@dataclass
class ResultadoConferencia:
    """Resultado da conferência automática dos dois PDFs."""

    # Falhas de leitura ou de identidade (nome/DRE) — bloqueiam ou alertam
    # conforme IDENTIDADE_PDF_MODO.
    divergencias: list[str] = field(default_factory=list)
    # Códigos declarados como concluídos que não constam no documento.
    codigos_ausentes: list[str] = field(default_factory=list)


def normalizar(texto: str | None) -> str:
    """Maiúsculas ASCII sem acentos, apenas [A-Z0-9]."""
    sem_acento = unicodedata.normalize("NFKD", str(texto or ""))
    sem_acento = "".join(c for c in sem_acento if not unicodedata.combining(c))
    return re.sub(r"[^A-Z0-9]", "", sem_acento.upper())


def extrair_texto(dados: bytes, max_paginas: int = MAX_PAGINAS) -> str:
    """Texto bruto das páginas do PDF (até `max_paginas`)."""
    try:
        reader = PdfReader(io.BytesIO(dados))
        if reader.is_encrypted:
            # PDFs do SIGA podem vir "protegidos" com senha vazia.
            if not reader.decrypt(""):
                raise DocumentoIlegivel("PDF protegido por senha.")
        partes = []
        for pagina in reader.pages[:max_paginas]:
            partes.append(pagina.extract_text() or "")
        return " ".join(partes)
    except DocumentoIlegivel:
        raise
    except (PyPdfError, ValueError, TypeError, KeyError, OSError) as exc:
        raise DocumentoIlegivel(str(exc)) from exc


def _texto_normalizado(rotulo: str, dados: bytes, divergencias: list[str]) -> str | None:
    """Extrai e normaliza; registra a falha em `divergencias` e devolve None."""
    try:
        texto = normalizar(extrair_texto(dados))
    except DocumentoIlegivel:
        divergencias.append(f"Não foi possível ler o texto do {rotulo}.")
        return None
    if not texto:
        divergencias.append(f"O {rotulo} não contém texto extraível (PDF digitalizado?).")
        return None
    return texto


def _codigos_concluidos(periodos: list[dict], letivos: bool) -> list[str]:
    """Códigos concluídos (AP/T) dos períodos letivos ou dos sintéticos."""
    codigos: list[str] = []
    for periodo in periodos or []:
        rotulo = str(periodo.get("periodo") or "").strip()
        if bool(PERIODO_LETIVO_REGEX.match(rotulo)) != letivos:
            continue
        for d in periodo.get("disciplinas") or []:
            codigo = normalizar(d.get("codigo"))
            if codigo and disciplina_concluida(d) and codigo not in codigos:
                codigos.append(codigo)
    return codigos


def conferir_documentos(
    boletim: bytes,
    boa: bytes,
    nome: str | None,
    dre: str | None,
    periodos: list[dict],
) -> ResultadoConferencia:
    """Confere identidade (nome/DRE) e disciplinas concluídas declaradas."""
    resultado = ResultadoConferencia()
    dre_norm = re.sub(r"\D", "", str(dre or ""))
    nome_norm = normalizar(nome)
    if not dre_norm or not nome_norm:
        resultado.divergencias.append(
            "Nome e DRE precisam ser identificados nos documentos."
        )

    textos = {
        "Boletim": _texto_normalizado("Boletim", boletim, resultado.divergencias),
        "BOA": _texto_normalizado("BOA", boa, resultado.divergencias),
    }

    if dre_norm and nome_norm:
        for rotulo, texto in textos.items():
            if texto is None:
                continue
            if dre_norm not in texto:
                resultado.divergencias.append(f"O DRE informado não consta no {rotulo}.")
            if nome_norm not in texto:
                resultado.divergencias.append(f"O nome informado não consta no {rotulo}.")

    # Disciplinas concluídas: períodos letivos vêm do Boletim; o agrupamento
    # "Aprovadas (BOA)" (mesclado no navegador) vem do BOA.
    for rotulo, letivos in (("Boletim", True), ("BOA", False)):
        texto = textos[rotulo]
        if texto is None:
            continue  # ilegível: já registrado em `divergencias`
        resultado.codigos_ausentes.extend(
            c for c in _codigos_concluidos(periodos, letivos) if c not in texto
        )
    return resultado
