/**
 * Portal do discente: upload obrigatório de Boletim + BOA → parsing local →
 * confirmação interativa (com declaração de exceções) → diagnóstico preliminar →
 * submissão à Comissão → acompanhamento de status.
 *
 * O Boletim Não Oficial é a fonte principal de aprovações, notas e CR.
 * O BOA complementa com a grade curricular, pendências e validação cruzada.
 */

import { api } from '../api/client.js';
import { processarPDF } from '../parsers/pdfParser.js';
import { processarBOA } from '../parsers/boaParser.js';
import {
  calcularCRAcumulado,
  disciplinaConcluida,
  extrairPesoDisciplina,
} from '../domain/cr.js';
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

const state = {
  boletim: null, // { file, historico }
  boa: null,     // { file, dados }
  regras: null,
  diagnostico: null,
  excecoes: [],
  alertasCruzamento: [],
};

const STATUS_LABEL = {
  fila_regular: 'Na fila de aprovação',
  mesa_revisao: 'Em revisão pela Comissão',
  aprovada: 'Aprovada',
  indeferida: 'Indeferida',
  devolvida: 'Devolvida para correção',
  cancelada: 'Cancelada pelo discente',
};

const STATUS_BADGE = {
  fila_regular: 'badge-cursando',
  mesa_revisao: 'badge-cursando',
  aprovada: 'badge-ap',
  indeferida: 'badge-reprovado',
  devolvida: 'badge-neutro',
  cancelada: 'badge-neutro',
};

const STATUS_ATIVOS = ['fila_regular', 'mesa_revisao'];

export async function initPortal() {
  const statusEl = document.getElementById('discente-status');
  const fluxoEl = document.getElementById('discente-fluxo');
  const btnLimpar = document.getElementById('btn-limpar-documentos');

  initUploads();

  btnLimpar?.addEventListener('click', () => {
    resetUploadState();
    clearElement(document.getElementById('discente-revisao'));
    clearElement(document.getElementById('discente-analise'));
    document.getElementById('discente-revisao').hidden = true;
  });

  try {
    state.regras = await carregarRegras();
  } catch {
    state.regras = null;
  }

  const { submissao } = await api('/api/submissoes/minha');
  await renderHistorico();
  if (!submissao) {
    resetUploadState();
    fluxoEl.hidden = false;
    return;
  }

  const ativo = STATUS_ATIVOS.includes(submissao.status);
  const autorizacaoBloqueante = isAutorizacaoBloqueante(submissao.autorizacao);
  fluxoEl.hidden = ativo || autorizacaoBloqueante;
  renderStatus(statusEl, submissao);
}

function isAutorizacaoBloqueante(autorizacao) {
  if (!autorizacao || autorizacao.expirada) return false;
  return autorizacao.diasParaVencer > 30;
}

function resetUploadState() {
  state.boletim = null;
  state.boa = null;
  state.diagnostico = null;
  state.excecoes = [];
  updateUploadBadges();
  updateConfirmButton();
}

function initUploads() {
  setupDropzone('boletim');
  setupDropzone('boa');
}

function setupDropzone(tipo) {
  const dropzone = document.getElementById(`${tipo}-dropzone`);
  const input = document.getElementById(`${tipo}-input`);
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
    if (file) handleUpload(tipo, file, { progress, progressBar });
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) handleUpload(tipo, file, { progress, progressBar });
  });
}

