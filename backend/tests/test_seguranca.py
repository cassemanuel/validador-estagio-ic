"""Testes de segurança: confinamento do spa_fallback contra path traversal."""


def test_spa_fallback_nao_vaza_env(client):
    """Caminhos percent-encoded com ..%2f não devem sair do diretório frontend."""
    resp = client.get("/..%2f.env")
    assert resp.status_code in (200, 404)
    assert b"JWT_SECRET" not in resp.content
    assert resp.content.lstrip().startswith(b"<!DOCTYPE") or resp.status_code == 404


def test_spa_fallback_nao_vaza_banco(client):
    """O banco SQLite não pode ser lido via traversal."""
    resp = client.get("/..%2fbackend%2fdata%2fapp.db")
    assert resp.status_code in (200, 404)
    assert not resp.content.startswith(b"SQLite format")


def test_spa_fallback_nao_vaza_codigo_fonte(client):
    resp = client.get("/%2e%2e/%2e%2e/backend/Dockerfile")
    assert b"FROM python" not in resp.content


def test_spa_fallback_ainda_serve_frontend(client):
    """Arquivos legítimos do frontend continuam acessíveis."""
    assert client.get("/js/app.js").status_code == 200
    resp = client.get("/rota-spa-qualquer")
    assert resp.status_code == 200
    assert b"<html" in resp.content
