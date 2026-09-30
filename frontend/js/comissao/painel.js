/**
 * Painel da Comissão: cards de métricas, Fila de Casos Regulares
 * (aprovação em 1 clique), Mesa de Revisão e histórico de auditoria.
 */

import { api } from '../api/client.js';
import { el, clearElement } from '../ui/dom.js';
import { abrirMesa } from './mesa.js';

let filaAtual = 'regular';

export function initPainel() {
  document.querySelectorAll('#view-comissao .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => ativarFila(btn.dataset.fila));
  });
  carregarPainel();
}

/**
 * Alterna a aba segmentada para a fila indicada ('regular' | 'revisao'),
 * fecha a mesa aberta e rola até a barra de filas.
 */
export function ativarFila(tipo) {
  filaAtual = tipo;
  document.querySelectorAll('#view-comissao .tab-btn').forEach((b) => {
    const ativo = b.dataset.fila === tipo;
    b.classList.toggle('active', ativo);
    b.setAttribute('aria-pressed', String(ativo));
  });
  document.getElementById('comissao-mesa').hidden = true;
  document.getElementById('comissao-fila').hidden = false;
  document
    .querySelector('#view-comissao .app-nav')
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  carregarFila();
}

/** Recarrega métricas, auditoria, autorizações e fila. */
export function carregarPainel() {
  carregarMetricas();
  carregarAuditoria();
  carregarAutorizacoes();
  carregarFila();
}

/* ============================================================
   Métricas agregadas
   ============================================================ */

async function carregarMetricas() {
  const container = document.getElementById('comissao-metricas');
  clearElement(container);

  let m;
  try {
    m = await api('/api/comissao/metricas');
  } catch {
    return;
  }

  atualizarBadges(m);

  const vencendo = m.autorizacoes_vencendo;

  // Chips do card "Pendentes": atalho direto para cada fila.
  const chipFila = (tipo, label, count) => {
    const chip = el('button', {
      className: 'seg-chip',
      type: 'button',
      title: `Abrir ${tipo === 'regular' ? 'Fila de Casos Regulares' : 'Mesa de Revisão'}`,
    }, `${label}: ${count}`);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      ativarFila(tipo);
    });
    return chip;
  };

  const cards = [
    {
      label: 'Solicitações recebidas',
      valor: `${m.total}`,
      detalhe: `no semestre ${m.semestre}: ${m.total_semestre}`,
    },
    { label: 'Deferidos', valor: `${m.deferidos}` },
    { label: 'Indeferidos', valor: `${m.indeferidos}` },
    {
      label: 'Pendentes',
      valor: `${m.pendentes}`,
      // Clique no card abre a fila com pendências (regular tem precedência).
      onClick: () => ativarFila(m.fila_regular > 0 ? 'regular' : 'revisao'),
      detalheNode: el('p', { className: 'text-muted metric-det' }, [
        chipFila('regular', 'regular', m.fila_regular),
        ' ',
        chipFila('revisao', 'mesa', m.mesa_revisao),
      ]),
    },
    {
      label: 'Autorizações a vencer',
      valor: `${vencendo}`,
      detalhe:
        `${m.autorizacoes_vigentes ?? m.deferidos} vigentes · ` +
        `validade ${m.validade_autorizacao_dias ?? 90}d · ` +
        `alerta ≤ ${m.janela_vencimento_dias ?? 30}d`,
      cls: vencendo > 0 ? 'metric-alerta' : '',
    },
    {
      label: 'Relatórios de estágio',
      valor: `${m.relatorios.entregues} entregues`,
      detalhe: `${m.relatorios.pendentes} pendentes no semestre`,
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
            (c.detalhe
              ? el('p', { className: 'text-muted metric-det' }, c.detalhe)
              : null),
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

function atualizarBadges(metricas) {
  const badges = {
    'badge-regular': metricas.fila_regular,
    'badge-revisao': metricas.mesa_revisao,
  };
  Object.entries(badges).forEach(([id, count]) => {
    const badge = document.getElementById(id);
    badge.hidden = !count;
    badge.textContent = count;
  });
}

/* ============================================================
   Histórico de auditoria (10 últimos eventos)
   ============================================================ */

const ACAO_LABEL = {
  login: 'Login',
  submissao_criada: 'Submissão recebida',
  acesso_pdf: 'Acesso ao PDF',
  decisao: 'Deliberação',
  expurgo_pdf: 'Expurgo de PDF',
  arquivamento: 'Arquivamento de logs',
};

async function carregarAuditoria() {
  const container = document.getElementById('comissao-auditoria');
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
          el('span', { className: 'audit-ts' },
            new Date(e.ts).toLocaleString('pt-BR')),
          el('span', { className: 'audit-ator' },
            `${e.ator}${e.papel ? ` (${e.papel})` : ''}`),
          el('span', { className: 'audit-acao' },
            ACAO_LABEL[e.acao] || e.acao),
          el('span', { className: 'text-muted' },
            e.entidade ? `${e.entidade} #${e.entidade_id ?? '—'}` : ''),
        ])
      )
    : [el('li', { className: 'text-muted' }, 'Nenhum evento registrado.')];

  container.appendChild(
    el('div', { className: 'card audit-card' }, [
      el('h3', { id: 'auditoria-titulo' }, 'Histórico de Ações'),
      el('p', { className: 'text-muted' },
        'Últimos eventos do registro transacional imutável. Deliberações e ' +
        'logs são retidos por 6 meses antes do arquivamento.'),
      el('ul', { className: 'audit-list' }, itens),
    ])
  );
}

