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
    _migrar_schemas()

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


def _recriar_tabela(cur, tabela, precisa_migrar) -> None:
    """Recria `tabela` com o DDL atual do modelo quando `precisa_migrar`
    (avaliado sobre o DDL e as colunas existentes) retorna True.

    O SQLite não permite ALTER em CHECK constraints nem em colunas, então
    a tabela é reconstruída (CREATE → INSERT das colunas em comum →
    DROP → RENAME) dentro de uma transação com foreign_keys desligado.
    """
    ddl_atual = cur.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
        (tabela.name,),
    ).fetchone()
    if not ddl_atual:
        return
    ddl = ddl_atual[0] or ""
    colunas_atuais = {
        r[1] for r in cur.execute(f"PRAGMA table_info({tabela.name})")
    }
    if not precisa_migrar(ddl, colunas_atuais):
        return

    from sqlalchemy.schema import CreateTable

    ddl_novo = str(CreateTable(tabela).compile(engine)).replace(
        f"CREATE TABLE {tabela.name}",
        f"CREATE TABLE {tabela.name}_nova",
    )
    comum = ", ".join(
        c.name for c in tabela.columns if c.name in colunas_atuais
    )
    cur.execute(ddl_novo)
    cur.execute(
        f"INSERT INTO {tabela.name}_nova ({comum}) "
        f"SELECT {comum} FROM {tabela.name}"
    )
    cur.execute(f"DROP TABLE {tabela.name}")
    cur.execute(f"ALTER TABLE {tabela.name}_nova RENAME TO {tabela.name}")


def _migrar_schemas() -> None:
    """Reconstrói tabelas cujo schema gravado é anterior ao modelo atual.

    - `submissoes`: CHECK de status sem 'arquivada' ou sem a coluna
      `status_anterior` (usada pelo desarquivamento).
    - `decisoes`: CHECK `ck_decisao` sem 'revogada' — sem a migração, a
      revogação falha com IntegrityError (HTTP 500).
    """
    from .models import Decisao, Submissao

    raw = engine.raw_connection()
    try:
        cur = raw.cursor()
        cur.execute("PRAGMA foreign_keys=OFF")
        _recriar_tabela(
            cur,
            Submissao.__table__,
            lambda ddl, cols: "'arquivada'" not in ddl
            or "status_anterior" not in cols,
        )
        _recriar_tabela(
            cur,
            Decisao.__table__,
            lambda ddl, cols: "'revogada'" not in ddl,
        )
        cur.execute("PRAGMA foreign_keys=ON")
        raw.commit()
    finally:
        raw.close()


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
