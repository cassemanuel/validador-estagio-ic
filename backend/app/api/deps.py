"""Dependências compartilhadas das rotas."""

from functools import lru_cache

from ..config import settings
from ..rules.ppc2022 import carregar_regras


@lru_cache(maxsize=1)
def get_regras() -> dict:
    return carregar_regras(settings.rules_file)


def get_settings():
    return settings
