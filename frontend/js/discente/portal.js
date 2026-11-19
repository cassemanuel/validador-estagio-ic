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
  extrairPesoDisciplina,
} from '../domain/cr.js';
import {
  carregarRegras,
  disciplinasFaltantesCicloBasico,
  disciplinasObrigatoriasFaltantes,
  verificarElegibilidadeEstagio,
} from '../rules/ppc2022.js';
import {
  el,
  badgeClassForSituacao,
  clearElement,
  formatNumberBR,
  validatePdfFile,
} from '../ui/dom.js';
import { dialogConfirmar, dialogAviso } from '../ui/dialog.js';
import {
  CREDITOS_ELETIVAS_EXIGIDOS,
  FONTE_BOA_CUMPRIDA,
  PERIODO_BOA,
  creditosEletivasCursadas,
  disciplinaCursada,
  listarEletivasCursadas,
} from '../domain/eletivas.js';

const state = {
  boletim: null, // { file, historico } — histórico do Boletim, nunca mutado
  boa: null,     // { file, dados }
  merged: null,  // { metadata, periodos, resumo } — Boletim + aprovadas do BOA
  regras: null,
  diagnostico: null,
  excecoes: [],
  alertasCruzamento: [],
  submissaoBloqueada: false,
  // 'submissao' quando a análise foi pré-carregada do banco: o primeiro
  // upload novo descarta tudo para não misturar documentos.
  origem: null,
};

// Listeners do portal são registrados uma única vez: initPortal() roda a cada
// navegação para /aluno e, sem esta trava, cada upload disparava o parsing N
// vezes, com respostas concorrentes sobrescrevendo o estado.
let listenersRegistrados = false;

const STATUS_LABEL = {
  fila_regular: 'Na fila de aprovação',
  mesa_revisao: 'Em revisão pela Comissão',
  aprovada: 'Aprovada',
  indeferida: 'Indeferida',
  devolvida: 'Devolvida para correção',
  cancelada: 'Cancelada pelo discente',
  revogada: 'Autorização revogada pela Comissão',
  arquivada: 'Processo arquivado',
};

const STATUS_BADGE = {
  fila_regular: 'badge-cursando',
  mesa_revisao: 'badge-cursando',
  aprovada: 'badge-ap',
  indeferida: 'badge-reprovado',
  devolvida: 'badge-neutro',
  cancelada: 'badge-neutro',
  revogada: 'badge-reprovado',
  arquivada: 'badge-neutro',
};

const STATUS_ATIVOS = ['fila_regular', 'mesa_revisao'];

export async function initPortal() {
  const statusEl = document.getElementById('discente-status');
  const fluxoEl = document.getElementById('discente-fluxo');
  const btnLimpar = document.getElementById('btn-limpar-documentos');
  const alunoNav = document.getElementById('aluno-nav');
  const tabSub = document.getElementById('aluno-tab-submissao');
  const tabAnalise = document.getElementById('aluno-tab-analise');
  const btnAnalise = alunoNav?.querySelector('[data-aluno-tab="analise"]');

  const ativarAba = (nome) => {
    alunoNav?.querySelectorAll('[data-aluno-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.alunoTab === nome);
    });
    if (tabSub) tabSub.hidden = nome !== 'submissao';
    if (tabAnalise) tabAnalise.hidden = nome !== 'analise';
  };

  const habilitarAnalise = (habilitar) => {
    if (!btnAnalise) return;
    btnAnalise.disabled = !habilitar;
    if (habilitar) {
      btnAnalise.removeAttribute('data-tooltip');
    } else {
      btnAnalise.setAttribute('data-tooltip', 'Ativa somente ao carregar o BOA e o Boletim');
    }
  };

  const limparTela = () => {
    resetUploadState();
    clearElement(document.getElementById('discente-revisao'));
    clearElement(document.getElementById('discente-analise'));
    document.getElementById('discente-revisao').hidden = true;
    ativarAba('submissao');
    habilitarAnalise(false);
  };

  if (!listenersRegistrados) {
    listenersRegistrados = true;
    initUploads();

    alunoNav?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-aluno-tab]');
      if (!btn || btn.disabled) return;
      ativarAba(btn.dataset.alunoTab);
    });

    btnLimpar?.addEventListener('click', limparTela);
  }

  // Cada entrada no portal parte do zero: nada da visita anterior (uploads,
  // diagnóstico, exceções) sobrevive; os dados do banco são recarregados.
  limparTela();

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
  state.submissaoBloqueada = ativo || autorizacaoBloqueante;

  // Sempre exibe o fluxo como simulador; o envio é controlado separadamente.
  fluxoEl.hidden = false;
  renderStatus(statusEl, submissao);

  // Pré-renderiza a análise com os dados da submissão existente, liberando
  // a aba "Análise de Desempenho" mesmo sem novo upload.
  if (carregarSubmissaoExistente(submissao)) {
    const revisao = document.getElementById('discente-revisao');
    const analise = document.getElementById('discente-analise');
    if (revisao && analise) {
      renderRevisao(revisao);
      renderAnalise(analise);
      habilitarAnalise(true);
    }
  }

  aplicarBloqueioDeEnvio();
}

