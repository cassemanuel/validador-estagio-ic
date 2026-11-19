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
import {
  calcularProgressoIntegralizacao,
  renderSvgCrEvolution,
} from '../discente/portal.js';
import { dialogAviso, dialogConfirmar } from '../ui/dialog.js';
import { carregarRegras } from '../rules/ppc2022.js';
import { navegarPara } from '../router.js';

const TIPO_EXCECAO = {
  equivalencia: 'Equivalência',
  aproveitamento: 'Aproveitamento',
  dispensa: 'Dispensa',
  acordo: 'Solicitar Acordo',
  outros: 'Outro(s)',
};

// Listeners globais da Mesa aberta (ex.: Esc do visualizador). Abortados a
// cada reabertura para não acumular handlers presos a processos antigos.
let mesaAbort = null;

const ROTULO_DOC = { boletim: 'Boletim', boa: 'BOA' };

/**
 * Registra quais PDFs o membro da comissão já abriu nesta Mesa. No piloto,
 * "Aprovar" só é liberado depois que Boletim e BOA foram visualizados (no
 * visualizador embutido ou em nova guia).
 */
function criarControleVisualizacao(docs) {
  const vistos = new Set();
  const ouvintes = new Set();
  const nomes = ['boletim', 'boa'];
  return {
    marcar(nome) {
      if (vistos.has(nome)) return;
      vistos.add(nome);
      ouvintes.forEach((fn) => fn());
    },
    pendentes: () => nomes.filter((n) => docs[n]?.disponivel && !vistos.has(n)),
    indisponiveis: () => nomes.filter((n) => !docs[n]?.disponivel),
    aoMudar: (fn) => ouvintes.add(fn),
  };
}

export async function abrirMesa(subId, docInicial = 'boletim') {
  const mesa = document.getElementById('admin-mesa');
  mesaAbort?.abort();
  mesaAbort = new AbortController();
  const { signal } = mesaAbort;
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

  const regras = await carregarRegras();
  const controleDocs = criarControleVisualizacao(sub.documentos || {});
  const { col, tabelaDisciplinas, evolucaoCR } = renderLadoDados(sub, regras, controleDocs);

  mesa.appendChild(header);
  mesa.appendChild(el('div', { className: 'mesa' }, [
    el('div', { className: 'mesa-col' }, [
      renderLadoPdf(sub, docInicial, signal, controleDocs),
      tabelaDisciplinas,
    ]),
    col,
  ]));
  mesa.appendChild(el('div', { className: 'mesa-rodape' }, evolucaoCR));
}

