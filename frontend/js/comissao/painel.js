/**
 * Painel administrativo da Comissão: 4 views dedicadas.
 *
 *   /admin/dashboard      → Dashboard Geral (métricas + auditoria + alertas)
 *   /admin/fila           → Fila de Triagem (tabela unificada, busca, paginação)
 *   /admin/mesa           → Mesa de Análise Individual (selecionada a partir da fila)
 *   /admin/autorizacoes   → Autorizações e Deferimentos
 */

import { api } from '../api/client.js';
import { el, clearElement, formatNumberBR } from '../ui/dom.js';
import { navegarPara } from '../router.js';
import { abrirMesa } from './mesa.js';

let filaParams = { tipo: 'todos', status: 'todos', q: '', offset: 0, limite: 25 };
let filaCarregando = false;
let dashboardAno = '';
let autorizacoesAno = '';

const ACAO_LABEL = {
  login: 'Login',
  submissao_criada: 'Submissão recebida',
  acesso_pdf: 'Acesso ao Boletim',
  acesso_boletim: 'Acesso ao Boletim',
  acesso_boa: 'Acesso ao BOA',
  decisao: 'Deliberação',
  expurgo_pdfs: 'Expurgo de PDFs',
  arquivamento: 'Arquivamento de logs',
  processo_arquivado: 'Processo arquivado',
};

const fmtData = (iso) =>
  iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';

export function initPainel(viewAtual = 'view-admin-dashboard') {
  initFilaTabs();
  initBuscaFila();
  initFiltrosAno();
  carregarPainel(viewAtual);
}

function initFiltrosAno() {
  const dash = document.getElementById('dashboard-ano');
  if (dash && !dash.dataset.bound) {
    dash.dataset.bound = '1';
    dash.addEventListener('change', () => {
      dashboardAno = dash.value;
      carregarMetricas();
    });
  }
  const aut = document.getElementById('autorizacoes-ano');
  if (aut && !aut.dataset.bound) {
    aut.dataset.bound = '1';
    aut.addEventListener('change', () => {
      autorizacoesAno = aut.value;
      carregarAutorizacoes();
    });
  }
}

function preencherAnos(selectEl, anos, selecionado) {
  if (!selectEl) return;
  const lista = anos || [];
  clearElement(selectEl);
  selectEl.appendChild(el('option', { value: '' }, 'Todos os anos'));
  lista.forEach((a) =>
    selectEl.appendChild(el('option', { value: String(a) }, String(a))));
  selectEl.value = selecionado && lista.includes(Number(selecionado))
    ? selecionado
    : '';
}

export async function carregarPainel(viewAtual) {
  if (viewAtual === 'view-admin-dashboard') {
    await Promise.all([carregarMetricas(), carregarAuditoriaDashboard()]);
  }
  if (viewAtual === 'view-admin-fila') await carregarFila();
  if (viewAtual === 'view-admin-mesa') {
    const mesa = document.getElementById('admin-mesa');
    const params = new URLSearchParams(window.location.search);
    const subId = Number(params.get('id'));
    if (subId) {
      await abrirMesa(subId, params.get('doc') || 'boletim');
    } else if (!mesa.firstChild) {
      clearElement(mesa);
      mesa.appendChild(el('div', { className: 'card' }, [
        el('p', { className: 'text-muted' }, 'Selecione um processo na Fila para abrir a mesa de análise.'),
      ]));
    }
  }
  if (viewAtual === 'view-admin-autorizacoes') await carregarAutorizacoes();
}

/* ============================================================
   Dashboard Geral
   ============================================================ */

