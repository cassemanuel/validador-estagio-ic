# Roadmap de Melhorias Futuras — Validador de Estágio IC/UFRJ

Este documento reúne as melhorias planejadas e as contingências documentadas para a plataforma.

## 1. Integração LDAP em produção

- Substituir o provider de autenticação local/seed pelo LDAP institucional da UFRJ.
- Campos esperados: `uid`, `cn`/`displayName` e o grupo da Comissão de Estágio.
- Variáveis de ambiente (ver `.env.example`): `AUTH_PROVIDER=ldap`, `LDAP_URL`,
  `LDAP_BASE_DN`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_USER_FILTER` e
  `LDAP_GROUP_COMISSAO` (com `COMMISSION_USERS` como lista de apoio).
- Com `AUTH_PROVIDER=ldap` a aplicação exige `JWT_SECRET` forte e
  `STORAGE_ENCRYPTION_KEY`, e não provisiona os usuários seed.

## 2. Integração com nuvem institucional (backup)

- **Objetivo:** redundância off-site dos dados da aplicação (volume `app-data`,
  montado em `/app/data`) sem expor documentos brutos.
- **Pré-requisito — snapshot do SQLite (modo WAL):** nunca sincronize o
  `app.db` vivo (com `-wal`/`-shm` sendo escritos), pois a cópia pode ficar
  inconsistente. Antes de cada sincronização, gere um snapshot com a API de
  backup do SQLite (`sqlite3.Connection.backup` / comando `.backup`) ou
  `VACUUM INTO '/app/data/backup/app-AAAA-MM-DD.db'`, e envie **apenas o
  snapshot**, junto com `uploads/` (já cifrados). A `STORAGE_ENCRYPTION_KEY`
  deve ser guardada fora do backup (cofre institucional).
- **Opção A — Nextcloud do IC via WebDAV:**
  - Configurar `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_PASS`.
  - Rotina diária (`services/backup.py`) gera o snapshot e sincroniza o
    snapshot + `uploads/` via WebDAV.
- **Opção B — rclone:**
  - Perfil `rclone` apontando para S3/Nextcloud/Google Drive institucional.
  - Job cron/crontab no host ou container sidecar que gera o snapshot antes
    do `rclone sync` (nunca sincroniza o `app.db` vivo).

## 3. Notificações automáticas por e-mail

- SMTP institucional do Google Workspace (`@ic.ufrj.br`, porta 587 STARTTLS).
- Envio em background nas transições:
  - `aprovada` → e-mail de liberação com validade da autorização.
  - `indeferida` → e-mail com motivo e orientações.
  - `devolvida` → e-mail solicitando correção dos documentos.
- Biblioteca sugerida: `aiosmtplib` ou `fastapi-mail`.
- Cuidado: não anexar PDFs; enviar apenas links seguros e resumos.

## 4. Contingência para mudanças de layout do SIGA

- **Risco:** alteração visual do BOA/Boletim pela PR1/DRE (ex.: 2028) pode quebrar o parser baseado em coordenadas.
- **Mitigação:**
  1. Manter **formulário alternativo temporário** (Google Forms institucional) para coleta manual.
  2. Recalibração do parser com base em amostras reais do novo layout.
  3. Versionamento das regras de parsing (`frontend/rules/parsers-v2.json`) para suportar múltiplos layouts.
- **Documentação de calibração:** manter scripts em `scripts/dump_boa_tokens.*` com exemplos sintéticos para futura calibração.

## 5. Dashboards e relatórios avançados

- **Status do módulo de Relatórios de Estágio:** em construção — placeholder
  navegável em `/admin/relatorios`, previsto para o ciclo **2027/1**.
- Exportação CSV/JSONL da fila, autorizações e auditoria.
- Taxa de deferimento por semestre (tempo médio de resposta e período mais
  comum entre os deferidos já estão no portal `/autorizados`).
- Painel de evolução histórica do CR agregado (anonimizado).

## 6. Auditoria e compliance

- Interface de consulta ao `audit_log` para a comissão.
- Assinatura digital de decisões (opcional) com chave privada da comissão.
- Rotina de arquivamento de logs antigos em `data/archive/`.

## 7. Testes e CI/CD

- Pipeline GitHub/GitLab Actions rodando `pytest` e `npm test`.
- Sonar/linter para evitar regressões de segurança.
- Deploy automatizado via Docker Compose no servidor do IC.

## 8. Acessibilidade e usabilidade

- Revisão de acessibilidade (WCAG 2.1 AA).
- Suporte a alto contraste e redução de movimento.
- Internacionalização futura (i18n) se necessário.
