/**
 * Mesa de Revisão: split-screen com o PDF original à esquerda e os dados
 * extraídos/declarados + exceções + deliberação à direita.
 */

import { api } from '../api/client.js';
import {
  el,
  badgeClassForSituacao,
  clearElement,
  formatNumberBR,
} from '../ui/dom.js';
import { carregarPainel } from './painel.js';

const TIPO_EXCECAO = {
  equivalencia: 'Equivalência',
  aproveitamento: 'Aproveitamento',
  dispensa: 'Dispensa',
};

export async function abrirMesa(subId) {
  const mesa = document.getElementById('comissao-mesa');
  const fila = document.getElementById('comissao-fila');
  clearElement(mesa);
  mesa.hidden = false;
  fila.hidden = true;

  let sub;
  try {
    sub = await api(`/api/comissao/submissoes/${subId}`);
  } catch (err) {
    mesa.appendChild(el('div', { className: 'card' },
      el('p', { className: 'text-muted' }, err.message)));
    return;
  }

  mesa.appendChild(
    el('div', { className: 'mesa' }, [
      renderLadoPdf(sub),
      renderLadoDados(sub),
    ])
  );
}

/* ============================================================
   Lado esquerdo: PDF original
   ============================================================ */

function renderLadoPdf(sub) {
  const iframe = el('iframe', {
    className: 'mesa-pdf',
    src: `/api/comissao/submissoes/${sub.id}/pdf`,
    title: 'PDF original submetido pelo discente',
  });

  const conteudo = sub.pdfDisponivel
    ? iframe
    : el('div', { className: 'card' },
        el('p', { className: 'text-muted' },
          'PDF expurgado por política de retenção (LGPD).'));

  return el('div', { className: 'mesa-col' }, [
    el('h3', {}, 'Documento original'),
    sub.pdfSha256
      ? el('p', { className: 'text-muted mesa-hash' },
          `sha256: ${sub.pdfSha256.slice(0, 24)}…`)
      : null,
    conteudo,
  ]);
}

/* ============================================================
   Lado direito: dados extraídos + exceções + deliberação
   ============================================================ */

function renderLadoDados(sub) {
  const col = el('div', { className: 'mesa-col' }, [el('h3', {}, 'Dados extraídos')]);

  const { metadata, diagnostico, alertas } = sub;

  col.appendChild(
    el('div', { className: 'card' },
      [
        ['Nome', metadata?.nome],
        ['DRE', metadata?.dre],
        ['Curso', metadata?.curso],
        ['Ingresso', metadata?.ingresso],
        ['Documento', sub.tipoDocumento],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => el('p', {}, [el('strong', {}, `${k}: `), String(v)]))
    )
  );

  if (alertas?.length) {
    col.appendChild(
      el('div', { className: 'card card-aviso' }, [
        el('h4', {}, 'Alertas de saneamento'),
        el('ul', { className: 'estagio-criterios' },
          alertas.map((a) =>
            el('li', { className: 'criterio-falta' }, [
              el('i', { className: 'bi bi-exclamation-circle', 'aria-hidden': 'true' }),
              el('span', {}, ` ${a}`),
            ])
          )),
      ])
    );
  }

  if (diagnostico?.criterios?.length) {
    col.appendChild(
      el('div', { className: 'card' }, [
        el('h4', {}, 'Diagnóstico (declarado × recalculado)'),
        el('ul', { className: 'estagio-criterios' },
          diagnostico.criterios.map((c) =>
            el('li', { className: c.ok ? 'criterio-ok' : 'criterio-falta' }, [
              el('i', {
                className: `bi ${c.ok ? 'bi-check-circle-fill' : 'bi-exclamation-circle'}`,
                'aria-hidden': 'true',
              }),
              el('span', {}, ` ${c.rotulo} — ${c.detalhe}`),
            ])
          )),
      ])
    );
  }

  col.appendChild(renderExcecoes(sub));
  col.appendChild(renderTabelaDisciplinas(sub));
  col.appendChild(renderDeliberacao(sub));

  return col;
}

