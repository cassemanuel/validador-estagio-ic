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

/** Recarrega métricas, auditoria e fila — após decisões ou na abertura. */
export function carregarPainel() {
  carregarMetricas();
  carregarAuditoria();
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
      detalhe: `fim do período ${m.fim_periodo} (${m.dias_para_fim_periodo}d)`,
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
   Fila
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

  const lista = el('div', { className: 'fila-list' },
    submissoes.map(renderCard));
  container.appendChild(lista);
}

function renderCard(sub) {
  const { metadata, diagnostico, alertas, excecoes } = sub;
  const apto = diagnostico?.apto;

  const meta = el('div', { className: 'fila-meta' }, [
    el('strong', {}, metadata?.nome || 'Nome não identificado'),
    el('span', { className: 'text-muted' },
      `DRE ${metadata?.dre || '—'} · ${sub.tipoDocumento || 'doc.'} · ` +
      `enviado em ${new Date(sub.criadoEm).toLocaleDateString('pt-BR')}`),
    el('span', { className: 'text-muted' },
        diagnostico?.criterios?.length
        ? diagnostico.criterios.map((c) => `${c.ok ? '✓' : '✗'} ${c.rotulo}`).join(' · ')
        : ''),
  ]);

  const badges = el('div', { className: 'fila-badges' }, [
    el('span', { className: `badge ${apto ? 'badge-ap' : 'badge-cursando'}` },
      apto ? 'Apto' : 'Pendente'),
    excecoes?.length
      ? el('span', { className: 'badge badge-neutro' },
          `${excecoes.length} exceção(ões)`)
      : null,
    alertas?.length
      ? el('span', { className: 'badge badge-reprovado' },
          `${alertas.length} alerta(s)`)
      : null,
  ]);

  const acoes = el('div', { className: 'actions-row' });

  if (filaAtual === 'regular' && apto) {
    const btnAprovar = el('button', {
      className: 'btn btn-primary btn-sm',
      type: 'button',
    }, 'Aprovar');
    btnAprovar.addEventListener('click', async () => {
      if (!confirm(`Aprovar a submissão de ${metadata?.nome || 'este discente'}?`)) {
        return;
      }
      btnAprovar.disabled = true;
      try {
        await api(`/api/comissao/submissoes/${sub.id}/decisao`, {
          method: 'POST',
          body: { decisao: 'aprovada' },
        });
        carregarPainel();
      } catch (err) {
        alert(err.message);
        btnAprovar.disabled = false;
      }
    });
    acoes.appendChild(btnAprovar);
  }

  const btnRevisar = el('button', {
    className: 'btn btn-secondary btn-sm',
    type: 'button',
  }, 'Revisar');
  btnRevisar.addEventListener('click', () => abrirMesa(sub.id));
  acoes.appendChild(btnRevisar);

  return el('div', { className: 'card fila-card' }, [
    el('div', { className: 'fila-info' }, [meta, badges]),
    acoes,
  ]);
}
