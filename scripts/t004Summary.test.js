import { describe, it, expect } from 'vitest';
import { opsFromReport, clusterMean, diffArms, pairedDiff, decide, summarize } from './t004Summary.js';

const op = (symbol, t, side, r) => ({ op: { symbol, candle_open_time: t, side }, r });
const rep = (rows) => ({ overall: { curve: rows.map((x) => op(...x)) } });

describe('opsFromReport', () => {
  it('lê R, chave (moeda|vela|lado) e mês; ignora R não numérico', () => {
    const o = opsFromReport({ overall: { curve: [op('BTCUSDT', '2026-01-05T08:00:00.000Z', 'BUY', 1.5), { op: { symbol: 'X', candle_open_time: '2026-01-06T00:00:00Z', side: 'BUY' }, r: null }] } });
    expect(o).toEqual([{ key: 'BTCUSDT|2026-01-05T08:00|BUY', month: '2026-01', r: 1.5 }]);
  });
  it('relatório sem curva: lista vazia', () => {
    expect(opsFromReport({})).toEqual([]);
  });
});

describe('clusterMean', () => {
  it('sem agrupamento relevante (um mês por operação): erro-padrão = desvio / raiz de n', () => {
    const ops = [1, 2, 3, 4].map((r, i) => ({ key: `k${i}`, month: `2026-0${i + 1}`, r }));
    const c = clusterMean(ops);
    expect(c.mean).toBeCloseTo(2.5, 10);
    // soma dos desvios^2 = 1,5^2 + 0,5^2 + 0,5^2 + 1,5^2 = 5 -> se = raiz(5)/4
    expect(c.se).toBeCloseTo(Math.sqrt(5) / 4, 10);
    expect(c.clusters).toBe(4);
  });
  it('o agrupamento por mês ALARGA o erro quando o mês inteiro anda junto (operações do mês não são independentes)', () => {
    const solto = [1, 1, -1, -1].map((r, i) => ({ key: `a${i}`, month: `m${i}`, r }));
    const junto = [1, 1, -1, -1].map((r, i) => ({ key: `b${i}`, month: i < 2 ? 'm0' : 'm1', r }));
    expect(clusterMean(junto).se).toBeGreaterThan(clusterMean(solto).se);
  });
  it('vazio: NaN, sem exceção', () => {
    expect(clusterMean([]).n).toBe(0);
  });
});

describe('diffArms e pairedDiff', () => {
  const A = [1, 2, 3].map((r, i) => ({ key: `k${i}`, month: `m${i}`, r }));
  const B = [0, 1, 2].map((r, i) => ({ key: `k${i}`, month: `m${i}`, r }));
  it('A - B = diferença das médias; IC = diferença ± 1,96 erro', () => {
    const d = diffArms(A, B);
    expect(d.diff).toBeCloseTo(1, 10);
    expect(d.ci95[0]).toBeLessThan(1);
    expect(d.ci95[1]).toBeGreaterThan(1);
  });
  it('pares: só as entradas iguais; média de R_A - R_B', () => {
    const p = pairedDiff(A, [{ key: 'k0', month: 'm0', r: 0 }, { key: 'zzz', month: 'm9', r: 5 }]);
    expect(p).toEqual({ pairs: 1, mean: 1 });
  });
});

describe('decide (regra pré-registrada)', () => {
  const w = (diff, lo) => ({ label: 'W', diff, ci95: [lo, diff + 0.2] });
  it('adotar: diferença > 0,05 nas duas janelas E IC exclui zero nas duas', () => {
    expect(decide([w(0.12, 0.02), w(0.2, 0.05)])).toBe('adotar_modo_pine');
  });
  it('manter produção: diferença <= 0 em QUALQUER janela', () => {
    expect(decide([w(0.3, 0.1), w(-0.01, -0.2)])).toBe('manter_producao');
    expect(decide([w(0, -0.1), w(0.3, 0.1)])).toBe('manter_producao');
  });
  it('inconclusivo: positivo mas pequeno, ou IC cruzando zero', () => {
    expect(decide([w(0.03, 0.01), w(0.2, 0.05)])).toBe('inconclusivo'); // efeito <= 0,05 em uma janela
    expect(decide([w(0.12, -0.05), w(0.2, 0.05)])).toBe('inconclusivo'); // IC cruza zero em uma janela
  });
  it('dado ausente: inconclusivo (nunca decide no escuro)', () => {
    expect(decide([])).toBe('inconclusivo');
    expect(decide([{ label: 'W', diff: NaN, ci95: [NaN, NaN] }])).toBe('inconclusivo');
  });
});

describe('summarize', () => {
  it('monta a tabela e o veredito; nunca afirma "adotar" quando a diferença é negativa', () => {
    const mk = (rs) => rep(rs.map((r, i) => ['BTCUSDT', `2026-0${(i % 9) + 1}-01T00:00:00Z`, 'BUY', r]));
    const out = summarize({ W1: { A: mk([-1, -1, 0.5, 0.2]), B: mk([0.5, 0.5, 0.5, 0.5]) }, W2: { A: mk([1, 1, 1]), B: mk([0, 0, 0]) } });
    expect(out.verdict).toBe('manter_producao');
    expect(out.markdown).toMatch(/T-2026-004/);
    expect(out.markdown).toMatch(/MANTER A PRODUÇÃO/);
    expect(out.markdown).not.toMatch(/ADOTAR O MODO PINE/);
    expect(out.windows).toHaveLength(2);
  });
});

import { prepareArm } from './t004Summary.js';
import fs from 'node:fs';

describe('prepareArm (fonte única: o pré-registro)', () => {
  const prereg = JSON.parse(fs.readFileSync('docs/experiments/pine-vs-producao-prereg.json', 'utf8'));
  it('braço A e B, janelas W1 e W2: moedas, datas, timeframes e chaves do pré-registro', () => {
    const a = prepareArm(prereg, 'W1', 'A_modo_pine');
    expect(a.symbols.split(',')).toHaveLength(7);
    expect(a).toMatchObject({ from: '2025-11-24', to: '2026-11-24', timeframes: '15m,1h,4h,1d' });
    expect(a.pineConfig.preTp1TrailEnabled).toBe(false);
    expect(a.pineConfig.disableTp2CapEnabled).toBe(true);
    const b = prepareArm(prereg, 'W2', 'B_producao');
    expect(b).toMatchObject({ from: '2024-11-24', to: '2025-11-24' });
    expect(b.pineConfig).toEqual({ skip15mConfirmationEnabled: true });
  });
  it('janela ou braço desconhecido: erro claro (nada de adivinhar)', () => {
    expect(() => prepareArm(prereg, 'W9', 'A_modo_pine')).toThrow(/janela desconhecida/);
    expect(() => prepareArm(prereg, 'W1', 'C')).toThrow(/braço desconhecido/);
  });
});