async function carregarMetricas() {
  const container = document.getElementById('admin-metricas');
  clearElement(container);

  let m;
  try {
    m = await api(`/api/comissao/metricas${dashboardAno ? `?ano=${dashboardAno}` : ''}`);
  } catch {
    return;
  }
  preencherAnos(document.getElementById('dashboard-ano'), m.anos, dashboardAno);

  const chipFila = (tipo, label, count) => {
    const chip = el('button', {
      className: 'seg-chip', type: 'button',
      title: `Abrir ${tipo === 'regular' ? 'Fila de Casos Regulares' : 'Mesa de Revisão'}`,
    }, `${label}: ${count}`);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      navegarPara('/admin/fila');
    });
    return chip;
  };

  const vencendo = m.autorizacoes_vencendo || 0;
  const cards = [
    {
      label: 'Solicitações recebidas',
      valor: `${m.total || 0}`,
      detalhe: `no semestre ${m.semestre || ''}: ${m.total_semestre || 0}`,
    },
    { label: 'Deferidos', valor: `${m.deferidos || 0}` },
    { label: 'Indeferidos', valor: `${m.indeferidos || 0}` },
    {
      label: 'Pendentes',
      valor: `${m.pendentes || 0}`,
      onClick: () => navegarPara('/admin/fila'),
      detalheNode: el('p', { className: 'text-muted metric-det' }, [
        chipFila('regular', 'regular', m.fila_regular || 0), ' ',
        chipFila('revisao', 'mesa', m.mesa_revisao || 0),
      ]),
    },
    {
      label: 'Autorizações a vencer',
      valor: `${vencendo}`,
      detalhe: `${m.autorizacoes_vigentes || m.deferidos || 0} vigentes · validade ${m.validade_autorizacao_dias || 90}d · alerta ≤ ${m.janela_vencimento_dias || 30}d`,
      cls: vencendo > 0 ? 'metric-alerta' : '',
      onClick: () => navegarPara('/admin/autorizacoes'),
    },
    {
      label: 'Relatórios de estágio',
      valor: `${(m.relatorios && m.relatorios.entregues) || 0} entregues`,
      detalhe: `${(m.relatorios && m.relatorios.pendentes) || 0} pendentes no semestre`,
    },
  ];

  container.appendChild(
    el('div', { className: 'cards-grid metricas-grid' },
      cards.map((c) => {
        const attrs = {
          className: `card metric-card ${c.cls || ''} ${c.onClick ? 'metric-clicavel' : ''}`,
        };
        if (c.onClick) {
          attrs.role = 'button';
          attrs.tabindex = '0';
        }
        const card = el('div', attrs, [
          el('span', { className: 'cr-detail-label' }, c.label),
          el('p', { className: 'metric-value' }, c.valor),
          c.detalheNode ||
            (c.detalhe ? el('p', { className: 'text-muted metric-det' }, c.detalhe) : null),
        ]);
        if (c.onClick) {
          card.addEventListener('click', c.onClick);
          card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              c.onClick();
            }
          });
        }
        return card;
      }))
  );
}

async function carregarAuditoriaDashboard() {
  const container = document.getElementById('admin-auditoria-card');
  clearElement(container);

  let eventos;
  try {
    ({ eventos } = await api('/api/comissao/auditoria?limite=10'));
  } catch {
    return;
  }

  const itens = eventos.length
    ? eventos.map((e) =>
        el('li', { className: 'audit-item' }, [
          el('span', { className: 'audit-ts' }, fmtData(e.ts)),
          el('span', { className: 'audit-ator' }, `${e.ator}${e.papel ? ` (${e.papel})` : ''}`),
          el('span', { className: 'audit-acao' }, ACAO_LABEL[e.acao] || e.acao),
        ])
      )
    : [el('li', { className: 'text-muted' }, 'Nenhum evento registrado.')];

  container.appendChild(el('h3', {}, 'Auditoria Recente'));
  container.appendChild(el('p', { className: 'text-muted' }, 'Últimos eventos do registro imutável. Logs são retidos por 6 meses.'));
  container.appendChild(el('ul', { className: 'audit-list' }, itens));
}

/* ============================================================
   Fila de Triagem (tabela unificada, busca, paginação)
   ============================================================ */

const STATUS_POR_TIPO = {
  regular: 'fila_regular',
  revisao: 'mesa_revisao',
  todos: 'todos',
};

function initFilaTabs() {
  document.querySelectorAll('#view-admin-fila .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tipo = btn.dataset.fila;
      const status = STATUS_POR_TIPO[tipo] || 'todos';
      filaParams = { ...filaParams, tipo, status, offset: 0 };
      const statusSelect = document.getElementById('fila-status');
      if (statusSelect) statusSelect.value = status;
      atualizarTabsFila(tipo);
      carregarFila();
    });
  });
  const statusSelect = document.getElementById('fila-status');
  if (statusSelect) {
    statusSelect.addEventListener('change', () => {
      const status = statusSelect.value;
      const tipo = status === 'fila_regular' ? 'regular'
        : status === 'mesa_revisao' ? 'revisao'
        : 'todos';
      filaParams = { ...filaParams, tipo, status, offset: 0 };
      atualizarTabsFila(tipo);
      carregarFila();
    });
  }
}

