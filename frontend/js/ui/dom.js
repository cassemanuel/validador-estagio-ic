/**
 * Helpers e renderização de componentes da interface.
 */

const MAX_PDF_SIZE = 15 * 1024 * 1024; // 15 MB
const PDF_MAGIC = '%PDF-';

/**
 * Valida um arquivo de upload de PDF (magic bytes, extensão/MIME e tamanho).
 * Lança Error com mensagem amigável quando inválido.
 * @param {File} file
 * @returns {Promise<void>}
 */
export async function validatePdfFile(file) {
  const isPdf = /\.pdf$/i.test(file?.name || '') || file?.type === 'application/pdf';
  if (!isPdf) throw new Error('Envie um arquivo PDF válido (.pdf).');
  if (file.size > MAX_PDF_SIZE) throw new Error('Arquivo muito grande (máx. 15 MB).');

  // Verifica magic bytes assíncronamente (FileReader) — fail-fast contra
  // arquivos com extensão trocada.
  const header = await readFileSlice(file, 0, PDF_MAGIC.length);
  if (header !== PDF_MAGIC) {
    throw new Error('O arquivo não parece ser um PDF válido.');
  }
}

function readFileSlice(file, start, end) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new TextDecoder().decode(reader.result));
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsArrayBuffer(file.slice(start, end));
  });
}

/**
 * Sanitiza uma URL permitindo apenas esquemas seguros (http/https).
 * URLs com outros esquemas (javascript:, data:, etc.) são bloqueadas.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeUrl(value) {
  const url = String(value || '').trim();
  return /^https?:/i.test(url) ? url : '#';
}

/**
 * Cria um elemento DOM a partir de uma tag e atributos.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {string | Node | Array<string | Node>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children) {
  const element = document.createElement(tag);

  Object.entries(attrs).forEach(([key, value]) => {
    // Atributos booleanos: false/null/undefined omitem o atributo (senão
    // `disabled: false` viraria disabled="false", que ainda desabilita);
    // true gera o atributo vazio (`disabled=""`).
    if (value === false || value === null || value === undefined) return;
    if (value === true) {
      element.setAttribute(key, '');
      return;
    }
    if (key === 'className') {
      element.className = value;
    } else if (key === 'dataset') {
      Object.assign(element.dataset, value);
    } else if (key === 'href') {
      element.setAttribute(key, sanitizeUrl(value));
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      element.setAttribute(key, value);
    }
  });

  if (children !== undefined) {
    const nodes = Array.isArray(children) ? children : [children];
    nodes.forEach((child) => {
      if (child instanceof Node) {
        element.appendChild(child);
      } else if (child !== null && child !== undefined) {
        element.appendChild(document.createTextNode(String(child)));
      }
    });
  }

  return element;
}

/**
 * Retorna a classe CSS do badge de acordo com a situação final (SF).
 * @param {string} situacao
 * @returns {string}
 */
export function badgeClassForSituacao(situacao) {
  switch (situacao?.toUpperCase()) {
    case 'AP':
      return 'badge-ap';
    case 'RM':
    case 'RF':
    case 'RFM':
      return 'badge-reprovado';
    case 'NCG':
    case 'NCC':
    case 'T':
      return 'badge-neutro';
    case 'CURSANDO':
      return 'badge-cursando';
    default:
      return 'badge-ciano';
  }
}

/**
 * Prepara uma tabela para o layout em cartões do mobile (CSS em
 * `.triage-table` abaixo de 640px): copia o texto de cada cabeçalho para o
 * `data-label` das células e fixa os papéis ARIA de tabela, que alguns
 * leitores de tela descartam quando o CSS troca o `display` das linhas.
 * Idempotente: pode ser chamada de novo após anexar linhas.
 * @param {HTMLTableElement} table
 * @returns {HTMLTableElement}
 */
export function tabelaResponsiva(table) {
  const rotulos = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  table.setAttribute('role', 'table');
  table.querySelectorAll('thead, tbody').forEach((g) => g.setAttribute('role', 'rowgroup'));
  table.querySelectorAll('tr').forEach((tr) => tr.setAttribute('role', 'row'));
  table.querySelectorAll('thead th').forEach((th) => th.setAttribute('role', 'columnheader'));
  table.querySelectorAll('tbody tr').forEach((tr) => {
    let coluna = 0;
    [...tr.children].forEach((td) => {
      td.setAttribute('role', 'cell');
      const span = Number(td.getAttribute('colspan')) || 1;
      // Células que ocupam a linha inteira (estado vazio) não ganham rótulo.
      if (span === 1 && rotulos[coluna]) td.dataset.label = rotulos[coluna];
      coluna += span;
    });
  });
  return table;
}

/**
 * Limpa o conteúdo de um elemento.
 * @param {HTMLElement} element
 */
export function clearElement(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

/**
 * Converte uma string numérica no formato brasileiro (vírgula como decimal)
 * ou internacional (ponto como decimal) para número.
 * @param {string | number} value
 * @returns {number}
 */
export function parseNumberBR(value) {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const str = String(value).trim();
  // Se houver vírgula e ponto, assume que ponto é separador de milhar
  const normalized = str.includes(',') ? str.replace(/\./g, '').replace(',', '.') : str;
  const parsed = parseFloat(normalized);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Formata um número no padrão brasileiro (vírgula como separador decimal).
 * @param {number} value
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatNumberBR(value, decimals = 1) {
  const n = Number(value);
  if (value === null || value === undefined || Number.isNaN(n)) {
    return '0,0'.padEnd(decimals + 2, '0');
  }
  return n.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