function renderLadoPdf(sub, docInicial = 'boletim', signal, controleDocs) {
  const docs = sub.documentos || {};
  const [abaAtiva, setAbaAtiva] = useState(docInicial === 'boa' ? 'boa' : 'boletim');

  const tabs = el('div', { className: 'app-nav segmented' });
  // Contêiner visível do visualizador: a troca de aba renderiza aqui.
  const wrap = el('div', { className: 'mesa-pdf-wrap' });

  const renderAba = (nome) => {
    clearElement(wrap);
    const doc = docs[nome];
    if (!doc?.disponivel) {
      wrap.appendChild(el('div', { className: 'card' }, [
        el('p', { className: 'text-muted' },
          `${nome.toUpperCase()} indisponível ou expurgado por política de retenção.`),
      ]));
      return;
    }
    const iframe = el('iframe', {
      className: 'mesa-pdf',
      src: doc.url,
      title: `PDF ${nome.toUpperCase()} submetido pelo discente`,
    });
    // Conta como visualizado só quando o PDF de fato carregou (uma resposta
    // de erro da API chega como JSON e não libera a aprovação).
    iframe.addEventListener('load', () => {
      let tipo = null;
      try {
        tipo = iframe.contentDocument?.contentType || null;
      } catch {
        tipo = null;
      }
      if (!tipo || tipo === 'application/pdf') controleDocs?.marcar(nome);
    });
    wrap.appendChild(iframe);
  };

  ['boletim', 'boa'].forEach((nome) => {
    const btn = el('button', {
      className: `tab-btn tab-doc ${abaAtiva() === nome ? 'active' : ''}`,
      type: 'button',
      'aria-pressed': String(abaAtiva() === nome),
      dataset: { doc: nome },
    }, nome === 'boletim' ? 'Boletim' : 'BOA');
    btn.addEventListener('click', () => {
      setAbaAtiva(nome);
      [...tabs.children].forEach((b) => {
        const ativo = b === btn;
        b.classList.toggle('active', ativo);
        b.setAttribute('aria-pressed', String(ativo));
      });
      renderAba(nome);
      btnAbrir.disabled = !docAtivo().disponivel;
    });
    tabs.appendChild(btn);
  });

  renderAba(abaAtiva());

  const docAtivo = () => (abaAtiva() === 'boa' ? docs.boa : docs.boletim) || {};

  const btnAbrir = el('button', {
    className: 'btn btn-secondary btn-sm', type: 'button', disabled: !docAtivo().disponivel,
  }, 'Abrir PDF em nova guia');
  btnAbrir.addEventListener('click', () => {
    // Lê a aba ativa no momento do clique (padrão: boletim).
    const abaAtivaEl = tabs.querySelector('.tab-doc.active');
    const docAtual = abaAtivaEl?.dataset.doc || 'boletim';
    window.open(`/api/comissao/submissoes/${sub.id}/${docAtual}`, '_blank', 'noopener');
    controleDocs?.marcar(docAtual);
  });

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
  }, { signal });

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
  const codigos = new Set();
  (metadata?.cursos || []).forEach((c) => {
    const cod = String(c).match(/\d{4,6}/)?.[0];
    if (cod) codigos.add(cod);
  });
  // Fallback para submissões antigas sem metadata.cursos
  (String(metadata?.curso || '').match(/\d{4,6}\s*-/g) || []).forEach((m) =>
    codigos.add(m.replace(/\s*-/, '').trim()));
  return codigos.size;
}

