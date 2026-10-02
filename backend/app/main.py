"""Aplicação FastAPI — validador-estagio-ic."""

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response

from .api import auth_routes, comissao, submissoes
from .config import settings
from .db import SessionLocal, init_db
from .services.expurgo import purge_loop

_FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    purge_task = asyncio.create_task(purge_loop(settings, SessionLocal))
    yield
    purge_task.cancel()
    try:
        await purge_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.include_router(auth_routes.router)
app.include_router(submissoes.router)
app.include_router(comissao.router)


@app.get("/api/health")
def health():
    return {"ok": True}


# Fallback para SPA: serve index.html para rotas do frontend, preservando
# arquivos estáticos (css, js, vendor, fonts) quando existem.
if _FRONTEND_DIR.exists():
    INDEX_PATH = _FRONTEND_DIR / "index.html"

    @app.get("/{path:path}")
    async def spa_fallback(request: Request, path: str):
        candidate = _FRONTEND_DIR / path
        if candidate.is_file():
            return FileResponse(candidate)
        if path.startswith(("css/", "js/", "vendor/", "fonts/")):
            return Response(status_code=404)
        return FileResponse(INDEX_PATH)
