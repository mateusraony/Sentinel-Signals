// docs/known-risks.md item 269 — tamanho pela volatilidade. Dados sintéticos
// com a resposta conhecida: efeito plantado tem que ser achado; ruído não.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { dailySigma, weightSeries, opsFromReport, clusterT, runVolSizingWindow, combineWindows, formatWindowMarkdown, formatCombinedMarkdown } from './volSizing.mjs';
import { studentTCritical95 } from './backtest-correlation-check.mjs';
import { synthWindow } from './__fixtures__/volSizingSynth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREREG = JSON.parse(readFileSync(resolve(__dirname, '../docs/experiments/vol-sizing-prereg.json'), 'utf8'));
const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.parse('2026-01-01T00:00:00Z');
const candles = (closes, start = D0) => closes.map((close, i) => ({ openTime: start + i * DAY, closeTime: start + (i + 1) * DAY - 1, open: close, close }));
const run = (opts) => runVolSizingWindow({ ...synthWindow({ prereg: PREREG, ...opts }), prereg: PREREG });
const SHA = { preregSha256: 'x' };
const both = (opts) => PREREG.windows.map((w) => ({ ...run({ ...opts, windowLabel: w.label }), preregSha256: 'x' }));

describe('pré-registro travado (mudar exige mudar este teste, à vista no PR)', () => {
  it('janelas, moedas, peso, inferência e régua congelados', () => {
    expect(PREREG.windows).toEqual([
      { label: 'W1', from: '2025-10-10', to: '2026-10-10' },
      { label: 'W2', from: '2024-07-27', to: '2025-07-27' },
    ]);
    expect(PREREG.symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'FETUSDT', 'PENDLEUSDT', 'ZROUSDT', 'DYDXUSDT', 'PAXGUSDT']);
    expect([PREREG.nSeeds, PREREG.randomProb]).toEqual([40, 0.0075]);
    expect([PREREG.lookbackDays, PREREG.refDays, PREREG.minRefDays, PREREG.weightClamp]).toEqual([20, 365, 180, [0.5, 2]]);
    expect([PREREG.clusterBy, PREREG.alpha, PREREG.minEffectR, PREREG.predictedSdRatio]).toEqual(['entryMonthUTC', 0.025, 0.05, 1.06]);
  });
});

describe('volatilidade e peso — só o que já fechou', () => {
  it('σ do dia D = desvio amostral dos retornos log das velas fechadas antes de D', () => {
    const closes = [100, 110, 99, 108.9, 98.01];
    const s = dailySigma(candles(closes), 2);
    const r = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    const sd2 = (a, b) => Math.abs(a - b) / Math.sqrt(2);
    expect(s.get(D0 + 3 * DAY)).toBeCloseTo(sd2(r[0], r[1]), 12);
    expect(s.get(D0 + 5 * DAY)).toBeCloseTo(sd2(r[2], r[3]), 12);
    expect(s.has(D0 + 2 * DAY)).toBe(false); // ainda sem 2 retornos fechados
  });

  it('causal: mudar a vela do próprio dia ou do futuro não muda o σ nem o peso daquele dia', () => {
    const base = candles(Array.from({ length: 400 }, (_, i) => 100 * Math.exp(0.02 * Math.sin(i / 3) + 0.001 * i)));
    const day = D0 + 300 * DAY;
    const changed = base.map((c) => (c.openTime >= day ? { ...c, close: c.close * 3 } : c));
    const opts = { fromMs: day, toMs: day + DAY, refDays: 365, minRefDays: 180, clamp: [0.5, 2] };
    expect(dailySigma(changed, 20).get(day)).toBe(dailySigma(base, 20).get(day));
    expect(weightSeries(dailySigma(changed, 20), opts)[0].w).toBe(weightSeries(dailySigma(base, 20), opts)[0].w);
  });

  it('buraco nas velas deixa o dia sem σ', () => {
    const c = candles([100, 101, 102, 103, 104, 105]).filter((_, i) => i !== 3);
    expect(dailySigma(c, 2).has(D0 + 4 * DAY)).toBe(false);
  });

  it('peso = mediana da referência ÷ σ do dia, limitado a [0,5; 2]; sem referência suficiente, 1', () => {
    const sigma = new Map();
    for (let k = 0; k < 400; k += 1) sigma.set(D0 + k * DAY, 0.02);
    sigma.set(D0 + 399 * DAY, 0.01);
    sigma.set(D0 + 398 * DAY, 0.1);
    const ws = weightSeries(sigma, { fromMs: D0 + 397 * DAY, toMs: D0 + 400 * DAY, refDays: 365, minRefDays: 180, clamp: [0.5, 2] });
    expect(ws.map((x) => x.w)).toEqual([1, 0.5, 2]);
    expect(ws.every((x) => !x.flat)).toBe(true);
    const early = weightSeries(sigma, { fromMs: D0 + 100 * DAY, toMs: D0 + 101 * DAY, refDays: 365, minRefDays: 180, clamp: [0.5, 2] });
    expect(early[0]).toMatchObject({ w: 1, flat: true });
    // A referência é só dos dias ANTERIORES: o dia 179 tem 179 dias antes dele
    // (plano); o dia 180 tem 180 (já pesa).
    const edge = weightSeries(sigma, { fromMs: D0 + 179 * DAY, toMs: D0 + 181 * DAY, refDays: 365, minRefDays: 180, clamp: [0.5, 2] });
    expect(edge.map((x) => x.flat)).toEqual([true, false]);
  });
});

