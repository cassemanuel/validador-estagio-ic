"""Ciclo 1 de hardening: ambiente, auth/LDAP, integridade documental,
privacidade do portal público, expurgo, concorrência e arquivos."""

import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from app.auth.provider import UserInfo
from app.config import JWT_SECRET_PADRAO, Settings, settings
from app.db import SessionLocal
from app.models import AuditLog, Submissao, Usuario

from .conftest import (
    DRE_ALUNO1,
    login,
    payload_apto,
    pdf_com_texto,
    pdfs_do_payload,
    submeter,
)

SEGREDO_FORTE = "x" * 40
CHAVE_FERNET = Fernet.generate_key().decode()


# ---------------------------------------------------------------- ambiente


def _settings(**kw):
    base = {"env": "production", "jwt_secret": SEGREDO_FORTE,
            "storage_encryption_key": CHAVE_FERNET}
    base.update(kw)
    return Settings(_env_file=None, **base)


def test_producao_aceita_configuracao_forte():
    _settings().validar_seguranca()


@pytest.mark.parametrize(
    "overrides, trecho",
    [
        ({"jwt_secret": JWT_SECRET_PADRAO}, "valor padrão"),
        ({"jwt_secret": "curto"}, "32 caracteres"),
        ({"storage_encryption_key": None}, "STORAGE_ENCRYPTION_KEY é obrigatória"),
        ({"storage_encryption_key": "nao-e-fernet"}, "não é uma chave Fernet"),
    ],
)
def test_producao_aborta_com_configuracao_insegura(overrides, trecho):
    with pytest.raises(RuntimeError, match=trecho):
        _settings(**overrides).validar_seguranca()


def test_ldap_exige_segredos_mesmo_em_dev():
    s = _settings(env="dev", auth_provider="ldap", jwt_secret=JWT_SECRET_PADRAO)
    assert s.modo_producao
    with pytest.raises(RuntimeError):
        s.validar_seguranca()


def test_dev_local_nao_exige_segredos_e_habilita_seeds():
    s = _settings(env="dev", jwt_secret=JWT_SECRET_PADRAO, storage_encryption_key=None)
    s.validar_seguranca()
    assert s.seeds_habilitados


@pytest.mark.parametrize(
    "kw, esperado",
    [
        ({"env": "dev"}, True),
        # docker compose / ambientes de teste com auth local mantêm os seeds
        ({"env": "production"}, True),
        ({"env": "dev", "auth_provider": "ldap"}, False),
    ],
)
def test_seeds_dependem_apenas_de_auth_local(kw, esperado):
    assert _settings(**kw).seeds_habilitados is esperado


def test_init_db_nao_cria_seeds_com_ldap(monkeypatch):
    from app import db as db_mod

    monkeypatch.setattr(settings, "auth_provider", "ldap")
    monkeypatch.setattr(settings, "seed_users", "seedldap:senha123:comissao:Seed LDAP")
    db_mod.init_db()
    with SessionLocal() as db:
        assert db.query(Usuario).filter_by(username="seedldap").first() is None


def test_init_db_cria_seeds_com_auth_local_mesmo_fora_de_dev(monkeypatch):
    from app import db as db_mod

    monkeypatch.setattr(settings, "env", "production")
    monkeypatch.setattr(settings, "seed_users", "seedlocal:senha123:discente:Seed Local")
    try:
        db_mod.init_db()
        with SessionLocal() as db:
            assert db.query(Usuario).filter_by(username="seedlocal").one().origem == "local"
    finally:
        with SessionLocal() as db:
            db.query(Usuario).filter_by(username="seedlocal").delete()
            db.commit()


def test_auth_info_expoe_atalhos_com_auth_local(client, monkeypatch):
    info = client.get("/api/auth/info").json()
    assert info["devLogin"] is True
    assert {u["username"] for u in info["devUsers"]} >= {"aluno1", "comissao1"}

    # Independe de ENV: o que desliga os atalhos é o provider LDAP.
    monkeypatch.setattr(settings, "env", "production")
    assert client.get("/api/auth/info").json()["devLogin"] is True

    monkeypatch.setattr(settings, "auth_provider", "ldap")
    info = client.get("/api/auth/info").json()
    assert info["devLogin"] is False
    assert "devUsers" not in info


