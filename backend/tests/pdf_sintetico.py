"""Gerador de PDFs sintéticos (texto simples) para testes e smoke e2e.

Sem dependências da aplicação: pode ser importado por scripts externos.
"""


def pdf_com_texto(*linhas: str) -> bytes:
    """Gera um PDF mínimo e válido com as linhas de texto informadas.

    Usado para exercitar a conferência server-side (nome/DRE extraídos do
    PDF com pypdf). Fonte Helvetica com WinAnsiEncoding (aceita acentos).
    """

    def escapar(texto: str) -> bytes:
        bruto = texto.encode("cp1252")
        return (
            bruto.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
        )

    conteudo = b"BT /F1 12 Tf 50 780 Td 16 TL "
    for linha in linhas:
        conteudo += b"(" + escapar(linha) + b") Tj T* "
    conteudo += b"ET"

    objetos = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
        b"/Encoding /WinAnsiEncoding >>",
        b"<< /Length %d >>\nstream\n" % len(conteudo) + conteudo + b"\nendstream",
    ]
    saida = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objetos, start=1):
        offsets.append(len(saida))
        saida += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(saida)
    saida += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objetos) + 1)
    for off in offsets:
        saida += b"%010d 00000 n \n" % off
    saida += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % (len(objetos) + 1)
    saida += b"startxref\n%d\n%%%%EOF\n" % xref
    return saida