function carregarSubmissaoExistente(sub) {
  if (!sub?.periodos?.length) return false;

  // O payload salvo já traz o período sintético do BOA; separa de volta o que
  // é do Boletim e o que veio do BOA para o merge recompor sem duplicar.
  const periodosBoletim = sub.periodos.filter((p) => p.periodo !== PERIODO_BOA);
  const doBoa = sub.periodos
    .filter((p) => p.periodo === PERIODO_BOA)
    .flatMap((p) => p.disciplinas || []);

  state.boletim = {
    file: null,
    historico: {
      metadata: {
        ...(sub.metadata || {}),
        tipoDocumento: sub.tipoDocumento || sub.metadata?.tipoDocumento || 'boletim',
      },
      periodos: periodosBoletim,
    },
  };
  state.boa = {
    file: null,
    dados: {
      metadata: sub.metadata || {},
      resumo: sub.resumoBoa || {},
      obrigatorias: sub.pendencias?.obrigatorias || [],
      optativas: sub.pendencias?.optativas || [],
      aprovadas: doBoa.filter((d) => d.fonte !== FONTE_BOA_CUMPRIDA),
      cumpridos: doBoa.filter((d) => d.fonte === FONTE_BOA_CUMPRIDA),
    },
  };
  state.origem = 'submissao';
  mergeAndDiagnose();
  state.diagnostico = sub.diagnostico || state.diagnostico;
  return true;
}

function aplicarBloqueioDeEnvio() {
  const fluxo = document.getElementById('discente-fluxo');
  const submitCard = document.querySelector('#discente-revisao .submit-card');
  if (!fluxo) return;

  let aviso = document.getElementById('simulador-aviso');
  if (state.submissaoBloqueada) {
    if (!aviso) {
      aviso = el('div', { className: 'card card-aviso', id: 'simulador-aviso' }, [
        el('i', { className: 'bi bi-info-circle' }),
        el('span', {}, 'Você possui uma submissão em análise ou autorização vigente. O envio oficial está bloqueado, mas você pode anexar documentos atualizados abaixo apenas para visualizar sua Análise de Desempenho e simular sua grade.'),
      ]);
      fluxo.insertBefore(aviso, fluxo.firstChild);
    }
    if (submitCard) submitCard.style.display = 'none';
  } else {
    if (aviso) aviso.remove();
    if (submitCard) submitCard.style.display = '';
  }
}

function isAutorizacaoBloqueante(autorizacao) {
  if (!autorizacao || autorizacao.expirada) return false;
  // A janela de renovação é regra do servidor (RENOVACAO_JANELA_DIAS), que
  // também bloqueia o envio; o fallback de 30 dias cobre respostas antigas.
  if (typeof autorizacao.renovavel === 'boolean') return !autorizacao.renovavel;
  return autorizacao.diasParaVencer > 30;
}

function resetUploadState() {
  state.boletim = null;
  state.boa = null;
  state.merged = null;
  state.diagnostico = null;
  state.excecoes = [];
  state.alertasCruzamento = [];
  state.origem = null;
  updateUploadBadges();
  updateConfirmButton();
}