def test_dockerfile_nao_forca_ambiente_de_producao():
    dockerfile = Path(__file__).resolve().parents[1] / "Dockerfile"
    assert "ENV=production" not in dockerfile.read_text(encoding="utf-8")


def test_html_nao_contem_credenciais_de_dev():
    html = (Path(__file__).resolve().parents[2] / "frontend" / "index.html").read_text(
        encoding="utf-8"
    )
    assert "aluno123" not in html and "comissao123" not in html


# ------------------------------------------------------------ login / LDAP


class _ProviderFalso:
    def __init__(self, info):
        self.info = info

    def authenticate(self, username, password):
        return self.info


def _login_ldap(client, monkeypatch, info):
    from app.api import auth_routes

    monkeypatch.setattr(settings, "auth_provider", "ldap")
    monkeypatch.setattr(
        auth_routes, "get_auth_provider", lambda *_: _ProviderFalso(info)
    )
    return client.post("/api/auth/login", json={"username": info.username, "senha": "x"})


def test_ldap_reaproveita_conta_existente_pelo_username(client, monkeypatch):
    """Contrato original: o upsert casa apenas pelo username."""
    username = "ldap.existente"
    with SessionLocal() as db:
        db.add(Usuario(username=username, nome="Pré-cadastrado", papel="discente", origem="local"))
        db.commit()
    try:
        resp = _login_ldap(client, monkeypatch, UserInfo(username, "Do Diretório", "discente"))
        assert resp.status_code == 200
        with SessionLocal() as db:
            assert db.query(Usuario).filter_by(username=username).count() == 1
    finally:
        with SessionLocal() as db:
            db.query(Usuario).filter_by(username=username).delete()
            db.commit()


def test_ldap_resincroniza_papel_a_cada_login(client, monkeypatch):
    username = "ldap.membro"
    try:
        resp = _login_ldap(client, monkeypatch, UserInfo(username, "Membro", "comissao"))
        assert resp.status_code == 200 and resp.json()["papel"] == "comissao"

        # Removido do grupo da comissão no diretório → rebaixado no login.
        resp = _login_ldap(client, monkeypatch, UserInfo(username, "Membro", "discente"))
        assert resp.status_code == 200 and resp.json()["papel"] == "discente"
        with SessionLocal() as db:
            assert db.query(Usuario).filter_by(username=username).one().papel == "discente"
            assert db.query(AuditLog).filter_by(acao="papel_alterado").count() == 1
    finally:
        with SessionLocal() as db:
            db.query(Usuario).filter_by(username=username).delete()
            db.commit()


class _Entrada:
    def __init__(self, dn, attrs):
        self.entry_dn = dn
        self._attrs = attrs

    def __contains__(self, k):
        return k in self._attrs

    def __getattr__(self, k):
        if k.startswith("_"):
            raise AttributeError(k)
        return self._attrs[k]

    def __getitem__(self, k):
        return type("Attr", (), {"value": self._attrs[k]})()


def _ldap_falso(monkeypatch, entradas, filtros):
    import ldap3

    from app.auth import ldap as ldap_mod

    class Conn:
        def __init__(self, server, user=None, password=None, auto_bind=False):
            self.user = user
            self.entries = []

        def search(self, base, filtro, attributes=None):
            filtros.append(filtro)
            self.entries = entradas if "member=" not in filtro else []
            return bool(self.entries)

        def bind(self):
            return True

        def unbind(self):
            pass

    monkeypatch.setattr(ldap3, "Server", lambda *a, **k: object())
    monkeypatch.setattr(ldap_mod.ldap3, "Connection", Conn)
    s = _settings(auth_provider="ldap", ldap_url="ldap://x", ldap_base_dn="dc=x",
                  ldap_group_comissao="cn=comissao,dc=x")
    return ldap_mod.LdapAuthProvider(s, db=None)


def test_ldap_escapa_filtro_de_busca(monkeypatch):
    filtros = []
    entrada = _Entrada("uid=joao(adm),dc=x", {"cn": "João", "uid": "joao"})
    provider = _ldap_falso(monkeypatch, [entrada], filtros)

    info = provider.authenticate("  joao*)(uid=* ", "senha")
    assert filtros[0] == "(uid=joao\\2a\\29\\28uid=\\2a)"
    # Filtro de grupo também recebe o DN escapado.
    assert filtros[1] == "(member=uid=joao\\28adm\\29,dc=x)"
    # Contrato original: o username é o digitado (sem espaços nas pontas).
    assert info.username == "joao*)(uid=*"


