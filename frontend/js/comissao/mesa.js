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
import { renderSvgCrEvolution } from '../discente/portal.js';
import { carregarPainel } from './painel.js';
import { navegarPara } from '../router.js';

const TIPO_EXCECAO = {
  equivalencia: 'Equivalência',
  aproveitamento: 'Aproveitamento',
  dispensa: 'Dispensa',
};

export async function abrirMesa(subId, docInicial = 'boletim') {
  const mesa = document.getElementById('admin-mesa');
  clearElement(mesa);

  let sub;
  try {
    sub = await api(`/api/comissao/submissoes/${subId}`);
  } catch (err) {
    mesa.appendChild(el('div', { className: 'card' },
      el('p', { className: 'text-muted' }, err.message)));
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

  const { col, tabelaDisciplinas, evolucaoCR } = renderLadoDados(sub);

  mesa.appendChild(header);
  mesa.appendChild(el('div', { className: 'mesa' }, [
    el('div', { className: 'mesa-col' }, [
      renderLadoPdf(sub, docInicial),
      tabelaDisciplinas,
    ]),
    col,
  ]));
  mesa.appendChild(el('div', { className: 'mesa-rodape' }, evolucaoCR));
}

function renderLadoPdf(sub, docInicial = 'boletim') {
  const docs = sub.documentos || {};
  const [abaAtiva, setAbaAtiva] = useState(docInicial === 'boa' ? 'boa' : 'boletim');

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

  const docAtivo = () => (abaAtiva() === 'boa' ? docs.boa : docs.boletim) || {};

  const btnAbrir = el('button', {
    className: 'btn btn-secondary btn-sm', type: 'button', disabled: !docAtivo().disponivel,
  }, 'Abrir PDF em nova guia');
  btnAbrir.addEventListener('click', () => {
    const url = docAtivo().url;
    if (url) window.open(url, '_blank', 'noopener');
  });

  const wrap = el('div', { className: 'mesa-pdf-wrap' });
  while (conteudo.firstChild) {
    wrap.appendChild(conteudo.firstChild);
  }

  const btnFecharFloat = el('button', {
    className: 'btn-fechar-pdf-fullscreen hidden',
    type: 'button',
    'aria-label': 'Fechar visualizador',
  }, '✕ Fechar Visualizador');

  const atualizarEstadoFullscreen = (expandir) => {
    wrap.classList.toggle('mesa-pdf-fullscreen', expandir);
    btnExpandir.textContent = expandir ? 'Restaurar visualizador' : 'Expandir visualizador';
    btnFecharFloat.classList.toggle('hidden', !expandir);
  };

  const btnExpandir = el('button', { className: 'btn btn-secondary btn-sm', type: 'button' }, 'Expandir visualizador');
  btnExpandir.addEventListener('click', () => atualizarEstadoFullscreen(!wrap.classList.contains('mesa-pdf-fullscreen')));
  btnFecharFloat.addEventListener('click', () => atualizarEstadoFullscreen(false));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrap.classList.contains('mesa-pdf-fullscreen')) {
      atualizarEstadoFullscreen(false);
    }
  });

  const sha256 = docs.boletim?.sha256 || sub.pdfSha256;
  return el('div', { className: 'mesa-col' }, [
    el('h3', {}, 'Documentos originais'),
    sha256 ? el('p', { className: 'text-muted mesa-hash' },
      `sha256 boletim: ${sha256.slice(0, 24)}…`) : null,
    el('div', { className: 'actions-row mesa-pdf-actions' }, [tabs, btnAbrir, btnExpandir]),
    el('div', { className: 'mesa-pdf-viewport' }, [wrap, btnFecharFloat]),
  ]);
}

function useState(initial) {
  let value = initial;
  return [() => value, (v) => { value = v; }];
}

function estimarPeriodo(ingresso) {
  const m = String(ingresso || '').match(/(\d{4})\/(\d)/);
  if (!m) return null;
  const anoIngresso = Number(m[1]);
  const semIngresso = Number(m[2]);
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const semAtual = hoje.getMonth() < 6 ? 1 : 2;
  const periodos = (anoAtual - anoIngresso) * 2 + (semAtual - semIngresso) + 1;
  return periodos > 0 ? periodos : 1;
}

function contarCursos(metadata) {
  const text = String(metadata?.curso || '');
  const matches = text.match(/\d{4,5}\s*-/g) || [];
  const cursos = new Set(matches.map((m) => m.replace(/\s*-/, '').trim()));
  return cursos.size;
}

