/**
 * Testes da contagem de eletivas/optativas cursadas (domain/eletivas.js),
 * usada pela "Análise de Desempenho" do discente e pela Mesa da comissão.
 *
 * Regressão: o BOA marcava colunas do elenco recomendado como "cumpridas"
 * (código da vaga + 4 créditos presumidos), que eram somadas às eletivas já
 * presentes no Boletim — ex.: 88/44 créditos para quem tinha 44.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FONTE_BOA_CUMPRIDA,
  PERIODO_BOA,
  codigosObrigatorios,
  creditosEletivasCursadas,
  disciplinaCursada,
  listarEletivasCursadas,
} from '../../frontend/js/domain/eletivas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const regras = JSON.parse(
  readFileSync(join(__dirname, '../../frontend/rules/ciclo_basico.json'), 'utf-8')
);

const disc = (codigo, situacao = 'AP', crR = 4, extra = {}) => ({
  codigo, nome: `Disciplina ${codigo}`, situacao, crR, grau: 8.0, ...extra,
});

/** Boletim com ciclo básico completo + as eletivas informadas. */
function periodosBoletim(eletivas) {
  return [
    { periodo: '2022/1', disciplinas: regras.ciclo_basico.map((r) => disc(r.codigo)) },
    { periodo: '2023/1', disciplinas: eletivas },
  ];
}

test('só conta eletivas aprovadas/dispensadas do Boletim', () => {
  const periodos = periodosBoletim([
    disc('COS812'),
    disc('ICPX10'),
    disc('COS813', 'RM'),        // reprovada
    disc('COS814', 'CURSANDO'),  // em curso
    disc('COS815', 'RF'),        // reprovada por frequência
  ]);
  const lista = listarEletivasCursadas(periodos, regras);
  assert.deepEqual(lista.map((d) => d.codigo), ['COS812', 'ICPX10']);
  assert.equal(creditosEletivasCursadas(periodos, regras), 8);
});

test('obrigatórias do PPC (inclusive equivalências aceitas) nunca entram', () => {
  const obrigatorias = codigosObrigatorios(regras);
  assert.ok(obrigatorias.has('ICP123'), 'obrigatória do ciclo profissional');
  assert.ok(obrigatorias.has('MAB120'), 'equivalência aceita de ICP131');

  const periodos = periodosBoletim([disc('ICP123'), disc('MAB120'), disc('COS812')]);
  assert.deepEqual(listarEletivasCursadas(periodos, regras).map((d) => d.codigo), ['COS812']);
  assert.equal(creditosEletivasCursadas(periodos, regras), 4);
});

test('colunas "cumpridas" do elenco recomendado do BOA não viram eletivas', () => {
  const periodos = [
    ...periodosBoletim([disc('COS812'), disc('COS816')]),
    {
      periodo: PERIODO_BOA,
      disciplinas: [
        // Vagas de optativa do elenco recomendado marcadas como concluídas.
        disc('ICPX01', 'AP', 4, { fonte: FONTE_BOA_CUMPRIDA, grau: null }),
        disc('ICPX02', 'AP', 4, { fonte: FONTE_BOA_CUMPRIDA, grau: null }),
      ],
    },
  ];
  assert.equal(creditosEletivasCursadas(periodos, regras), 8);
  assert.deepEqual(
    listarEletivasCursadas(periodos, regras).map((d) => d.codigo),
    ['COS812', 'COS816']
  );
});

test('regressão 88/44: 44 créditos no Boletim continuam 44 com o BOA mesclado', () => {
  const eletivas = Array.from({ length: 11 }, (_, i) => disc(`COS9${String(i).padStart(2, '0')}`));
  const cumpridas = Array.from({ length: 11 }, (_, i) =>
    disc(`ICPX${String(i).padStart(2, '0')}`, 'AP', 4, { fonte: FONTE_BOA_CUMPRIDA }));
  const periodos = [
    ...periodosBoletim(eletivas),
    // Repetidas do Boletim também aparecem na zona de aprovadas do BOA.
    { periodo: PERIODO_BOA, disciplinas: [...cumpridas, ...eletivas.slice(0, 3)] },
  ];
  assert.equal(creditosEletivasCursadas(periodos, regras), 44);
});

test('zona de aprovadas do BOA complementa o Boletim sem duplicar', () => {
  const periodos = periodosBoletim([disc('COS812')]);
  const aprovadasBoa = [
    disc('COS812'),             // já está no Boletim
    disc('NEP101', 'AP', 2),    // só no BOA
    disc('COS817', 'RM'),       // reprovada no BOA
  ];
  const lista = listarEletivasCursadas(periodos, regras, aprovadasBoa);
  assert.deepEqual(lista.map((d) => [d.codigo, d.fonte]), [['COS812', 'boletim'], ['NEP101', 'boa']]);
});

test('NCC conta como cursada mas não confere crédito; T e NCG conferem', () => {
  const periodos = periodosBoletim([
    disc('COS821', 'NCC', 4),
    disc('COS822', 'T', 4),
    disc('COS823', 'NCG', 2),
  ]);
  const lista = listarEletivasCursadas(periodos, regras);
  assert.equal(lista.length, 3);
  assert.equal(creditosEletivasCursadas(periodos, regras), 6);
});

test('disciplinaCursada aceita AP, T, A, NCC e NCG (e grau "T")', () => {
  for (const s of ['AP', 'T', 'A', 'NCC', 'NCG', 'ap']) assert.ok(disciplinaCursada({ situacao: s }), s);
  for (const s of ['RM', 'RF', 'RFM', 'CURSANDO', '', undefined]) assert.ok(!disciplinaCursada({ situacao: s }), String(s));
  assert.ok(disciplinaCursada({ situacao: '', grau: 'T' }));
});

test('sem regras carregadas, a contagem é zero (não inventa créditos)', () => {
  assert.equal(creditosEletivasCursadas(periodosBoletim([disc('COS812')]), null), 0);
});