function normalizarTexto(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

async function extrairTextoPaginas(pdfData, maxPaginas = 2) {
  // Usa cópia independente para não transferir/detach o buffer original.
  const dados = new Uint8Array(pdfData.slice ? pdfData.slice(0) : pdfData);
  const pdf = await pdfjsLib.getDocument({ data: dados, isEvalSupported: false, useSystemFonts: true }).promise;
  const partes = [];
  for (let i = 1; i <= Math.min(maxPaginas, pdf.numPages); i += 1) {
    const page = await pdf.getPage(i);
    const text = await page.getTextContent();
    partes.push(text.items.map((it) => it.str).join(' '));
  }
  return normalizarTexto(partes.join(' '));
}

async function validarTipoPDF(tipo, buffer) {
  const texto = await extrairTextoPaginas(buffer, 2);
  if (tipo === 'boletim') {
    const contemBoa = texto.includes('ORIENTACAO ACADEMICA') || texto.includes('BOA ');
    const contemBoletim = texto.includes('NAO OFICIAL');
    if (contemBoa && !contemBoletim) {
      throw new Error('Você anexou o BOA no campo do Boletim. Por favor, anexe o Boletim Não Oficial neste campo.');
    }
  } else if (tipo === 'boa') {
    const contemBoletim = texto.includes('NAO OFICIAL') || texto.includes('HISTORICO ESCOLAR');
    const contemBoa = texto.includes('ORIENTACAO ACADEMICA');
    if (contemBoletim && !contemBoa) {
      throw new Error('Você anexou o Boletim no campo do BOA.');
    }
  }
}

function limparErroUpload(revisao, analise) {
  clearElement(revisao);
  clearElement(analise);
  revisao.hidden = true;
}

async function handleUpload(tipo, file, { progress, progressBar }) {
  const revisao = document.getElementById('discente-revisao');
  const analise = document.getElementById('discente-analise');
  progress?.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '0%';
  limparErroUpload(revisao, analise);

  try {
    await validatePdfFile(file);
    const rawBuffer = await file.arrayBuffer();
    // O pdf.js pode transferir/detach o ArrayBuffer; mantemos cópia própria.
    const buffer = rawBuffer.slice(0);

    await validarTipoPDF(tipo, buffer);

    if (tipo === 'boletim') {
      const historico = await processarPDF(buffer, (pct) => {
        if (progressBar) progressBar.style.width = `${Math.round(pct * 50)}%`;
      });
      state.boletim = { file, historico };
    } else {
      const boa = await processarBOA(buffer);
      state.boa = { file, dados: boa };
    }

    if (progressBar) progressBar.style.width = '100%';
    updateUploadBadges();

    if (state.boletim && state.boa) {
      mergeAndDiagnose();
      renderRevisao(revisao);
      renderAnalise(analise);
    }
  } catch (err) {
    console.error(err);
    clearElement(revisao);
    revisao.hidden = false;
    const mensagem = err?.message || String(err);
    const amigavel = mensagem.includes('detached') || mensagem.includes('ArrayBuffer')
      ? 'Ocorreu um erro interno ao ler o PDF. Tente selecionar o arquivo novamente.'
      : mensagem.includes('não é um PDF válido')
      ? 'Documento inválido: o arquivo não é um PDF válido do SIGA.'
      : mensagem;
    revisao.appendChild(
      el('div', { className: 'card card-aviso' }, [
        el('h3', {}, `Erro ao processar ${tipo === 'boletim' ? 'Boletim' : 'BOA'}`),
        el('p', { className: 'text-muted' }, amigavel),
        el('p', {}, 'Se o erro persistir, verifique se anexou o arquivo correto ou tente recarregar a página.'),
      ])
    );
    // Reset para permitir nova tentativa.
    if (tipo === 'boletim') state.boletim = null;
    else state.boa = null;
    updateUploadBadges();
  } finally {
    progress?.classList.add('hidden');
  }
}

function updateUploadBadges() {
  const boletimBadge = document.getElementById('boletim-badge');
  const boaBadge = document.getElementById('boa-badge');

  if (state.boletim?.file) {
    boletimBadge.textContent = `Boletim carregado: ${state.boletim.file.name}`;
    boletimBadge.classList.remove('hidden');
  } else {
    boletimBadge.classList.add('hidden');
  }

  if (state.boa?.file) {
    boaBadge.textContent = `BOA carregado: ${state.boa.file.name}`;
    boaBadge.classList.remove('hidden');
  } else {
    boaBadge.classList.add('hidden');
  }
}

function mergeAndDiagnose() {
  const historico = state.boletim.historico;
  const boa = state.boa.dados;

  state.alertasCruzamento = validarCruzamentoDocumentos(
    state.boletim.file?.name,
    historico?.metadata,
    state.boa.file?.name,
    boa?.metadata
  );

  // BOA: adiciona disciplinas já aprovadas/cumpridas por coluna e pendências.
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
  }

  // Metadados: prioriza o Boletim, mas preenche gaps com o BOA.
  for (const campo of ['nome', 'dre', 'curso']) {
    if (!historico.metadata[campo] && boa.metadata?.[campo]) {
      historico.metadata[campo] = boa.metadata[campo];
    }
  }
  // Cursos detectados: união dos códigos do Boletim e do BOA
  // (transferência interna pode aparecer em qualquer documento).
  const cursos = new Map();
  for (const c of [
    ...(historico.metadata.cursos || []),
    ...(boa.metadata?.cursos || []),
  ]) {
    const cod = String(c).match(/\d{4,6}/)?.[0];
    if (cod && !cursos.has(cod)) cursos.set(cod, String(c));
  }
  historico.metadata.cursos = [...cursos.values()];
  if (!historico.metadata.tipoDocumento) {
    historico.metadata.tipoDocumento = 'boa';
  }

  historico.resumo = calcularCRAcumulado(historico);
  const dadosElegibilidade = {
    ...historico,
    resumoBoa: state.boa?.dados?.resumo || {},
  };
  state.diagnostico = state.regras
    ? verificarElegibilidadeEstagio(dadosElegibilidade, state.regras)
    : null;
}

