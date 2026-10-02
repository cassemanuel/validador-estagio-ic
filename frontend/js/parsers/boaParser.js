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

const DRE_REGEX = /\b(\d{9,10})\b/;
const NOME_REGEX = /^[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇ][A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇa-záàâãéèêíïóôõöúç]+(\s+[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇa-záàâãéèêíïóôõöúç][A-Za-záàâãéèêíïóôõöúç.]*)+$/;

const MAX_PDF_PAGES = 25;

// Parâmetros de layout da tabela do BOA (coordenadas do documento do SIGA).
const LAYOUT_CONFIG = {
  // Y padrão das linhas do elenco recomendado, usado como fallback quando a
  // página não traz os rótulos da coluna esquerda.
  PADRAO_Y_CRED_RECOM: 277,
  PADRAO_Y_PER: 356,
  TOLERANCIA_LINHA: 10, // variação de Y aceitável para itens da mesma linha
  MAX_COLUNA_DELTA: 4, // variação de X aceitável para itens da mesma coluna (estritamente <= 4px)
  ZONA_APROVADAS_OFFSET_Y: 20, // distância acima da linha "Cred" das aprovadas
  CREDITOS_PADRAO: 4.0, // CrR assumido quando a célula "Cred" não é legível
};

// Rótulos das linhas da tabela variam entre versões do SIGA
// (com/sem ponto final, "Cred"/"Cred.", "C.H."/"CH", "Per"/"Per.").
const LABEL_LINHA_REGEX = {
  cred: /^cred\.?$/i,
  per: /^per\.?$/i,
  grau: /^grau\.?$/i,
  ch: /^c\.?\s*h\.?$/i,
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
 * Verifica se o texto é o rótulo de uma linha da tabela do BOA,
 * tolerante a variações de pontuação entre versões do SIGA.
 * @param {string} str
 * @param {'cred'|'per'|'grau'|'ch'} linha
 * @returns {boolean}
 */
function isLabelLinha(str, linha) {
  return LABEL_LINHA_REGEX[linha].test(normalize(str).trim());
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
 * Extrai metadados do cabeçalho do BOA (layout em linhas rotuladas,
 * diferente do Boletim). Busca DRE (9–10 dígitos), nome do discente
 * (linha "Aluno"/"Nome" ou texto em nome próprio no topo) e curso.
 * @param {Array<{str: string, x: number, y: number}>} items Itens da 1ª página.
 * @returns {{nome: string|null, dre: string|null, curso: string|null}}
 */
export function extrairMetadataBOA(items) {
  const meta = { nome: null, dre: null, curso: null, cursos: [], emissao: null };
  if (!items?.length) return meta;

  for (const it of items) {
    const s = it.str;

    // Rótulo embutido no próprio texto: "Aluno: NOME", "Matrícula: 123...".
    if (!meta.nome) {
      const m = s.match(/\b(?:aluno|nome)\b\s*[:\-–]?\s*(.+)$/i);
      if (m && NOME_REGEX.test(m[1].trim())) {
        meta.nome = m[1].trim();
      }
    }
    if (!meta.dre) {
      const m = s.match(/(?:dre|matr[íi]cula|registro)\s*[:\-–]?\s*(\d{9,10})/i);
      if (m) meta.dre = m[1];
    }
    const mCurso = s.match(/(\d{4,6}\s*-\s*[A-Za-zÁ-ú\s]+)/);
    if (mCurso) {
      const curso = mCurso[1].trim();
      const codigo = curso.match(/^\d{4,6}/)?.[0];
      if (codigo && !meta.cursos.some((c) => c.match(/^\d{4,6}/)?.[0] === codigo)) {
        meta.cursos.push(curso);
      }
      if (!meta.curso) meta.curso = curso;
    }
    if (!meta.emissao) {
      const m = s.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (m) meta.emissao = m[1];
    }
  }

  // Fallbacks: DRE isolado (9–10 dígitos) e nome em caixa alta no topo.
  if (!meta.dre) {
    const item = items.find((it) => DRE_REGEX.test(it.str));
    if (item) meta.dre = item.str.match(DRE_REGEX)[1];
  }
  if (!meta.nome) {
    // Títulos institucionais do cabeçalho não são nomes de pessoa.
    const naoNome =
      /boletim|orienta|acad[eê]mica|ufrj|universidade|instituto|centro|p[áa]gina|emiss[ãa]o|gradua[çc][ãa]o|bacharelado|curso|turno|forma[çc][ãa]o|sit\.|matr[íi]cula|vers[ãa]o|emiss[ãa]o/i;
    const yMin = Math.min(...items.map((it) => it.y));
    const topo = items
      .filter(
        (it) =>
          it.y < yMin + 150 &&
          NOME_REGEX.test(it.str.trim()) &&
          !naoNome.test(normalize(it.str))
      )
      .sort((a, b) => a.y - b.y || a.x - b.x);
    if (topo.length) meta.nome = topo[0].str.trim();
  }

  console.debug('[boaParser] metadados:', meta);
  return meta;
}

/**
 * Extrai disciplinas pendentes e já aprovadas dos itens de uma página.
 * @param {Array<{str: string, x: number, y: number}>} items
 * @param {{credRecomY: number, perY: number}} faixas Valores de referência das linhas.
 * @returns {{obrigatorias: Array<object>, optativas: Array<object>, aprovadas: Array<object>, cumpridos: Array<object>, credRecomY: number, perY: number}}
 */
export function parsePaginaBOA(items, faixas) {
  let { credRecomY, perY } = faixas;

  // Localiza os rótulos das linhas para calibrar as faixas de Y desta página.
  // O match é tolerante a variantes de pontuação ("Cred.", "CH", "Per.").
  const credLabelYs = items
    .filter((it) => isLabelLinha(it.str, 'cred'))
    .map((it) => it.y);
  const perLabelY = items.find((it) => isLabelLinha(it.str, 'per'))?.y;

  if (credLabelYs.length) credRecomY = Math.min(...credLabelYs);
  if (perLabelY != null) perY = perLabelY;

  // Tudo acima da linha de cred do elenco recomendado pertence à zona de
  // atividades já aprovadas (ou ao cabeçalho de ocorrências).
  const approvalMinY = credRecomY + LAYOUT_CONFIG.ZONA_APROVADAS_OFFSET_Y;

  // Rótulos da zona de aprovadas (Grau/C.H./Cred acima do elenco recomendado)
  // permitem associar cada decimal à linha correta dentro da coluna.
  const labelY = (linha) =>
    items
      .filter((it) => isLabelLinha(it.str, linha) && it.y > approvalMinY)
      .map((it) => it.y);
  const grauYs = labelY('grau');
  const credAprYs = labelY('cred');
  const chAprYs = labelY('ch');

  // Depuração opcional (DevTools → nível "Verbose"): tokens lidos e faixas
  // calibradas da página, úteis para inspecionar layouts novos do SIGA.
  console.debug('[boaParser] página:', {
    itens: items.length,
    credRecomY,
    perY,
    approvalMinY,
    labels: { cred: credLabelYs, per: perLabelY, grau: grauYs, credApr: credAprYs, ch: chAprYs },
  });

  const obrigatorias = [];
  const optativas = [];
  const aprovadas = [];
  const cumpridos = [];
  const vistos = new Set();
  const vistosAprovadas = new Set();
  const vistosCumpridos = new Set();

  for (const coluna of agruparPorColuna(items)) {
    try {
      const ordenados = [...coluna].sort((a, b) => a.y - b.y);

      // Depuração (Verbose): tokens brutos da coluna antes da classificação.
      console.debug(
        `[boaParser] coluna x=${coluna[0]?.x?.toFixed(1)}:`,
        ordenados.map((it) => `${it.str}@${it.y.toFixed(0)}`)
      );

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
      if (!codigos.length) {
        console.debug('[boaParser] coluna descartada: sem código UFRJ.');
        continue;
      }
      const codigo = codigos[0].str.trim();

      // Aprovação/equivalência: qualquer código, grau ou conceito na zona
      // superior da coluna indica que a disciplina já foi cumprida.
      // No BOA real do SIGA, disciplinas concluídas não têm status de
      // pendência — só o registro na zona superior — então este teste vem
      // antes da busca por status de pendência.
      const aprovado = ordenados.some(
        (it) =>
          it.y > approvalMinY &&
          !isLabelLinha(it.str, 'cred') &&
          !isLabelLinha(it.str, 'ch') &&
          !isLabelLinha(it.str, 'grau') &&
          !detectarStatus(it.str) &&
          (isCodigoUFRJ(it.str) ||
            DECIMAL_REGEX.test(it.str) ||
            LETRAS_APROVACAO.has(it.str.toUpperCase()))
      );
      if (aprovado) {
        // Regra do estágio (PPC 2022): coluna com registro na zona superior
        // (aprovação AP, aproveitamento T, grau) conta como CONCLUÍDA mesmo
        // quando o código cursado difere do recomendado — a equivalência é
        // resolvida depois pela lista `aceitos` ou pela comissão.
        if (!vistosCumpridos.has(codigo)) {
          vistosCumpridos.add(codigo);
          cumpridos.push({
            codigo,
            nome: ordenados.find((it) => !isCabecalhoOuLabel(it.str))?.str || codigo,
            situacao: 'AP',
            grau: null,
            crR: LAYOUT_CONFIG.CREDITOS_PADRAO,
            fonte: 'boa_coluna_cumprida',
          });
          console.debug(`[boaParser] ${codigo} concluída (zona de aprovadas).`);
        }
        continue;
      }

      // Status de pendência na coluna (linha de ocorrências).
      const statusItem = ordenados.find((it) => detectarStatus(it.str));
      if (!statusItem) {
        console.debug(`[boaParser] ${codigo} descartada: sem status de pendência.`);
        continue;
      }
      const status = detectarStatus(statusItem.str);

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

  return { obrigatorias, optativas, aprovadas, cumpridos, credRecomY, perY };
}

/**
 * Extrai, do quadro de Resumo do BOA, os créditos exigidos e faltantes
 * dos grupos de eletivas/optativas.
 *
 * Procura rótulos como "Escolha Condicionada", "Livre Escolha",
 * "Escolha Restrita" e valores decimais nas colunas de créditos.
 * Retorna objeto com total de créditos exigidos e faltantes.
 *
 * @param {Array<Array<{str:string, x:number, y:number}>>} paginas
 * @returns {{grupos: Array<{nome: string, exigido: number, cumprido: number, faltante: number}>, creditosFaltantes: number}}
 */
// Créditos exigidos por grupo de eletivas/optativas (PPC 2022 — BCC).
// Os totais são fixos: o quadro de Resumo do BOA também lista C.H./horas
// (ex.: 320h de Extensão), que não devem ser confundidas com créditos.
const CREDITOS_EXIGIDOS = {
  'escolha condicionada': 32,
  'livre escolha': 8,
  'escolha restrita': 4,
};

export function extrairResumoBOA(paginas) {
  const nomes = [
    ['escolha condicionada', /escolha\s*condicionada/i],
    ['livre escolha', /livre\s*escolha/i],
    ['escolha restrita', /escolha\s*restrita|humanidades/i],
  ];

  const grupos = [];
  let creditosFaltantes = 0;

  for (const items of paginas) {
    for (const [nomePadrao, regex] of nomes) {
      if (grupos.find((g) => g.nome === nomePadrao)) continue;

      const exigido = CREDITOS_EXIGIDOS[nomePadrao];
      const labelItem = items.find((it) => regex.test(normalize(it.str)));
      if (!labelItem) continue;

      // Números à direita do rótulo, plausíveis como créditos do grupo —
      // valores acima do teto (ex.: "320" horas de Extensão) são ignorados.
      const numericos = items
        .filter((it) => it.x > labelItem.x)
        .map((it) => ({ x: it.x, y: it.y, n: parseFloat(it.str) }))
        .filter((o) => !Number.isNaN(o.n) && o.n >= 0 && o.n <= exigido);

      // A linha do grupo é a faixa de Y mais próxima do rótulo: tolera
      // rótulos quebrados em duas linhas ou com Y deslocado das células.
      // Na tabela de resumo, "Falta Cumprir" é a última coluna (maior X).
      let faltante = exigido;
      if (numericos.length) {
        const dyMin = Math.min(
          ...numericos.map((o) => Math.abs(o.y - labelItem.y))
        );
        const linha = numericos
          .filter(
            (o) => Math.abs(o.y - labelItem.y) <= dyMin + TOLERANCIA_LINHA
          )
          .sort((a, b) => a.x - b.x);
        faltante = linha[linha.length - 1].n;
      }
      const cumprido = Math.max(0, exigido - faltante);

      grupos.push({ nome: nomePadrao, exigido, cumprido, faltante });
      creditosFaltantes += faltante;
    }
  }

  return { grupos, creditosFaltantes };
}

/**
 * Processa um arquivo BOA e retorna pendências e disciplinas aprovadas.
 * @param {ArrayBuffer | Uint8Array} pdfData
 * @returns {Promise<{obrigatorias: Array<object>, optativas: Array<object>, aprovadas: Array<object>, cumpridos: Array<object>, resumo: object, metadata: object}>}
 */
export async function processarBOA(pdfData, pdfjsLib) {
  const paginas = await extractBOAItems(pdfData, pdfjsLib);
  const obrigatorias = [];
  const optativas = [];
  const aprovadas = [];
  const cumpridos = [];
  const vistos = new Set();
  const vistosAprovadas = new Set();
  const vistosCumpridos = new Set();
  const metadata = paginas.length ? extrairMetadataBOA(paginas[0]) : {};

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
    for (const d of resultado.cumpridos || []) {
      if (!vistosCumpridos.has(d.codigo)) {
        vistosCumpridos.add(d.codigo);
        cumpridos.push(d);
      }
    }
  }

  const resumo = extrairResumoBOA(paginas);

  console.debug('[boaParser] resumo do documento:', {
    paginas: paginas.length,
    aprovadas: aprovadas.map((d) => d.codigo),
    cumpridos: cumpridos.map((d) => d.codigo),
    obrigatorias: obrigatorias.map((d) => d.codigo),
    optativas: optativas.map((d) => d.codigo),
    resumo,
  });

  return { obrigatorias, optativas, aprovadas, cumpridos, resumo, metadata };
}