describe('estatística', () => {
  it('t sobre as somas por mês; o limiar é o t de Student unicaudal 2,5% com G−1 graus', () => {
    const r = clusterT([0.01, 0.02, 0.03, 0.02], 0.025);
    // média 0,02, desvio 0,008165 → t = 0,02·√4/0,008165
    expect(r.total).toBeCloseTo(0.08, 12);
    expect(r.t).toBeCloseTo((0.02 * 2) / Math.sqrt(0.0002 / 3), 9);
    expect(r.critical).toBe(studentTCritical95(3, 0.05));
    expect(r.pass).toBe(true);
    expect(clusterT([0.01, -0.01, 0.01, -0.01], 0.025).pass).toBe(false);
  });

  it('T = média(w̃·R) − média(R) entre os braços; somar uma constante a todo R não muda nada', () => {
    const input = synthWindow({ prereg: PREREG, seed: 9 });
    const r = runVolSizingWindow({ ...input, prereg: PREREG });
    const shifted = (rep) => ({ ...rep, overall: { ...rep.overall, curve: rep.overall.curve.map((c) => ({ ...c, r: c.r + 0.37 })) } });
    const r2 = runVolSizingWindow({ ...input, control: shifted(input.control), randoms: input.randoms.map(shifted), prereg: PREREG });
    expect(r2.observed).toBeCloseTo(r.observed, 12);
    // Conferência à mão no R0.
    const fromMs = Date.parse(`${PREREG.windows[0].from}T00:00:00Z`);
    const toMs = Date.parse(`${PREREG.windows[0].to}T00:00:00Z`);
    const weights = Object.fromEntries(PREREG.symbols.map((s) => [s, weightSeries(dailySigma(input.candlesBySymbol[s], 20), { fromMs, toMs, refDays: 365, minRefDays: 180, clamp: [0.5, 2] })]));
    const ops = opsFromReport(input.control);
    const ws = ops.map((o) => weights[o.symbol][Math.floor((o.openedMs - fromMs) / DAY)].w);
    const mw = ws.reduce((a, b) => a + b, 0) / ws.length;
    const manual = ops.reduce((a, o, i) => a + (ws[i] / mw) * o.r, 0) / ops.length - ops.reduce((a, o) => a + o.r, 0) / ops.length;
    expect(r.observedR0).toBeCloseTo(manual, 12);
    expect(r.clusterSums.reduce((a, x) => a + x.sum, 0)).toBeCloseTo(r.observed, 12);
  });
});

describe('veredito — acha o que existe, não inventa o que não existe', () => {
  it('ruído puro → NO_VOLSIZING_EDGE', () => {
    const c = combineWindows(both({ seed: 21 }), PREREG, SHA);
    expect(c.verdict).toBe('NO_VOLSIZING_EDGE');
    expect(formatCombinedMarkdown(c)).toMatch(/não melhorou/);
  });

  it('efeito forte plantado (operação em mercado calmo rende mais) → VOLSIZING_EDGE', () => {
    const windows = both({ seed: 22, beta: 1 });
    expect(formatWindowMarkdown(windows[0])).toMatch(/janela W1/);
    const c = combineWindows(windows, PREREG, SHA);
    expect(c.verdict).toBe('VOLSIZING_EDGE');
    expect(c.observed).toBeGreaterThan(PREREG.minEffectR);
    expect(formatCombinedMarkdown(c)).toMatch(/melhorou o resultado/);
  });

  it('efeito pequeno demais (abaixo de 0,05R) não passa mesmo sendo significativo', () => {
    const c = combineWindows(both({ seed: 23, beta: 0.2 }), PREREG, SHA);
    expect(c.checks.significance).toBe(true);
    expect(c.checks.effect).toBe(false);
    expect(c.verdict).toBe('NO_VOLSIZING_EDGE');
  });
}, 60000);

