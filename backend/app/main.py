"""Aplicação FastAPI — validador-estagio-ic."""

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response

from .api import auth_routes, autorizacoes, comissao, submissoes
from .config import AMBIENTES_DEV, settings
from .db import SessionLocal, init_db
from .services.expurgo import purge_loop

_FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

# Headers defensivos aplicados a todas as respostas (camada extra além do
# proxy reverso; o proxy pode acrescentar CSP e HSTS). SAMEORIGIN mantém o
# iframe de PDFs da Mesa, que é servido pela própria aplicação.
HEADERS_SEGURANCA = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "same-origin",
}

# Caminhos da documentação interativa: fora de dev não existem, e o fallback
# da SPA também não pode devolvê-los como index.html.
_ROTAS_DOCUMENTACAO = ("docs", "redoc", "openapi.json")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Fail-fast: segredos padrão/fracos abortam a subida fora de dev.
    settings.validar_seguranca()
    init_db()
    purge_task = asyncio.create_task(purge_loop(settings, SessionLocal))
    yield
    purge_task.cancel()
    try:
        await purge_task
    except asyncio.CancelledError:
        pass


def create_app() -> FastAPI:
    """Monta a aplicação; a documentação interativa só existe em dev."""
    em_dev = settings.env.strip().lower() in AMBIENTES_DEV
    app = FastAPI(
        title=settings.app_name,
        lifespan=lifespan,
        docs_url="/docs" if em_dev else None,
        redoc_url="/redoc" if em_dev else None,
        openapi_url="/openapi.json" if em_dev else None,
    )

    @app.middleware("http")
    async def headers_seguranca(request: Request, call_next):
        response = await call_next(request)
        for nome, valor in HEADERS_SEGURANCA.items():
            response.headers.setdefault(nome, valor)
        return response

    app.include_router(auth_routes.router)
    app.include_router(submissoes.router)
    app.include_router(comissao.router)
    app.include_router(autorizacoes.router)

    @app.get("/api/health")
    def health():
        return {"ok": True}

    # Fallback para SPA: serve index.html para rotas do frontend, preservando
    # arquivos estáticos (css, js, vendor, fonts) quando existem.
    if _FRONTEND_DIR.exists():
        index_path = _FRONTEND_DIR / "index.html"
        frontend_root = _FRONTEND_DIR.resolve()

        @app.get("/{path:path}")
        async def spa_fallback(request: Request, path: str):
            # Rotas de API inexistentes e a documentação desativada respondem
            # 404 de verdade (não o index.html da SPA).
            if path.startswith("api/") or path.strip("/") in _ROTAS_DOCUMENTACAO:
                return Response(status_code=404)
            # Confinamento: resolve o caminho canônico (expande "..", "%2e%2e",
            # symlinks) e só serve arquivos dentro do diretório do frontend.
            candidate = (_FRONTEND_DIR / path).resolve()
            if not candidate.is_relative_to(frontend_root):
                return Response(status_code=404)
            if candidate.is_file():
                return FileResponse(candidate)
            if path.startswith(("css/", "js/", "vendor/", "fonts/")):
                return Response(status_code=404)
            return FileResponse(index_path)

    return app


app = create_app()
