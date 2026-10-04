"""DTOs de request/response (Pydantic)."""

from typing import Any, Literal

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    senha: str = Field(min_length=1, max_length=128)


class ExcecaoIn(BaseModel):
    codigo_requisito: str = Field(min_length=1, max_length=16)
    tipo: Literal["equivalencia", "dispensa", "aproveitamento", "acordo"]
    codigo_cursada: str | None = Field(default=None, max_length=16)
    justificativa: str = Field(min_length=1, max_length=2000)


class SubmissaoPayload(BaseModel):
    """JSON enviado junto ao PDF no multipart (campo 'payload')."""

    metadata: dict[str, Any] = Field(default_factory=dict)
    periodos: list[dict[str, Any]] = Field(default_factory=list)
    pendencias: dict[str, Any] = Field(default_factory=dict)
    diagnostico: dict[str, Any] = Field(default_factory=dict)
    excecoes: list[ExcecaoIn] = Field(default_factory=list)
    resumo_boa: dict[str, Any] = Field(default_factory=dict)


class DecisaoExcecaoIn(BaseModel):
    id: int
    status: Literal["aceita", "recusada"]


class DecisaoIn(BaseModel):
    decisao: Literal["aprovada", "indeferida", "devolvida"]
    motivo: str | None = Field(default=None, max_length=4000)
    excecoes: list[DecisaoExcecaoIn] = Field(default_factory=list)


class RevogarIn(BaseModel):
    motivo: str = Field(min_length=1, max_length=4000)
