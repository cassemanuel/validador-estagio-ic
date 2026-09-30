/**
 * Testes do motor de elegibilidade do PPC 2022 (rules/ppc2022.js)
 * contra a fonte Ãºnica frontend/rules/ciclo_basico.json.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  disciplinasFaltantesCicloBasico,
  verificarElegibilidadeEstagio,
} from '../../frontend/js/rules/ppc2022.js';
import { calcularCRAcumulado } from '../../frontend/js/domain/cr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const regras = JSON.parse(
  readFileSync(
    join(__dirname, '../../frontend/rules/ciclo_basico.json'),
    'utf-8'
  )
);

function historicoApto() {
  const disciplinas = regras.ciclo_basico.map((req) => ({
    codigo: req.codigo,
    nome: req.nome,
    crR: 4,
    grau: 8.0,
    pontos: 32.0,
    situacao: 'AP',
  }));
  const h = {
    periodos: [{ periodo: '2023/1', disciplinas }],
  };
  h.resumo = calcularCRAcumulado(h);
  return h;
}

test('aluno com ciclo bÃ¡sico completo e CR >= 6 Ã© apto', () => {
  const h = historicoApto();
  const { apto, criterios } = verificarElegibilidadeEstagio(h, regras);
  assert.ok(apto);
  assert.ok(criterios.every((c) => c.ok));
});

test('equivalÃªncia histÃ³rica MAB cobre requisito ICP', () => {
  const h = historicoApto();
  // Troca ICP131 (Prog. I) pelo equivalente MAB120.
  const disc = h.periodos[0].disciplinas.find((d) => d.codigo === 'ICP131');
  disc.codigo = 'MAB120';
  h.resumo = calcularCRAcumulado(h);
  assert.ok(verificarElegibilidadeEstagio(h, regras).apto);
});

test('faltante do ciclo bÃ¡sico torna inapto', () => {
  const h = historicoApto();
  h.periodos[0].disciplinas = h.periodos[0].disciplinas.filter(
    (d) => d.codigo !== 'MAD243'
  );
  h.resumo = calcularCRAcumulado(h);
  const { apto } = verificarElegibilidadeEstagio(h, regras);
  assert.equal(apto, false);
  assert.deepEqual(
    disciplinasFaltantesCicloBasico(h, regras).map((f) => f.codigo),
    ['MAD243']
  );
});

test('CR abaixo de 6 torna inapto', () => {
  const h = historicoApto();
  h.periodos[0].disciplinas.forEach((d) => {
    d.grau = 4.0;
    d.pontos = 16.0;
  });
  h.resumo = calcularCRAcumulado(h);
  assert.equal(verificarElegibilidadeEstagio(h, regras).apto, false);
});

test('mais de 14 perÃ­odos torna inapto', () => {
  const h = historicoApto();
  for (let i = 2; i <= 16; i++) {
    h.periodos.push({ periodo: `20${20 + i}/${(i % 2) + 1}`, disciplinas: [] });
  }
  const { apto, criterios } = verificarElegibilidadeEstagio(h, regras);
  assert.equal(apto, false);
  assert.equal(criterios[2].ok, false);
});

test('equivalência combinada MAB121+CMT012 cobre ICP131 e ICP141', () => {
  const h = historicoApto();
  const disciplinas = h.periodos[0].disciplinas;
  // Remove ICP131 e ICP141 e adiciona o par combinado MAB121 + CMT012.
  h.periodos[0].disciplinas = disciplinas.filter(
    (d) => d.codigo !== 'ICP131' && d.codigo !== 'ICP141'
  );
  h.periodos[0].disciplinas.push(
    { codigo: 'MAB121', nome: 'Matemática para Computação', crR: 4, grau: 7.0, pontos: 28, situacao: 'AP' },
    { codigo: 'CMT012', nome: 'Cálculo para Computação', crR: 4, grau: 7.0, pontos: 28, situacao: 'AP' },
  );
  h.resumo = calcularCRAcumulado(h);
  assert.ok(verificarElegibilidadeEstagio(h, regras).apto);
});

test('apenas metade do par combinado não cobre o requisito', () => {
  const h = historicoApto();
  h.periodos[0].disciplinas = h.periodos[0].disciplinas.filter(
    (d) => d.codigo !== 'ICP131'
  );
  h.periodos[0].disciplinas.push(
    { codigo: 'MAB121', nome: 'Matemática para Computação', crR: 4, grau: 7.0, pontos: 28, situacao: 'AP' },
  );
  h.resumo = calcularCRAcumulado(h);
  const faltantes = disciplinasFaltantesCicloBasico(h, regras).map((f) => f.codigo);
  // ICP131 continua faltando (CMT012 ausente); ICP141 segue coberta por si.
  assert.ok(faltantes.includes('ICP131'));
  assert.ok(!faltantes.includes('ICP141'));
});

test('MAC118 cobre MAE111 e MAC128 cobre MAE992', () => {
  const h = historicoApto();
  h.periodos[0].disciplinas.find((d) => d.codigo === 'MAE111').codigo = 'MAC118';
  h.periodos[0].disciplinas.find((d) => d.codigo === 'MAE992').codigo = 'MAC128';
  h.resumo = calcularCRAcumulado(h);
  assert.ok(verificarElegibilidadeEstagio(h, regras).apto);
});

test('ICP249 é o requisito de Tecnologia e Sociedade e ICP354 o cobre', () => {
  const codigos = regras.ciclo_basico.map((r) => r.codigo);
  // Códigos inexistentes no PPC 2022 foram removidos da fonte única.
  ['ICP251', 'ICP252', 'ICP253'].forEach((c) =>
    assert.ok(!codigos.includes(c), `${c} não deveria estar no ciclo básico`)
  );
  const tecsoc = regras.ciclo_basico.find((r) => r.codigo === 'ICP249');
  assert.ok(tecsoc);

  const h = historicoApto();
  h.periodos[0].disciplinas.find((d) => d.codigo === 'ICP249').codigo = 'ICP354';
  h.resumo = calcularCRAcumulado(h);
  assert.ok(verificarElegibilidadeEstagio(h, regras).apto);
});
