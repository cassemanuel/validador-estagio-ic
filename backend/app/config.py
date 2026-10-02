"""Configurações da aplicação via variáveis de ambiente (.env)."""

import base64
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from pydantic_settings import BaseSettings, SettingsConfigDict


def _derive_key(secret: str, salt: bytes = b"validador-estagio-ic-v1") -> bytes:
    """Deriva chave AES-256 (32 bytes) a partir de um segredo arbitrário."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100_000,
    )
    return base64.urlsafe_b64encode(kdf.derive(secret.encode("utf-8")))

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_RULES = _REPO_ROOT / "frontend" / "rules" / "ciclo_basico.json"


class Settings(BaseSettings):
    app_name: str = "Validador de Estágio — IC/UFRJ"

    # Persistência
    database_url: str = "sqlite:///./data/app.db"
    upload_dir: str = "./data/uploads"

    # Sessão JWT (cookie httpOnly)
    jwt_secret: str = "dev-secret-troque-em-producao"
    jwt_expire_minutes: int = 480

    # Criptografia at-rest dos PDFs (Fernet). Se não fornecida, deriva de jwt_secret.
    storage_encryption_key: str | None = None
    cookie_secure: bool = False  # True em produção (HTTPS)

    # Provedor de autenticação: 'local' (seeds) ou 'ldap'
    auth_provider: str = "local"

    # LDAP institucional (usado apenas quando auth_provider='ldap')
    ldap_url: str = ""
    ldap_base_dn: str = ""
    ldap_bind_dn: str = ""
    ldap_bind_password: str = ""
    ldap_user_filter: str = "(uid={username})"
    ldap_group_comissao: str = ""

    # Provisionamento de papéis/usuários
    # SEED_USERS: "user:senha:papel:nome;user2:senha2:discente:Nome Dois"
    seed_users: str = (
        "aluno1:aluno123:discente:Aluno Exemplo;"
        "aluno2:aluno123:discente:Discente Dois;"
        "aluno3:aluno123:discente:Discente Três;"
        "comissao1:comissao123:comissao:Membro da Comissão"
    )
    # COMMISSION_USERS: usernames (csv) promovidos a 'comissao' em logins LDAP
    commission_users: str = ""

    # LGPD / expurgo
    pdf_retention_days: int = 30
    audit_retention_days: int = 183  # ~6 meses antes do arquivamento
    archive_dir: str = "./data/archive"
    purge_interval_seconds: int = 3600
    max_pdf_size: int = 15 * 1024 * 1024  # 15 MB por arquivo PDF

    # Autorização de estágio: validade após a liberação (dias)
    autorizacao_validade_dias: int = 90

    # Métricas: autorizações consideradas "próximas do vencimento"
    vencimento_alerta_dias: int = 30

    # Regras do PPC 2022 (fonte única compartilhada com o frontend)
    rules_file: str = str(_DEFAULT_RULES)

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def fernet_key(self) -> bytes:
        if self.storage_encryption_key:
            return self.storage_encryption_key.encode("utf-8")
        return _derive_key(self.jwt_secret)


settings = Settings()
