/**
 * Motor de cálculo de CR acumulado e do período.
 *
 * Regras de negócio implementadas:
 * - CR = Σ(Grau × CrR) / Σ(CrR), considerando apenas disciplinas que conferem grau.
 * - Conferem grau: AP, RM, RF, RFM cujo grau seja um número válido.
 * - Não conferem grau: situações NCG, NCC, T, Cursando, ou quando o
 *   campo grau for textual (T, NCG, NCC, *****), indicando transferência
 *   ou disciplinas que não computam nota para o CR.
 */

const SITUACOES_COM_GRAU = ['AP', 'RM', 'RF', 'RFM'];
const SITUACOES_SEM_GRAU = ['NCG', 'NCC', 'T', 'CURSANDO'];
const GRAUS_TEXTUAIS_SEM_GRAU = ['T', 'NCG', 'NCC', '*****'];

/**
 * Determina se uma situação final (SF) confere grau.
 * @param {string} situacao
 * @returns {boolean}
 */
export function situacaoConferGrau(situacao) {
  if (!situacao) return false;
  return SITUACOES_COM_GRAU.includes(String(situacao).toUpperCase());
}

function isGrauNumericoValido(grau) {
  return typeof grau === 'number' && !isNaN(grau);
}

function isGrauTextualSemGrau(grau) {
  if (grau === null || grau === undefined) return true;
  return GRAUS_TEXTUAIS_SEM_GRAU.includes(String(grau).toUpperCase());
}

/**
 * Determina se uma disciplina confere grau para o cálculo do CR.
 * @param {object} disciplina
 * @returns {boolean}
 */
export function disciplinaConferGrau(disciplina) {
  if (!disciplina) return false;
  const situacao = String(disciplina.situacao || '').toUpperCase();
  if (SITUACOES_SEM_GRAU.includes(situacao)) return false;
  if (isGrauTextualSemGrau(disciplina.grau)) return false;
  return SITUACOES_COM_GRAU.includes(situacao) && isGrauNumericoValido(disciplina.grau);
}

/**
 * Verifica se a disciplina conta como concluída para fins de integralização
 * (aprovada com grau ou cursada via equivalência/transferência).
 * @param {object} disciplina
 * @returns {boolean}
 */
export function disciplinaConcluida(disciplina) {
  const situacao = String(disciplina?.situacao || '').toUpperCase();
  const grau = String(disciplina?.grau ?? '').toUpperCase();
  return situacao === 'AP' || situacao === 'T' || grau === 'T';
}

/**
 * Retorna o peso de créditos de uma disciplina.
 * @param {object} disciplina
 * @returns {{crR: number, pontos: number}}
 */
export function extrairPesoDisciplina(disciplina) {
  const confere = disciplinaConferGrau(disciplina);
  if (!confere) return { crR: 0, pontos: 0 };
  return {
    crR: Number(disciplina.crR) || 0,
    pontos: Number(disciplina.pontos) || Number(disciplina.grau) * (Number(disciplina.crR) || 0) || 0,
  };
}

/**
 * Calcula CR simples a partir de pontos e créditos.
 * @param {number} pontos
 * @param {number} crR
 * @returns {number}
 */
export function calcularCR(pontos, crR) {
  if (!crR) return 0;
  return pontos / crR;
}

/**
 * Calcula CR a partir de uma lista de disciplinas.
 * @param {Array<object>} disciplinas
 * @returns {{crRComGrau: number, pontosTotais: number, crCalculado: number}}
 */
export function calcularCRDisciplinas(disciplinas) {
  const { crRComGrau, pontosTotais } = (disciplinas || []).reduce(
    (acc, d) => {
      const peso = extrairPesoDisciplina(d);
      return {
        crRComGrau: acc.crRComGrau + peso.crR,
        pontosTotais: acc.pontosTotais + peso.pontos,
      };
    },
    { crRComGrau: 0, pontosTotais: 0 }
  );
  return {
    crRComGrau,
    pontosTotais,
    crCalculado: calcularCR(pontosTotais, crRComGrau),
  };
}

/**
 * Calcula CR acumulado a partir do histórico parseado.
 * @param {object} historyData
 * @param {Array<object>} [disciplinasExtras]
 * @returns {{crRComGrau: number, pontosTotais: number, crCalculado: number}}
 */
export function calcularCRAcumulado(historyData, disciplinasExtras = []) {
  const disciplinas = [];
  if (historyData?.periodos) {
    historyData.periodos.forEach((periodo) => {
      if (Array.isArray(periodo.disciplinas)) {
        disciplinas.push(...periodo.disciplinas);
      }
    });
  }
  if (Array.isArray(disciplinasExtras)) {
    disciplinas.push(...disciplinasExtras);
  }
  return calcularCRDisciplinas(disciplinas);
}
