"""Conferência server-side leve dos PDFs submetidos (Boletim e BOA).

O parsing completo roda no navegador; aqui o servidor apenas extrai o texto
bruto das primeiras páginas e confirma que a identidade declarada no JSON
(DRE e nome) realmente consta em cada documento. Isso impede submeter o
PDF de um discente com dados de outro (ou dados inventados).

A comparação é tolerante a diferenças de extração entre pdf.js e pypdf:
acentos, caixa, espaços e pontuação são ignorados.
"""

import io
import logging
import re
import unicodedata

from pypdf import PdfReader
from pypdf.errors import PyPdfError

# Identidade (nome/DRE) fica no cabeçalho — poucas páginas bastam e limitam
# o custo de CPU de PDFs grandes ou maliciosos.
MAX_PAGINAS = 3

# pypdf emite warnings ruidosos para PDFs levemente malformados.
logging.getLogger("pypdf").setLevel(logging.ERROR)


class DocumentoIlegivel(Exception):
    """O PDF não pôde ser lido/extraído."""


def normalizar(texto: str | None) -> str:
    """Maiúsculas ASCII sem acentos, apenas [A-Z0-9]."""
    sem_acento = unicodedata.normalize("NFKD", str(texto or ""))
    sem_acento = "".join(c for c in sem_acento if not unicodedata.combining(c))
    return re.sub(r"[^A-Z0-9]", "", sem_acento.upper())


def extrair_texto(dados: bytes, max_paginas: int = MAX_PAGINAS) -> str:
    """Texto bruto das primeiras páginas do PDF."""
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


def conferir_identidade(
    documentos: dict[str, bytes], nome: str | None, dre: str | None
) -> list[str]:
    """Retorna a lista de divergências (vazia = identidade confirmada).

    `documentos` mapeia o rótulo exibido ao usuário (ex.: "Boletim") aos
    bytes do PDF.
    """
    dre_norm = re.sub(r"\D", "", str(dre or ""))
    nome_norm = normalizar(nome)
    if not dre_norm or not nome_norm:
        return ["Nome e DRE precisam ser identificados nos documentos."]

    erros: list[str] = []
    for rotulo, dados in documentos.items():
        try:
            texto = normalizar(extrair_texto(dados))
        except DocumentoIlegivel:
            erros.append(f"Não foi possível ler o texto do {rotulo}.")
            continue
        if not texto:
            erros.append(
                f"O {rotulo} não contém texto extraível (PDF digitalizado?)."
            )
            continue
        if dre_norm not in texto:
            erros.append(f"O DRE informado não consta no {rotulo}.")
        if nome_norm not in texto:
            erros.append(f"O nome informado não consta no {rotulo}.")
    return erros
