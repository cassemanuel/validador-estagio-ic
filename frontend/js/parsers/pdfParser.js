/**
 * Parser de PDFs do SIGA/UFRJ (boletim/histórico).
 *
 * Extrai metadados do aluno, disciplinas por período e totais oficiais.
 * Aplica as regras de negócio do CR:
 * - AP, RM, RF, RFM conferem grau.
 * - NCG, NCC, T e Cursando não conferem grau.
 */

import { disciplinaConferGrau } from '../domain/cr.js';

const HEADER_REGEX = /CH\s+SFGrau\s+CrO\s+PontosPer[íi]odo\s+C[óo]digo\s+Nome\s+da\s+Disciplina\/RCC\s+CrR/i;
const PERIODO_INICIO_REGEX = /^(\d{4}\s*\/\s*\d|\d{4})\b/;
const SITUACOES = ['AP', 'RM', 'RF', 'RFM', 'NCG', 'NCC', 'T', 'CURSANDO'];
const SF_FIM_REGEX = new RegExp(`\\s+(${SITUACOES.join('|')})\\s*$`, 'i');
const CODIGO_INICIO_REGEX = /^([A-Z]{2,4}[A-Z0-9]?\d{2,4})\s+/;
const CAMPO_TOKEN = String.raw`\d+(?:\.\d+)?|NCG|NCC|\*{2,}|T`;
const CAMPOS_FINAIS_REGEX = new RegExp(
  `(${CAMPO_TOKEN})\\s+(${CAMPO_TOKEN})\\s+(${CAMPO_TOKEN})\\s+(${CAMPO_TOKEN})\\s+(${CAMPO_TOKEN})$`,
  'i'
);

const MAX_PDF_PAGES = 25;

// Parâmetros de layout do documento usados na reconstrução das linhas.
const LAYOUT_CONFIG = {
  TOLERANCIA_Y: 4, // variação vertical aceitável para itens da mesma linha
};

/**
 * Extrai texto de um arquivo PDF usando pdfjs-dist.
 * @param {ArrayBuffer | Uint8Array} pdfData
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<string[]>}
 */
export async function extractTextFromPDF(pdfData, onProgress, pdfjsLib = globalThis.pdfjsLib) {
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

  const lines = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      // Agrupa os itens por coordenada Y para reconstruir as linhas do PDF.
      const linhasPagina = agruparItensPorLinha(textContent.items);
      lines.push(...linhasPagina.map((l) => l.trim()).filter(Boolean));
    } catch (err) {
      console.warn(`Falha ao extrair texto da página ${i}; página ignorada.`, err);
    }

    if (onProgress) {
      onProgress(i / pdf.numPages);
    }
  }

  return lines;
}

/**
 * Agrupa itens de texto do pdf.js em linhas pela coordenada Y.
 * @param {Array<object>} items
 * @returns {string[]}
 */
function agruparItensPorLinha(items) {
  const { TOLERANCIA_Y } = LAYOUT_CONFIG;
  const grupos = [];

  for (const item of items) {
    if (!item.str || item.str.trim() === '') continue;

    const rawY = item.transform?.[5];
    const y = typeof rawY === 'number' && !isNaN(rawY)
      ? Math.round(rawY / TOLERANCIA_Y) * TOLERANCIA_Y
      : 0;

    let grupo = grupos.find((g) => Math.abs(g.y - y) <= TOLERANCIA_Y);

    if (!grupo) {
      grupo = { y, items: [] };
      grupos.push(grupo);
    }

    grupo.items.push(item);
  }

  // Ordena por Y decrescente (de cima para baixo) e, dentro de cada linha, por X.
  return grupos
    .sort((a, b) => b.y - a.y)
    .map((g) =>
      g.items
        .sort((a, b) => (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0))
        .map((item) => item.str)
        .join(' ')
    );
}

