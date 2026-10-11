// docs/known-risks.md item 268 — teste de tendência semanal. Dados sintéticos
// com a resposta conhecida: momentum plantado tem que ser achado; ruído não.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mulberry32 } from '../src/lib/seededRandom.js';
import { buildWeeks, symbolSeries, evaluateTiming, holmThresholds, runWeeklyTrend, formatWeeklyTrendMarkdown } from './weeklyTrend.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREREG = JSON.parse(readFileSync(resolve(__dirname, '../docs/experiments/weekly-trend-prereg.json'), 'utf8'));
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const MON = Date.parse('2018-10-01T00:00:00Z'); // segunda

// Velas diárias com retornos semanais r_t = beta·sinal(r_{t−1})·sigma + ruído·sigma,
// distribuídos igualmente pelos 7 dias (em log).
function synthDaily({ weeks, seed, beta = 0, sigma = 0.08, startMonday = MON }) {
  const rand = mulberry32(seed);
  const gauss = () => { const u = Math.max(rand(), 1e-12); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
  const out = [];
  let price = 100;
  let prev = 0;
  for (let w = 0; w < weeks; w += 1) {
    const r = beta * Math.sign(prev) * sigma + gauss() * sigma;
    const daily = r / 7;
    for (let d = 0; d < 7; d += 1) {
      const open = price;
      price *= Math.exp(daily);
      const openTime = startMonday + w * WEEK + d * DAY;
      out.push({ openTime, closeTime: openTime + DAY - 1, open, high: Math.max(open, price), low: Math.min(open, price), close: price });
    }
    prev = r;
  }
  return out;
}

const WEEKS_ALL = Math.floor((Date.parse(PREREG.end) + 1 - MON) / WEEK);
const datasetFor = (beta, seed) => Object.fromEntries([...PREREG.primarySymbols, ...PREREG.descriptiveSymbols].map((s, i) => {
  // Listagens tardias como as reais (aproximadas): DYDX 2021-09, PENDLE 2023-07, ZRO 2024-06, PAXG 2020-09.
  const lateStart = { DYDXUSDT: '2021-09-13', PENDLEUSDT: '2023-07-03', ZROUSDT: '2024-06-24', PAXGUSDT: '2020-09-07' }[s];
  const startMonday = lateStart ? Date.parse(`${lateStart}T00:00:00Z`) : MON;
  const weeks = Math.floor((Date.parse(PREREG.end) + 1 - startMonday) / WEEK);
  return [s, synthDaily({ weeks, seed: seed + i, beta, startMonday })];
}));

describe('pré-registro travado (mudar exige mudar este teste, à vista no PR)', () => {
  it('universo, datas, regra, nula e régua congelados', () => {
    expect(PREREG.primarySymbols).toEqual(['BTCUSDT', 'ETHUSDT', 'FETUSDT', 'DYDXUSDT', 'PENDLEUSDT', 'ZROUSDT']);
    expect(PREREG.coPrimarySymbol).toBe('BTCUSDT');
    expect(PREREG.descriptiveSymbols).toEqual(['PAXGUSDT']);
    expect([PREREG.start, PREREG.end]).toEqual(['2019-01-07T00:00:00.000Z', '2026-10-04T23:59:59.999Z']);
    expect(PREREG.halves).toEqual([
      { from: '2019-01-07T00:00:00.000Z', to: '2022-12-25T23:59:59.999Z' },
      { from: '2023-01-02T00:00:00.000Z', to: '2026-10-04T23:59:59.999Z' },
    ]);
    expect([PREREG.lookbackWeeks, PREREG.secondaryLookbackWeeks, PREREG.excludeWeeksAfterListing, PREREG.minShiftWeeks]).toEqual([1, 4, 8, 8]);
    expect([PREREG.costBpsPerSide, PREREG.alphaFamily, PREREG.minAnnualExcess, PREREG.minCoPrimaryWeeks, PREREG.maxMissingWeeks]).toEqual([6, 0.025, 0.02, 300, 2]);
    expect(new Date(PREREG.start).getUTCDay()).toBe(1);
    expect(new Date(Date.parse(PREREG.end) - DAY + 1).getUTCDay()).toBe(0);
  });
});

describe('semanas, sinal e causalidade', () => {
  it('semana só conta com as 7 velas; vela além do FIM não entra', () => {
    const daily = synthDaily({ weeks: 4, seed: 1 });
    expect(buildWeeks(daily, { endMs: Infinity })).toHaveLength(4);
    const missing = daily.filter((_, i) => i !== 9); // tira a quarta-feira da semana 2
    expect(buildWeeks(missing, { endMs: Infinity }).map((w) => w.weekStart)).toEqual([MON, MON + 2 * WEEK, MON + 3 * WEEK]);
    expect(buildWeeks(daily, { endMs: MON + 2 * WEEK - 1 })).toHaveLength(2);
  });

  it('sinal da semana t usa só t−1 e t−1−L; retorno é abertura de segunda → fechamento de domingo', () => {
    const daily = synthDaily({ weeks: 20, seed: 2 });
    const weeks = buildWeeks(daily, { endMs: Infinity });
    const s = symbolSeries(weeks, { startMs: MON, endMs: Infinity, lookbackWeeks: 1, excludeWeeks: 0 });
    for (const e of s) {
      const i = weeks.findIndex((w) => w.weekStart === e.weekStart);
      expect(e.pos).toBe(weeks[i - 1].close / weeks[i - 2].close - 1 > 0 ? 1 : 0);
      expect(e.ret).toBeCloseTo(weeks[i].close / weeks[i].open - 1, 12);
    }
    // Causal: a posição da semana t não muda se o futuro mudar.
    const truncated = symbolSeries(buildWeeks(daily.slice(0, 10 * 7), { endMs: Infinity }), { startMs: MON, endMs: Infinity, lookbackWeeks: 1, excludeWeeks: 0 });
    for (const e of truncated) expect(s.find((x) => x.weekStart === e.weekStart).pos).toBe(e.pos);
  });

  it('exclui as primeiras semanas após a listagem e respeita o início', () => {
    const weeks = buildWeeks(synthDaily({ weeks: 30, seed: 3 }), { endMs: Infinity });
    const s = symbolSeries(weeks, { startMs: MON, endMs: Infinity, lookbackWeeks: 1, excludeWeeks: 8 });
    expect(s[0].weekStart).toBe(MON + 8 * WEEK);
  });
});

describe('nula de deslocamento comum', () => {
  it('custo: 6 bps por troca, contado em círculo; comprado/vendido tem o mesmo p', () => {
    const entries = [{ pos: 1, ret: 0.1 }, { pos: 1, ret: -0.05 }, { pos: 0, ret: 0.2 }, { pos: 1, ret: 0.03 }]
      .map((e, i) => ({ ...e, weekStart: MON + i * WEEK }));
    const r = evaluateTiming([{ symbol: 'X', entries }], { minShift: 1, costPerSide: 0.0006 });
    // A 1ª semana compara com a última (comprado → comprado: sem custo).
    // 0,1 ; −0,05 ; 0−0,0006 ; 0,03−0,0006 → média
    expect(r.observed).toBeCloseTo((0.1 - 0.05 - 0.0006 + 0.0294) / 4, 12);
    const series = Object.entries(datasetFor(0.3, 10)).slice(0, 2).map(([symbol, d]) => ({
      symbol, entries: symbolSeries(buildWeeks(d, { endMs: Infinity }), { startMs: MON, endMs: Infinity, lookbackWeeks: 1, excludeWeeks: 0 }),
    }));
    const lf = evaluateTiming(series, { minShift: 8, costPerSide: 0.0006 });
    const ls = evaluateTiming(series, { minShift: 8, costPerSide: 0.0006, transform: (p) => 2 * p - 1 });
    expect(ls.p).toBeCloseTo(lf.p, 12);
    expect(lf.shifts).toBeGreaterThan(300);
  });

  it('toda rotação paga o mesmo custo (retorno zero → toda a nula é igual ao observado)', () => {
    const rand = mulberry32(7);
    const entries = Array.from({ length: 60 }, (_, i) => ({ weekStart: MON + i * WEEK, pos: rand() < 0.5 ? 1 : 0, ret: 0 }));
    const r = evaluateTiming([{ symbol: 'X', entries }], { minShift: 8, costPerSide: 0.0006 });
    expect(r.observed).toBeLessThan(0);
    expect(r.nullDistribution.min).toBeCloseTo(r.observed, 15);
    expect(r.nullDistribution.max).toBeCloseTo(r.observed, 15);
  });

  it('o mesmo k vale para todas as moedas: k vai até (série mais curta − mín)', () => {
    const rand = mulberry32(8);
    const mk = (n, offset) => Array.from({ length: n }, (_, i) => ({ weekStart: MON + (offset + i) * WEEK, pos: rand() < 0.5 ? 1 : 0, ret: rand() - 0.5 }));
    const r = evaluateTiming([{ symbol: 'A', entries: mk(40, 0) }, { symbol: 'B', entries: mk(30, 10) }], { minShift: 8, costPerSide: 0 });
    expect(r.shifts).toBe(30 - 2 * 8 + 1);
  });

  it('Holm de livro', () => {
    expect(holmThresholds([0.01, 0.02], 0.025).map((x) => x.pass)).toEqual([true, true]);
    expect(holmThresholds([0.02, 0.01], 0.025).map((x) => x.pass)).toEqual([true, true]);
    expect(holmThresholds([0.013, 0.02], 0.025).map((x) => x.pass)).toEqual([false, false]);
  });
});

describe('runWeeklyTrend — acha o que existe, não inventa o que não existe', () => {
  it('momentum forte plantado → TREND_FOUND', () => {
    const r = runWeeklyTrend(datasetFor(0.5, 100), PREREG);
    expect(r.verdict).toBe('TREND_FOUND');
    expect(r.tests[0].full.p).toBeLessThan(0.0125);
    expect(formatWeeklyTrendMarkdown(r)).toMatch(/Achei tendência semanal/);
  });

  it('ruído puro → NO_TREND_EDGE', () => {
    const r = runWeeklyTrend(datasetFor(0, 200), PREREG);
    expect(r.verdict).toBe('NO_TREND_EDGE');
    expect(formatWeeklyTrendMarkdown(r)).toMatch(/Não achei vantagem/);
  });

  it('moeda primária sem dado ou BTC curto → INCOMPLETE', () => {
    const d = datasetFor(0, 300);
    delete d.ETHUSDT;
    expect(runWeeklyTrend(d, PREREG).verdict).toBe('INCOMPLETE');
    const short = datasetFor(0, 301);
    short.BTCUSDT = short.BTCUSDT.slice(-100 * 7);
    expect(runWeeklyTrend(short, PREREG).verdict).toBe('INCOMPLETE');
  });

  it('histórico cortado no fim, BTC começando tarde ou semanas faltando → INCOMPLETE', () => {
    const lastDay = Date.parse(PREREG.end) - DAY + 1;
    const truncated = datasetFor(0, 400);
    truncated.ETHUSDT = truncated.ETHUSDT.filter((c) => c.openTime < lastDay - 20 * WEEK);
    const rt = runWeeklyTrend(truncated, PREREG);
    expect(rt.verdict).toBe('INCOMPLETE');
    expect(rt.untested.join(' ')).toMatch(/ETHUSDT: termina/);

    const late = datasetFor(0, 401);
    late.BTCUSDT = late.BTCUSDT.filter((c) => c.openTime >= Date.parse('2019-03-04T00:00:00Z'));
    const rl = runWeeklyTrend(late, PREREG);
    expect(rl.coverage.BTCUSDT.weeks).toBeGreaterThanOrEqual(PREREG.minCoPrimaryWeeks);
    expect(rl.verdict).toBe('INCOMPLETE');
    expect(rl.untested.join(' ')).toMatch(/BTCUSDT: começa/);

    // Um dia faltando = 1 semana incompleta (tolerado até 2); três = INCOMPLETE.
    const holes = (n) => {
      const d = datasetFor(0, 402);
      const drop = new Set(Array.from({ length: n }, (_, i) => Date.parse('2021-03-03T00:00:00Z') + i * 10 * WEEK));
      d.FETUSDT = d.FETUSDT.filter((c) => !drop.has(c.openTime));
      return runWeeklyTrend(d, PREREG);
    };
    expect(holes(1).coverage.FETUSDT.missingWeeks).toBe(1);
    expect(holes(1).verdict).not.toBe('INCOMPLETE');
    const r3 = holes(3);
    expect(r3.coverage.FETUSDT.missingWeeks).toBe(3);
    expect(r3.verdict).toBe('INCOMPLETE');
    expect(r3.untested.join(' ')).toMatch(/FETUSDT: 3 semanas faltando/);
  });
}, 60000);