function renderLadoDados(sub, regras, controleDocs) {
  const col = el('div', { className: 'mesa-col' }, [el('h3', {}, 'Dados extraídos')]);
  const { metadata, diagnostico, alertas, periodos } = sub;
  const tabelaDisciplinas = renderTabelaDisciplinas(sub);
  const evolucaoCR = renderEvolucaoCR(periodos);

  const periodoEstimado = estimarPeriodo(metadata?.ingresso);
  const qtdCursos = contarCursos(metadata);
  const cursoInfo = qtdCursos > 1
    ? `${qtdCursos} cursos (Transferência interna)`
    : '1 curso';

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

  const progresso = calcularProgressoIntegralizacao(
    sub.periodos,
    regras
  );
  const badge30h = progresso.creditosRestantes <= 10
    ? el('span', { className: 'badge badge-ap' }, 'Elegível para estágio de 30h')
    : el('span', { className: 'badge badge-cursando' }, 'Limitado a 20h semanais');
  col.appendChild(
    el('div', { className: 'card' }, [
      el('h4', {}, 'Integralização do curso'),
      el('p', {}, [
        el('strong', {}, 'Créditos restantes para formatura: '),
        String(progresso.creditosRestantes),
        ' ',
        badge30h,
      ]),
    ])
  );

  col.appendChild(renderExcecoes(sub));
  col.appendChild(renderDeliberacao(sub, controleDocs));

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
          el('td', {}, d.grau !== null && d.grau !== undefined ? formatNumberBR(d.grau, 1) : '—'),
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

function renderDeliberacao(sub, controleDocs) {
  const motivo = el('textarea', {
    placeholder: 'Motivo da deliberação (obrigatório para indeferir/devolver)',
    'aria-label': 'Motivo da deliberação',
    rows: '3',
  });
  const erro = el('p', { className: 'login-erro', role: 'alert', hidden: true });
  // Aviso discreto enquanto Boletim e BOA não foram abertos (piloto).
  const avisoDocs = el('p', {
    id: `mesa-aviso-documentos-${sub.id}`,
    className: 'text-muted aviso-documentos', role: 'status', 'aria-live': 'polite',
  });

  const coletarDecisoesExcecoes = () =>
    [...document.querySelectorAll('input[data-exc-id]:checked')].map((i) => ({
      id: Number(i.dataset.excId),
      status: i.dataset.status,
    }));

  const botoesDeliberacao = [];
  let btnAprovar = null;
  let deliberando = false;

  // "Aprovar" exige os dois PDFs abertos; indeferir/devolver não.
  const aprovacaoBloqueada = () => {
    if (!controleDocs) return false;
    return controleDocs.pendentes().length > 0 || controleDocs.indisponiveis().length > 0;
  };

  /** Explica, no modal, por que a aprovação ainda não pode seguir. */
  const avisarConferenciaPendente = () => {
    const nomes = (lista) => lista.map((n) => ROTULO_DOC[n]).join(' e ');
    const indisponiveis = controleDocs.indisponiveis();
    const pendentes = controleDocs.pendentes();
    if (indisponiveis.length) {
      return dialogAviso(
        'Aprovação indisponível',
        `Este processo não pode ser aprovado: ${nomes(indisponiveis)} está indisponível ou foi `
          + 'expurgado, e a aprovação exige a conferência do Boletim e do BOA originais. '
          + 'Indefira ou devolva o processo, informando o motivo.'
          + (pendentes.length ? ` (Também falta abrir: ${nomes(pendentes)}.)` : ''),
      );
    }
    return dialogAviso(
      'Conferência obrigatória pendente',
      'Antes de aprovar o estágio, abra e confira o Boletim e o BOA do discente '
        + `(na aba acima ou em nova guia). Falta abrir: ${nomes(pendentes)}.`,
    );
  };

  const atualizarBotoes = () => {
    // `disabled` só durante o envio (evita duplo clique). Com a conferência
    // pendente, "Aprovar" continua clicável — o clique abre o modal explicando
    // o que falta — e é sinalizado com aria-disabled.
    botoesDeliberacao.forEach((b) => { b.disabled = deliberando; });
    if (btnAprovar) {
      if (aprovacaoBloqueada()) {
        btnAprovar.setAttribute('aria-disabled', 'true');
        btnAprovar.setAttribute('aria-describedby', avisoDocs.id);
      } else {
        btnAprovar.removeAttribute('aria-disabled');
        btnAprovar.removeAttribute('aria-describedby');
      }
    }
    if (!controleDocs) return;
    const indisponiveis = controleDocs.indisponiveis();
    const pendentes = controleDocs.pendentes();
    if (indisponiveis.length) {
      avisoDocs.textContent = `Aprovação indisponível: ${indisponiveis.map((n) => ROTULO_DOC[n]).join(' e ')} `
        + 'não pode ser conferido. Indefira ou devolva o processo.';
    } else if (pendentes.length) {
      avisoDocs.textContent = `Para aprovar, abra antes: ${pendentes.map((n) => ROTULO_DOC[n]).join(' e ')}.`;
    } else {
      avisoDocs.textContent = '';
    }
    avisoDocs.hidden = !avisoDocs.textContent;
  };
  const setDeliberando = (ativo) => {
    deliberando = ativo;
    atualizarBotoes();
  };

  const decidir = async (decisao) => {
    if (decisao !== 'aprovada' && !motivo.value.trim()) {
      erro.textContent = 'Informe o motivo para indeferir ou devolver.';
      erro.hidden = false;
      return;
    }
    if (decisao === 'aprovada') {
      if (aprovacaoBloqueada()) {
        await avisarConferenciaPendente();
        return;
      }
      const nome = sub.metadata?.nome || `processo #${sub.id}`;
      const ok = await dialogConfirmar({
        titulo: 'Aprovar Processo',
        mensagem: `Confirmar a aprovação de ${nome}? A autorização de estágio será emitida imediatamente.`,
        comMotivo: false,
        labelOk: 'Aprovar',
      });
      if (!ok) return;
    }
    erro.hidden = true;
    // Evita duplo envio enquanto o POST está em andamento.
    setDeliberando(true);
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
      setDeliberando(false);
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
    botoesDeliberacao.push(btn);
    return btn;
  };

  const STATUS_ABERTOS = ['fila_regular', 'mesa_revisao'];
  const STATUS_ARQUIVAVEIS = ['indeferida', 'devolvida', 'cancelada', 'revogada'];
  const emAnalise = STATUS_ABERTOS.includes(sub.status);

  if (sub.status === 'aprovada') {
    const btnRevogar = el('button', { className: 'btn btn-danger', type: 'button' }, 'Revogar Autorização');
    btnRevogar.addEventListener('click', async () => {
      const motivo = await dialogConfirmar({
        titulo: 'Revogar Autorização',
        mensagem: 'Informe o motivo da revogação da autorização.',
      });
      if (!motivo) return;
      btnRevogar.disabled = true;
      try {
        await api(`/api/comissao/submissoes/${sub.id}/revogar`, {
          method: 'POST',
          body: { motivo },
        });
        navegarPara('/admin/autorizacoes');
      } catch (err) {
        erro.textContent = err.message;
        erro.hidden = false;
        btnRevogar.disabled = false;
      }
    });
    botoes.appendChild(btnRevogar);
  } else if (emAnalise) {
    btnAprovar = criarBotao('Aprovar', 'btn-primary', 'aprovada');
    botoes.appendChild(btnAprovar);
    botoes.appendChild(criarBotao('Indeferir', 'btn-danger', 'indeferida'));
    botoes.appendChild(criarBotao('Devolver', 'btn-secondary', 'devolvida'));
  } else if (STATUS_ARQUIVAVEIS.includes(sub.status)) {
    const btnArquivar = el('button', { className: 'btn btn-arquivar', type: 'button' }, 'Arquivar Processo');
    btnArquivar.addEventListener('click', async () => {
      const ok = await dialogConfirmar({
        titulo: 'Arquivar Processo',
        mensagem: 'Arquivar este processo? Ele sairá da fila ativa e das contagens do dashboard.',
        comMotivo: false,
        labelOk: 'Arquivar',
      });
      if (!ok) return;
      btnArquivar.disabled = true;
      try {
        await api(`/api/comissao/submissoes/${sub.id}/arquivar`, { method: 'POST' });
        navegarPara('/admin/fila');
      } catch (err) {
        erro.textContent = err.message;
        erro.hidden = false;
        btnArquivar.disabled = false;
      }
    });
    botoes.appendChild(el('p', { className: 'text-muted' },
      'Processo concluído. O arquivamento o remove da fila ativa e das métricas.'));
    botoes.appendChild(btnArquivar);
  } else {
    botoes.appendChild(el('p', { className: 'text-muted' }, 'Processo arquivado.'));
  }

  if (emAnalise) {
    controleDocs?.aoMudar(atualizarBotoes);
    atualizarBotoes();
  }

  return el('div', { className: 'card' }, [
    el('h4', {}, 'Deliberação'),
    emAnalise ? el('div', { className: 'respostas-rapidas' }, [
      el('span', { className: 'text-muted' }, 'Respostas rápidas:'),
      ...respostasRapidas.map(btnResposta),
    ]) : null,
    emAnalise ? motivo : null,
    erro,
    emAnalise ? avisoDocs : null,
    botoes,
  ]);
}
