/**
 * Testes do motor de CR (domain/cr.js) — portados do bloco de testes
 * manuais do calculator.js legado.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calcularCR,
  calcularCRAcumulado,
  calcularCRDisciplinas,
  disciplinaConcluida,
  disciplinaConferGrau,
  situacaoConferGrau,
} from '../../frontend/js/domain/cr.js';

const EPS = 1e-6;

test('situações que conferem grau', () => {
  for (const sf of ['AP', 'RM', 'RF', 'RFM']) {
    assert.ok(situacaoConferGrau(sf), `${sf} deve conferir grau`);
  }
  for (const sf of ['NCG', 'NCC', 'T', 'Cursando']) {
    assert.ok(!situacaoConferGrau(sf), `${sf} não deve conferir grau`);
  }
});

test('grau textual não entra no CR', () => {
  assert.ok(!disciplinaConferGrau({ situacao: 'AP', grau: 'T', crR: 4 }));
  assert.ok(!disciplinaConferGrau({ situacao: 'AP', grau: 'NCG', crR: 2 }));
  assert.ok(disciplinaConferGrau({ situacao: 'AP', grau: 10.0, crR: 4 }));
  assert.ok(disciplinaConferGrau({ situacao: 'RM', grau: 0, crR: 4 }));
});

test('conclusão para integralização aceita AP/T', () => {
  assert.ok(disciplinaConcluida({ situacao: 'AP' }));
  assert.ok(disciplinaConcluida({ situacao: 'T' }));
  assert.ok(disciplinaConcluida({ situacao: 'X', grau: 'T' }));
  assert.ok(!disciplinaConcluida({ situacao: 'RM' }));
  assert.ok(!disciplinaConcluida({ situacao: 'CURSANDO' }));
});

test('CR simples e lista de disciplinas', () => {
  assert.ok(Math.abs(calcularCR(42, 6) - 7) < EPS);
  assert.equal(calcularCR(10, 0), 0);

  const res = calcularCRDisciplinas([
    { situacao: 'AP', grau: 8.4, crR: 5, pontos: 42 },
    { situacao: 'RM', grau: 0, crR: 4, pontos: 0 },
  ]);
  assert.equal(res.crRComGrau, 9);
  assert.ok(Math.abs(res.crCalculado - 42 / 9) < EPS);
});

test('NCG/NCC/T/Cursando ignorados no CR', () => {
  const res = calcularCRDisciplinas([
    { situacao: 'AP', grau: 8, crR: 4, pontos: 32 },
    { situacao: 'NCG', crR: 2 },
    { situacao: 'T', crR: 4 },
    { situacao: 'Cursando', crR: 4 },
  ]);
  assert.equal(res.crRComGrau, 4);
  assert.ok(Math.abs(res.crCalculado - 8) < EPS);
});

test('CR acumulado via historyData', () => {
  const historyData = {
    periodos: [
      {
        periodo: '2020/2',
        disciplinas: [
          { situacao: 'AP', grau: 8.4, crR: 5, pontos: 42 },
          { situacao: 'RM', grau: 0, crR: 4, pontos: 0 },
          { situacao: 'NCG', crR: 2 },
        ],
      },
    ],
  };
  const res = calcularCRAcumulado(historyData);
  assert.equal(res.crRComGrau, 9);
  assert.ok(Math.abs(res.crCalculado - 42 / 9) < EPS);
});