function getMergedDados() {
  const historico = state.boletim?.historico || { metadata: {}, periodos: [] };
  const boa = state.boa?.dados || { obrigatorias: [], optativas: [], metadata: {} };
  return {
    metadata: {
      ...historico.metadata,
      emissaoBoa: boa.metadata?.emissao || null,
    },
    periodos: historico.periodos,
    pendencias: { obrigatorias: boa.obrigatorias || [], optativas: boa.optativas || [] },
    resumo: historico.resumo,
  };
}

function normalizarNome(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function descricaoCursos(cursos) {
  const codigos = new Set(
    (cursos || [])
      .map((c) => String(c).match(/\d{4,6}/)?.[0])
      .filter(Boolean)
  );
  if (!codigos.size) return null;
  return codigos.size > 1
    ? `${codigos.size} cursos (Transferência interna)`
    : '1 curso';
}

function parseDataBR(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function validarCruzamentoDocumentos(nomeBoletim, metaBoletim, nomeBoa, metaBoa) {
  const alertas = [];
  const nomeB = normalizarNome(metaBoletim?.nome);
  const nomeO = normalizarNome(metaBoa?.nome);
  const dreB = String(metaBoletim?.dre || '').trim();
  const dreO = String(metaBoa?.dre || '').trim();

  if (nomeB && nomeO && nomeB !== nomeO) {
    alertas.push('Os documentos anexados pertencem a discentes diferentes ou não puderam ser validados.');
  }
  if (dreB && dreO && dreB !== dreO) {
    alertas.push('Os documentos anexados pertencem a discentes diferentes ou não puderam ser validados.');
  }

  const dataB = parseDataBR(metaBoletim?.emissao);
  const dataO = parseDataBR(metaBoa?.emissao);
  if (dataB && dataO) {
    const diff = Math.abs(dataO - dataB) / (1000 * 60 * 60 * 24);
    if (diff > 10) {
      alertas.push(`Documentos com mais de 10 dias de diferença entre as datas de emissão (${Math.round(diff)} dias).`);
    }
  }

  return alertas;
}

function renderRevisao(container) {
  clearElement(container);
  container.hidden = false;
  const dados = getMergedDados();
  const { metadata, periodos, pendencias } = dados;

  container.appendChild(
    el('div', { className: 'card' }, [
      el('h3', {}, 'Confira os dados extraídos'),
      ...[
        ['Nome', metadata.nome],
        ['DRE', metadata.dre],
        ['Curso', metadata.curso],
        ['Cursos detectados', descricaoCursos(metadata.cursos)],
        ['Ingresso', metadata.ingresso],
        ['Documento', metadata.tipoDocumento],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => el('p', {}, [el('strong', {}, `${k}: `), String(v)])),
    ])
  );

  if (state.alertasCruzamento?.length) {
    container.appendChild(
      el('div', { className: 'card card-aviso' }, [
        el('h4', {}, 'Atenção: validação cruzada dos documentos'),
        el('ul', { className: 'estagio-criterios' },
          state.alertasCruzamento.map((a) =>
            el('li', { className: 'criterio-falta' }, [
              el('i', { className: 'bi bi-exclamation-circle', 'aria-hidden': 'true' }),
              el('span', {}, ` ${a}`),
            ])
          )),
      ])
    );
  }

  container.appendChild(renderCicloBasico());
  container.appendChild(renderDisciplinas(periodos));
  if (pendencias?.obrigatorias?.length || pendencias?.optativas?.length) {
    container.appendChild(renderPendencias(pendencias));
  }
  if (state.diagnostico) {
    container.appendChild(renderDiagnostico(state.diagnostico));
  }

  const erro = el('p', { className: 'login-erro', role: 'alert', hidden: true });
  const btn = el('button', { className: 'btn btn-primary btn-lg', type: 'button', id: 'btn-confirmar-submissao' },
    'Confirmar documentos e enviar à Comissão');
  btn.addEventListener('click', () => submitDocuments(btn, erro));
  updateConfirmButton();
  container.appendChild(el('div', { className: 'card submit-card' }, [btn, erro]));
}

function updateConfirmButton() {
  const btn = document.getElementById('btn-confirmar-submissao');
  if (!btn) return;
  const temAlertaBloqueante = (state.alertasCruzamento || []).some((a) =>
    a.includes('pertencem a discentes diferentes'));
  const habilitado = !!(state.boletim?.file && state.boa?.file && !temAlertaBloqueante);
  btn.disabled = !habilitado;
  btn.title = habilitado
    ? 'Enviar Boletim + BOA à Comissão'
    : 'Anexe ambos os documentos e resolva os alertas para prosseguir';
}

async function submitDocuments(btn, erro) {
  btn.disabled = true;
  erro.hidden = true;
  try {
    const dados = getMergedDados();
    const metadata = {
      ...dados.metadata,
      nomeArquivoBoletim: state.boletim.file?.name || 'boletim.pdf',
      nomeArquivoBoa: state.boa.file?.name || 'boa.pdf',
    };
    const form = new FormData();
    form.append('boletim', state.boletim.file);
    form.append('boa', state.boa.file);
    form.append('payload', JSON.stringify({
      metadata,
      periodos: dados.periodos,
      pendencias: dados.pendencias,
      diagnostico: state.diagnostico || {},
      excecoes: state.excecoes,
      resumo_boa: state.boa?.dados?.resumo || {},
    }));
    const sub = await api('/api/submissoes', { method: 'POST', form });
    document.getElementById('discente-fluxo').hidden = true;
    renderStatus(document.getElementById('discente-status'), sub);
  } catch (err) {
    erro.textContent = err.message;
    erro.hidden = false;
    btn.disabled = false;
  }
}

/* ============================================================
   Análise / Painel analítico
   ============================================================ */

function renderAnalise(container) {
  clearElement(container);
  const dados = getMergedDados();
  if (!dados.periodos.length) return;

  const periodosComCR = dados.periodos
    .filter((p) => String(p.periodo).match(/^\d{4}\/\d$/))
    .sort((a, b) => String(a.periodo).localeCompare(String(b.periodo)))
    .map((p) => {
      const disciplinas = p.disciplinas || [];
      const { crCalculado } = calcularCRAcumulado({ periodos: [p] });
      return { periodo: p.periodo, cr: crCalculado, disciplinas };
    });

  container.appendChild(
    el('div', { className: 'card' }, [
      el('h3', {}, 'Evolução do CR por Período'),
      renderSvgCrEvolution(periodosComCR, dados.resumo?.crCalculado || 0),
      el('p', { className: 'text-muted' },
        `CR acumulado: ${formatNumberBR(dados.resumo?.crCalculado || 0, 3)} — Créditos com grau: ${dados.resumo?.crRComGrau || 0}`),
    ])
  );
}

export function renderSvgCrEvolution(periodos, crAcumuladoTotal) {
  if (!periodos.length) return el('p', { className: 'text-muted' }, 'Sem dados de evolução por período.');

  const width = 700;
  const height = 300;
  const margin = { top: 20, right: 30, bottom: 60, left: 50 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  // Série acumulada
  // Acumulado oficial: soma ponderada dos pontos/créditos das disciplinas
  // que conferem grau (mesma regra de calcularCRAcumulado) — garante que o
  // último ponto coincida com o CR acumulado exibido no resumo.
  let acumulado = 0;
  let totalCrR = 0;
  const acumData = periodos.map((p) => {
    (p.disciplinas || []).forEach((x) => {
      const peso = extrairPesoDisciplina(x);
      totalCrR += peso.crR;
      acumulado += peso.pontos;
    });
    return { periodo: p.periodo, cr: totalCrR ? acumulado / totalCrR : 0 };
  });

  // O último ponto é o fechamento oficial exibido no resumo do discente.
  if (acumData.length && crAcumuladoTotal) {
    acumData[acumData.length - 1].cr = crAcumuladoTotal;
  }

  const x = (i) => margin.left + (i / Math.max(1, periodos.length - 1)) * innerW;
  const y = (cr) => margin.top + innerH - (cr / 10) * innerH;

  const pathLine = (pts) =>
    `M ${pts.map((p, i) => `${x(i)},${y(p.cr)}`).join(' L ')}`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'chart-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Gráfico de evolução do CR por período');

  // grid + eixos
  for (let v = 0; v <= 10; v += 2) {
    const yy = y(v);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('y1', yy);
    line.setAttribute('x2', width - margin.right);
    line.setAttribute('y2', yy);
    line.setAttribute('class', 'chart-grid-line');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', margin.left - 8);
    text.setAttribute('y', yy + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('class', 'chart-label');
    text.textContent = String(v);
    svg.appendChild(text);
  }

  // linha de referência CR 6.0
  const ref = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  ref.setAttribute('x1', margin.left);
  ref.setAttribute('y1', y(6));
  ref.setAttribute('x2', width - margin.right);
  ref.setAttribute('y2', y(6));
  ref.setAttribute('class', 'chart-ref-line');
  svg.appendChild(ref);

  // labels eixo X
  periodos.forEach((p, i) => {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x(i));
    text.setAttribute('y', height - margin.bottom + 25);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'chart-label-x');
    text.textContent = p.periodo;
    svg.appendChild(text);
  });

  // linha acumulada
  const pathAcum = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathAcum.setAttribute('d', pathLine(acumData));
  pathAcum.setAttribute('class', 'chart-line chart-line-acumulado');
  pathAcum.setAttribute('fill', 'none');
  svg.appendChild(pathAcum);

  // linha semestral
  const pathSem = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathSem.setAttribute('d', pathLine(periodos));
  pathSem.setAttribute('class', 'chart-line chart-line-periodo');
  pathSem.setAttribute('fill', 'none');
  svg.appendChild(pathSem);

  // pontos com tooltip
  const tooltip = el('div', { className: 'chart-tooltip', hidden: true });
  acumData.forEach((p, i) => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x(i));
    circle.setAttribute('cy', y(p.cr));
    circle.setAttribute('r', '5');
    circle.setAttribute('class', 'chart-dot chart-dot-acumulado');
    circle.setAttribute('tabindex', '0');
    circle.addEventListener('mouseenter', () => {
      tooltip.hidden = false;
      tooltip.textContent = `${p.periodo}: CR acumulado ${formatNumberBR(p.cr, 3)}`;
    });
    circle.addEventListener('mouseleave', () => {
      tooltip.hidden = true;
    });
    svg.appendChild(circle);
  });

  const wrapper = el('div', { className: 'chart-wrap' }, [
    svg,
    el('div', { className: 'chart-legenda' }, [
      el('span', { className: 'chart-legenda-item' }, [
        el('span', { className: 'chart-swatch chart-swatch-acumulado' }),
        ' CR acumulado',
      ]),
      el('span', { className: 'chart-legenda-item' }, [
        el('span', { className: 'chart-swatch chart-swatch-periodo' }),
        ' CR semestral',
      ]),
    ]),
    tooltip,
  ]);
  return wrapper;
}