/** Desabilita a aba de análise até haver Boletim e BOA desta sessão. */
function bloquearAbaAnalise() {
  const btn = document.querySelector('[data-aluno-tab="analise"]');
  if (!btn) return;
  btn.disabled = true;
  btn.setAttribute('data-tooltip', 'Ativa somente ao carregar o BOA e o Boletim');
  document.querySelector('[data-aluno-tab="submissao"]')?.click();
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

  // Análise pré-carregada do banco: o primeiro documento novo descarta o par
  // antigo inteiro (nunca mistura Boletim novo com BOA de outra submissão).
  if (state.origem === 'submissao') resetUploadState();
  // Qualquer troca de documento invalida o merge e o diagnóstico anteriores.
  state.merged = null;
  state.diagnostico = null;
  state.alertasCruzamento = [];
  state.excecoes = [];
  state.origem = 'upload';
  bloquearAbaAnalise();

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
      const btnAnalise = document.querySelector('[data-aluno-tab="analise"]');
      if (btnAnalise) {
        btnAnalise.disabled = false;
        btnAnalise.title = '';
      }
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
    state.merged = null;
    state.diagnostico = null;
    updateUploadBadges();
    updateConfirmButton();
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

  // O histórico do Boletim é a fonte da verdade e nunca é alterado: o merge
  // produz um objeto novo a cada chamada (troca de BOA não deixa resíduo).
  const periodosBoletim = (historico.periodos || [])
    .filter((p) => p.periodo !== PERIODO_BOA);
  const existentes = new Set(
    periodosBoletim.flatMap((p) => (p.disciplinas || [])
      .map((d) => String(d.codigo || '').trim().toUpperCase()))
  );

  // BOA complementa só com o que está concluído e ausente do Boletim:
  // zona de aprovadas (código real) e colunas do elenco já cumpridas (estas
  // contam para obrigatórias/equivalências, nunca como eletivas).
  const doBoa = [];
  for (const d of [...(boa.aprovadas || []), ...(boa.cumpridos || [])]) {
    const codigo = String(d.codigo || '').trim().toUpperCase();
    if (!codigo || existentes.has(codigo) || !disciplinaCursada(d)) continue;
    existentes.add(codigo);
    doBoa.push({ ...d });
  }
  const periodos = doBoa.length
    ? [...periodosBoletim, { periodo: PERIODO_BOA, disciplinas: doBoa, totais: {} }]
    : periodosBoletim;

  // Metadados: prioriza o Boletim, mas preenche gaps com o BOA.
  const metadata = { ...(historico.metadata || {}) };
  for (const campo of ['nome', 'dre', 'curso']) {
    if (!metadata[campo] && boa.metadata?.[campo]) metadata[campo] = boa.metadata[campo];
  }
  // Cursos detectados: união dos códigos do Boletim e do BOA
  // (transferência interna pode aparecer em qualquer documento).
  const cursos = new Map();
  for (const c of [...(metadata.cursos || []), ...(boa.metadata?.cursos || [])]) {
    const cod = String(c).match(/\d{4,6}/)?.[0];
    if (cod && !cursos.has(cod)) cursos.set(cod, String(c));
  }
  metadata.cursos = [...cursos.values()];
  if (!metadata.tipoDocumento) metadata.tipoDocumento = 'boa';

  const merged = { metadata, periodos };
  merged.resumo = calcularCRAcumulado(merged);
  state.merged = merged;

  state.diagnostico = state.regras
    ? verificarElegibilidadeEstagio(
      { ...merged, resumoBoa: boa.resumo || {} },
      state.regras
    )
    : null;
}