function renderLadoDados(sub) {
  const col = el('div', { className: 'mesa-col' }, [el('h3', {}, 'Dados extraídos')]);
  const { metadata, diagnostico, alertas, periodos } = sub;
  const tabelaDisciplinas = renderTabelaDisciplinas(sub);
  const evolucaoCR = renderEvolucaoCR(periodos);

  const periodoEstimado = estimarPeriodo(metadata?.ingresso);
  const qtdCursos = contarCursos(metadata);
  const cursoInfo = qtdCursos === 1
    ? '1 curso'
    : `${qtdCursos} cursos${qtdCursos > 1 ? ' — Transferência interna' : ''}`;

  col.appendChild(
    el('div', { className: 'card' },
      [
        ['Nome', metadata?.nome],
        ['DRE', metadata?.dre],
        ['Curso', metadata?.curso],
        ['Cursos detectados', cursoInfo],
        ['Ingresso', metadata?.ingresso],
        ['Período estimado', periodoEstimado ? `${periodoEstimado}º período` : null],
        ['Data de emissão', metadata?.emissao || metadata?.emissaoBoa],
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

  col.appendChild(renderExcecoes(sub));
  col.appendChild(renderDeliberacao(sub));

  return { col, tabelaDisciplinas, evolucaoCR };
}

function renderEvolucaoCR(periodos) {
  const periodosValidos = (periodos || [])
    .filter((p) => String(p.periodo).match(/^\d{4}\/\d$/))
    .sort((a, b) => String(a.periodo).localeCompare(String(b.periodo)));

  return el('div', { className: 'card' }, [
    el('h4', {}, 'Evolução do CR por Período'),
    renderSvgCrEvolution(periodosValidos, 0),
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
  const container = el('div', { className: 'card mesa-disciplinas' });
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

  const tabela = rows.length
    ? el('div', { className: 'table-container mesa-tabela' }, [
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
      ])
    : el('p', { className: 'text-muted' }, 'Nenhuma disciplina extraída.');

  container.appendChild(
    el('details', { className: 'accordion' }, [
      el('summary', {}, `Exibir lista completa de disciplinas (${rows.length})`),
      tabela,
    ])
  );
  return container;
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

  const respostasRapidas = [
    { label: 'Falta integralizar ciclo básico', texto: 'Discente ainda não integralizou todo o ciclo básico obrigatório do PPC 2022.' },
    { label: 'CR abaixo do mínimo regulamentar (6.0)', texto: 'Coeficiente de Rendimento abaixo do mínimo de 6,0 exigido para estágio.' },
    { label: 'Deferido', texto: 'Caso regular: discente atende todos os requisitos de elegibilidade.' },
    { label: 'Aprovado c/ ressalva', texto: 'Aprovado, desde que o discente conclua a disciplina pendente no período em curso: ' },
  ];

  const btnResposta = (r) => {
    const btn = el('button', { className: 'btn btn-text btn-sm btn-resposta-rapida', type: 'button' }, r.label);
    btn.addEventListener('click', () => {
      motivo.value = r.texto;
      motivo.focus();
    });
    return btn;
  };

  const botoes = el('div', { className: 'actions-row' }, []);
  const criarBotao = (label, classe, decisao) => {
    const btn = el('button', { className: `btn ${classe}`, type: 'button' }, label);
    btn.addEventListener('click', () => decidir(decisao));
    return btn;
  };
  if (sub.status === 'aprovada') {
    const btnRevogar = el('button', { className: 'btn btn-danger', type: 'button' }, 'Revogar Autorização');
    btnRevogar.addEventListener('click', async () => {
      const motivo = window.prompt('Motivo da revogação:');
      if (!motivo) return;
      try {
        await api(`/api/comissao/submissoes/${sub.id}/revogar`, {
          method: 'POST',
          body: { motivo },
        });
        navegarPara('/admin/autorizacoes');
      } catch (err) {
        erro.textContent = err.message;
        erro.hidden = false;
      }
    });
    botoes.appendChild(btnRevogar);
  } else {
    botoes.appendChild(criarBotao('Aprovar', 'btn-primary', 'aprovada'));
    botoes.appendChild(criarBotao('Indeferir', 'btn-danger', 'indeferida'));
    botoes.appendChild(criarBotao('Devolver', 'btn-secondary', 'devolvida'));
  }

  return el('div', { className: 'card' }, [
    el('h4', {}, 'Deliberação'),
    el('div', { className: 'respostas-rapidas' }, [
      el('span', { className: 'text-muted' }, 'Respostas rápidas:'),
      ...respostasRapidas.map(btnResposta),
    ]),
    motivo,
    erro,
    botoes,
  ]);
}
