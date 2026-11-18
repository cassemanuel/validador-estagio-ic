"""Configurações da aplicação via variáveis de ambiente (.env)."""

import base64
from pathlib import Path
from typing import Literal

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

# Valor padrão de desenvolvimento — proibido fora de ENV=dev (ver
# Settings.validar_seguranca).
JWT_SECRET_PADRAO = "dev-secret-troque-em-producao"
JWT_SECRET_MIN_CHARS = 32
AMBIENTES_DEV = ("dev", "development", "local", "test")
_DEFAULT_RULES = _REPO_ROOT / "frontend" / "rules" / "ciclo_basico.json"


class Settings(BaseSettings):
    app_name: str = "Validador de Estágio — IC/UFRJ"

    # Ambiente: 'dev' (padrão) ou qualquer outro valor (ex.: 'production').
    # Fora de dev — ou com AUTH_PROVIDER=ldap — a inicialização exige segredos
    # fortes e explícitos. Seeds dependem só de AUTH_PROVIDER=local.
    env: str = "dev"

    # Persistência
    database_url: str = "sqlite:///./data/app.db"
    upload_dir: str = "./data/uploads"

    # Sessão JWT (cookie httpOnly)
    jwt_secret: str = JWT_SECRET_PADRAO
    jwt_expire_minutes: int = 480

    # Criptografia at-rest dos PDFs (Fernet). Obrigatória fora de dev; em dev,
    # se ausente, deriva de jwt_secret.
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
    audit_retention_days: int = 365  # 1 ano antes do arquivamento
    archive_dir: str = "./data/archive"
    purge_interval_seconds: int = 3600
    max_pdf_size: int = 15 * 1024 * 1024  # 15 MB por arquivo PDF

    # Conferência automática do texto dos PDFs (pypdf): 'bloquear' recusa a
    # submissão (HTTP 422) quando nome/DRE não conferem ou o PDF é ilegível;
    # 'alertar' é o modo de contingência (ex.: layout novo do SIGA) — aceita,
    # registra alerta e encaminha para a Mesa de Revisão.
    identidade_pdf_modo: Literal["bloquear", "alertar"] = "bloquear"

    # Autorização de estágio: validade após a liberação (dias)
    autorizacao_validade_dias: int = 90

    # Renovação: nova submissão só é aceita quando faltam N dias ou menos
    # para o vencimento da autorização vigente.
    renovacao_janela_dias: int = 30

    # Métricas: autorizações consideradas "próximas do vencimento"
    vencimento_alerta_dias: int = 30

    # Regras do PPC 2022 (fonte única compartilhada com o frontend)
    rules_file: str = str(_DEFAULT_RULES)

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def modo_producao(self) -> bool:
        """Produção = ENV fora de dev ou autenticação institucional (LDAP)."""
        return (
            self.env.strip().lower() not in AMBIENTES_DEV
            or self.auth_provider == "ldap"
        )

    @property
    def seeds_habilitados(self) -> bool:
        """Usuários seed e atalhos de login existem sempre que a auth é local
        (dev, testes e `docker compose up`); nunca com LDAP."""
        return self.auth_provider == "local"

    @property
    def fernet_key(self) -> bytes:
        if self.storage_encryption_key:
            return self.storage_encryption_key.encode("utf-8")
        return _derive_key(self.jwt_secret)

    def validar_seguranca(self) -> None:
        """Aborta a inicialização com configuração insegura em produção."""
        if not self.modo_producao:
            return
        erros = []
        if self.jwt_secret == JWT_SECRET_PADRAO:
            erros.append("JWT_SECRET está com o valor padrão de desenvolvimento.")
        elif len(self.jwt_secret) < JWT_SECRET_MIN_CHARS:
            erros.append(
                f"JWT_SECRET deve ter pelo menos {JWT_SECRET_MIN_CHARS} caracteres."
            )
        if not self.storage_encryption_key:
            erros.append(
                "STORAGE_ENCRYPTION_KEY é obrigatória fora de dev "
                "(gere com Fernet.generate_key())."
            )
        else:
            from cryptography.fernet import Fernet

            try:
                Fernet(self.storage_encryption_key.encode("utf-8"))
            except (ValueError, TypeError):
                erros.append("STORAGE_ENCRYPTION_KEY não é uma chave Fernet válida.")
        if erros:
            raise RuntimeError(
                "Configuração insegura para produção "
                f"(ENV={self.env}, AUTH_PROVIDER={self.auth_provider}): "
                + " ".join(erros)
            )


settings = Settings()
