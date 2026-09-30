/**
 * Parser opcional do Boletim de Orientação Acadêmica (BOA).
 *
 * Extrai disciplinas pendentes do currículo recomendado para sugerir no simulador.
 *
 * O BOA é uma tabela em que cada disciplina ocupa uma COLUNA vertical fixa
 * (coordenada X). As linhas da tabela são os atributos: ocorrências (status),
 * Grau, C.H., Cred, Nome, Código das atividades já aprovadas, depois Per, C.H.,
 * Cred, Nome e Código do elenco recomendado.
 *
 * O pdf.js retorna cada célula como um item com transform[4]=x e
 * transform[5]=y. Agrupamos os itens por coluna (X) e classificamos cada item
 * pelo rótulo da sua linha (Y), preservando a correspondência espacial:
 *
 *   - código recomendado  = item-código na linha "Código" mais baixa (menor Y)
 *   - nome recomendado    = texto na linha "Nome" mais baixa
 *   - créditos (CrR)      = decimal na linha "Cred" mais baixa
 *   - período recomendado = inteiro na linha "Per"
 *   - aprovação           = qualquer código/grau na zona de aprovadas (acima
 *                           da linha de créditos recomendados)
 *   - pendência           = status textual na linha de ocorrências
 *
 * Regra de negócio: uma disciplina só é pendente se tiver código recomendado
 * válido, status de pendência na mesma coluna e nenhuma aprovação equivalente.
 */

const CODIGO_UFRJ_REGEX = /^([A-Z]{3}\d{3}|[A-Z]{3}[A-Z0-9]\d{2})$/;
const DECIMAL_REGEX = /^\d{1,2}\.\d+$/;
const INTEIRO_REGEX = /^\d{1,2}$/;
const LETRAS_APROVACAO = new Set(['AP', 'RM', 'RF', 'RFM', 'NCG', 'NCC', 'T']);

const STATUS_MAP = [
  ['inscricao vedada', 'inscricao_vedada'],
  ['inscricao facultada', 'inscricao_facultada'],
  ['a cursar', 'a_cursar'],
  ['cursando', 'cursando'],
];

const MAX_PDF_PAGES = 25;

// Parâmetros de layout da tabela do BOA (coordenadas do documento do SIGA).
const LAYOUT_CONFIG = {
  // Y padrão das linhas do elenco recomendado, usado como fallback quando a
  // página não traz os rótulos da coluna esquerda.
  PADRAO_Y_CRED_RECOM: 277,
  PADRAO_Y_PER: 356,
  TOLERANCIA_LINHA: 8, // variação de Y aceitável para itens da mesma linha
  MAX_COLUNA_DELTA: 4, // variação de X aceitável para itens da mesma coluna
  ZONA_APROVADAS_OFFSET_Y: 20, // distância acima da linha "Cred" das aprovadas
  CREDITOS_PADRAO: 4.0, // CrR assumido quando a célula "Cred" não é legível
};

const { PADRAO_Y_CRED_RECOM, PADRAO_Y_PER, TOLERANCIA_LINHA } = LAYOUT_CONFIG;

/**
 * Normaliza texto para comparação: minúsculas e sem acentos.
 * @param {string} str
 * @returns {string}
 */
function normalize(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Verifica se o texto é um código de disciplina no formato UFRJ.
 * @param {string} str
 * @returns {boolean}
 */
function isCodigoUFRJ(str) {
  return CODIGO_UFRJ_REGEX.test(str.trim());
}

/**
 * Detecta status de pendência a partir do texto da ocorrência.
 * @param {string} str
 * @returns {string|null} Chave do status ou null se não for pendência.
 */
function detectarStatus(str) {
  const normalized = normalize(str).trim();
  for (const [keyword, status] of STATUS_MAP) {
    if (normalized.includes(keyword)) return status;
  }
  return null;
}

/**
 * Verifica se o texto é um rótulo/cabeçalho da tabela (não é nome de disciplina).
 * @param {string} str
 * @returns {boolean}
 */
function isCabecalhoOuLabel(str) {
  const s = str.trim();
  return (
    s.length < 4 ||
    isCodigoUFRJ(s) ||
    DECIMAL_REGEX.test(s) ||
    INTEIRO_REGEX.test(s) ||
    LETRAS_APROVACAO.has(s.toUpperCase()) ||
    /^(Código|Nome|Cred|C\.H\.|Per|Grau|Aluno|Centro|Unidade|Curso|Turno|Formação|Matrícula|Versão|Emissão|Página|Sit\.|Totais|Já Cumpridos|Falta Cumprir|Extensão|Elenco Recomendado|Atividades|Ativ\.|BOLETIM|GRADUAÇÃO|PR1|Av\.|Cidade|Rio de Janeiro|Instituto|Bacharelado|Integral|Descr|Local)\b/i.test(
      s
    )
  );
}

/**
 * Extrai os itens de texto com coordenadas de cada página do PDF.
 * @param {ArrayBuffer | Uint8Array} pdfData
 * @returns {Promise<Array<Array<{str: string, x: number, y: number}>>>}
 */
export async function extractBOAItems(pdfData, pdfjsLib = globalThis.pdfjsLib) {
  if (!pdfjsLib) {
    throw new Error('pdf.js não está disponível.');
  }

  const pdf = await pdfjsLib.getDocument({
    data: pdfData,
    isEvalSupported: false, // Desativa avaliação de código dinâmico
    useSystemFonts: true,
  }).promise;

  if (pdf.numPages > MAX_PDF_PAGES) {
    throw new Error(`PDF excede o limite de ${MAX_PDF_PAGES} páginas.`);
  }

  const paginas = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const items = textContent.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({
          str: it.str.trim(),
          x: it.transform?.[4] ?? 0,
          y: it.transform?.[5] ?? 0,
        }));
      paginas.push(items);
    } catch (err) {
      console.warn(`Falha ao extrair itens da página ${i}; página ignorada.`, err);
    }
  }

  return paginas;
}