function atualizarTabsFila(tipo) {
  document.querySelectorAll('#view-admin-fila .tab-btn').forEach((b) => {
    const ativo = b.dataset.fila === tipo;
    b.classList.toggle('active', ativo);
    b.setAttribute('aria-pressed', String(ativo));
  });
}

function initBuscaFila() {
  const input = document.getElementById('fila-busca');
  if (!input) return;
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      filaParams = { ...filaParams, q: input.value.trim(), offset: 0 };
      carregarFila();
    }, 300);
  });
}

export async function carregarFila() {
  if (filaCarregando) return;
  filaCarregando = true;

  const container = document.getElementById('admin-fila');
  const paginacao = document.getElementById('admin-paginacao');
  clearElement(container);
  clearElement(paginacao);
  atualizarTabsFila(filaParams.tipo);

  const statusSelect = document.getElementById('fila-status');
  if (statusSelect) statusSelect.value = filaParams.status;

  const query = new URLSearchParams({
    tipo: filaParams.tipo,
    status: filaParams.status,
    q: filaParams.q,
    offset: String(filaParams.offset),
    limite: String(filaParams.limite),
  });

  let resp;
  try {
    resp = await api(`/api/comissao/fila?${query.toString()}`);
  } catch (err) {
    container.appendChild(el('div', { className: 'card' }, [
      el('p', { className: 'text-muted' }, err.message || 'Erro ao carregar fila.'),
    ]));
    filaCarregando = false;
    return;
  }

  if (!resp.submissoes.length) {
    container.appendChild(el('div', { className: 'card' }, [
      el('p', { className: 'text-muted' }, 'Nenhum processo encontrado.'),
    ]));
    filaCarregando = false;
    return;
  }

  container.appendChild(
    el('div', { className: 'card table-container' }, [
      el('table', { className: 'triage-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col' }, 'Nome'),
            el('th', { scope: 'col' }, 'DRE'),
            el('th', { scope: 'col' }, 'Curso'),
            el('th', { scope: 'col' }, 'Critérios'),
            el('th', { scope: 'col' }, 'Status'),
            el('th', { scope: 'col' }, 'Boletim'),
            el('th', { scope: 'col' }, 'BOA'),
          ]),
        ]),
        el('tbody', {}, resp.submissoes.map((s) => renderLinha(s))),
      ]),
    ])
  );

  renderPaginacao(resp.total, paginacao);
  filaCarregando = false;
}

function renderLinha(sub) {
  const { metadata, diagnostico, alertas, excecoes, documentos } = sub;
  const apto = diagnostico?.apto;
  const criterios = diagnostico?.criterios || [];
  const ok = criterios.filter((c) => c.ok).length;
  const aprovacaoImediata =
    sub.status === 'fila_regular' && apto && !excecoes?.length && !alertas?.length;

  const linkDoc = (tipo, label) => {
    const btn = el('button', {
      className: 'btn btn-secondary btn-sm doc-link',
      type: 'button',
    }, label);
    btn.addEventListener('click', () =>
      navegarPara(`/admin/mesa?id=${sub.id}&doc=${tipo}`));
    return btn;
  };

  const statusLabel = {
    fila_regular: 'Aguardando Análise',
    mesa_revisao: 'Aguardando Análise',
    aprovada: 'Aprovado',
    indeferida: 'Indeferido',
    cancelada: 'Cancelado',
    revogada: 'Revogado',
    devolvida: 'Devolvido',
    arquivada: 'Arquivado',
  };
  const statusClass = {
    fila_regular: 'badge-cursando',
    mesa_revisao: 'badge-cursando',
    aprovada: 'badge-ap',
    indeferida: 'badge-reprovado',
    cancelada: 'badge-neutro',
    revogada: 'badge-neutro',
    devolvida: 'badge-neutro',
    arquivada: 'badge-neutro',
  };
  const statusCell = el('td', {}, [
    el('span', { className: `badge ${statusClass[sub.status] || 'badge-neutro'}` },
      statusLabel[sub.status] || sub.status),
    aprovacaoImediata ? el('span', { className: 'badge badge-ap' }, 'Aprovação imediata') : null,
    excecoes?.length ? el('span', { className: 'badge badge-neutro' }, `${excecoes.length} exceção(ões)`) : null,
    alertas?.length ? el('span', { className: 'badge badge-reprovado' }, `${alertas.length} alerta(s)`) : null,
  ]);

  return el('tr', { className: aprovacaoImediata ? 'triage-ok' : '' }, [
    el('td', {}, [
      el('strong', {}, metadata?.nome || 'Nome não identificado'),
      el('br'),
      el('span', { className: 'text-muted' }, `enviado em ${fmtData(sub.criadoEm)}`),
    ]),
    el('td', {}, metadata?.dre || '—'),
    el('td', {}, metadata?.curso || '—'),
    el('td', {}, criterios.length ? `${ok}/${criterios.length}` : '—'),
    statusCell,
    el('td', {}, linkDoc('boletim', 'Ver Boletim')),
    el('td', {}, linkDoc('boa', 'Ver BOA')),
  ]);
}

