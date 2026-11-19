/**
 * Eletivas/optativas cursadas e créditos cumpridos — regra única usada pelo
 * Portal do discente e pela Mesa da comissão.
 *
 * Fonte da verdade:
 *  1. Boletim Não Oficial: disciplinas com situação de aprovação/dispensa.
 *  2. BOA, só a zona de aprovadas: disciplina cursada de fato (código real,
 *     com situação), quando ausente do Boletim.
 *
 * Nunca entram:
 *  - disciplinas obrigatórias do PPC 2022 (obrigatorias + ciclo_basico,
 *    incluindo códigos equivalentes aceitos);
 *  - colunas do elenco recomendado do BOA marcadas como cumpridas
 *    (`fonte: 'boa_coluna_cumprida'`): o código é o da vaga recomendada,
 *    não o da disciplina cursada, e os créditos são presumidos — contá-las
 *    duplicava as eletivas já presentes no Boletim;
 *  - disciplinas a cursar, cursando, reprovadas ou com inscrição
 *    facultada/vedada.
 */

/** Rótulo do período sintético que o portal usa para mesclar o BOA. */
export const PERIODO_BOA = 'Aprovadas (BOA)';

/** Marca das colunas do elenco recomendado concluídas, vindas do boaParser. */
export const FONTE_BOA_CUMPRIDA = 'boa_coluna_cumprida';

/** Créditos de eletivas/optativas exigidos pelo PPC 2022. */
export const CREDITOS_ELETIVAS_EXIGIDOS = 44;

// AP = aprovado; T = transferência/aproveitamento; A = aprovado (variante);
// NCC = não confere crédito; NCG = não confere grau.
const SITUACOES_CURSADAS = new Set(['AP', 'T', 'A', 'NCC', 'NCG']);

const normalizarCodigo = (codigo) => String(codigo || '').trim().toUpperCase();

/**
 * A disciplina conta como cursada/concluída?
 * @param {object} d
 * @returns {boolean}
 */
export function disciplinaCursada(d) {
  if (!d) return false;
  const situacao = String(d.situacao || '').trim().toUpperCase();
  const grau = String(d.grau ?? '').trim().toUpperCase();
  return SITUACOES_CURSADAS.has(situacao) || grau === 'T';
}

/**
 * Créditos que a disciplina confere (NCC: "não confere crédito").
 * @param {object} d
 * @returns {number}
 */
export function creditosDaDisciplina(d) {
  if (String(d?.situacao || '').trim().toUpperCase() === 'NCC') return 0;
  const crR = Number(d?.crR);
  return Number.isFinite(crR) && crR > 0 ? crR : 0;
}

/**
 * Códigos obrigatórios do PPC 2022 (inclui equivalências aceitas).
 * @param {object} regras Conteúdo de ciclo_basico.json
 * @returns {Set<string>}
 */
export function codigosObrigatorios(regras) {
  const codigos = new Set();
  const adicionar = (lista) => {
    for (const req of lista || []) {
      codigos.add(normalizarCodigo(req.codigo));
      (req.aceitos || []).forEach((c) => codigos.add(normalizarCodigo(c)));
      (req.aceitos_conjunto || []).flat().forEach((c) => codigos.add(normalizarCodigo(c)));
    }
  };
  adicionar(regras?.obrigatorias);
  adicionar(regras?.ciclo_basico);
  codigos.delete('');
  return codigos;
}

/**
 * Eletivas/optativas cursadas, sem duplicatas, a partir dos períodos (do
 * Boletim, opcionalmente com o período sintético do BOA) e das aprovadas do
 * BOA.
 *
 * @param {Array<object>} periodos Períodos do Boletim; o período
 *   `PERIODO_BOA`, se presente, é tratado como origem BOA.
 * @param {object} regras
 * @param {Array<object>} [aprovadasBoa] Zona de aprovadas do BOA (opcional,
 *   quando ainda não mesclada em `periodos`).
 * @returns {Array<{codigo: string, nome: string, crR: number, creditos: number,
 *   grau: *, situacao: string, periodo: string|null, fonte: 'boletim'|'boa'}>}
 */
export function listarEletivasCursadas(periodos, regras, aprovadasBoa = []) {
  const obrigatorias = codigosObrigatorios(regras);
  const vistos = new Set();
  const resultado = [];

  const considerar = (d, periodo, fonte) => {
    const codigo = normalizarCodigo(d?.codigo);
    if (!codigo || vistos.has(codigo) || obrigatorias.has(codigo)) return;
    if (!disciplinaCursada(d)) return;
    if (d.fonte === FONTE_BOA_CUMPRIDA) return;
    vistos.add(codigo);
    resultado.push({
      codigo,
      nome: d.nome || codigo,
      crR: Number(d.crR) || 0,
      creditos: creditosDaDisciplina(d),
      grau: d.grau ?? null,
      situacao: String(d.situacao || 'AP').toUpperCase(),
      periodo: periodo ?? null,
      fonte,
    });
  };

  const lista = periodos || [];
  // Boletim primeiro: em caso de código repetido, prevalece o registro dele.
  lista
    .filter((p) => p.periodo !== PERIODO_BOA)
    .forEach((p) => (p.disciplinas || []).forEach((d) => considerar(d, p.periodo, 'boletim')));
  lista
    .filter((p) => p.periodo === PERIODO_BOA)
    .forEach((p) => (p.disciplinas || []).forEach((d) => considerar(d, null, 'boa')));
  (aprovadasBoa || []).forEach((d) => considerar(d, null, 'boa'));

  return resultado;
}

/**
 * Soma dos créditos de eletivas/optativas cursadas.
 * @param {Array<object>} periodos
 * @param {object} regras
 * @returns {number}
 */
export function creditosEletivasCursadas(periodos, regras) {
  if (!regras) return 0;
  return listarEletivasCursadas(periodos, regras)
    .reduce((soma, d) => soma + d.creditos, 0);
}
