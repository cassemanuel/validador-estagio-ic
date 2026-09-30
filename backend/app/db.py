"""Conexão SQLite (modo WAL), sessões e inicialização do banco."""

from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from .config import settings

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from . import models  # noqa: F401 — registra os metadados
    from .auth.local import hash_password
    from .models import Usuario

    # Garante o diretório do arquivo SQLite antes do primeiro connect.
    if settings.database_url.startswith("sqlite:///"):
        db_path = Path(settings.database_url.removeprefix("sqlite:///"))
        db_path.parent.mkdir(parents=True, exist_ok=True)

    models.Base.metadata.create_all(engine)

    # Provisiona usuários seed (SEED_USERS) e membros da comissão.
    with Session(engine) as db:
        for entry in _parse_seed_users(settings.seed_users):
            username, senha, papel, nome = entry
            existe = db.query(Usuario).filter_by(username=username).first()
            if existe:
                continue
            db.add(
                Usuario(
                    username=username,
                    nome=nome,
                    papel=papel,
                    origem="local",
                    senha_hash=hash_password(senha),
                )
            )

        for username in _parse_commission_users(settings.commission_users):
            user = db.query(Usuario).filter_by(username=username).first()
            if user and user.papel != "comissao":
                user.papel = "comissao"

        db.commit()


def _parse_seed_users(raw: str):
    for chunk in (raw or "").split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        partes = chunk.split(":")
        username = partes[0].strip()
        senha = partes[1] if len(partes) > 1 else "trocar123"
        papel = partes[2] if len(partes) > 2 else "discente"
        nome = partes[3] if len(partes) > 3 else username
        if papel not in ("discente", "comissao"):
            papel = "discente"
        yield username, senha, papel, nome


def _parse_commission_users(raw: str):
    return [u.strip() for u in (raw or "").split(",") if u.strip()]