/**
 * Agrupa itens em colunas pela coordenada X (células da mesma disciplina
 * compartilham o mesmo X, com pequenas variações de arredondamento).
 * @param {Array<{str: string, x: number, y: number}>} items
 * @returns {Array<{str: string, x: number, y: number}[]>}
 */
function agruparPorColuna(items) {
  const ordenados = [...items].sort((a, b) => a.x - b.x);
  const colunas = [];

  for (const item of ordenados) {
    const ultima = colunas[colunas.length - 1];
    if (ultima && item.x - ultima.xMax <= LAYOUT_CONFIG.MAX_COLUNA_DELTA) {
      ultima.items.push(item);
      ultima.xMax = Math.max(ultima.xMax, item.x);
    } else {
      colunas.push({ xMax: item.x, items: [item] });
    }
  }

  return colunas.map((c) => c.items);
}

/**
 * Extrai disciplinas pendentes e já aprovadas dos itens de uma página.
 * @param {Array<{str: string, x: number, y: number}>} items
 * @param {{credRecomY: number, perY: number}} faixas Valores de referência das linhas.
 * @returns {{obrigatorias: Array<object>, optativas: Array<object>, aprovadas: Array<object>, credRecomY: number, perY: number}}
 */
export function parsePaginaBOA(items, faixas) {
  let { credRecomY, perY } = faixas;

  // Localiza os rótulos das linhas para calibrar as faixas de Y desta página.
  const credLabelYs = items
    .filter((it) => it.str === 'Cred')
    .map((it) => it.y);
  const perLabelY = items.find((it) => it.str === 'Per')?.y;

  if (credLabelYs.length) credRecomY = Math.min(...credLabelYs);
  if (perLabelY != null) perY = perLabelY;

  // Tudo acima da linha de cred do elenco recomendado pertence à zona de
  // atividades já aprovadas (ou ao cabeçalho de ocorrências).
  const approvalMinY = credRecomY + LAYOUT_CONFIG.ZONA_APROVADAS_OFFSET_Y;

  // Rótulos da zona de aprovadas (Grau/C.H./Cred acima do elenco recomendado)
  // permitem associar cada decimal à linha correta dentro da coluna.
  const labelY = (txt) =>
    items
      .filter((it) => it.str === txt && it.y > approvalMinY)
      .map((it) => it.y);
  const grauYs = labelY('Grau');
  const credAprYs = labelY('Cred');
  const chAprYs = labelY('C.H.');

  const obrigatorias = [];
  const optativas = [];
  const aprovadas = [];
  const vistos = new Set();
  const vistosAprovadas = new Set();

  for (const coluna of agruparPorColuna(items)) {
    try {
      const ordenados = [...coluna].sort((a, b) => a.y - b.y);

      // Atividades já aprovadas: códigos na zona superior da coluna (acima
      // do elenco recomendado). O BOA discrimina por coluna o código, grau,
      // C.H., Cred e nome de cada disciplina cumprida — sem isso o ciclo
      // básico não marca nada como concluído quando o documento é o BOA.
      const zona = ordenados.filter(
        (it) => it.y > approvalMinY && !detectarStatus(it.str)
      );
      for (const codItem of zona.filter((it) => isCodigoUFRJ(it.str))) {
        const codAprov = codItem.str.trim();
        if (vistosAprovadas.has(codAprov)) continue;
        vistosAprovadas.add(codAprov);

        const proximo = (alvoY, pred) =>
          zona
            .filter((it) => it !== codItem && pred(it))
            .sort((a, b) => Math.abs(a.y - alvoY) - Math.abs(b.y - alvoY))[0];

        // Decimal na linha rotulada (Grau/Cred/C.H.); fallback para o
        // decimal mais próximo do código quando o rótulo não veio na página.
        const decLinha = (labelYs) => {
          for (const y of labelYs) {
            const hit = zona.find(
              (it) =>
                DECIMAL_REGEX.test(it.str) &&
                Math.abs(it.y - y) <= TOLERANCIA_LINHA
            );
            if (hit) return parseFloat(hit.str);
          }
          const prox = proximo(codItem.y, (it) => DECIMAL_REGEX.test(it.str));
          return prox ? parseFloat(prox.str) : null;
        };

        const letra = proximo(codItem.y, (it) =>
          LETRAS_APROVACAO.has(it.str.toUpperCase())
        );
        const nomeItem = proximo(
          codItem.y,
          (it) => !isCabecalhoOuLabel(it.str)
        );
        const grau = decLinha(grauYs);
        const crR = decLinha(credAprYs) ?? LAYOUT_CONFIG.CREDITOS_PADRAO;

        aprovadas.push({
          codigo: codAprov,
          nome: nomeItem?.str || codAprov,
          situacao: letra ? letra.str.toUpperCase() : 'AP',
          grau,
          crR,
          ch: decLinha(chAprYs),
          pontos: grau != null ? grau * crR : null,
        });
      }

      // Código recomendado: item-código na linha mais baixa da coluna.
      const codigos = ordenados.filter((it) => isCodigoUFRJ(it.str));
      if (!codigos.length) continue;
      const codigo = codigos[0].str.trim();

      // Status de pendência na coluna (linha de ocorrências).
      const statusItem = ordenados.find((it) => detectarStatus(it.str));
      if (!statusItem) continue;
      const status = detectarStatus(statusItem.str);

      // Aprovação/equivalência: qualquer código, grau ou conceito na zona
      // superior da coluna indica que a disciplina já foi cumprida.
      const aprovado = ordenados.some(
        (it) =>
          it.y > approvalMinY &&
          it !== statusItem &&
          !detectarStatus(it.str) &&
          (isCodigoUFRJ(it.str) ||
            DECIMAL_REGEX.test(it.str) ||
            LETRAS_APROVACAO.has(it.str.toUpperCase()))
      );
      if (aprovado) continue;

      // Período recomendado: inteiro na linha "Per" (define obrigatoriedade).
      const perItem = ordenados.find(
        (it) => INTEIRO_REGEX.test(it.str) && Math.abs(it.y - perY) <= TOLERANCIA_LINHA
      );
      const periodoRecomendado = perItem ? parseInt(perItem.str, 10) : null;

      // Créditos recomendados: decimal na linha "Cred" mais baixa.
      const credItem = ordenados.find(
        (it) => DECIMAL_REGEX.test(it.str) && Math.abs(it.y - credRecomY) <= TOLERANCIA_LINHA
      );
      const crR = credItem ? parseFloat(credItem.str) : LAYOUT_CONFIG.CREDITOS_PADRAO;

      // Nome recomendado: texto da linha "Nome" mais baixa da coluna.
      const nomeItem = ordenados.find((it) => !isCabecalhoOuLabel(it.str));
      const nome = nomeItem ? nomeItem.str : codigo;

      if (vistos.has(codigo)) continue;
      vistos.add(codigo);

      const disciplina = { codigo, nome, crR, periodoRecomendado, status };
      if (periodoRecomendado != null) {
        obrigatorias.push(disciplina);
      } else {
        optativas.push(disciplina);
      }
    } catch (err) {
      // Uma coluna malformada não deve derrubar o parsing da página inteira.
      console.warn('Coluna ignorada por erro de parsing.', err);
    }
  }

  return { obrigatorias, optativas, aprovadas, credRecomY, perY };
}