def test_ldap_usa_primeira_entrada_quando_ha_varias(monkeypatch):
    """Contrato original: múltiplas entradas não bloqueiam o login."""
    entradas = [_Entrada(f"uid=a{i},dc=x", {"cn": f"A{i}", "uid": f"a{i}"}) for i in range(2)]
    provider = _ldap_falso(monkeypatch, entradas, [])
    info = provider.authenticate("a", "senha")
    assert info is not None and info.nome == "A0"


# -------------------------------------------------- integridade documental


def test_pdf_de_outro_discente_e_rejeitado_com_422(client):
    login(client, "aluno1", "aluno123")
    outro = pdf_com_texto("BOLETIM NAO OFICIAL", "Nome: Outra Pessoa", "DRE: 199999999")
    resp = submeter(client, boletim_bytes=outro)
    assert resp.status_code == 422
    assert "Boletim" in resp.json()["detail"]
    with SessionLocal() as db:
        assert db.query(Submissao).count() == 0


def test_pdf_sem_texto_extraivel_e_rejeitado(client):
    login(client, "aluno1", "aluno123")
    resp = submeter(client, boa_bytes=b"%PDF-1.4 sem estrutura")
    assert resp.status_code == 422
    assert "BOA" in resp.json()["detail"]


def test_identidade_tolerante_a_acentos_e_caixa(client):
    login(client, "aluno1", "aluno123")
    payload = payload_apto()
    payload["metadata"]["nome"] = "José da Conceição"
    boletim = pdf_com_texto("Nome: JOSE DA CONCEICAO", f"DRE: {DRE_ALUNO1}")
    _, boa = pdfs_do_payload(payload)
    assert submeter(client, payload, boletim_bytes=boletim, boa_bytes=boa).status_code == 200


def test_somente_diagnostico_do_servidor_e_persistido(client):
    login(client, "aluno1", "aluno123")
    payload = payload_apto(
        diagnostico={"apto": True, "criterios": [{"rotulo": "FORJADO", "ok": True}]}
    )
    sub = submeter(client, payload).json()
    rotulos = [c["rotulo"] for c in sub["diagnostico"]["criterios"]]
    assert "FORJADO" not in rotulos
    assert any(r.startswith("CR acumulado") for r in rotulos)


# ----------------------------------------------------- portal público


def _aprovar(client, sub_id):
    login(client, "comissao1", "comissao123")
    resp = client.post(f"/api/comissao/submissoes/{sub_id}/decisao", json={"decisao": "aprovada"})
    assert resp.status_code == 200


def test_portal_publico_mascara_dre_e_limita_paginacao(client):
    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()
    _aprovar(client, sub["id"])

    login(client, "aluno2", "aluno123")
    dados = client.get("/api/autorizacoes").json()
    assert dados["autorizacoes"][0]["dre"] == "120****01"
    assert client.get("/api/autorizacoes?limite=51").status_code == 422
    assert client.get("/api/autorizacoes?limite=50").status_code == 200

    # Busca pública só por nome: DRE completo não confirma existência.
    assert client.get(f"/api/autorizacoes?q={DRE_ALUNO1}").json()["total"] == 0
    assert client.get("/api/autorizacoes?q=Aluno Exemplo").json()["total"] == 1

    # A comissão continua vendo o DRE completo.
    login(client, "comissao1", "comissao123")
    completo = client.get("/api/comissao/autorizacoes").json()
    assert completo["autorizacoes"][0]["dre"] == DRE_ALUNO1


@pytest.mark.parametrize(
    "dre, esperado",
    [("120012345", "120****45"), ("12345", "*****"), (None, None), ("1234567890", "123*****90")],
)
def test_mascarar_dre(dre, esperado):
    from app.api.comissao import mascarar_dre

    assert mascarar_dre(dre) == esperado


# ------------------------------------------------- renovação / expurgo


