# Validador de Estágio — BCC/IC/UFRJ

Plataforma institucional de **triagem e validação de elegibilidade para estágio
curricular** de discentes do Bacharelado em Ciência da Computação (BCC) da
Universidade Federal do Rio de Janeiro (UFRJ), operando junto à **Comissão de
Estágio do Instituto de Computação (IC/UFRJ)**.

Este projeto é uma **iniciativa desenvolvida por discentes do IC/UFRJ voltada
para o próprio Instituto de Computação**, com o objetivo de dar **agilidade e
transparência** à validação dos estágios curriculares do BCC sob o **PPC 2022**
(Anexo C, Art. 4º — Programa de Estágio).

## Arquitetura

Monorepo cliente-servidor:

- **`frontend/`** — SPA vanilla JS (sem build), servida como estático pelo
  backend. O parsing dos documentos SIGA (Boletim Não Oficial + BOA) roda
  **no navegador** com `pdf.js` vendored em `frontend/vendor/`. Os PDFs só são
  enviados ao servidor após a confirmação interativa do discente.
- **`backend/`** — FastAPI + SQLite (modo WAL), containerizado com Docker.
  Persiste submissões, exceções, decisões e um `audit_log` imutável
  (append-only com hash chain sha256).
- **`frontend/rules/ciclo_basico.json`** — fonte única das regras do PPC 2022,
  consumida pelo frontend (diagnóstico preliminar) e pelo backend
  (`backend/app/rules/ppc2022.py`) para saneamento e recálculo independente.

## Fluxos

### Discente

1. Login com credencial institucional (local em dev; LDAP em produção).
2. Upload obrigatório de **dois documentos**:
   - **Boletim Não Oficial**: histórico de notas, períodos cursados e CR.
   - **BOA (Boletim de Orientação Acadêmica)**: grade curricular, pendências
     e cumprimentos no PPC 2022.
3. Parsing local + confirmação interativa dos dados extraídos.
4. Declaração estruturada de exceções (equivalência / dispensa / aproveitamento).
5. Diagnóstico preliminar de elegibilidade.
6. Submissão à Comissão de Estágio.

A triagem automática (`services/triagem.py`) encaminha o processo para:

- **Fila de Casos Regulares** (aprovação em 1 clique) quando apto, sem exceções
  e sem alertas de saneamento.
- **Mesa de Revisão** (split-screen: Boletim/BOA × dados extraídos) nos demais
  casos.

### Comissão / Admin

O painel administrativo possui **5 telas dedicadas**:

1. **`/admin/dashboard`** — métricas consolidadas em cards clicáveis, alertas
   de vencimento e auditoria recente.
2. **`/admin/fila`** — tabela unificada de triagem com busca por nome/DRE,
   filtro por status (incluindo **Arquivadas**) e paginação.
3. **`/admin/mesa`** — análise individual do processo, com abas para alternar
   entre Boletim e BOA, exceções declaradas, evolução do CR, deliberação e
   **arquivamento** de processos concluídos.
4. **`/admin/autorizacoes`** — liberações deferidas e validade de 90 dias.
5. **`/admin/relatorios`** — módulo de acompanhamento de relatórios de estágio
   (em construção, previsto para o ciclo 2027/1).

## Segurança, LGPD e governança

### Proteção contra arquivos maliciosos

- **Magic bytes**: todos os uploads são validados contra o cabeçalho `%PDF-`
  tanto no cliente quanto no servidor.
- **Tamanho**: limite estrito de **15 MB por arquivo PDF**; rejeição com HTTP 413.
- **Path traversal**: DRE e identificadores são sanitizados antes de compor os
  nomes dos arquivos no disco (`boletim_{dre}_{timestamp}.pdf` /
  `boa_{dre}_{timestamp}.pdf`).
- **SPA fallback confinado**: o `spa_fallback` resolve o caminho canônico e só
  serve arquivos contidos em `frontend/` (`resolve()` + `is_relative_to`);
  tentativas de escape como `..%2f` retornam HTTP 404 — coberto por testes em
  `backend/tests/test_seguranca.py`.
- **PDF.js hardening**: `isEvalSupported: false` no `getDocument`, worker local
  vendored e limite máximo de páginas processadas por documento.
- **Sanitização de DOM**: helpers de renderização usam `createTextNode` e
  `sanitizeUrl`, evitando injeção de HTML/JS via dados extraídos de PDFs.

### Privacidade e integridade

- PDFs brutos ficam fora do banco (`data/uploads/`) e são **expurgados** após
  `PDF_RETENTION_DAYS` (padrão 30) da conclusão do processo — job periódico em
  `services/expurgo.py`.