/**
 * Remove linhas de cabeçalho/legenda que se repetem em cada página.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function limparLinhas(lines) {
  const ignorar = [
    /^SEM VALOR OFICIAL$/i,
    /^LEGENDA$/i,
    /^CrR\s+-/i,
    /^CrO\s+-/i,
    /^CH\s+-/i,
    /^SF\s+-/i,
    /^AP\s+-/i,
    /^RF\s+-/i,
    /^RM\s+-/i,
    /^RFM\s+-/i,
    /^NCC\s+-/i,
    /^NCG\s+-/i,
    /^CR\s+-/i,
    /^PR1\s+\/\s+DRE$/i,
    /^BOLETIM\s+NÃO\s+OFICIAL$/i,
    /^HISTÓRICO\s+NÃO\s+OFICIAL$/i,
    /^Unidade$/i,
    /^Curso$/i,
    /^Reconhecimento\/Renovação$/i,
    /^Pai$/i,
    /^Mãe$/i,
    /^GRADUAÇÃO$/i,
    /^Centro$/i,
    /^Naturalidade$/i,
    /^Nacionalidade\s+Certificado/i,
    /^Título\s+de\s+Eleitor$/i,
    /^Identidade$/i,
    /^CPF$/i,
    /^Ingresso$/i,
    /^Turno$/i,
    /^Data\s+de\s+Nascimento$/i,
    /^Página$/i,
    /^Conclusão$/i,
    /^CH\s+SFGrau/i,
    /^Creditos\s+transferidos/i,
  ];

  // Remove trechos de legenda colados ao final das linhas de disciplina.
  const removerLegenda = [
    /\s*AP\s+-\s+APROVADO/gi,
    /\s*RF\s+-\s+REP\.\s*P\/\s*FREQUÊNCIA/gi,
    /\s*RM\s+-\s+REPROVADO\s+P\/\s*MÉDIA/gi,
    /\s*RFM\s+-\s+REP\.\s*P\/\s*FREQ\.\s*MÉDIA/gi,
    /\s*NCC\s+-\s+NÃO\s+CONFERE\s+CRÉDITO/gi,
    /\s*NCG\s+-\s+NÃO\s+CONFERE\s+GRAU/gi,
    /\s*CR\s+-\s+COEF\.\s*DE\s*RENDIMENTO/gi,
    /\s*CrR\s+-\s+CRÉD\.\s*REQUISITADOS/gi,
    /\s*CrO\s+-\s+CRÉDITOS\s+OBTIDOS/gi,
    /\s*CH\s+-\s+CARGA\s+HORÁRIA/gi,
    /\s*SF\s+-\s+SITUAÇÃO\s+FINAL/gi,
    /\s*SEM\s+VALOR\s+OFICIAL\b/gi,
    /\s*LEGENDA\b.*$/gi,
  ];

  return lines
    .map((line) => {
      let cleaned = line;
      removerLegenda.forEach((re) => {
        cleaned = cleaned.replace(re, '');
      });
      return cleaned.trim();
    })
    .filter((line) => line && !ignorar.some((re) => re.test(line)));
}

/**
 * Extrai metadados do aluno a partir das linhas do PDF.
 * @param {string[]} lines
 * @returns {object}
 */
export function parseMetadata(lines) {
  const metadata = {
    nome: null,
    dre: null,
    curso: null,
    ingresso: null,
    emissao: null,
    tipoDocumento: null,
  };

  for (let i = 0; i < lines.length; i++) {
    try {
      extrairMetadadosDaLinha(lines[i], lines[i + 1] || '', metadata);
    } catch (err) {
      console.warn('Linha de metadados ignorada por erro de parsing:', lines[i], err);
    }
  }

  return metadata;
}

/**
 * Tenta extrair um campo de metadados de uma única linha.
 * @param {string} line
 * @param {string} nextLine
 * @param {object} metadata Objeto de metadados em preenchimento (mutado).
 */