function getMergedDados() {
  const base = state.merged
    || { metadata: state.boletim?.historico?.metadata || {}, periodos: state.boletim?.historico?.periodos || [] };
  const boa = state.boa?.dados || { obrigatorias: [], optativas: [], metadata: {} };
  return {
    metadata: {
      ...base.metadata,
      emissaoBoa: boa.metadata?.emissao || null,
    },
    periodos: base.periodos,
    pendencias: { obrigatorias: boa.obrigatorias || [], optativas: boa.optativas || [] },
    resumo: base.resumo,
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
  const { metadata, pendencias } = dados;

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
  if (state.diagnostico) {
    container.appendChild(renderDiagnostico(state.diagnostico));
  }
  container.appendChild(renderJornada());

  const erro = el('p', { className: 'login-erro', role: 'alert', hidden: true });
  const btn = el('button', { className: 'btn btn-primary btn-lg', type: 'button', id: 'btn-confirmar-submissao' },
    'Confirmar documentos e enviar à Comissão');
  btn.addEventListener('click', () => submitDocuments(btn, erro));
  updateConfirmButton();
  container.appendChild(el('div', { className: 'card submit-card' }, [btn, erro]));

  aplicarBloqueioDeEnvio();
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

  if (dados.pendencias?.obrigatorias?.length || dados.pendencias?.optativas?.length) {
    container.appendChild(renderPendencias(dados.pendencias));
  }
  container.appendChild(renderDisciplinas(dados.periodos));

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

  // pontos com tooltip — o balão acompanha o ponto (acima dele; abaixo quando
  // não há espaço no topo) e fica limitado à área do gráfico, sem cobrir a
  // legenda, que é renderizada fora do SVG.
  const tooltip = el('div', { className: 'chart-tooltip', role: 'tooltip', hidden: true });
  let wrapper = null;
  const mostrarTooltip = (i, ponto) => {
    const semestral = periodos[i]?.cr;
    tooltip.textContent = `${ponto.periodo}: CR acumulado ${formatNumberBR(ponto.cr, 3)}`
      + (typeof semestral === 'number' ? ` · semestral ${formatNumberBR(semestral, 3)}` : '');
    tooltip.hidden = false;

    const caixaSvg = svg.getBoundingClientRect();
    const caixaWrap = wrapper.getBoundingClientRect();
    const escalaX = caixaSvg.width / width;
    const escalaY = caixaSvg.height / height;
    const pontoX = caixaSvg.left - caixaWrap.left + wrapper.scrollLeft + x(i) * escalaX;
    const pontoY = caixaSvg.top - caixaWrap.top + y(ponto.cr) * escalaY;

    const meiaLargura = tooltip.offsetWidth / 2;
    const minX = wrapper.scrollLeft + meiaLargura + 4;
    const maxX = wrapper.scrollLeft + wrapper.clientWidth - meiaLargura - 4;
    tooltip.style.left = `${Math.min(Math.max(pontoX, minX), Math.max(minX, maxX))}px`;
    tooltip.style.top = `${pontoY}px`;
    tooltip.classList.toggle('chart-tooltip-abaixo', pontoY < tooltip.offsetHeight + 14);
  };
  const esconderTooltip = () => { tooltip.hidden = true; };

  acumData.forEach((p, i) => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x(i));
    circle.setAttribute('cy', y(p.cr));
    circle.setAttribute('r', '5');
    circle.setAttribute('class', 'chart-dot chart-dot-acumulado');
    circle.setAttribute('tabindex', '0');
    circle.setAttribute('aria-label', `${p.periodo}: CR acumulado ${formatNumberBR(p.cr, 3)}`);
    circle.addEventListener('mouseenter', () => mostrarTooltip(i, p));
    circle.addEventListener('focus', () => mostrarTooltip(i, p));
    circle.addEventListener('mouseleave', esconderTooltip);
    circle.addEventListener('blur', esconderTooltip);
    svg.appendChild(circle);
  });

  wrapper = el('div', { className: 'chart-wrap' }, [
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
      const ok = await dialogConfirmar({
        titulo: 'Cancelar Solicitação',
        mensagem: 'Tem certeza que deseja cancelar esta solicitação? Os PDFs enviados serão apagados e a ação não pode ser desfeita.',
        comMotivo: false,
        labelOk: 'Cancelar solicitação',
      });
      if (!ok) return;
      btnCancelar.disabled = true;
      try {
        await api(`/api/submissoes/${sub.id}/cancelar`, { method: 'POST' });
        await initPortal();
      } catch (err) {
        btnCancelar.disabled = false;
        await dialogAviso('Não foi possível cancelar', err.message);
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
            className: `card card-autorizacao ${sub.autorizacao.expirada || !isAutorizacaoBloqueante(sub.autorizacao) ? 'card-aviso' : ''}`,
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

  const reqNodes = faltantes.map((req) => {
    const row = el('li', { className: 'criterio-falta' }, [
      el('i', {
        className: 'bi bi-exclamation-circle',
        'aria-hidden': 'true',
      }),
      el('span', {}, ` ${req.codigo} — ${req.nome} (${req.periodo}º período)`),
    ]);
    const btn = el('button', { className: 'btn btn-secondary btn-sm', type: 'button' }, 'Declarar exceção');
    btn.addEventListener('click', () => abrirFormExcecao(req, listaExcecoes, redesenharExcecoes));
    row.appendChild(btn);
    return row;
  });

  return el('div', { className: 'card' }, [
    el('h3', {}, 'Ciclo Básico'),
    el('p', { className: 'text-muted' },
      'Disciplina não detectada mas cursada? Declare uma exceção ' +
      '(equivalência, dispensa ou aproveitamento) para a Comissão avaliar.'),
    faltantes.length
      ? el('ul', { className: 'estagio-criterios' }, reqNodes)
      : el('p', { className: 'criterio-ok' }, 'Todas as disciplinas do ciclo básico foram concluídas.'),
    listaExcecoes,
  ]);
}

function abrirFormExcecao(req, lista, redesenhar) {
  document.querySelector('.excecao-form')?.remove();

  const tipo = el('select', { 'aria-label': 'Tipo de exceção' }, [
    el('option', { value: 'acordo' }, 'Solicitar Acordo (cursar e concluir no semestre corrente)'),
    el('option', { value: 'outros' }, 'Outro(s)'),
  ]);
  const ajudaTipo = el('p', { className: 'text-muted excecao-ajuda' },
    'Solicitação de acordo para cursar e concluir a disciplina pendente no semestre corrente.');
  const codigo = el('input', {
    type: 'text', placeholder: 'Disciplina cursada (ex.: MAE111)', maxLength: '16',
  });
  const just = el('textarea', {
    placeholder: 'Justificativa (máx. 300 palavras)...',
    rows: '3', maxLength: '2000', required: true,
  });
  const salvar = el('button', { className: 'btn btn-primary btn-sm', type: 'button' }, 'Adicionar');
  const cancelar = el('button', { className: 'btn btn-secondary btn-sm', type: 'button' }, 'Cancelar');

  const form = el('div', { className: 'card card-aviso excecao-form' }, [
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
          el('td', {}, d.grau !== null && d.grau !== undefined ? formatNumberBR(d.grau, 1) : '—'),
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

/**
 * Eletivas/optativas cursadas para exibição: Boletim + zona de aprovadas do
 * BOA, sem obrigatórias do PPC e sem colunas do elenco recomendado (regra em
 * domain/eletivas.js).
 */
function getOptativasCursadas() {
  return listarEletivasCursadas(getMergedDados().periodos, state.regras)
    .map((d) => ({
      ...d,
      grau: typeof d.grau === 'number' ? formatNumberBR(d.grau, 1) : d.grau,
    }));
}

const STATUS_PENDENCIA = {
  inscricao_vedada: 'Inscrição Vedada',
  inscricao_facultada: 'Inscrição Facultada',
  a_cursar: 'A Cursar',
  cursando: 'Cursando',
};

// Cores discretas por status do BOA (mesma escala dos badges de situação).
const BADGE_STATUS_PENDENCIA = {
  cursando: 'badge-cursando',
  inscricao_facultada: 'badge-ciano',
  inscricao_vedada: 'badge-reprovado',
  a_cursar: 'badge-neutro',
};

const ROTULO_SITUACAO = {
  AP: 'Aprovada',
  A: 'Aprovada',
  T: 'Aproveitamento',
  NCC: 'Sem crédito',
  NCG: 'Sem grau',
};

function calcularCreditosEletivasPorBoletim(periodos, regras) {
  return creditosEletivasCursadas(periodos, regras);
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
  const obrigatoriasFaltantes = disciplinasObrigatoriasFaltantes(
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
  const faltantesEletivas = Math.max(0, CREDITOS_ELETIVAS_EXIGIDOS - creditosEletivasCumpridos);

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
    STATUS_PENDENCIA[String(status || '').toLowerCase()]
      || (status ? String(status).replace(/_/g, ' ') : 'Pendente');
  const badgeStatus = (status) => el('span', {
    className: `badge ${BADGE_STATUS_PENDENCIA[String(status || '').toLowerCase()] || 'badge-neutro'}`,
  }, formatarStatus(status));

  /** Linha de disciplina: código · nome · badges (sem bullets). */
  const linhaDisciplina = (codigo, nome, badges) =>
    el('li', { className: 'disc-linha' }, [
      el('span', { className: 'disc-codigo' }, codigo || '—'),
      el('span', { className: 'disc-nome' }, nome || codigo || '—'),
      el('span', { className: 'disc-badges' }, badges),
    ]);

  const itemObr = (d) => linhaDisciplina(d.codigo, d.nome, [badgeStatus(d.status)]);
  const itemOpt = (d) => linhaDisciplina(d.codigo, d.nome, [
    d.grau ? el('span', { className: 'disc-grau' }, `grau ${d.grau}`) : null,
    el('span', { className: `badge ${badgeClassForSituacao(d.situacao)}` },
      ROTULO_SITUACAO[d.situacao] || d.situacao),
  ]);

  // Agrupa obrigatórias pendentes pelo período recomendado do BOA.
  const renderObrigatoriasPorPeriodo = () => {
    const grupos = new Map();
    const semPeriodo = [];
    for (const d of pendencias.obrigatorias || []) {
      const p = d.periodoRecomendado;
      if (p === null || p === undefined) {
        semPeriodo.push(d);
      } else {
        if (!grupos.has(p)) grupos.set(p, []);
        grupos.get(p).push(d);
      }
    }
    const ordenado = [...grupos.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    if (semPeriodo.length) ordenado.push(['não identificado', semPeriodo]);

    return ordenado.map(([periodo, lista]) =>
      el('div', {}, [
        el('h5', { className: 'disc-grupo' },
          typeof periodo === 'number'
            ? `${periodo}º período`
            : 'Período não identificado'),
        el('ul', { className: 'lista-disciplinas' }, lista.map(itemObr)),
      ])
    );
  };

  // Fonte única da verdade: Boletim (disciplinas aprovadas).
  const progresso = calcularProgressoIntegralizacao(
    getMergedDados().periodos,
    state.regras
  );
  const creditosEletivasCumpridos = progresso.creditosEletivasCumpridos;
  const faltantesEletivas = progresso.faltantesEletivas;
  const creditosRestantes = progresso.creditosRestantes;

  const renderOptativasBadge = () => {
    if (faltantesEletivas <= 0) {
      return el('div', { className: 'slot-preenchido' },
        `Eletivas e Optativas Concluídas (${creditosEletivasCumpridos}/44 créditos)`);
    }
    return el('div', { className: 'slot-vago' },
      `Faltam ${faltantesEletivas} créditos (Cumpridos: ${creditosEletivasCumpridos}/44)`);
  };

  // Heurística visual de categorização de eletivas/optativas já cursadas.
  const optativasCursadas = getOptativasCursadas()
    .slice()
    .sort((a, b) => String(a.codigo || '').localeCompare(String(b.codigo || '')));
  const categorias = { condicionadas: [], restrita: [], livres: [] };
  for (const d of optativasCursadas) {
    const c = String(d.codigo || '').toUpperCase();
    if (c.startsWith('ICP') || c === 'LEB599') {
      categorias.condicionadas.push(d);
    } else if (c.startsWith('NEP')) {
      categorias.restrita.push(d);
    } else {
      categorias.livres.push(d);
    }
  }
  const renderCategoria = (titulo, lista) =>
    lista.length
      ? el('div', {}, [
          el('h5', { className: 'disc-grupo' }, titulo),
          el('ul', { className: 'lista-disciplinas' }, lista.map(itemOpt)),
        ])
      : null;

  const avisoCategorizacao = el('div', {
    className: 'card-aviso categorizacao-aviso',
  }, [
    el('i', {
      className: 'bi bi-exclamation-triangle categorizacao-aviso-icone',
    }),
    el('span', { className: 'categorizacao-aviso-texto' }, [
      el('strong', {}, 'Aviso:'),
      ' A categorização acima é uma sugestão visual. Confirme se as matérias são realmente eletivas consultando a grade oficial do SIGA ou o seu BOA.',
    ]),
  ]);

  const cardPendencias = el('div', { className: 'card' }, [
    el('h3', {}, 'Obrigatórias pendentes e outras matérias cursadas'),
    el('div', { className: 'cards-grid' }, [
      el('div', {}, [
        el('h4', {}, 'Obrigatórias'),
        (pendencias.obrigatorias || []).length
          ? el('div', {}, renderObrigatoriasPorPeriodo())
          : el('p', { className: 'text-muted' }, 'Nenhuma obrigatória pendente.'),
      ]),
      el('div', {}, [
        el('h4', {}, 'Eletivas/Optativas Cursadas'),
        renderOptativasBadge(),
        renderCategoria('Prováveis Escolhas Condicionadas', categorias.condicionadas),
        renderCategoria('Provável Escolha Restrita (Humanidades)', categorias.restrita),
        renderCategoria('Prováveis Livres Escolhas', categorias.livres),
        !optativasCursadas.length
          ? el('p', { className: 'text-muted' }, 'Nenhuma optativa/eletiva detectada.')
          : null,
        avisoCategorizacao,
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

  return cardPendencias;
}

function renderJornada() {
  const progresso = calcularProgressoIntegralizacao(
    getMergedDados().periodos,
    state.regras
  );
  const creditosRestantes = progresso.creditosRestantes;

  return el('div', { className: 'card card-jornada-info' }, [
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