/* ============================================================
   Status / acompanhamento
   ============================================================ */

function renderStatus(container, sub) {
  clearElement(container);
  const concluida = !STATUS_ATIVOS.includes(sub.status);

  const btnCancelar = !concluida
    ? el('button', { className: 'btn btn-danger', type: 'button' }, 'Cancelar Solicitação')
    : null;
  if (btnCancelar) {
    btnCancelar.addEventListener('click', async () => {
      if (!confirm('Tem certeza que deseja cancelar esta solicitação?')) return;
      try {
        await api(`/api/submissoes/${sub.id}/cancelar`, { method: 'POST' });
        await initPortal();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  container.appendChild(
    el('div', { className: 'card' }, [
      el('div', { className: 'estagio-header' }, [
        el('h3', {}, 'Sua Submissão'),
        el('span', { className: `badge ${STATUS_BADGE[sub.status] || 'badge-neutro'}` },
          STATUS_LABEL[sub.status] || sub.status),
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
            className: `card card-autorizacao ${sub.autorizacao.expirada || sub.autorizacao.diasParaVencer <= 30 ? 'card-aviso' : ''}`,
          }, [
            el('strong', {}, `Autorização de estágio ${sub.autorizacao.expirada ? 'expirada' : 'vigente'}`),
            el('p', {},
              `Liberada em ${new Date(sub.autorizacao.liberadaEm).toLocaleDateString('pt-BR')} · ` +
              `válida até ${new Date(sub.autorizacao.validaAte).toLocaleDateString('pt-BR')}` +
              (sub.autorizacao.expirada ? '' : ` (${sub.autorizacao.diasParaVencer} dias restantes)`)),
            isAutorizacaoBloqueante(sub.autorizacao)
              ? el('p', { className: 'card-aviso-texto' },
                  `Você já possui uma autorização de estágio vigente até ${new Date(sub.autorizacao.validaAte).toLocaleDateString('pt-BR')}. ` +
                  'A renovação só fica disponível 30 dias antes do vencimento.')
              : null,
          ])
        : null,
      sub.status === 'devolvida'
        ? el('p', { className: 'card-aviso-texto' },
            'Corrija os dados apontados pela Comissão e reenvie ambos os documentos abaixo.')
        : null,
      sub.alertas?.length && !concluida
        ? el('p', { className: 'text-muted' }, 'Seu caso está na Mesa de Revisão para conferência detalhada.')
        : null,
      btnCancelar,
    ])
  );
}

async function renderHistorico() {
  const container = document.getElementById('discente-historico');
  if (!container) return;
  clearElement(container);

  let resp;
  try {
    resp = await api('/api/submissoes/minhas');
  } catch {
    return;
  }
  const subs = resp.submissoes || [];
  if (!subs.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const rows = subs.map((s) => {
    const decisao = s.decisao;
    return el('tr', {}, [
      el('td', {}, new Date(s.criadoEm).toLocaleDateString('pt-BR')),
      el('td', {}, [
        s.documentos?.boletim?.nome || '—',
        el('br'),
        s.documentos?.boa?.nome || '—',
      ]),
      el('td', {}, [
        el('span', { className: `badge ${STATUS_BADGE[s.status] || 'badge-neutro'}` },
          STATUS_LABEL[s.status] || s.status),
      ]),
      el('td', {}, decisao
        ? `${new Date(decisao.decididoEm).toLocaleDateString('pt-BR')}${decisao.motivo ? ' · ' + decisao.motivo : ''}`
        : '—'),
    ]);
  });

  container.appendChild(el('div', { className: 'card' }, [
    el('h3', {}, 'Histórico de Solicitações'),
    el('div', { className: 'table-container' }, [
      el('table', { className: 'triage-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', {}, 'Data do Envio'),
            el('th', {}, 'Documentos Anexados'),
            el('th', {}, 'Status'),
            el('th', {}, 'Parecer / Motivo'),
          ]),
        ]),
        el('tbody', {}, rows),
      ]),
    ]),
  ]));
}