function extrairMetadadosDaLinha(line, nextLine, metadata) {
  if (!metadata.tipoDocumento) {
    if (/HIST[ÓO]RICO\s+N[ÃA]O\s+OFICIAL/i.test(line)) {
      metadata.tipoDocumento = 'historico';
    } else if (/BOLETIM\s+N[ÃA]O\s+OFICIAL/i.test(line)) {
      metadata.tipoDocumento = 'boletim';
    }
  }

  if (!metadata.nome) {
    // Tenta capturar o nome logo depois de "Nome Civil".
    let nomeMatch = line.match(/Nome\s*Civil\s*([A-ZÁ-ÚÀ-Ù\s]+?)(?=\s+\d|\s+Pai|\s+Mãe|\s+Naturalidade|$)/i);
    if (nomeMatch) {
      metadata.nome = nomeMatch[1].trim();
      return;
    }
    // Fallback: nome vem antes de "Nome Civil" (texto colado do SIGA).
    nomeMatch = line.match(/([A-ZÁ-ÚÀ-Ù\s]+?)\s*Nome\s*Civil/i);
    if (nomeMatch) {
      metadata.nome = nomeMatch[1].trim();
      return;
    }
  }

  if (!metadata.dre) {
    // O DRE aparece logo acima da label "Registro" no boletim/histórico.
    if (/^Registro$/i.test(nextLine)) {
      const m = line.match(/\b(\d{9,10})\b/);
      if (m) metadata.dre = m[1];
      return;
    }

    // Fallback: linha isolada com exatamente 9 ou 10 dígitos (DRE).
    const m = line.match(/^\s*(\d{9,10})\s*$/);
    if (m && !line.includes(' ')) {
      metadata.dre = m[1];
      return;
    }
  }

  // Curso: em transferências, o primeiro cabeçalho pode ser o curso antigo
  // (ex: BCMT) e um cabeçalho posterior o curso atual (BCC). Por isso,
  // sempre sobrescrevemos com a última ocorrência válida.
  const cursoMatch = line.match(/(\d{4,5}\s*-\s*[A-Za-zÁ-Úá-ú\s]+?)(?=\s*Reconhecimento|\s*Portaria|\s*Unidade|\s*Turno|$)/i);
  if (cursoMatch) {
    metadata.curso = cursoMatch[1].trim().replace(/\s+Curso$/i, '');
    return;
  }

  if (!metadata.ingresso) {
    const ingressoMatch = line.match(/em:\s*(\d{4}\/\d)/i);
    if (ingressoMatch) {
      metadata.ingresso = ingressoMatch[1];
      return;
    }
  }

  if (!metadata.emissao) {
    const emissaoMatch = line.match(/Brasileiro\s+Nato\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/i);
    if (emissaoMatch) {
      metadata.emissao = emissaoMatch[1];
      return;
    }
    // Fallback genérico: data/hora isolada no formato do SIGA.
    const fallbackEmissao = line.match(/\b(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})\b/);
    if (fallbackEmissao && line.length < 80) {
      metadata.emissao = fallbackEmissao[1];
      return;
    }
  }

  if (!metadata.dre && /Nome\s*Civil/i.test(line)) {
    const candidatos = line.match(/\b\d{9,10}\b/g);
    if (candidatos) metadata.dre = candidatos[candidatos.length - 1];
  }
}

/**
 * Tenta interpretar uma linha como disciplina.
 * Retorna null se não for possível.
 * @param {string} line
 * @returns {object|null}
 */
export function parseDisciplinaLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('Prof.')) return null;

  // Remove ano opcional após a situação final (ex: AP2023)
  const semAno = trimmed.replace(
    /(AP|RM|RF|RFM|NCG|NCC|T|CURSANDO)\d{4}$/i,
    '$1'
  );

  // Situação final no final da linha.
  const sfMatch = semAno.match(SF_FIM_REGEX);
  if (!sfMatch) return null;
  const situacao = sfMatch[1].toUpperCase();
  const antesSF = semAno.slice(0, semAno.length - sfMatch[0].length).trim();

  // Código da disciplina no início da linha (ex: MAB120, ICPX06, NCG011).
  const codigoMatch = antesSF.match(CODIGO_INICIO_REGEX);
  if (!codigoMatch) return null;
  const codigo = codigoMatch[1];
  const resto = antesSF.slice(codigoMatch[0].length).trim();

  // Os últimos 5 campos do boletim são: CrR CH Grau CrO Pontos.
  // Podem ser numéricos ou textuais (NCG, NCC, *****, T).
  const camposMatch = resto.match(CAMPOS_FINAIS_REGEX);
  if (!camposMatch) return null;

  const [crRRaw, chRaw, grauRaw, crORaw, pontosRaw] = camposMatch.slice(1);
  const nomeBruto = resto.slice(0, resto.length - camposMatch[0].length).trim();

  // Remove fragmentos de professor colados no nome (ex: "Prof. NOME - (TITULAÇÃO)").
  const nome = nomeBruto
    .replace(/\bProf\..*$/i, '')
    .replace(/[\s\-–(]+$/, '')
    .trim();

  const grau = parseCampoDisciplina(grauRaw);

  return {
    grau,
    pontos: parseCampoDisciplina(pontosRaw),
    crO: parseCampoDisciplina(crORaw),
    crR: parseCampoDisciplina(crRRaw),
    ch: parseCampoDisciplina(chRaw),
    nome: nome || codigo,
    codigo,
    situacao,
    conferGrau: disciplinaConferGrau({ situacao, grau }),
  };
}

/**
 * Converte um campo do boletim em número ou preserva o valor textual
 * (NCG, NCC, *****).
 * @param {string | number} value
 * @returns {number | string | null}
 */
