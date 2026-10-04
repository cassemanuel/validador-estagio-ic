/**
 * Motor de regras do PPC 2022 para elegibilidade a estágio não obrigatório
 * (Anexo C, Art. 4º — Programa de Estágio, BCC/UFRJ).
 *
 * Fonte única de dados: `frontend/rules/ciclo_basico.json`, compartilhada
 * com o espelho server-side (`backend/app/rules/ppc2022.py`), que lê o
 * mesmo arquivo para o sanity check das submissões.
 *
 * Critérios avaliados:
 *  1. Ciclo básico concluído (1º–4º período), aceitando equivalências
 *     históricas declaradas em cada entrada (`aceitos`).
 *  2. CR acumulado mínimo.
 *  3. Tempo de curso dentro do máximo de períodos de integralização.
 *  4. Carga Horária de Extensão (Art. 4º, IV) — 120h obrigatórias para
 *     ingressantes a partir de 2025/1.
 */

import { disciplinaConcluida } from '../domain/cr.js';

export const RULES_URL = '/rules/ciclo_basico.json';

let _regrasCache = null;

/**
 * Carrega as regras compartilhadas do ciclo básico (com cache em memória).
 * @param {boolean} [forcar] Recarrega mesmo se já houver cache.
 * @returns {Promise<object>}
 */
export async function carregarRegras(forcar = false) {
  if (_regrasCache && !forcar) return _regrasCache;
  const resp = await fetch(RULES_URL);
  if (!resp.ok) throw new Error('Falha ao carregar regras do PPC 2022.');
  _regrasCache = await resp.json();
  return _regrasCache;
}

/**
 * Retorna os requisitos do ciclo básico ainda não concluídos.
 * @param {object} historyData {periodos: [{disciplinas: [...]}]}
 * @param {object} regras Conteúdo de ciclo_basico.json
 * @returns {Array<{codigo: string, nome: string, periodo: number, aceitos: string[]}>}
 */
export function disciplinasFaltantesCicloBasico(historyData, regras) {
  const disciplinas = (historyData?.periodos || []).flatMap((p) => p.disciplinas || []);
  const codigosConcluidos = new Set(
    disciplinas
      .filter(disciplinaConcluida)
      .map((d) => String(d.codigo || '').trim().toUpperCase())
  );

  return (regras?.ciclo_basico || []).filter((req) => {
    const direta = (req.aceitos || [req.codigo]).some((cod) =>
      codigosConcluidos.has(cod)
    );
    // Equivalência combinada: o grupo inteiro de códigos precisa constar
    // como concluído para cobrir o requisito (ex.: MAB121 + CMT012 = MAB120).
    const combinada = (req.aceitos_conjunto || []).some((grupo) =>
      grupo.every((cod) => codigosConcluidos.has(cod))
    );
    return !direta && !combinada;
  });
}

/**
 * Avalia a elegibilidade do aluno para estágio não obrigatório conforme o
 * PPC 2022: ciclo básico concluído, CR acumulado mínimo e tempo de curso
 * dentro do máximo de integralização.
 * @param {object} historyData
 * @param {object} regras Conteúdo de ciclo_basico.json
 * @returns {{apto: boolean, criterios: Array<{rotulo: string, ok: boolean, detalhe: string}>}}
 */
function _ingressoAposOuIgual(ingresso, referencia) {
  if (!ingresso || !referencia) return false;
  const [a1, s1] = ingresso.split('/').map(Number);
  const [a2, s2] = referencia.split('/').map(Number);
  if (Number.isNaN(a1) || Number.isNaN(s1) || Number.isNaN(a2) || Number.isNaN(s2)) {
    return false;
  }
  return a1 > a2 || (a1 === a2 && s1 >= s2);
}

export function verificarElegibilidadeEstagio(historyData, regras) {
  const periodos = historyData?.periodos || [];
  const faltantes = disciplinasFaltantesCicloBasico(historyData, regras);

  const crMinimo = regras?.cr_minimo ?? 6.0;
  const maxPeriodos = regras?.max_periodos_integralizacao ?? 14;
  const extensaoMinima = regras?.extensao_minima_horas ?? 120;
  const extensaoAPartir = regras?.extensao_ingresso_a_partir ?? '2025/1';

  const crAcumulado = historyData?.resumo?.crCalculado ?? 0;
  const periodosCursados = new Set(
    periodos.map((p) => String(p.periodo || '').trim()).filter(Boolean)
  ).size;
  const ingresso = historyData?.metadata?.ingresso || null;
  const extensao = historyData?.resumoBoa?.extensao || {};
  const horasCumpridas = Number(extensao.cumpridas) || 0;
  const horasFaltantes = Number(extensao.faltantes) || 0;

  const extensaoAplicavel = ingresso
    ? _ingressoAposOuIgual(ingresso, extensaoAPartir)
    : false;

  const criterios = [
    {
      rotulo: 'Ciclo básico concluído (1º–4º período)',
      ok: faltantes.length === 0,
      detalhe: faltantes.length
        ? `Faltam disciplinas do ciclo básico: ${faltantes.map((f) => f.codigo).join(', ')}`
        : 'Todas as obrigatórias do ciclo básico foram concluídas.',
    },
    {
      rotulo: `CR acumulado mínimo de ${crMinimo.toFixed(3)}`,
      ok: crAcumulado >= crMinimo,
      detalhe: `CR atual ${crAcumulado.toFixed(3).replace('.', ',')} (mínimo ${crMinimo.toFixed(3).replace('.', ',')})`,
    },
    {
      rotulo: `Tempo de curso dentro de ${maxPeriodos} períodos`,
      ok: periodosCursados <= maxPeriodos,
      detalhe: `${periodosCursados} períodos cursados (máx. ${maxPeriodos})`,
    },
  ];

  if (extensaoAplicavel) {
    criterios.push({
      rotulo: `Carga Horária de Extensão (mínimo ${extensaoMinima}h)`,
      ok: horasCumpridas >= extensaoMinima,
      detalhe: horasCumpridas >= extensaoMinima
        ? `${horasCumpridas}h cumpridas (mínimo ${extensaoMinima}h)`
        : `${horasCumpridas}h cumpridas — faltam ${horasFaltantes || (extensaoMinima - horasCumpridas)}h (mínimo ${extensaoMinima}h)`,
    });
  }

  return { apto: criterios.every((c) => c.ok), criterios };
}
