# Roadmap de Melhorias Futuras — Validador de Estágio IC/UFRJ

Este documento reúne as melhorias planejadas e as contingências documentadas para a plataforma.

## 1. Integração LDAP em produção

- Substituir o provider de autenticação local/seed pelo LDAP institucional da UFRJ.
- Campos esperados: `uid`, `cn`, `mail`, `departmentNumber` ou grupo da Comissão de Estágio.
- Variáveis de ambiente: `LDAP_HOST`, `LDAP_BIND_DN`, `LDAP_BASE_DN`, `LDAP_ENABLED=true`.

## 2. Integração com nuvem institucional (backup)

- **Objetivo:** redundância off-site do volume `./data` sem expor documentos brutos.
- **Opção A — Nextcloud do IC via WebDAV:**
  - Configurar `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_PASS`.
  - Rotina diária (`services/backup.py`) sincroniza `./data` via WebDAV.
- **Opção B — rclone:**
  - Perfil `rclone` apontando para S3/Nextcloud/Google Drive institucional.
  - Job cron/contab no host ou container sidecar.

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

- Exportação CSV/JSONL da fila, autorizações e auditoria.
- Métricas de tempo médio de análise e taxa de deferimento por semestre.
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