function parseCampoDisciplina(value) {
  if (!value) return null;
  const upper = String(value).toUpperCase();
  if (upper === '*****' || upper === 'NCC' || upper === 'NCG') return upper;
  const num = parseFloat(value);
  return isNaN(num) ? value : num;
}

/**
 * Extrai o rótulo de período (ex: "2024/1") do início de uma linha.
 * @param {string} line
 * @returns {string|null}
 */
function extractPeriodoDaLinha(line) {
  const match = line.trim().match(PERIODO_INICIO_REGEX);
  return match ? match[1].replace(/\s/g, '') : null;
}

/**
 * Parser principal: transforma as linhas do PDF em objeto estruturado.
 * @param {string[]} lines
 * @returns {object}
 */
export function parseHistorico(lines) {
  const cleanLines = limparLinhas(lines);
  const metadata = parseMetadata(cleanLines);

  const periodos = [];
  let currentPeriodo = null;
  let emTotais = false;

  function finalizarPeriodo() {
    if (currentPeriodo && currentPeriodo.disciplinas.length > 0) {
      // Se não houver período identificado, usa o último rótulo conhecido
      // ou um texto padrão para não deixar o campo vazio.
      if (!currentPeriodo.periodo) {
        const ultimoPeriodo = periodos[periodos.length - 1]?.periodo;
        currentPeriodo.periodo = ultimoPeriodo || 'Não identificado';
      }
      periodos.push(currentPeriodo);
    }
    currentPeriodo = null;
  }

  for (const line of cleanLines) {
    try {
      // Linhas de professores são ignoradas.
      if (line.startsWith('Prof.')) continue;

      // Detecta início de período no começo da linha.
      const periodoDetectado = extractPeriodoDaLinha(line);
      if (periodoDetectado) {
        // Remove o período do início e tenta parsear o restante como disciplina.
        const resto = line.trim().replace(PERIODO_INICIO_REGEX, '').trim();

        if (currentPeriodo) {
          if (currentPeriodo.disciplinas.length > 0) {
            if (!currentPeriodo.periodo) {
              // Período veio depois das disciplinas (primeiro bloco do boletim).
              currentPeriodo.periodo = periodoDetectado;
              periodos.push(currentPeriodo);
              currentPeriodo = null;
            } else {
              // Período já estava definido: finaliza o atual e inicia novo.
              periodos.push(currentPeriodo);
              currentPeriodo = { periodo: periodoDetectado, disciplinas: [], totais: {} };
            }
          } else {
            // Período veio antes das disciplinas: define o período atual.
            currentPeriodo.periodo = periodoDetectado;
          }
        } else {
          currentPeriodo = { periodo: periodoDetectado, disciplinas: [], totais: {} };
        }

        // Se sobrou texto após o período, tenta processar como disciplina.
        if (resto) {
          const disciplina = parseDisciplinaLine(resto);
          if (disciplina && currentPeriodo) {
            currentPeriodo.disciplinas.push(disciplina);
          }
        }

        emTotais = false;
        continue;
      }

      // Detecta início de bloco de totais.
      if (/^Totais:/i.test(line) || line.toLowerCase() === 'acumulado') {
        emTotais = true;
        continue;
      }

      // Tenta parsear disciplina.
      const disciplina = parseDisciplinaLine(line);
      if (disciplina) {
        if (!currentPeriodo) {
          // Disciplina sem período explícito anterior – cria período genérico.
          currentPeriodo = { periodo: null, disciplinas: [], totais: {} };
        }
        currentPeriodo.disciplinas.push(disciplina);
        emTotais = false;
        continue;
      }

      // Tenta extrair números de linhas de totais.
      if (emTotais && currentPeriodo) {
        const numeros = line.match(/\d+(?:\.\d+)?/g)?.map(Number);
        if (numeros && numeros.length > 0) {
          if (!currentPeriodo.totais.numerosBrutos) {
            currentPeriodo.totais.numerosBrutos = [];
          }
          currentPeriodo.totais.numerosBrutos.push(...numeros);
        }
      }
    } catch (err) {
      // Uma linha malformada não deve derrubar o parsing do documento inteiro.
      console.warn('Linha ignorada por erro de parsing:', line, err);
    }
  }

  finalizarPeriodo();

  return { metadata, periodos, resumo: {} };
}

/**
 * Processa um arquivo PDF e retorna o histórico estruturado.
 * @param {ArrayBuffer | Uint8Array} pdfData
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<object>}
 */
export async function processarPDF(pdfData, onProgress, pdfjsLib) {
  const lines = await extractTextFromPDF(pdfData, onProgress, pdfjsLib);
  return parseHistorico(lines);
}
