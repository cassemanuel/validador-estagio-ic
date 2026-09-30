/**
 * Portal do discente: upload do BOA/Boletim → parsing local → confirmação
 * interativa (com declaração de exceções) → diagnóstico preliminar →
 * submissão à Comissão → acompanhamento de status.
 */

import { api } from '../api/client.js';
import { processarPDF } from '../parsers/pdfParser.js';
import { processarBOA } from '../parsers/boaParser.js';
import { calcularCRAcumulado } from '../domain/cr.js';
import {
  carregarRegras,
  disciplinasFaltantesCicloBasico,
  verificarElegibilidadeEstagio,
} from '../rules/ppc2022.js';
import {
  el,
  badgeClassForSituacao,
  clearElement,
  formatNumberBR,
  validatePdfFile,
} from '../ui/dom.js';

// Estado do fluxo client-side (o PDF só vai ao servidor após confirmar).
const state = {
  file: null,
  dados: null, // {metadata, periodos, pendencias}
  regras: null,
  diagnostico: null,
  excecoes: [], // {codigo_requisito, tipo, codigo_cursada, justificativa}
};

const STATUS_LABEL = {
  fila_regular: 'Na fila de aprovação',
  mesa_revisao: 'Em revisão pela Comissão',
  aprovada: 'Aprovada',
  indeferida: 'Indeferida',
  devolvida: 'Devolvida para correção',
};

const STATUS_BADGE = {
  fila_regular: 'badge-cursando',
  mesa_revisao: 'badge-cursando',
  aprovada: 'badge-ap',
  indeferida: 'badge-reprovado',
  devolvida: 'badge-neutro',
};

const STATUS_ATIVOS = ['fila_regular', 'mesa_revisao'];

export async function initPortal() {
  const statusEl = document.getElementById('discente-status');
  const fluxoEl = document.getElementById('discente-fluxo');

  initDropzone();

  try {
    state.regras = await carregarRegras();
  } catch {
    // Regras indisponíveis — diagnóstico fica indisponível, mas o fluxo segue.
  }

  const { submissao } = await api('/api/submissoes/minha');
  if (!submissao) return;

  const ativo = STATUS_ATIVOS.includes(submissao.status);
  fluxoEl.hidden = ativo;
  renderStatus(statusEl, submissao);
}

/* ============================================================
   Status / acompanhamento
   ============================================================ */