/**
 * Processa um arquivo BOA e retorna pendências e disciplinas aprovadas.
 * @param {ArrayBuffer | Uint8Array} pdfData
 * @returns {Promise<{obrigatorias: Array<object>, optativas: Array<object>, aprovadas: Array<object>}>}
 */
export async function processarBOA(pdfData, pdfjsLib) {
  const paginas = await extractBOAItems(pdfData, pdfjsLib);
  const obrigatorias = [];
  const optativas = [];
  const aprovadas = [];
  const vistos = new Set();
  const vistosAprovadas = new Set();

  // As faixas de Y são calibradas pelos rótulos de cada página e carregadas
  // para a página seguinte (a continuação da tabela repete o mesmo layout).
  let faixas = { credRecomY: PADRAO_Y_CRED_RECOM, perY: PADRAO_Y_PER };

  for (const items of paginas) {
    let resultado;
    try {
      resultado = parsePaginaBOA(items, faixas);
    } catch (err) {
      // Uma página malformada não deve derrubar o parsing do BOA inteiro.
      console.warn('Página do BOA ignorada por erro de parsing.', err);
      continue;
    }
    faixas = { credRecomY: resultado.credRecomY, perY: resultado.perY };

    for (const d of resultado.obrigatorias) {
      if (!vistos.has(d.codigo)) {
        vistos.add(d.codigo);
        obrigatorias.push(d);
      }
    }
    for (const d of resultado.optativas) {
      if (!vistos.has(d.codigo)) {
        vistos.add(d.codigo);
        optativas.push(d);
      }
    }
    for (const d of resultado.aprovadas || []) {
      if (!vistosAprovadas.has(d.codigo)) {
        vistosAprovadas.add(d.codigo);
        aprovadas.push(d);
      }
    }
  }

  return { obrigatorias, optativas, aprovadas };
}
