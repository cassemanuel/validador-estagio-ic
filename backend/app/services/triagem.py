"""Roteamento de submissões entre Fila Regular e Mesa de Revisão."""

VAI_PARA_MESA = "mesa_revisao"
VAI_PARA_FILA = "fila_regular"


def rotear(diagnostico: dict, excecoes: list, alertas: list[str]) -> str:
    """Caso regular: apto, sem exceções declaradas e sem alertas de saneamento.

    Qualquer exceção, alerta ou diagnóstico de pendência envia o caso
    para a Mesa de Revisão (conferência humana detalhada).
    """
    if not (diagnostico or {}).get("apto"):
        return VAI_PARA_MESA
    if excecoes or alertas:
        return VAI_PARA_MESA
    return VAI_PARA_FILA