function renderStatus(container, sub) {
  clearElement(container);
  const concluida = !STATUS_ATIVOS.includes(sub.status);

  const btnNova = concluida
    ? el('button', {
        className: 'btn btn-primary',
        type: 'button',
      }, 'Nova Submissão / Reenviar Documentação')
    : null;
  if (btnNova) {
    btnNova.addEventListener('click', () => {
      const fluxo = document.getElementById('discente-fluxo');
      fluxo.hidden = false;
      document
        .getElementById('pdf-dropzone')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  container.appendChild(
    el('div', { className: 'card' }, [
      el('div', { className: 'estagio-header' }, [
        el('h3', {}, 'Sua Submissão'),
        el(
          'span',
          { className: `badge ${STATUS_BADGE[sub.status] || 'badge-neutro'}` },
          STATUS_LABEL[sub.status] || sub.status
        ),
      ]),
      el('p', { className: 'text-muted' },
        `Enviada em ${new Date(sub.criadoEm).toLocaleString('pt-BR')}.`),
      sub.decisao
        ? el('div', { className: 'card card-aviso' }, [
            el('strong', {}, `Decisão: ${STATUS_LABEL[sub.decisao.decisao] || sub.decisao.decisao}`),
            sub.decisao.motivo ? el('p', {}, `Motivo: ${sub.decisao.motivo}`) : null,
          ])
        : null,
      sub.autorizacao
        ? el('div', {
            className: `card card-autorizacao ${sub.autorizacao.expirada ? 'card-aviso' : ''}`,
          }, [
            el('strong', {},
              `Autorização de estágio ${sub.autorizacao.expirada ? 'expirada' : 'vigente'}`),
            el('p', {},
              `Liberada em ${new Date(sub.autorizacao.liberadaEm).toLocaleDateString('pt-BR')} · ` +
              `válida até ${new Date(sub.autorizacao.validaAte).toLocaleDateString('pt-BR')}` +
              (sub.autorizacao.expirada
                ? ''
                : ` (${sub.autorizacao.diasParaVencer} dias restantes)`)),
          ])
        : null,
      sub.status === 'devolvida'
        ? el('p', { className: 'card-aviso-texto' },
            'Corrija os dados apontados pela Comissão e reenvie abaixo.')
        : null,
      sub.alertas?.length && !concluida
        ? el('p', { className: 'text-muted' },
            'Seu caso está na Mesa de Revisão para conferência detalhada.')
        : null,
      btnNova,
    ])
  );
}

/* ============================================================
   Upload e parsing local
   ============================================================ */

function initDropzone() {
  const dropzone = document.getElementById('pdf-dropzone');
  const input = document.getElementById('pdf-input');
  const progress = document.getElementById('pdf-progress');
  const progressBar = document.getElementById('pdf-progress-bar');

  ['dragenter', 'dragover'].forEach((event) => {
    dropzone.addEventListener(event, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((event) => {
    dropzone.addEventListener(event, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handlePDF(file, { progress, progressBar });
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) handlePDF(file, { progress, progressBar });
  });
}

async function handlePDF(file, { progress, progressBar }) {
  const revisao = document.getElementById('discente-revisao');
  progress?.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '0%';

  try {
    validatePdfFile(file);
    const buffer = await file.arrayBuffer();

    // Histórico (aprovações) + BOA (pendências e aprovadas por coluna) —
    // cada parser retorna vazio quando o documento não é do seu tipo.
    const historico = await processarPDF(buffer, (pct) => {
      if (progressBar) progressBar.style.width = `${Math.round(pct * 50)}%`;
    });
    const boa = await processarBOA(buffer).catch(() => ({
      obrigatorias: [],
      optativas: [],
      aprovadas: [],
      cumpridos: [],
      metadata: {},
    }));
    if (progressBar) progressBar.style.width = '100%';

    const pendencias = {
      obrigatorias: boa.obrigatorias || [],
      optativas: boa.optativas || [],
    };

    // O BOA também lista as disciplinas já aprovadas (zona superior de cada
    // coluna). `aprovadas` traz o código da atividade cursada; `cumpridos`
    // marca o código do requisito da coluna como concluído quando há
    // registro na zona superior (AP/T/grau) — cobre equivalências ainda
    // não mapeadas. Sem isso, num BOA todo o ciclo básico ficava pendente.
    const concluidasBOA = [...(boa.aprovadas || []), ...(boa.cumpridos || [])];
    if (concluidasBOA.length) {
      const existentes = new Set(
        historico.periodos.flatMap((p) =>
          (p.disciplinas || []).map((d) => d.codigo)
        )
      );
      const novas = concluidasBOA.filter((d) => !existentes.has(d.codigo));
      if (novas.length) {
        historico.periodos.push({
          periodo: 'Aprovadas (BOA)',
          disciplinas: novas,
          totais: {},
        });
      }
      if (!historico.metadata.tipoDocumento) {
        historico.metadata.tipoDocumento = 'boa';
      }
    }

    // Cabeçalho do BOA: preenche nome/DRE/curso que o parser de linhas
    // do boletim não encontra nesse layout.
    for (const campo of ['nome', 'dre', 'curso']) {
      if (!historico.metadata[campo] && boa.metadata?.[campo]) {
        historico.metadata[campo] = boa.metadata[campo];
      }
    }

    historico.resumo = calcularCRAcumulado(historico);

    state.file = file;
    state.dados = {
      metadata: historico.metadata,
      periodos: historico.periodos,
      pendencias,
    };
    state.excecoes = [];
    state.diagnostico = state.regras
      ? verificarElegibilidadeEstagio(historico, state.regras)
      : null;

    renderRevisao(revisao);
  } catch (err) {
    console.error(err);
    clearElement(revisao);
    revisao.hidden = false;
    revisao.appendChild(
      el('div', { className: 'card' }, [
        el('h3', {}, 'Erro ao processar PDF'),
        el('p', { className: 'text-muted' }, err.message),
      ])
    );
  } finally {
    progress?.classList.add('hidden');
  }
}

/* ============================================================
   Confirmação interativa + exceções + diagnóstico
   ============================================================ */

function renderRevisao(container) {
  clearElement(container);
  container.hidden = false;
  const { metadata, periodos, pendencias } = state.dados;

  // Identificação
  container.appendChild(
    el('div', { className: 'card' }, [
      el('h3', {}, 'Confira os dados extraídos'),
      ...[
        ['Nome', metadata.nome],
        ['DRE', metadata.dre],
        ['Curso', metadata.curso],
        ['Ingresso', metadata.ingresso],
        ['Documento', metadata.tipoDocumento],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => el('p', {}, [el('strong', {}, `${k}: `), String(v)])),
      metadata.tipoDocumento === 'historico'
        ? el('p', { className: 'card-aviso-texto' },
            'Atenção: o Histórico omite reprovações; prefira o Boletim Não Oficial.')
        : null,
    ])
  );

  // Ciclo básico + exceções
  container.appendChild(renderCicloBasico());

  // Disciplinas extraídas (conferência rápida)
  container.appendChild(renderDisciplinas(periodos));

  // Pendências do BOA
  if (pendencias?.obrigatorias?.length || pendencias?.optativas?.length) {
    container.appendChild(renderPendencias(pendencias));
  }

  // Diagnóstico preliminar
  if (state.diagnostico) {
    container.appendChild(renderDiagnostico(state.diagnostico));
  }

  // Submissão
  const erro = el('p', { className: 'login-erro', role: 'alert', hidden: true });
  const btn = el('button', { className: 'btn btn-primary', type: 'button' },
    'Confirmar e enviar à Comissão');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    erro.hidden = true;
    try {
      const form = new FormData();
      form.append('pdf', state.file);
      form.append('payload', JSON.stringify({
        metadata: state.dados.metadata,
        periodos: state.dados.periodos,
        pendencias: state.dados.pendencias,
        diagnostico: state.diagnostico || {},
        excecoes: state.excecoes,
      }));
      const sub = await api('/api/submissoes', { method: 'POST', form });
      document.getElementById('discente-fluxo').hidden = true;
      renderStatus(document.getElementById('discente-status'), sub);
    } catch (err) {
      erro.textContent = err.message;
      erro.hidden = false;
      btn.disabled = false;
    }
  });
  container.appendChild(el('div', { className: 'card submit-card' }, [btn, erro]));
}

function renderCicloBasico() {
  const historico = { periodos: state.dados.periodos };
  const faltantes = state.regras
    ? disciplinasFaltantesCicloBasico(historico, state.regras)
    : [];
  const concluidasCodigos = new Set(
    (state.regras?.ciclo_basico || [])
      .filter((r) => !faltantes.some((f) => f.codigo === r.codigo))
      .map((r) => r.codigo)
  );

  const listaExcecoes = el('ul', { className: 'excecao-list' });

  const redesenharExcecoes = () => {
    clearElement(listaExcecoes);
    state.excecoes.forEach((exc, i) => {
      const remover = el('button', {
        className: 'btn-icon',
        type: 'button',
        'aria-label': 'Remover exceção',
      }, [el('i', { className: 'bi bi-x-circle' })]);
      remover.addEventListener('click', () => {
        state.excecoes.splice(i, 1);
        redesenharExcecoes();
      });
      listaExcecoes.appendChild(
        el('li', {}, [
          el('span', {},
            `${exc.codigo_requisito} — ${exc.tipo}` +
            (exc.codigo_cursada ? ` por ${exc.codigo_cursada}` : '') +
            `: ${exc.justificativa}`),
          remover,
        ])
      );
    });
  };

  const reqNodes = (state.regras?.ciclo_basico || []).map((req) => {
    const ok = concluidasCodigos.has(req.codigo);
    const row = el('li', { className: ok ? 'criterio-ok' : 'criterio-falta' }, [
      el('i', {
        className: `bi ${ok ? 'bi-check-circle-fill' : 'bi-exclamation-circle'}`,
        'aria-hidden': 'true',
      }),
      el('span', {}, ` ${req.codigo} — ${req.nome} (${req.periodo}º período)`),
    ]);
    if (!ok) {
      const btn = el('button', {
        className: 'btn btn-secondary btn-sm',
        type: 'button',
      }, 'Declarar exceção');
      btn.addEventListener('click', () => abrirFormExcecao(req, listaExcecoes, redesenharExcecoes));
      row.appendChild(btn);
    }
    return row;
  });

  return el('div', { className: 'card' }, [
    el('h3', {}, 'Ciclo básico (1º–4º período)'),
    el('p', { className: 'text-muted' },
      'Disciplina não detectada mas cursada? Declare uma exceção ' +
      '(equivalência, dispensa ou aproveitamento) para a Comissão avaliar.'),
    el('ul', { className: 'estagio-criterios' }, reqNodes),
    listaExcecoes,
  ]);
}

function abrirFormExcecao(req, lista, redesenhar) {
  // Remove formulário anterior, se houver.
  document.querySelector('.excecao-form')?.remove();

  const tipo = el('select', { 'aria-label': 'Tipo de exceção' }, [
    el('option', { value: 'equivalencia' }, 'Equivalência'),
    el('option', { value: 'aproveitamento' }, 'Aproveitamento'),
    el('option', { value: 'dispensa' }, 'Dispensa'),
  ]);
  const codigo = el('input', {
    type: 'text', placeholder: 'Disciplina cursada (ex.: MAE111)', maxLength: '16',
  });
  const just = el('textarea', {
    placeholder: 'Justificativa (ex.: resolução de equivalência nº ...)',
    rows: '3', required: true,
  });
  const salvar = el('button', { className: 'btn btn-primary btn-sm', type: 'button' }, 'Adicionar');
  const cancelar = el('button', { className: 'btn btn-secondary btn-sm', type: 'button' }, 'Cancelar');

  const form = el('div', { className: 'card excecao-form' }, [
    el('h4', {}, `Exceção para ${req.codigo} — ${req.nome}`),
    el('label', {}, ['Tipo ', tipo]),
    el('label', {}, ['Disciplina cursada (se aplicável) ', codigo]),
    el('label', {}, ['Justificativa ', just]),
    el('div', { className: 'actions-row' }, [salvar, cancelar]),
  ]);

  salvar.addEventListener('click', () => {
    if (!just.value.trim()) {
      just.focus();
      return;
    }
    state.excecoes.push({
      codigo_requisito: req.codigo,
      tipo: tipo.value,
      codigo_cursada: codigo.value.trim() || null,
      justificativa: just.value.trim(),
    });
    form.remove();
    redesenhar();
  });
  cancelar.addEventListener('click', () => form.remove());

  lista.after(form);
  just.focus();
}

function renderDisciplinas(periodos) {
  const total = periodos.reduce((s, p) => s + (p.disciplinas?.length || 0), 0);
  const rows = [];
  periodos.forEach((p) => {
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

  const body = el('div', { className: 'periodo-body hidden' }, [
    el('div', { className: 'table-container' }, [
      el('table', {}, [
        el('caption', {}, 'Disciplinas extraídas do documento'),
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

  const header = el('button', {
    className: 'periodo-header', type: 'button', 'aria-expanded': 'false',
  }, [
    el('span', {}, 'Disciplinas extraídas'),
    el('span', {}, `${total} registros — clique para conferir`),
  ]);
  header.addEventListener('click', () => {
    const aberto = !body.classList.toggle('hidden');
    header.setAttribute('aria-expanded', String(aberto));
  });

  return el('div', { className: 'card periodo-card' }, [header, body]);
}

function renderPendencias(pendencias) {
  const item = (d) => el('li', {}, `${d.codigo} — ${d.nome} (${d.status})`);
  return el('div', { className: 'card' }, [
    el('h3', {}, 'Pendências detectadas (BOA)'),
    el('div', { className: 'cards-grid' }, [
      el('div', {}, [
        el('h4', {}, 'Obrigatórias'),
        el('ul', {}, (pendencias.obrigatorias || []).map(item)),
      ]),
      el('div', {}, [
        el('h4', {}, 'Optativas'),
        el('ul', {}, (pendencias.optativas || []).map(item)),
      ]),
    ]),
  ]);
}

function renderDiagnostico({ apto, criterios }) {
  return el('div', {
    className: `card estagio-card ${apto ? 'estagio-apto' : 'estagio-pendente'}`,
  }, [
    el('div', { className: 'estagio-header' }, [
      el('h4', {}, 'Diagnóstico preliminar de elegibilidade'),
      el('span', { className: `badge ${apto ? 'badge-ap' : 'badge-cursando'}` },
        apto ? 'Preliminarmente apto' : 'Pendências identificadas'),
    ]),
    el('ul', { className: 'estagio-criterios' },
      criterios.map((c) =>
        el('li', { className: c.ok ? 'criterio-ok' : 'criterio-falta' }, [
          el('i', {
            className: `bi ${c.ok ? 'bi-check-circle-fill' : 'bi-exclamation-circle'}`,
            'aria-hidden': 'true',
          }),
          el('span', {}, ` ${c.rotulo} — ${c.detalhe}`),
        ])
      )),
    el('p', { className: 'text-muted' },
      'Diagnóstico preliminar — a deliberação final é da Comissão de Estágio.'),
  ]);
}
