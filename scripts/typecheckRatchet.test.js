// docs/known-risks.md item 166 — a catraca do typecheck.
//
// O teste que importa aqui é o do BURACO: ao testar a catraca pela primeira
// vez, um erro de sintaxe fez o tsc abortar a análise e reportar 1 erro em vez
// de 17 — a contagem DESPENCOU e a catraca teria aprovado um projeto quebrado.
// Uma catraca que só olha o número tem exatamente o defeito que ela previne.
import { describe, it, expect } from 'vitest';
import { contarErros, temErroDeSintaxe } from './typecheck-ratchet.mjs';

const SAIDA_TIPOS = [
  "src/lib/tradeMetrics.js(234,9): error TS2353: Object literal may only specify known properties.",
  "src/pages/Assets.jsx(254,102): error TS2322: Type '{ title: string; }' is not assignable.",
].join('\n');

const SAIDA_SINTAXE = "src/lib/signalRejection.js(105,12): error TS1005: ',' expected.";

describe('contarErros', () => {
  it('conta uma linha por erro reportado', () => {
    expect(contarErros(SAIDA_TIPOS)).toBe(2);
  });

  it('saída limpa é zero, e entrada ausente não lança', () => {
    expect(contarErros('')).toBe(0);
    expect(contarErros(null)).toBe(0);
    expect(contarErros(undefined)).toBe(0);
  });
});

describe('temErroDeSintaxe', () => {
  it('REGRESSÃO: erro de sintaxe (TS1xxx) é reprovação, não "menos erros"', () => {
    // Este é o caso real: 1 erro na saída, MENOS que o teto de 16 — passaria
    // na comparação numérica e levaria um projeto que nem compila para o main.
    expect(contarErros(SAIDA_SINTAXE)).toBe(1);
    expect(temErroDeSintaxe(SAIDA_SINTAXE)).toBe(true);
  });

  it('erro de TIPO (TS2xxx) não é sintaxe — esse é julgado pelo teto', () => {
    expect(temErroDeSintaxe(SAIDA_TIPOS)).toBe(false);
  });

  it('saída limpa não acusa sintaxe', () => {
    expect(temErroDeSintaxe('')).toBe(false);
    expect(temErroDeSintaxe(null)).toBe(false);
  });
});
