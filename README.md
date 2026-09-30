# Validador de Estágio — BCC/IC/UFRJ

Plataforma institucional de **triagem e validação de elegibilidade para estágio
curricular** de discentes do Bacharelado em Ciência da Computação (UFRJ),
conforme o PPC 2022 (Anexo C, Art. 4º — Programa de Estágio).

## Arquitetura

Monorepo cliente-servidor:

- **`frontend/`** — SPA vanilla JS (sem build), servida como estático pelo
  backend. O parsing do BOA/Boletim (pdf.js vendored em `frontend/vendor/`)
  roda **no navegador**: o PDF só é enviado ao servidor após a confirmação
  interativa do discente.
- **`backend/`** — FastAPI + SQLite (modo WAL) em Docker. Persistência de
  submissões, exceções, decisões e `audit_log` imutável (append-only com
  hash chain sha256).
- **`frontend/rules/ciclo_basico.json`** — fonte única das regras do PPC 2022,
  consumida pelo frontend (diagnóstico preliminar) e pelo backend
  (sanity check em `backend/app/rules/ppc2022.py`).

## Fluxo

**Discente**: login → upload do BOA/Boletim → parsing local → confirmação dos
dados extraídos com declaração de exceções estruturadas (equivalência /
dispensa / aproveitamento) → diagnóstico preliminar → submissão.

**Triagem automática** (`services/triagem.py`): submissão vai para a
**Fila de Casos Regulares** (aprovação em 1 clique) quando o diagnóstico é
apto, não há exceções e não há alertas de saneamento; caso contrário, vai
para a **Mesa de Revisão** (split-screen: PDF original × dados extraídos).

**Saneamento server-side** (`services/saneamento.py`): DRE do documento ×
usuário autenticado, formato de códigos UFRJ, tipo de documento e recálculo
independente da elegibilidade — divergências forçam revisão humana.

## LGPD e governança

- PDF bruto fora do banco (`data/uploads/`, sha256 registrado) e **expurgado**
  após `PDF_RETENTION_DAYS` (default 30) da conclusão — job periódico em
  `services/expurgo.py`.
- `audit_log` registra logins, submissões, acessos ao PDF, decisões e
  expurgos — nunca contém o documento nem dados pessoais além de ids.
- Histórico do SIGA gera alerta automático (omite reprovações).

## Como rodar

### Docker (recomendado)

```bash
cp .env.example .env   # edite JWT_SECRET
docker compose up --build
# http://localhost:8000
```

### Desenvolvimento local

```bash
# Backend (porta 8000 serve API + frontend)
python -m venv .venv && .venv\Scripts\activate   # ou source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend && python -m uvicorn app.main:app --reload --port 8000
```

### Credenciais de desenvolvimento (SEED_USERS)

| Usuário    | Senha        | Papel     |
|------------|--------------|-----------|
| `aluno1`   | `aluno123`   | discente  |
| `comissao1`| `comissao123`| comissão  |

### LDAP institucional

Configure `AUTH_PROVIDER=ldap` e as variáveis `LDAP_*` no `.env`. O papel
`comissao` deriva do grupo `LDAP_GROUP_COMISSAO` ou da lista
`COMMISSION_USERS`. `LdapAuthProvider` fica atrás da interface
`AuthProvider` — em dev, `LocalAuthProvider` usa os seeds acima.

## Testes

```bash
# Backend (pytest): fluxo e2e — auth, submissão, triagem, decisão,
# cadeia do audit_log e expurgo
cd backend && python -m pytest tests/ -x -q

# Frontend/rules (node --test): parsers sintéticos, motor de CR,
# elegibilidade contra ciclo_basico.json
npm test
```

## Endpoints principais

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| POST | `/api/auth/login` | — | Login (cookie httpOnly JWT) |
| POST | `/api/submissoes` | discente | Multipart: PDF + dados extraídos |
| GET | `/api/submissoes/minha` | discente | Submissão ativa + decisão |
| GET | `/api/comissao/fila?tipo=regular\|revisao` | comissão | Filas |
| GET | `/api/comissao/submissoes/{id}` | comissão | Dados + exceções + alertas |
| GET | `/api/comissao/submissoes/{id}/pdf` | comissão | Stream do PDF (auditado) |
| POST | `/api/comissao/submissoes/{id}/decisao` | comissão | Deliberação transacional |

## Licença

MIT