- **Criptografia em repouso:** antes de gravar em disco, cada PDF é cifrado
  com Fernet (`cryptography`) e armazenado em `data/uploads/*.bin`. A chave
  pode ser fornecida por `STORAGE_ENCRYPTION_KEY` no `.env` ou derivada do
  `JWT_SECRET` via PBKDF2-HMAC-SHA256. O servidor decifra o arquivo em memória
  apenas ao fazer stream para a mesa de curadoria.
- `audit_log` registra logins, submissões, acessos aos PDFs, decisões e
  expurgos, sem guardar o documento nem dados pessoais além do necessário.
- Hash chain sha256 garante integridade tamper-evident dos registros de auditoria.
- Histórico do SIGA gera alerta automático (omite reprovações).
- Dados tratados conforme a LGPD.

### Armazenamento local e Docker

O `docker-compose.yml` monta o diretório `data/` do host dentro do container:

```yaml
volumes:
  - ./data:/app/data
```

Assim, o banco SQLite (`data/app.db`, `data/app.db-wal`, `data/app.db-shm`)
e os PDFs cifrados (`data/uploads/*.bin`) persistem no servidor hospedeiro,
mesmo após o container ser destruído. Para backup, basta copiar o diretório
`data/`.

## Documentação detalhada

- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — visão arquitetural completa, modelo de dados, criptografia at-rest, SQLite WAL e governança.
- [`docs/ROADMAP_MELHORIAS.md`](docs/ROADMAP_MELHORIAS.md) — melhorias planejadas: LDAP, backup Nextcloud/WebDAV, notificações SMTP, contingência para mudanças de layout do SIGA e CI/CD.

## Como rodar

### Docker (recomendado)

```bash
cp .env.example .env   # edite JWT_SECRET

docker compose up --build
# Acesse http://localhost:8000
```

O container sobe o backend FastAPI servindo o frontend estático, com SQLite em
`data/app.db` e uploads em `data/uploads/`.

### Desenvolvimento local

```bash
# Backend (porta 8000 serve API + frontend)
python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate  # Linux/macOS

pip install -r backend/requirements.txt
cd backend
python -m uvicorn app.main:app --reload --port 8000
```

### Credenciais de desenvolvimento (SEED_USERS)

| Usuário     | Senha         | Papel      |
|-------------|---------------|------------|
| `aluno1`    | `aluno123`    | discente   |
| `aluno2`    | `aluno123`    | discente   |
| `aluno3`    | `aluno123`    | discente   |
| `comissao1` | `comissao123` | comissão   |

### LDAP institucional

Configure `AUTH_PROVIDER=ldap` e as variáveis `LDAP_*` no `.env`. O papel
`comissao` deriva do grupo `LDAP_GROUP_COMISSAO` ou da lista
`COMMISSION_USERS`. Em desenvolvimento, `LocalAuthProvider` usa os seeds acima.

## Testes

```bash
# Backend (pytest): auth, submissão, triagem, decisão, auditoria, expurgo
cd backend && python -m pytest tests/ -x -q

# Frontend/rules (node --test): parsers sintéticos, motor de CR e elegibilidade
cd .. && npm test
```

## Endpoints principais

| Método | Rota | Papel | Descrição |
|--------|------|-------|-----------|
| POST   | `/api/auth/login` | — | Login (cookie httpOnly JWT) |
| POST   | `/api/submissoes` | discente | Multipart: Boletim + BOA + dados extraídos |
| GET    | `/api/submissoes/minha` | discente | Submissão ativa + decisão |
| GET    | `/api/comissao/fila?tipo=todos\|regular\|revisao` | comissão | Fila de triagem |
| GET    | `/api/comissao/metricas` | comissão | Métricas consolidadas |
| GET    | `/api/comissao/auditoria` | comissão | Últimos eventos do audit_log |
| GET    | `/api/comissao/autorizacoes` | comissão | Autorizações deferidas |
| GET    | `/api/comissao/submissoes/{id}` | comissão | Dados completos do processo |
| GET    | `/api/comissao/submissoes/{id}/boletim` | comissão | Stream do Boletim (auditado) |
| GET    | `/api/comissao/submissoes/{id}/boa` | comissão | Stream do BOA (auditado) |
| POST   | `/api/comissao/submissoes/{id}/decisao` | comissão | Deliberação transacional |
| POST   | `/api/comissao/submissoes/{id}/revogar` | comissão | Revogação de autorização |
| POST   | `/api/comissao/submissoes/{id}/arquivar` | comissão | Arquivamento de processo concluído |

## Licença

MIT
