# Arquitetura do Validador de Estágio IC/UFRJ

## 1. Visão geral

O Validador de Estágio é uma plataforma **cliente-servidor institucional** para triagem e validação de elegibilidade de estágio curricular do Bacharelado em Ciência da Computação (BCC/UFRJ) sob o PPC 2022.

- **Frontend:** SPA em JavaScript vanilla (ES modules), CSS customizado, sem frameworks pesados.
- **Backend:** FastAPI + SQLAlchemy + SQLite (modo WAL).
- **Parsing de PDFs:** executado no navegador do discente via `pdf.js` vendored.
- **Persistência:** SQLite local com trilha de auditoria imutável.
- **Deploy:** container Docker com volume `./data:/app/data`.

## 2. Estrutura do monorepo

```text
validador-estagio-ic/
├── backend/              # FastAPI, modelos, regras, serviços, testes
├── frontend/             # SPA, parsers, regras, CSS
├── scripts/              # Utilitários (smoke tests, calibração)
├── data/                 # SQLite + uploads cifrados (não versionado)
├── docs/                 # Documentação estendida
├── docker-compose.yml
└── README.md
```

## 3. Fluxo cliente-servidor

1. **Autenticação:** login via LDAP institucional ou desenvolvedor local; sessão em cookie httpOnly + JWT.
2. **Upload:** discente anexa **Boletim Não Oficial + BOA**; parsing ocorre no navegador.
3. **Saneamento:** backend recalcula elegibilidade com o espelho Python das regras e detecta divergências.
4. **Triagem:** comissão acessa fila unificada; casos regulares são deferíveis em 1 clique; demais vão para mesa de revisão.
5. **Decisão:** deferimento, indeferimento ou devolução gera `audit_log` e, se aprovado, autorização com validade de 90 dias.
6. **Arquivamento:** processos concluídos (`indeferida`, `devolvida`, `cancelada`, `revogada`) podem ser arquivados pela comissão (`status = 'arquivada'`), saindo da fila ativa e das métricas de pendentes — evento registrado no `audit_log`.
7. **Expurgo:** PDFs cifrados são removidos após `PDF_RETENTION_DAYS`; logs são arquivados após 6 meses.

## 4. Motor de parsing (client-side)

- Biblioteca: `pdf.js` vendored em `/vendor/pdfjs/`.
- Configuração defensiva: `isEvalSupported: false`.
- Limite de páginas: `MAX_PDF_PAGES = 25`.
- Calibração do BOA: agrupamento por colunas (coordenadas X/Y), rótulos tolerantes (`Cred.`, `C.H.`, `Per.`), distinção entre zona de aprovadas e zona de pendências.
- Versão de calibração: **layout SIGA/UFRJ de setembro/2026**.

## 5. Segurança e hardening

| Camada | Medida |
|--------|--------|
| Upload | Magic bytes `%PDF-`, limite 15 MB, content-type restrito. |
| Path traversal | DRE sanitizado; padrão de nome fixo; `spa_fallback` confinado ao diretório `frontend/` via caminho canônico (`resolve()` + `is_relative_to`, 404 para escapes). |
| PDF bomb | Máximo 25 páginas; worker local. |
| XSS | Text nodes; URLs sanitizadas. |
| RBAC | Endpoints `/api/comissao/*` exigem papel `comissao`. |
| Criptografia at-rest | Fernet (AES-128-CBC + HMAC-SHA256) em `data/uploads/*.bin`. |
| Integridade | `audit_log` imutável com hash chain SHA-256. |

## 6. Criptografia em repouso

- Chave: `STORAGE_ENCRYPTION_KEY` no `.env` ou derivada de `JWT_SECRET` via PBKDF2-HMAC-SHA256.
- Arquivos salvos: `data/uploads/{boletim,boa}_{dre}_{timestamp}.bin`.
- Decifragem: apenas no momento do stream para a mesa de revisão; nunca persistido em disco.

## 7. Modelo de dados (resumo)

- `usuarios`: credenciais e papéis (`discente`, `comissao`).
- `submissoes`: metadados, paths/hash dos PDFs, status, decisões.
- `excecoes`: declarações de equivalência/dispensa/aproveitamento.
- `decisoes`: histórico de pareceres.
- `audit_log`: registro imutável de todas as ações relevantes.

## 8. SQLite WAL

- Modo WAL ativado em `backend/app/db.py`.
- Garante leituras consistentes e alta resiliência a quedas de energia.
- Arquivos `*.db-wal` e `*.db-shm` são gerados automaticamente e devem ser preservados no backup.

## 9. Governança e LGPD

- Dados pessoais minimizados; PDFs expurgados após retenção.
- Logs mantidos por 6 meses.
- Acesso aos PDFs é auditado e restrito a membros da comissão.