describe('INCOMPLETE — rodada que não bate com o pré-registro não vira resposta', () => {
  it('janela fora do pré-registro, seed faltando, Fibonacci ligada ou outra probabilidade', () => {
    const base = synthWindow({ prereg: PREREG, seed: 30 });
    const wrongRange = { ...base.control, range: { ...base.control.range, from: '2025-10-11T00:00:00.000Z' } };
    expect(runVolSizingWindow({ ...base, control: wrongRange, prereg: PREREG }).errors.join(' ')).toMatch(/não é nenhuma das pré-registradas/);
    expect(runVolSizingWindow({ ...base, randoms: base.randoms.slice(1), prereg: PREREG }).verdict).toBe('INCOMPLETE');
    const fib = (rep) => ({ ...rep, reproducibility: { ...rep.reproducibility, pineConfig: { ...rep.reproducibility.pineConfig, fibEntryEnabled: true } } });
    expect(runVolSizingWindow({ ...base, control: fib(base.control), randoms: base.randoms.map(fib), prereg: PREREG }).errors.join(' ')).toMatch(/Fibonacci/);
    const prob = (rep) => ({ ...rep, reproducibility: { ...rep.reproducibility, pineConfig: { ...rep.reproducibility.pineConfig, randomEntryProb: 0.01 } } });
    expect(runVolSizingWindow({ ...base, randoms: base.randoms.map(prob), prereg: PREREG }).errors.join(' ')).toMatch(/randomEntryProb/);
  });

  it('moeda negociada sem velas diárias ou com buraco no dia da entrada', () => {
    const base = synthWindow({ prereg: PREREG, seed: 31 });
    const { BTCUSDT, ...rest } = base.candlesBySymbol;
    expect(BTCUSDT.length).toBeGreaterThan(0);
    expect(runVolSizingWindow({ ...base, candlesBySymbol: rest, prereg: PREREG }).errors.join(' ')).toMatch(/BTCUSDT sem velas diárias/);
    const op = opsFromReport(base.control).find((o) => o.symbol === 'ETHUSDT');
    const hole = base.candlesBySymbol.ETHUSDT.filter((c) => c.openTime !== Math.floor(op.openedMs / DAY) * DAY - 5 * DAY);
    const r = runVolSizingWindow({ ...base, candlesBySymbol: { ...base.candlesBySymbol, ETHUSDT: hole }, prereg: PREREG });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.errors.join(' ')).toMatch(/ETHUSDT sem σ no dia da entrada/);
  });

  it('combinar exige as duas janelas, completas, com o mesmo pré-registro', () => {
    const [w1, w2] = both({ seed: 32 });
    expect(combineWindows([w1], PREREG, SHA).verdict).toBe('INCOMPLETE');
    expect(combineWindows([w1, w1], PREREG, SHA).verdict).toBe('INCOMPLETE');
    expect(combineWindows([w1, { ...w2, preregSha256: 'y' }], PREREG, SHA).verdict).toBe('INCOMPLETE');
    // As duas com o mesmo hash, mas diferente do pré-registro atual.
    expect(combineWindows([{ ...w1, preregSha256: 'y' }, { ...w2, preregSha256: 'y' }], PREREG, SHA).verdict).toBe('INCOMPLETE');
    expect(combineWindows([w1, w2], PREREG).verdict).toBe('INCOMPLETE');
    expect(combineWindows([w1, { ...w2, reportCommitSha: 'b'.repeat(40) }], PREREG, SHA).errors.join(' ')).toMatch(/mesmo commit/);
    expect(combineWindows([w1, { verdict: 'INCOMPLETE', window: 'W2', errors: ['faltou'], preregSha256: 'x' }], PREREG, SHA).verdict).toBe('INCOMPLETE');
    expect(combineWindows([w2, w1], PREREG, SHA).verdict).not.toBe('INCOMPLETE');
  });
}, 60000);