def test_autorizacao_vigente_bloqueia_nova_submissao(client):
    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()
    _aprovar(client, sub["id"])

    login(client, "aluno1", "aluno123")
    minha = client.get("/api/submissoes/minha").json()["submissao"]
    assert minha["autorizacao"]["renovavel"] is False
    resp = submeter(client)
    assert resp.status_code == 409
    assert "autorização de estágio vigente" in resp.json()["detail"]


def test_expurgo_inclui_revogadas(client):
    from app.services.expurgo import executar_expurgo

    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()
    _aprovar(client, sub["id"])
    client.post(f"/api/comissao/submissoes/{sub['id']}/revogar", json={"motivo": "teste"})

    with SessionLocal() as db:
        s = db.get(Submissao, sub["id"])
        assert s.status == "revogada"
        caminhos = [Path(s.boletim_path), Path(s.boa_path)]
        s.concluido_em = datetime.now(timezone.utc) - timedelta(
            days=settings.pdf_retention_days + 1
        )
        db.commit()
        assert executar_expurgo(db, settings) == 1
        assert db.get(Submissao, sub["id"]).pdf_expurgado_em is not None
    assert not any(c.exists() for c in caminhos)


# ------------------------------------------------- arquivos em disco


def test_nome_de_arquivo_aleatorio_sem_dados_pessoais(client):
    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()
    with SessionLocal() as db:
        s = db.get(Submissao, sub["id"])
        nomes = [Path(s.boletim_path).name, Path(s.boa_path).name]
    assert all(DRE_ALUNO1 not in n for n in nomes)
    assert nomes[0].startswith("boletim_") and len(nomes[0]) == len("boletim_") + 32 + 4


def test_falha_no_commit_nao_deixa_pdfs_orfaos(client, monkeypatch):
    from app.api import submissoes

    def falhar(*_a, **_k):
        raise RuntimeError("falha simulada")

    upload_dir = Path(settings.upload_dir)
    antes = set(upload_dir.glob("*.bin")) if upload_dir.exists() else set()
    monkeypatch.setattr(submissoes, "registrar", falhar)

    login(client, "aluno1", "aluno123")
    with pytest.raises(RuntimeError):
        submeter(client)
    assert set(upload_dir.glob("*.bin")) == antes
    with SessionLocal() as db:
        assert db.query(Submissao).count() == 0


def test_cancelamento_com_falha_preserva_pdfs(client, monkeypatch):
    from app.api import submissoes

    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()
    with SessionLocal() as db:
        caminhos = [Path(db.get(Submissao, sub["id"]).boletim_path)]

    def falhar(*_a, **_k):
        raise RuntimeError("falha simulada")

    monkeypatch.setattr(submissoes, "registrar", falhar)
    with pytest.raises(RuntimeError):
        client.post(f"/api/submissoes/{sub['id']}/cancelar")
    assert all(c.exists() for c in caminhos)
    with SessionLocal() as db:
        assert db.get(Submissao, sub["id"]).status == "fila_regular"


def test_fernet_e_cacheado():
    from app.services import crypto

    assert crypto._fernet() is crypto._fernet()


# -------------------------------------------------- concorrência