/* ============================================================
   Ciclo básico, exceções e demais renderers
   ============================================================ */

function renderCicloBasico() {
  const dados = getMergedDados();
  const faltantes = state.regras
    ? disciplinasFaltantesCicloBasico(dados, state.regras)
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
        className: 'btn-icon', type: 'button', 'aria-label': 'Remover exceção',
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
      const btn = el('button', { className: 'btn btn-secondary btn-sm', type: 'button' }, 'Declarar exceção');
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
  document.querySelector('.excecao-form')?.remove();

  const tipo = el('select', { 'aria-label': 'Tipo de exceção' }, [
    el('option', { value: 'equivalencia' }, 'Equivalência'),
    el('option', { value: 'aproveitamento' }, 'Aproveitamento'),
    el('option', { value: 'dispensa' }, 'Dispensa'),
    el('option', { value: 'acordo' }, 'Solicitar Acordo (cursar e concluir no semestre corrente)'),
  ]);
  const ajudaTipo = el('p', { className: 'text-muted excecao-ajuda' });
  tipo.addEventListener('change', () => {
    ajudaTipo.textContent = tipo.value === 'acordo'
      ? 'Solicitação de acordo para cursar e concluir a disciplina pendente no semestre corrente.'
      : '';
  });
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
    el('label', {}, ['Tipo ', tipo, ajudaTipo]),
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
            el('span', { className: `badge ${badgeClassForSituacao(d.situacao)}` }, d.situacao),
          ]),
        ])
      );
    });
  });

  const body = el('div', { className: 'periodo-body hidden' }, [
    el('div', { className: 'table-container' }, [
      el('table', {}, [
        el('caption', {}, 'Disciplinas extraídas dos documentos'),
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

function disciplinaAprovada(d) {
  const sit = String(d.situacao || d.status || '').toUpperCase().trim();
  return sit === 'AP' || sit === 'T' || sit === 'A' || sit === 'NCC' || sit === 'NCG';
}

function getCodigosCicloBasico() {
  const regras = state.regras || {};
  const codigos = new Set();
  (regras.ciclo_basico || []).forEach((r) => {
    codigos.add(String(r.codigo || '').trim().toUpperCase());
    (r.aceitos || []).forEach((a) => codigos.add(String(a || '').trim().toUpperCase()));
    (r.aceitos_conjunto || []).flat().forEach((a) => codigos.add(String(a || '').trim().toUpperCase()));
  });
  return codigos;
}

function getOptativasCursadas(pendencias) {
  const obrigatorias = getCodigosCicloBasico();
  const catalogo = new Set(
    (pendencias.optativas || [])
      .map((o) => String(o.codigo || '').trim().toUpperCase())
      .filter(Boolean)
  );
  const vistos = new Set();
  const resultado = [];
  const adicionar = (codigo, nome, detalhes = {}) => {
    const c = String(codigo || '').trim().toUpperCase();
    if (!c || vistos.has(c) || obrigatorias.has(c)) return;
    // Aceita se está no catálogo de optativas do BOA OU já tem nota/conceito (aprovada).
    const noCatalogo = catalogo.has(c);
    const temNota = detalhes.grau != null || detalhes.situacao;
    if (!noCatalogo && !temNota) return;
    vistos.add(c);
    resultado.push({
      codigo: c,
      nome: nome || c,
      grau: detalhes.grau != null ? formatNumberBR(detalhes.grau, 1) : null,
      situacao: detalhes.situacao || 'AP',
    });
  };

  // Boletim: disciplinas aprovadas que não fazem parte do ciclo básico.
  (state.boletim?.historico?.periodos || []).forEach((p) => {
    (p.disciplinas || []).forEach((d) => {
      if (disciplinaAprovada(d)) adicionar(d.codigo, d.nome, d);
    });
  });
  // BOA: aprovadas/cumpridos da zona superior.
  (state.boa?.dados?.aprovadas || []).forEach((d) => adicionar(d.codigo, d.nome, d));
  (state.boa?.dados?.cumpridos || []).forEach((d) => adicionar(d, d, {}));

  return resultado;
}

const STATUS_PENDENCIA = {
  inscricao_vedada: 'Inscrição Vedada',
  inscricao_facultada: 'Inscrição Facultada',
  a_cursar: 'A Cursar',
  cursando: 'Cursando',
};

function calcularCreditosEletivasPorBoletim(periodos, regras) {
  if (!regras) return 0;
  const obrigatorias = new Set();
  for (const req of regras.ciclo_basico || []) {
    obrigatorias.add(String(req.codigo || '').trim().toUpperCase());
    (req.aceitos || []).forEach((cod) =>
      obrigatorias.add(String(cod || '').trim().toUpperCase())
    );
  }
  let total = 0;
  for (const p of periodos || []) {
    for (const d of p.disciplinas || []) {
      if (!disciplinaConcluida(d)) continue;
      const cod = String(d.codigo || '').trim().toUpperCase();
      if (obrigatorias.has(cod)) continue;
      total += Number(d.crR) || 0;
    }
  }
  return total;
}

/**
 * Calcula o progresso de integralização do curso a partir do Boletim
 * (fonte única da verdade), unindo créditos obrigatórios pendentes e
 * créditos de eletivas/optativas já cumpridos.
 *
 * @param {Array<object>} periodos
 * @param {object} regras
 * @returns {{
 *   faltantesObrigatorias: number,
 *   faltantesEletivas: number,
 *   creditosEletivasCumpridos: number,
 *   creditosRestantes: number,
 *   obrigatoriasFaltantes: Array<object>
 * }}
 */
export function calcularProgressoIntegralizacao(periodos, regras) {
  const obrigatoriasFaltantes = disciplinasFaltantesCicloBasico(
    { periodos },
    regras
  );
  const faltantesObrigatorias = obrigatoriasFaltantes.reduce(
    (s, r) => s + (Number(r.crR) || 4),
    0
  );
  const creditosEletivasCumpridos = calcularCreditosEletivasPorBoletim(
    periodos,
    regras
  );
  const faltantesEletivas = Math.max(0, 44 - creditosEletivasCumpridos);

  return {
    faltantesObrigatorias,
    faltantesEletivas,
    creditosEletivasCumpridos,
    creditosRestantes: faltantesObrigatorias + faltantesEletivas,
    obrigatoriasFaltantes,
  };
}

function renderPendencias(pendencias) {
  const formatarStatus = (status) =>
    STATUS_PENDENCIA[status] || (status ? String(status).replace(/_/g, ' ') : 'Pendente');
  const itemObr = (d) =>
    el('li', {}, `${d.codigo || d.nome} — ${formatarStatus(d.status)}`);

  // Fonte única da verdade: Boletim (disciplinas aprovadas).
  const progresso = calcularProgressoIntegralizacao(
    state.boletim?.historico?.periodos,
    state.regras
  );
  const creditosEletivasCumpridos = progresso.creditosEletivasCumpridos;
  const faltantesEletivas = progresso.faltantesEletivas;
  const creditosRestantes = progresso.creditosRestantes;

  const renderOptativas = () => {
    if (faltantesEletivas <= 0) {
      return el('div', { className: 'slot-preenchido' },
        `Eletivas e Optativas Concluídas (${creditosEletivasCumpridos}/44 créditos)`);
    }
    return el('div', { className: 'slot-vago' },
      `Faltam ${faltantesEletivas} créditos (Cumpridos: ${creditosEletivasCumpridos}/44)`);
  };

  const optativasCursadas = getOptativasCursadas(pendencias);
  const listaOptativas = optativasCursadas.length
    ? el('ul', { className: 'optativas-lista' },
        optativasCursadas.map((d) =>
          el('li', {},
            `${d.codigo} — ${d.nome}${d.grau ? ` (${d.grau})` : ''}`)
        ))
    : el('p', { className: 'text-muted' }, 'Nenhuma optativa/eletiva detectada.');

  const cardPendencias = el('div', { className: 'card' }, [
    el('h3', {}, 'Pendências detectadas (BOA)'),
    el('div', { className: 'cards-grid' }, [
      el('div', {}, [
        el('h4', {}, 'Obrigatórias'),
        el('ul', { className: 'pendencias-obr' },
          (pendencias.obrigatorias || []).length
            ? (pendencias.obrigatorias || []).map(itemObr)
            : [el('li', { className: 'text-muted' }, 'Nenhuma obrigatória pendente.')]),
      ]),
      el('div', {}, [
        el('h4', {}, 'Optativas/Eletivas'),
        renderOptativas(),
        listaOptativas,
      ]),
    ]),
  ]);

  const cardJornada = el('div', { className: 'card card-jornada-info' }, [
    el('strong', {}, 'Jornada de Estágio Permitida (Normas 2025 - Art. 2º):'),
    el('div', {}, [
      el('span', {}, 'Créditos restantes para conclusão do curso: '),
      el('strong', {}, String(creditosRestantes)),
      ' ',
      el('span', {
        className: `badge ${creditosRestantes <= 10 ? 'badge-ap' : 'badge-cursando'}`,
      }, creditosRestantes <= 10
        ? 'Elegível para até 30h semanais'
        : 'Carga horária máxima: 20h semanais'),
    ]),
    el('p', { className: 'text-muted jornada-ajuda' },
      creditosRestantes <= 10
        ? 'Autorização de 30h permitida por até 6 meses (Art. 2º, §1º).'
        : 'Estágios de 30h só são permitidos quando faltarem no máximo 10 créditos para conclusão.'),
  ]);

  return el('div', {}, [cardPendencias, cardJornada]);
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
