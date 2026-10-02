/**
 * Mesa de Análise Individual: split-screen com abas para alternar entre
 * Boletim e BOA, lado a lado com dados extraídos, exceções declaradas e
 * histórico de CR.
 */

import { api } from '../api/client.js';
import {
  el,
  badgeClassForSituacao,
  clearElement,
  formatNumberBR,
} from '../ui/dom.js';
import { calcularCRAcumulado } from '../domain/cr.js';
import { carregarPainel } from './painel.js';
import { navegarPara } from '../router.js';

const TIPO_EXCECAO = {
  equivalencia: 'Equivalência',
  aproveitamento: 'Aproveitamento',
  dispensa: 'Dispensa',
};

export async function abrirMesa(subId, onNavegar) {
  const mesa = document.getElementById('admin-mesa');
  const container = document.getElementById('view-admin-mesa');
  clearElement(mesa);

  let sub;
  try {
    sub = await api(`/api/comissao/submissoes/${subId}`);
  } catch (err) {
    mesa.appendChild(el('div', { className: 'card' },
      el('p', { className: 'text-muted' }, err.message)));
    if (onNavegar) onNavegar();
    return;
  }

  const voltar = el('button', { className: 'btn btn-secondary btn-sm', type: 'button' }, '← Voltar à fila');
  voltar.addEventListener('click', () => navegarPara('/admin/fila'));

  const header = el('div', { className: 'admin-header' }, [
    el('div', {}, [
      el('h2', {}, sub.metadata?.nome || `Processo #${sub.id}`),
      el('p', { className: 'text-muted' },
        `DRE ${sub.metadata?.dre || '—'} · ${sub.metadata?.curso || '—'} · ${sub.tipoDocumento || '—'}`),
    ]),
    voltar,
  ]);

  mesa.appendChild(header);
  mesa.appendChild(el('div', { className: 'mesa' }, [
    renderLadoPdf(sub),
    renderLadoDados(sub),
  ]));

  if (onNavegar) onNavegar();
}

function renderLadoPdf(sub) {
  const docs = sub.documentos || {};
  const [abaAtiva, setAbaAtiva] = useState('boletim');

  const tabs = el('div', { className: 'app-nav segmented' });
  const conteudo = el('div', { className: 'mesa-pdf-wrap' });

  const renderAba = (nome) => {
    clearElement(conteudo);
    const doc = docs[nome];
    if (!doc?.disponivel) {
      conteudo.appendChild(el('div', { className: 'card' }, [
        el('p', { className: 'text-muted' },
          `${nome.toUpperCase()} indisponível ou expurgado por política de retenção.`),
      ]));
      return;
    }
    conteudo.appendChild(el('iframe', {
      className: 'mesa-pdf',
      src: doc.url,
      title: `PDF ${nome.toUpperCase()} submetido pelo discente`,
    }));
  };

  ['boletim', 'boa'].forEach((nome) => {
    const btn = el('button', {
      className: `tab-btn ${abaAtiva() === nome ? 'active' : ''}`,
      type: 'button',
      'aria-pressed': String(abaAtiva() === nome),
    }, nome === 'boletim' ? 'Boletim' : 'BOA');
    btn.addEventListener('click', () => {
      setAbaAtiva(nome);
      [...tabs.children].forEach((b) => {
        const ativo = b === btn;
        b.classList.toggle('active', ativo);
        b.setAttribute('aria-pressed', String(ativo));
      });
      renderAba(nome);
    });
    tabs.appendChild(btn);
  });

  renderAba(abaAtiva());

  const sha256 = docs.boletim?.sha256 || sub.pdfSha256;
  return el('div', { className: 'mesa-col' }, [
    el('h3', {}, 'Documentos originais'),
    sha256 ? el('p', { className: 'text-muted mesa-hash' },
      `sha256 boletim: ${sha256.slice(0, 24)}…`) : null,
    tabs,
    conteudo,
  ]);
}

function useState(initial) {
  let value = initial;
  return [() => value, (v) => { value = v; }];
}

function renderLadoDados(sub) {
  const col = el('div', { className: 'mesa-col' }, [el('h3', {}, 'Dados extraídos')]);
  const { metadata, diagnostico, alertas, periodos } = sub;

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
        .map(([k, v]) => el('p', {}, [el('strong', {}, `${k}: `), String(v)])))
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
        el('h4', {}, 'Diagnóstico'),
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

  col.appendChild(renderEvolucaoCR(periodos));
  col.appendChild(renderExcecoes(sub));
  col.appendChild(renderTabelaDisciplinas(sub));
  col.appendChild(renderDeliberacao(sub));

  return col;
}

function renderEvolucaoCR(periodos) {
  const periodosValidos = (periodos || [])
    .filter((p) => String(p.periodo).match(/^\d{4}\/\d$/));
  const cards = periodosValidos.map((p) => {
    const disciplinas = p.disciplinas || [];
    const { crCalculado } = calcularCRAcumulado({ periodos: [p] });
    return el('div', { className: 'metric-card' }, [
      el('div', { className: 'metric-label' }, `Período ${p.periodo}`),
      el('div', { className: 'metric-value' }, formatNumberBR(crCalculado, 3)),
      el('div', { className: 'metric-sublabel' }, `${disciplinas.length} disciplinas`),
    ]);
  });

  return el('div', { className: 'card' }, [
    el('h4', {}, 'Evolução do CR por Período'),
    cards.length
      ? el('div', { className: 'metrics-grid mini' }, cards)
      : el('p', { className: 'text-muted' }, 'Sem dados de evolução por período.'),
  ]);
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
        el('strong', {}, `${TIPO_EXCECAO[e.tipo] || e.tipo} de ${e.codigoRequisito}`),
        e.codigoCursada ? ` por ${e.codigoCursada}` : '',
      ]),
      el('p', { className: 'text-muted' }, e.justificativa),
      radios,
    ]);
  });

  return el('div', { className: 'card' }, [
    el('h4', {}, 'Exceções declaradas'),
    el('ul', { className: 'estagio-criterios' }, itens),
    el('p', { className: 'text-muted' }, 'Sem marcação, a exceção permanece pendente.'),
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
            el('span', { className: `badge ${badgeClassForSituacao(d.situacao)}` }, d.situacao),
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
    [...document.querySelectorAll('input[data-exc-id]:checked')].map((i) => ({
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
      navegarPara('/admin/fila');
    } catch (err) {
      erro.textContent = err.message;
      erro.hidden = false;
    }
  };

  const botoes = el('div', { className: 'actions-row' }, []);
  const criarBotao = (label, classe, decisao) => {
    const btn = el('button', { className: `btn ${classe}`, type: 'button' }, label);
    btn.addEventListener('click', () => decidir(decisao));
    return btn;
  };
  botoes.appendChild(criarBotao('Aprovar', 'btn-primary', 'aprovada'));
  botoes.appendChild(criarBotao('Indeferir', 'btn-danger', 'indeferida'));
  botoes.appendChild(criarBotao('Devolver', 'btn-secondary', 'devolvida'));

  return el('div', { className: 'card' }, [
    el('h4', {}, 'Deliberação'),
    motivo,
    erro,
    botoes,
  ]);
}
