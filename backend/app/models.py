"""Modelos do banco (SQLite/WAL). O audit_log é append-only por contrato."""

from datetime import datetime, timezone

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Integer,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Usuario(Base):
    __tablename__ = "usuarios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    nome: Mapped[str | None] = mapped_column(Text)
    papel: Mapped[str] = mapped_column(Text, nullable=False, default="discente")
    origem: Mapped[str] = mapped_column(Text, nullable=False, default="local")
    senha_hash: Mapped[str | None] = mapped_column(Text)
    ativo: Mapped[int] = mapped_column(Integer, default=1)
    criado_em: Mapped[datetime] = mapped_column(default=utcnow)

    __table_args__ = (
        CheckConstraint("papel IN ('discente','comissao')", name="ck_usuario_papel"),
        CheckConstraint("origem IN ('local','ldap')", name="ck_usuario_origem"),
    )


STATUS_SUBMISSAO = (
    "fila_regular",
    "mesa_revisao",
    "aprovada",
    "indeferida",
    "devolvida",
)


class Submissao(Base):
    __tablename__ = "submissoes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    discente_id: Mapped[int] = mapped_column(
        ForeignKey("usuarios.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    tipo_documento: Mapped[str | None] = mapped_column(Text)
    metadata_json: Mapped[str] = mapped_column(Text, nullable=False)
    dados_extraidos_json: Mapped[str] = mapped_column(Text, nullable=False)
    diagnostico_json: Mapped[str | None] = mapped_column(Text)
    alertas_saneamento_json: Mapped[str | None] = mapped_column(Text)
    pdf_path: Mapped[str | None] = mapped_column(Text)
    pdf_sha256: Mapped[str | None] = mapped_column(Text)
    boletim_path: Mapped[str | None] = mapped_column(Text)
    boletim_sha256: Mapped[str | None] = mapped_column(Text)
    boa_path: Mapped[str | None] = mapped_column(Text)
    boa_sha256: Mapped[str | None] = mapped_column(Text)
    pdf_expurgado_em: Mapped[datetime | None] = mapped_column()
    criado_em: Mapped[datetime] = mapped_column(default=utcnow)
    atualizado_em: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    concluido_em: Mapped[datetime | None] = mapped_column()

    discente: Mapped[Usuario] = relationship()
    excecoes: Mapped[list["Excecao"]] = relationship(
        back_populates="submissao", cascade="all, delete-orphan"
    )
    decisoes: Mapped[list["Decisao"]] = relationship(
        back_populates="submissao", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('fila_regular','mesa_revisao','aprovada','indeferida','devolvida','cancelada')",
            name="ck_submissao_status",
        ),
    )


class Excecao(Base):
    __tablename__ = "excecoes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    submissao_id: Mapped[int] = mapped_column(
        ForeignKey("submissoes.id"), nullable=False
    )
    codigo_requisito: Mapped[str] = mapped_column(Text, nullable=False)
    tipo: Mapped[str] = mapped_column(Text, nullable=False)
    codigo_cursada: Mapped[str | None] = mapped_column(Text)
    justificativa: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pendente")
    decidida_por: Mapped[int | None] = mapped_column(ForeignKey("usuarios.id"))
    decidida_em: Mapped[datetime | None] = mapped_column()

    submissao: Mapped[Submissao] = relationship(back_populates="excecoes")

    __table_args__ = (
        CheckConstraint(
            "tipo IN ('equivalencia','dispensa','aproveitamento')",
            name="ck_excecao_tipo",
        ),
        CheckConstraint(
            "status IN ('pendente','aceita','recusada')",
            name="ck_excecao_status",
        ),
    )


class Decisao(Base):
    __tablename__ = "decisoes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    submissao_id: Mapped[int] = mapped_column(
        ForeignKey("submissoes.id"), nullable=False
    )
    decisao: Mapped[str] = mapped_column(Text, nullable=False)
    motivo: Mapped[str | None] = mapped_column(Text)
    decidido_por: Mapped[int] = mapped_column(ForeignKey("usuarios.id"), nullable=False)
    decidido_em: Mapped[datetime] = mapped_column(default=utcnow)

    submissao: Mapped[Submissao] = relationship(back_populates="decisoes")

    __table_args__ = (
        CheckConstraint(
            "decisao IN ('aprovada','indeferida','devolvida')",
            name="ck_decisao",
        ),
    )


class AuditLog(Base):
    """Registro transacional imutável (append-only + hash chain sha256)."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(default=utcnow)
    ator_id: Mapped[int | None] = mapped_column(Integer)
    ator_papel: Mapped[str | None] = mapped_column(Text)
    acao: Mapped[str] = mapped_column(Text, nullable=False)
    entidade: Mapped[str | None] = mapped_column(Text)
    entidade_id: Mapped[int | None] = mapped_column(Integer)
    payload_json: Mapped[str | None] = mapped_column(Text)
    hash_anterior: Mapped[str | None] = mapped_column(Text)
    hash_registro: Mapped[str | None] = mapped_column(Text)
