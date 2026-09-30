"""Interface abstrata de provedor de autenticação.

Implementações: LocalAuthProvider (usuários seed em dev) e
LdapAuthProvider (LDAP institucional, ativado via AUTH_PROVIDER=ldap).
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class UserInfo:
    username: str
    nome: str | None = None
    papel: str | None = None  # hint; papel definitivo fica na tabela usuarios


class AuthProvider(ABC):
    @abstractmethod
    def authenticate(self, username: str, password: str) -> UserInfo | None:
        """Retorna UserInfo se as credenciais forem válidas, senão None."""


def get_auth_provider(settings, db) -> AuthProvider:
    if settings.auth_provider == "ldap":
        from .ldap import LdapAuthProvider

        return LdapAuthProvider(settings, db)
    from .local import LocalAuthProvider

    return LocalAuthProvider(db)