def test_hash_chain_nao_bifurca_com_escritas_concorrentes():
    from app.services.auditoria import registrar, verificar_cadeia

    n_threads, por_thread = 8, 10
    barreira = threading.Barrier(n_threads)
    erros = []

    def trabalhador():
        try:
            barreira.wait()
            for _ in range(por_thread):
                with SessionLocal() as db:
                    registrar(db, None, "teste_concorrencia", "teste", None)
                    db.commit()
        except Exception as exc:  # noqa: BLE001
            erros.append(exc)

    threads = [threading.Thread(target=trabalhador) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not erros
    with SessionLocal() as db:
        assert db.query(AuditLog).count() == n_threads * por_thread
        anteriores = [r.hash_anterior for r in db.query(AuditLog).all()]
        assert len(anteriores) == len(set(anteriores)), "cadeia bifurcou"
        assert verificar_cadeia(db)


def test_submissoes_simultaneas_geram_uma_unica_ativa(client):
    """Duas requisições paralelas do mesmo discente: só uma fica ativa."""
    from fastapi.testclient import TestClient

    from app.main import app

    payload = payload_apto()
    boletim, boa = pdfs_do_payload(payload)
    clientes = []
    for _ in range(2):
        c = TestClient(app)
        login(c, "aluno1", "aluno123")
        clientes.append(c)

    barreira = threading.Barrier(2)
    status = []

    def enviar(c):
        barreira.wait()
        r = c.post(
            "/api/submissoes",
            files={
                "boletim": ("boletim.pdf", boletim, "application/pdf"),
                "boa": ("boa.pdf", boa, "application/pdf"),
            },
            data={"payload": json.dumps(payload)},
        )
        status.append(r.status_code)

    threads = [threading.Thread(target=enviar, args=(c,)) for c in clientes]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(status) == [200, 409]
    with SessionLocal() as db:
        assert db.query(Submissao).filter(Submissao.status.in_(("fila_regular", "mesa_revisao"))).count() == 1


# -------------------------------------------------- regras


def test_periodo_sintetico_nao_conta_no_tempo_de_curso():
    from app.api.deps import get_regras
    from app.rules.ppc2022 import verificar_elegibilidade

    regras = get_regras()
    maximo = regras["max_periodos_integralizacao"]
    payload = payload_apto()
    disciplinas = payload["periodos"][0]["disciplinas"]
    payload["periodos"] = [
        {"periodo": f"{2015 + i // 2}/{i % 2 + 1}", "disciplinas": disciplinas if i == 0 else []}
        for i in range(maximo)
    ] + [{"periodo": "Aprovadas (BOA)", "disciplinas": []}]
    criterios = verificar_elegibilidade(payload, regras)["criterios"]
    tempo = next(c for c in criterios if c["rotulo"].startswith("Tempo de curso"))
    assert tempo["ok"], tempo["detalhe"]


# ------------------------------------------- Ciclo 3: conferência dos PDFs


def _alertas_da_submissao(sub_id):
    with SessionLocal() as db:
        return json.loads(db.get(Submissao, sub_id).alertas_saneamento_json or "[]")


def test_modo_alertar_encaminha_para_mesa_em_vez_de_422(client, monkeypatch):
    from app.api.submissoes import ALERTA_PDF_CONTINGENCIA

    monkeypatch.setattr(settings, "identidade_pdf_modo", "alertar")
    login(client, "aluno1", "aluno123")
    outro = pdf_com_texto("BOLETIM NAO OFICIAL", "Nome: Outra Pessoa", "DRE: 199999999")
    resp = submeter(client, boletim_bytes=outro)
    assert resp.status_code == 200, resp.text
    sub = resp.json()
    assert sub["status"] == "mesa_revisao"
    assert ALERTA_PDF_CONTINGENCIA in sub["alertas"]
    assert any("DRE informado não consta no Boletim" in a for a in sub["alertas"])


def test_modo_alertar_aceita_pdf_ilegivel(client, monkeypatch):
    from app.api.submissoes import ALERTA_PDF_CONTINGENCIA

    monkeypatch.setattr(settings, "identidade_pdf_modo", "alertar")
    login(client, "aluno1", "aluno123")
    resp = submeter(client, boa_bytes=b"%PDF-1.4 sem estrutura")
    assert resp.status_code == 200
    assert resp.json()["status"] == "mesa_revisao"
    assert ALERTA_PDF_CONTINGENCIA in _alertas_da_submissao(resp.json()["id"])


def test_modo_bloquear_e_o_padrao(client):
    assert settings.identidade_pdf_modo == "bloquear"
    login(client, "aluno1", "aluno123")
    outro = pdf_com_texto("Nome: Outra Pessoa", "DRE: 199999999")
    assert submeter(client, boletim_bytes=outro).status_code == 422


def test_codigo_fabricado_gera_alerta_e_vai_para_mesa(client):
    login(client, "aluno1", "aluno123")
    payload = payload_apto()
    boletim, boa = pdfs_do_payload(payload)  # PDFs "verdadeiros", sem a disciplina extra
    payload["periodos"][0]["disciplinas"].append(
        {"codigo": "XYZ999", "nome": "Inventada", "crR": 4, "grau": 10.0,
         "pontos": 40.0, "situacao": "AP"}
    )
    resp = submeter(client, payload, boletim_bytes=boletim, boa_bytes=boa)
    assert resp.status_code == 200, resp.text
    sub = resp.json()
    assert sub["status"] == "mesa_revisao"
    assert any("XYZ999" in a and "não consta" in a for a in sub["alertas"])


def test_codigo_nao_concluido_nao_e_exigido_no_pdf(client):
    """Só disciplinas concluídas (AP/T) precisam constar no documento."""
    login(client, "aluno1", "aluno123")
    payload = payload_apto()
    boletim, boa = pdfs_do_payload(payload)
    payload["periodos"][0]["disciplinas"].append(
        {"codigo": "XYZ998", "nome": "Cursando", "crR": 4, "grau": None, "situacao": "CURSANDO"}
    )
    resp = submeter(client, payload, boletim_bytes=boletim, boa_bytes=boa)
    assert resp.json()["status"] == "fila_regular", resp.json()["alertas"]


def test_aprovadas_do_boa_sao_conferidas_no_boa(client):
    """O agrupamento "Aprovadas (BOA)" é conferido no BOA, não no Boletim."""
    login(client, "aluno1", "aluno123")
    payload = payload_apto()
    payload["periodos"].append({
        "periodo": "Aprovadas (BOA)",
        "disciplinas": [{"codigo": "MAE992", "nome": "Optativa", "crR": 4,
                         "grau": None, "situacao": "AP"}],
    })
    sub = submeter(client, payload).json()  # pdfs_do_payload põe MAE992 só no BOA
    assert sub["status"] == "fila_regular", sub["alertas"]

    _, boa_sem = pdfs_do_payload(payload_apto())
    boletim, _ = pdfs_do_payload(payload)
    with SessionLocal() as db:
        db.query(Submissao).delete()
        db.commit()
    sub = submeter(client, payload, boletim_bytes=boletim, boa_bytes=boa_sem).json()
    assert sub["status"] == "mesa_revisao"
    assert any("MAE992" in a for a in sub["alertas"])


def test_boletim_longo_le_alem_de_3_paginas():
    """Históricos longos: códigos da 4ª página em diante também são lidos."""
    import io

    from pypdf import PdfReader, PdfWriter

    from app.services.documento import conferir_documentos

    writer = PdfWriter()
    paginas = [
        pdf_com_texto("Nome: Aluno Exemplo", f"DRE: {DRE_ALUNO1}"),
        pdf_com_texto("2020/1 AAA111"),
        pdf_com_texto("2020/2 BBB222"),
        pdf_com_texto("2021/1 CCC333"),
        pdf_com_texto("2021/2 DDD444"),
    ]
    for dados in paginas:
        writer.add_page(PdfReader(io.BytesIO(dados)).pages[0])
    saida = io.BytesIO()
    writer.write(saida)
    boletim = saida.getvalue()
    boa = pdf_com_texto(f"{DRE_ALUNO1} - Aluno Exemplo")

    periodos = [{"periodo": "2021/2", "disciplinas": [{"codigo": "DDD444", "situacao": "AP"}]}]
    resultado = conferir_documentos(boletim, boa, "Aluno Exemplo", DRE_ALUNO1, periodos)
    assert resultado.divergencias == []
    assert resultado.codigos_ausentes == []


# ------------------------------------------- Ciclo 3: HTTP e documentação


def test_download_de_pdf_com_no_store(client):
    login(client, "aluno1", "aluno123")
    sub = submeter(client).json()
    login(client, "comissao1", "comissao123")
    for doc in ("boletim", "boa"):
        resp = client.get(f"/api/comissao/submissoes/{sub['id']}/{doc}")
        assert resp.status_code == 200
        assert resp.headers["cache-control"] == "no-store"


def test_headers_de_seguranca_em_todas_as_respostas(client):
    for caminho in ("/api/health", "/", "/api/auth/me"):
        resp = client.get(caminho)
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert resp.headers["x-frame-options"] == "SAMEORIGIN"
        assert resp.headers["referrer-policy"] == "same-origin"


def test_docs_desativados_fora_de_dev(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import create_app

    monkeypatch.setattr(settings, "env", "production")
    c = TestClient(create_app())  # sem lifespan: só o roteamento importa aqui
    for caminho in ("/docs", "/redoc", "/openapi.json"):
        assert c.get(caminho).status_code == 404, caminho


def test_docs_disponiveis_em_dev(client):
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200


def test_rota_de_api_inexistente_responde_404(client):
    assert client.get("/api/nao-existe").status_code == 404