/* ============================================================
   Autorizações (liberação + validade)
   ============================================================ */

const fmtData = (iso) =>
  iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';

async function carregarAutorizacoes() {
  const container = document.getElementById('comissao-autorizacoes');
  clearElement(container);

  let autorizacoes;
  try {
    ({ autorizacoes } = await api('/api/comissao/autorizacoes'));
  } catch {
    return;
  }

  const corpo = autorizacoes.length
    ? autorizacoes.map((a) =>
        el('tr', { className: a.status === 'expirada' ? 'row-expirada' : '' }, [
          el('td', {}, fmtData(a.liberadaEm)),
          el('td', {}, a.nome || '—'),
          el('td', {}, a.dre || '—'),
          el('td', {}, [
            el('span', {
              className: `badge ${a.status === 'vigente' ? 'badge-ap' : 'badge-reprovado'}`,
            }, a.status === 'vigente' ? 'Vigente' : 'Expirada'),
          ]),
          el('td', {},
            `${fmtData(a.validaAte)}` +
              (a.status === 'vigente' ? ` (${a.diasParaVencer}d)` : '')),
        ])
      )
    : [
        el('tr', {}, [
          el('td', { colspan: '5', className: 'text-muted' },
            'Nenhuma autorização emitida.'),
        ]),
      ];

  container.appendChild(
    el('div', { className: 'card audit-card' }, [
      el('h3', { id: 'autorizacoes-titulo' }, 'Autorizações de Estágio'),
      el('p', { className: 'text-muted' },
        'Liberações deferidas pela comissão. Validade: liberação + 90 dias.'),
      el('div', { className: 'table-container' }, [
        el('table', { className: 'triage-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col' }, 'Data da Liberação'),
              el('th', { scope: 'col' }, 'Nome do Aluno'),
              el('th', { scope: 'col' }, 'DRE'),
              el('th', { scope: 'col' }, 'Status'),
              el('th', { scope: 'col' }, 'Validade da Autorização'),
            ]),
          ]),
          el('tbody', {}, corpo),
        ]),
      ]),
    ])
  );
}

/* ============================================================
   Fila — tabela de triagem
   ============================================================ */

export async function carregarFila() {
  const container = document.getElementById('comissao-fila');
  clearElement(container);

  const { submissoes } = await api(`/api/comissao/fila?tipo=${filaAtual}`);

  if (!submissoes.length) {
    container.appendChild(
      el('div', { className: 'card' }, [
        el('p', { className: 'text-muted' },
          filaAtual === 'regular'
            ? 'Nenhum caso regular aguardando aprovação.'
            : 'Nenhum caso na Mesa de Revisão.'),
      ])
    );
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
            el('th', { scope: 'col' }, 'Ação Rápida'),
          ]),
        ]),
        el('tbody', {}, submissoes.map(renderLinha)),
      ]),
    ])
  );
}

function renderLinha(sub) {
  const { metadata, diagnostico, alertas, excecoes } = sub;
  const apto = diagnostico?.apto;
  const criterios = diagnostico?.criterios || [];
  const ok = criterios.filter((c) => c.ok).length;

  // Aprovação imediata: 100% apto, sem exceções declaradas nem alertas
  // de saneamento — o caso regular dispensa conferência manual.
  const aprovacaoImediata =
    filaAtual === 'regular' && apto && !excecoes?.length && !alertas?.length;

  const acoes = el('td', { className: 'actions-row' });
  if (aprovacaoImediata) {
    const btnDeferir = el('button', {
      className: 'btn btn-primary btn-sm',
      type: 'button',
      title: 'Deferir em 1 clique',
    }, 'Deferir');
    btnDeferir.addEventListener('click', async () => {
      btnDeferir.disabled = true;
      try {
        await api(`/api/comissao/submissoes/${sub.id}/decisao`, {
          method: 'POST',
          body: { decisao: 'aprovada' },
        });
        carregarPainel();
      } catch (err) {
        alert(err.message);
        btnDeferir.disabled = false;
      }
    });
    acoes.appendChild(btnDeferir);
  }

  const btnRevisar = el('button', {
    className: 'btn btn-secondary btn-sm',
    type: 'button',
  }, 'Revisar');
  btnRevisar.addEventListener('click', () => abrirMesa(sub.id));
  acoes.appendChild(btnRevisar);

  const statusCell = el('td', {}, [
    aprovacaoImediata
      ? el('span', { className: 'badge badge-ap' }, 'Apto — aprovação imediata')
      : el('span', {
          className: `badge ${apto ? 'badge-cursando' : 'badge-neutro'}`,
        }, apto ? 'Apto' : 'Pendências'),
    excecoes?.length
      ? el('span', { className: 'badge badge-neutro' },
          `${excecoes.length} exceção(ões)`)
      : null,
    alertas?.length
      ? el('span', { className: 'badge badge-reprovado' },
          `${alertas.length} alerta(s)`)
      : null,
  ]);

  return el('tr', { className: aprovacaoImediata ? 'triage-ok' : '' }, [
    el('td', {}, [
      el('strong', {}, metadata?.nome || 'Nome não identificado'),
      el('br'),
      el('span', { className: 'text-muted' },
        `enviado em ${fmtData(sub.criadoEm)}`),
    ]),
    el('td', {}, metadata?.dre || '—'),
    el('td', {}, metadata?.curso || '—'),
    el('td', {},
      criterios.length ? `${ok}/${criterios.length} critérios` : '—'),
    statusCell,
    acoes,
  ]);
}
