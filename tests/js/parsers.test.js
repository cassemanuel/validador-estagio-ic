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
import { parsePaginaBOA } from '../../frontend/js/parsers/boaParser.js';

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
