/**
 * Testes dos parsers do SIGA com entradas sintéticas —
 * parseHistorico (linhas) e parsePaginaBOA (itens com coordenadas).
 * Não dependem de PDF real nem do pdf.js.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  limparLinhas,
  parseDisciplinaLine,
  parseHistorico,
} from '../../frontend/js/parsers/pdfParser.js';
import {
  extrairMetadataBOA,
  parsePaginaBOA,
} from '../../frontend/js/parsers/boaParser.js';

const LINHAS_BOLETIM = [
  // O marcador isolado é filtrado por limparLinhas; no documento real ele
  // aparece embutido em linhas maiores, que sobrevivem à limpeza.
  'BOLETIM NÃO OFICIAL — SIGA/UFRJ',
  'JOAO DA SILVA Nome Civil',
  '123456789',
  'Registro',
  '2023/1 ICP131 Programação de Computadores I 4.0 60 8.0 4.0 32.0 AP',
  'ICP144 Matemática Discreta 4.0 60 7.5 4.0 30.0 AP',
  '2023/2 ICP141 Programação de Computadores II 4.0 60 7.0 4.0 28.0 RM',
];

test('parseHistorico extrai metadata e períodos', () => {
  const { metadata, periodos } = parseHistorico(LINHAS_BOLETIM);
  assert.equal(metadata.tipoDocumento, 'boletim');
  assert.equal(metadata.dre, '123456789');
  assert.equal(periodos.length, 2);
  assert.equal(periodos[0].periodo, '2023/1');
  assert.equal(periodos[0].disciplinas.length, 2);
  assert.equal(periodos[1].disciplinas[0].codigo, 'ICP141');
});

test('parseDisciplinaLine identifica campos e confere grau', () => {
  const d = parseDisciplinaLine(
    'ICP131 Programação de Computadores I 4.0 60 8.0 4.0 32.0 AP'
  );
  assert.equal(d.codigo, 'ICP131');
  assert.equal(d.situacao, 'AP');
  assert.equal(d.grau, 8.0);
  assert.equal(d.conferGrau, true);

  const rm = parseDisciplinaLine('ICP141 Prog II 4.0 60 3.0 4.0 12.0 RM');
  assert.equal(rm.situacao, 'RM');
  assert.equal(rm.conferGrau, true); // reprovação entra no CR
});

test('limparLinhas remove legendas e ruído', () => {
  const limpas = limparLinhas([
    'LEGENDA',
    'SEM VALOR OFICIAL',
    'ICP131 Prog I 4.0 60 8.0 4.0 32.0 AP',
  ]);
  assert.equal(limpas.length, 1);
  assert.ok(limpas[0].startsWith('ICP131'));
});

// Itens sintéticos do BOA: coluna de disciplina pendente.
// credRecomY=277, perY=356; zona de aprovadas: y > 297.
const ITENS_BOA = [
  { str: 'ICP115', x: 100, y: 200 }, // código recomendado (linha mais baixa)
  { str: 'Álgebra Linear Algorítmica', x: 100, y: 250 }, // nome
  { str: '4.0', x: 100, y: 277 }, // Cred recomendado
  { str: '3', x: 100, y: 356 }, // Per
  { str: 'Inscrição Facultada', x: 100, y: 600 }, // status (ocorrências)
];

test('parsePaginaBOA extrai pendência obrigatória', () => {
  const { obrigatorias } = parsePaginaBOA(ITENS_BOA, {
    credRecomY: 277,
    perY: 356,
  });
  assert.equal(obrigatorias.length, 1);
  assert.equal(obrigatorias[0].codigo, 'ICP115');
  assert.equal(obrigatorias[0].periodoRecomendado, 3);
  assert.equal(obrigatorias[0].status, 'inscricao_facultada');
});

test('coluna com aprovação na zona superior não é pendência', () => {
  const aprovada = [
    ...ITENS_BOA,
    { str: 'MAB115', x: 100, y: 500 }, // aprovação equivalente
  ];
  const { obrigatorias } = parsePaginaBOA(aprovada, {
    credRecomY: 277,
    perY: 356,
  });
  assert.equal(obrigatorias.length, 0);
});

test('parsePaginaBOA retorna disciplinas aprovadas da zona superior', () => {
  const itens = [
    ...ITENS_BOA,
    { str: 'MAB115', x: 100, y: 500 }, // c�digo da atividade aprovada
    { str: '�lgebra Linear', x: 100, y: 520 }, // nome na zona aprovada
    { str: 'AP', x: 100, y: 560 }, // letra de aprova��o
    { str: '8.5', x: 100, y: 540 }, // grau
  ];
  const { obrigatorias, aprovadas } = parsePaginaBOA(itens, {
    credRecomY: 277,
    perY: 356,
  });
  assert.equal(obrigatorias.length, 0); // coluna cumprida n�o � pend�ncia
  const ap = aprovadas.find((d) => d.codigo === 'MAB115');
  assert.ok(ap);
  assert.equal(ap.situacao, 'AP');
  assert.equal(ap.grau, 8.5);
});

test('BOA sem aprova��o n�o retorna aprovadas', () => {
  const { aprovadas } = parsePaginaBOA(ITENS_BOA, {
    credRecomY: 277,
    perY: 356,
  });
  assert.equal(aprovadas.length, 0);
});

test('coluna com registro na zona superior marca o requisito como cumprido', () => {
  // Coluna da disciplina recomendada ICP115 com aprovação equivalente na
  // zona superior — o requisito conta como concluído para o ciclo básico.
  const itens = [
    ...ITENS_BOA,
    { str: 'MAB115', x: 100, y: 500 },
  ];
  const { obrigatorias, cumpridos } = parsePaginaBOA(itens, {
    credRecomY: 277,
    perY: 356,
  });
  assert.equal(obrigatorias.length, 0);
  assert.deepEqual(cumpridos.map((c) => c.codigo), ['ICP115']);
});

test('extrairMetadataBOA captura nome, DRE e curso do cabeçalho', () => {
  const items = [
    { str: 'BOLETIM DE ORIENTACAO ACADEMICA', x: 10, y: 800 },
    { str: 'Aluno: JOAO DA SILVA', x: 10, y: 780 },
    { str: 'Matricula: 123456789', x: 10, y: 760 },
    { str: '85783 - Ciência da Computação', x: 10, y: 740 },
  ];
  const meta = extrairMetadataBOA(items);
  assert.equal(meta.nome, 'JOAO DA SILVA');
  assert.equal(meta.dre, '123456789');
  assert.equal(meta.curso, '85783 - Ciência da Computação');
});

test('extrairMetadataBOA: fallback de DRE isolado e nome no topo', () => {
  const items = [
    { str: 'BOLETIM DE ORIENTACAO ACADEMICA', x: 10, y: 800 },
    { str: 'MARIA APARECIDA SOUZA', x: 10, y: 770 },
    { str: '987654321', x: 300, y: 770 },
  ];
  const meta = extrairMetadataBOA(items);
  assert.equal(meta.dre, '987654321');
  assert.equal(meta.nome, 'MARIA APARECIDA SOUZA');
});

// Layout real do SIGA: labels e valores estão em itens separados no topo da página.
test('extrairMetadataBOA: nome e DRE em itens separados no topo (layout real BOA)', () => {
  const items = [
    { str: 'Aluno', x: 113, y: 22 },
    { str: 'CASSIO EMANUEL FERREIRA DA SILVA', x: 123, y: 22 },
    { str: 'Matrícula', x: 113, y: 362 },
    { str: '120154812', x: 123, y: 362 },
    { str: '85783 - Ciência da Computação', x: 90, y: 517 },
  ];
  const meta = extrairMetadataBOA(items);
  assert.equal(meta.nome, 'CASSIO EMANUEL FERREIRA DA SILVA');
  assert.equal(meta.dre, '120154812');
  assert.equal(meta.curso, '85783 - Ciência da Computação');
});

test('coluna BOA concluída sem status de pendência gera cumprido', () => {
  const itens = [
    { str: 'ICP131', x: 100, y: 26 },
    { str: 'Programação de Computadores I', x: 100, y: 78 },
    { str: '4.0', x: 100, y: 279 },
    { str: '60', x: 100, y: 319 },
    { str: '1', x: 100, y: 358 },
    { str: 'MAB120', x: 100, y: 386 }, // aprovação equivalente na zona superior
  ];
  const { obrigatorias, cumpridos, aprovadas } = parsePaginaBOA(itens, {
    credRecomY: 277,
    perY: 356,
  });
  assert.equal(obrigatorias.length, 0);
  assert.deepEqual(cumpridos.map((c) => c.codigo), ['ICP131']);
  const ap = aprovadas.find((a) => a.codigo === 'MAB120');
  assert.ok(ap);
});