function renderExcecoes(sub) {
  if (!sub.excecoes?.length) {
    return el('div', { className: 'card' },
      el('p', { className: 'text-muted' }, 'Nenhuma exceção declarada.'));
  }

  const itens = sub.excecoes.map((e) => {
    const radios = el('div', { className: 'actions-row' }, [
      radioExcecao(e.id, 'aceita', 'Aceitar'),
      radioExcecao(e.id, 'recusada', 'Recusar'),
    ]);
    return el('li', { className: 'mesa-excecao' }, [
      el('p', {}, [
        el('strong', {},
          `${TIPO_EXCECAO[e.tipo] || e.tipo} de ${e.codigoRequisito}`),
        e.codigoCursada ? ` por ${e.codigoCursada}` : '',
      ]),
      el('p', { className: 'text-muted' }, e.justificativa),
      radios,
    ]);
  });

  return el('div', { className: 'card' }, [
    el('h4', {}, 'Exceções declaradas'),
    el('ul', { className: 'estagio-criterios' }, itens),
    el('p', { className: 'text-muted' },
      'Sem marcação, a exceção permanece pendente.'),
  ]);
}

function radioExcecao(excId, valor, rotulo) {
  const input = el('input', {
    type: 'radio',
    name: `exc-${excId}`,
    value: valor,
    dataset: { excId: String(excId), status: valor },
  });
  return el('label', { className: 'radio-inline' }, [input, ` ${rotulo}`]);
}

function renderTabelaDisciplinas(sub) {
  const rows = [];
  (sub.periodos || []).forEach((p) => {
    (p.disciplinas || []).forEach((d) => {
      rows.push(
        el('tr', {}, [
          el('td', {}, p.periodo || '—'),
          el('td', {}, d.codigo),
          el('td', {}, d.nome),
          el('td', {}, formatNumberBR(d.crR, 1)),
          el('td', {}, d.grau != null ? formatNumberBR(d.grau, 1) : '—'),
          el('td', {}, [
            el('span', { className: `badge ${badgeClassForSituacao(d.situacao)}` },
              d.situacao),
          ]),
        ])
      );
    });
  });

  return el('div', { className: 'card' }, [
    el('h4', {}, `Disciplinas (${rows.length})`),
    el('div', { className: 'table-container mesa-tabela' }, [
      el('table', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col' }, 'Período'),
            el('th', { scope: 'col' }, 'Código'),
            el('th', { scope: 'col' }, 'Disciplina'),
            el('th', { scope: 'col' }, 'CrR'),
            el('th', { scope: 'col' }, 'Grau'),
            el('th', { scope: 'col' }, 'SF'),
          ]),
        ]),
        el('tbody', {}, rows),
      ]),
    ]),
  ]);
}

function renderDeliberacao(sub) {
  const motivo = el('textarea', {
    placeholder: 'Motivo da deliberação (obrigatório para indeferir/devolver)',
    rows: '3',
  });
  const erro = el('p', { className: 'login-erro', role: 'alert', hidden: true });

  const coletarDecisoesExcecoes = () =>
    [...document.querySelectorAll(`input[data-exc-id]:checked`)].map((i) => ({
      id: Number(i.dataset.excId),
      status: i.dataset.status,
    }));

  const decidir = async (decisao) => {
    if (decisao !== 'aprovada' && !motivo.value.trim()) {
      erro.textContent = 'Informe o motivo para indeferir ou devolver.';
      erro.hidden = false;
      return;
    }
    try {
      await api(`/api/comissao/submissoes/${sub.id}/decisao`, {
        method: 'POST',
        body: {
          decisao,
          motivo: motivo.value.trim() || null,
          excecoes: coletarDecisoesExcecoes(),
        },
      });
      voltarParaFila();
    } catch (err) {
      erro.textContent = err.message;
      erro.hidden = false;
    }
  };

  const voltar = el('button', {
    className: 'btn btn-secondary', type: 'button',
  }, '← Voltar à fila');
  voltar.addEventListener('click', voltarParaFila);

  const botoes = el('div', { className: 'actions-row' }, [
    botaoDecisao('Aprovar', 'btn-primary', () => decidir('aprovada')),
    botaoDecisao('Indeferir', 'btn-danger', () => decidir('indeferida')),
    botaoDecisao('Devolver', 'btn-secondary', () => decidir('devolvida')),
  ]);

  return el('div', { className: 'card' }, [
    el('h4', {}, 'Deliberação'),
    motivo,
    erro,
    botoes,
    voltar,
  ]);
}

function botaoDecisao(rotulo, classe, onClick) {
  const btn = el('button', { className: `btn ${classe}`, type: 'button' }, rotulo);
  btn.addEventListener('click', onClick);
  return btn;
}

function voltarParaFila() {
  document.getElementById('comissao-mesa').hidden = true;
  const fila = document.getElementById('comissao-fila');
  fila.hidden = false;
  carregarPainel();
}
