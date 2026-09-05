// docs/known-risks.md item 166 — a catraca do typecheck.
//
// O teste que importa aqui é o do BURACO: ao testar a catraca pela primeira
// vez, um erro de sintaxe fez o tsc abortar a análise e reportar 1 erro em vez
// de 17 — a contagem DESPENCOU e a catraca teria aprovado um projeto quebrado.
// Uma catraca que só olha o número tem exatamente o defeito que ela previne.
import { describe, it, expect } from 'vitest';
import { contarErros, temErroDeSintaxe, avaliarExecucao } from './typecheck-ratchet.mjs';

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

// Achados do Codex no PR #312 — os dois verificados por reprodução antes da
// correção. Ver o cabeçalho de typecheck-ratchet.mjs, "os três buracos".
describe('avaliarExecucao — o compilador chegou a rodar?', () => {
  const ok = { status: 0, signal: null, saida: '', erroDeSpawn: null };

  it('status normal com diagnósticos de tipo conta como execução válida', () => {
    expect(avaliarExecucao(ok).rodou).toBe(true);
    expect(avaliarExecucao({ ...ok, status: 1, saida: 'a.js(1,1): error TS2322: nope' }).rodou).toBe(true);
    expect(avaliarExecucao({ ...ok, status: 2 }).rodou).toBe(true);
  });

  it('REGRESSÃO: config sem arquivos de entrada (TS18003) NÃO é "zero erros"', () => {
    // O caso real: um jsconfig apontando para pasta inexistente fazia a versão
    // anterior sair com código 0 — CI verde sem nenhum arquivo checado.
    const r = avaliarExecucao({ ...ok, status: 1, saida: "error TS18003: No inputs were found in config file" });
    expect(r.rodou).toBe(false);
    expect(r.motivo).toMatch(/TS18003/);
  });

  it('erro de opção/config do compilador (TS5xxx/TS6xxx) reprova', () => {
    expect(avaliarExecucao({ ...ok, status: 1, saida: 'error TS5058: The specified path does not exist' }).rodou).toBe(false);
    expect(avaliarExecucao({ ...ok, status: 1, saida: 'error TS6053: File not found' }).rodou).toBe(false);
  });

  it('compilador morto por sinal, ausente, ou com código estranho reprova', () => {
    expect(avaliarExecucao({ ...ok, signal: 'SIGKILL' }).rodou).toBe(false);
    expect(avaliarExecucao({ ...ok, erroDeSpawn: 'spawn npx ENOENT' }).rodou).toBe(false);
    expect(avaliarExecucao({ ...ok, status: 127 }).rodou).toBe(false);
    expect(avaliarExecucao({ ...ok, status: null }).rodou).toBe(false);
  });

  it('cada reprovação explica O QUE foi observado, nunca uma suposição', () => {
    for (const caso of [
      { ...ok, signal: 'SIGKILL' },
      { ...ok, erroDeSpawn: 'ENOENT' },
      { ...ok, status: 127 },
      { ...ok, status: 1, saida: 'error TS18003: x' },
    ]) {
      expect(avaliarExecucao(caso).motivo).toBeTruthy();
    }
  });
});

describe('erro de sintaxe × código de 5 dígitos', () => {
  it('TS1005 é sintaxe; TS18003 não é (é config, tratado à parte)', () => {
    expect(temErroDeSintaxe('error TS1005: expected')).toBe(true);
    expect(temErroDeSintaxe('error TS18003: No inputs')).toBe(false);
  });
});
