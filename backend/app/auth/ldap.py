"""Autenticação via LDAP institucional (ldap3).

Ativada com AUTH_PROVIDER=ldap e as variáveis LDAP_* configuradas.
O papel 'comissao' deriva de membership no grupo LDAP_GROUP_COMISSAO
(quando configurado) ou da lista COMMISSION_USERS; caso contrário,
'discente'.
"""

import ldap3

from .provider import AuthProvider, UserInfo


class LdapAuthProvider(AuthProvider):
    def __init__(self, settings, db):
        if not settings.ldap_url or not settings.ldap_base_dn:
            raise RuntimeError(
                "AUTH_PROVIDER=ldap exige LDAP_URL e LDAP_BASE_DN configurados."
            )
        self.settings = settings
        self.db = db
        self.server = ldap3.Server(settings.ldap_url, get_info=ldap3.ALL)

    def authenticate(self, username: str, password: str) -> UserInfo | None:
        username = username.strip()
        if not username or not password:
            return None

        filtro = self.settings.ldap_user_filter.format(username=username)

        try:
            # Bind de serviço (opcional) para pesquisar o DN do usuário.
            conn = ldap3.Connection(
                self.server,
                user=self.settings.ldap_bind_dn or None,
                password=self.settings.ldap_bind_password or None,
                auto_bind=bool(self.settings.ldap_bind_dn),
            )
            if not conn.search(
                self.settings.ldap_base_dn, filtro, attributes=["displayName", "cn"]
            ):
                return None
            entry = conn.entries[0]
            user_dn = entry.entry_dn
            nome = str(entry.displayName) if "displayName" in entry else str(entry.cn)

            # Bind com as credenciais do usuário para validar a senha.
            user_conn = ldap3.Connection(self.server, user=user_dn, password=password)
            if not user_conn.bind():
                return None
            user_conn.unbind()

            papel = "discente"
            if self._is_comissao(conn, user_dn, username):
                papel = "comissao"
            conn.unbind()

            return UserInfo(username=username, nome=nome, papel=papel)
        except ldap3.core.exceptions.LDAPException:
            return None

    def _is_comissao(self, conn, user_dn: str, username: str) -> bool:
        if self.settings.ldap_group_comissao:
            filtro = f"(member={user_dn})"
            if conn.search(
                self.settings.ldap_group_comissao, filtro, attributes=["cn"]
            ):
                return True
        comissao = {
            u.strip() for u in (self.settings.commission_users or "").split(",") if u.strip()
        }
        return username in comissao