function renderPaginacao(total, container) {
  if (total <= filaParams.limite) return;
  const paginas = Math.ceil(total / filaParams.limite);
  const atual = Math.floor(filaParams.offset / filaParams.limite);

  const botoes = [];
  for (let i = 0; i < paginas; i++) {
    const btn = el('button', {
      className: `btn btn-sm ${i === atual ? 'btn-primary' : 'btn-secondary'}`,
      type: 'button',
    }, String(i + 1));
    btn.addEventListener('click', () => {
      filaParams = { ...filaParams, offset: i * filaParams.limite };
      carregarFila();
    });
    botoes.push(btn);
  }

  container.appendChild(
    el('div', { className: 'paginacao' }, [
      el('span', { className: 'text-muted' }, `${total} processo(s)`),
      ...botoes,
    ])
  );
}

/* ============================================================
   Autorizações
   ============================================================ */

async function carregarAutorizacoes() {
  const container = document.getElementById('admin-autorizacoes');
  clearElement(container);

  let resp;
  try {
    resp = await api(`/api/comissao/autorizacoes${autorizacoesAno ? `?ano=${autorizacoesAno}` : ''}`);
  } catch {
    return;
  }
  const { autorizacoes } = resp;
  preencherAnos(
    document.getElementById('autorizacoes-ano'), resp.anos, autorizacoesAno
  );

  const corpo = autorizacoes.length
    ? autorizacoes.map((a) => {
        const btnRevogar = a.status === 'vigente'
          ? el('button', { className: 'btn btn-danger btn-sm', type: 'button' }, 'Revogar')
          : null;
        if (btnRevogar) {
          btnRevogar.addEventListener('click', async () => {
            const motivo = window.prompt('Motivo da revogação:');
            if (!motivo) return;
            try {
              await api(`/api/comissao/submissoes/${a.id}/revogar`, {
                method: 'POST',
                body: { motivo },
              });
              await carregarAutorizacoes();
            } catch (err) {
              alert(err.message);
            }
          });
        }
        return el('tr', { className: a.status === 'expirada' ? 'row-expirada' : '' }, [
          el('td', {}, fmtData(a.liberadaEm)),
          el('td', {}, a.nome || '—'),
          el('td', {}, a.dre || '—'),
          el('td', {}, [
            el('span', {
              className: `badge ${a.status === 'vigente' ? 'badge-ap' : 'badge-reprovado'}`,
            }, a.status === 'vigente' ? 'Vigente' : 'Expirada'),
          ]),
          el('td', {},
            `${fmtData(a.validaAte)}` + (a.status === 'vigente' ? ` (${a.diasParaVencer}d)` : '')),
          el('td', {}, btnRevogar || '—'),
        ]);
      })
    : [el('tr', {}, [el('td', { colspan: '6', className: 'text-muted' }, 'Nenhuma autorização emitida.')])];

  container.appendChild(
    el('div', { className: 'card table-container' }, [
      el('table', { className: 'triage-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col' }, 'Data da Liberação'),
            el('th', { scope: 'col' }, 'Nome do Aluno'),
            el('th', { scope: 'col' }, 'DRE'),
            el('th', { scope: 'col' }, 'Status'),
            el('th', { scope: 'col' }, 'Validade'),
            el('th', { scope: 'col' }, 'Ação'),
          ]),
        ]),
        el('tbody', {}, corpo),
      ]),
    ])
  );
}
