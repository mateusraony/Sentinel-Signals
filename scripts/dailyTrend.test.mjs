// docs/known-risks.md item 271 — teste de tendência diária EMA 10/21 +
// Supertrend(10,3). Dados sintéticos com a resposta conhecida: tendência
// plantada tem que ser achada; ruído não; dado faltando invalida a rodada.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildDays, supertrend, dailySignals, dailyShortSignals, symbolDailySeries, runDailyTrend, formatDailyTrendMarkdown } from './dailyTrend.mjs';
import { evaluateTiming } from './weeklyTrend.mjs';
import { synthMarket, REPLICATION_PREREG } from './__fixtures__/dailyTrendSynth.mjs';
import { mulberry32 } from '../src/lib/seededRandom.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREREG = JSON.parse(readFileSync(resolve(__dirname, '../docs/experiments/daily-ema-supertrend-prereg.json'), 'utf8'));
const DAY = 24 * 60 * 60 * 1000;

// Versão encurtada SÓ para os testes rodarem rápido (mesmas regras, janela de
// ~3,8 anos). O pré-registro real fica travado no 1º describe.
const FAST = {
  ...PREREG,
  start: '2023-01-02T00:00:00.000Z',
  halves: [
    { from: '2023-01-02T00:00:00.000Z', to: '2024-12-29T23:59:59.999Z' },
    { from: '2024-12-30T00:00:00.000Z', to: '2026-10-04T23:59:59.999Z' },
  ],
  minCoPrimaryDays: 1000,
};
const marketFor = (seed, scenario, drift) => synthMarket({ seed, scenario, drift, prereg: FAST, symbols: FAST.primarySymbols });

const candle = (i, o, h, l, c) => ({ openTime: i * DAY, closeTime: (i + 1) * DAY - 1, open: o, high: h, low: l, close: c });

describe('pré-registro travado (mudar exige mudar este teste, à vista no PR)', () => {
  it('universo, datas, regra, nula e régua congelados', () => {
    expect(PREREG.primarySymbols).toEqual(['BTCUSDT', 'ETHUSDT', 'FETUSDT', 'DYDXUSDT', 'PENDLEUSDT', 'ZROUSDT']);
    expect(PREREG.coPrimarySymbol).toBe('BTCUSDT');
    expect(PREREG.descriptiveSymbols).toEqual(['PAXGUSDT']);
    expect([PREREG.fetchFrom, PREREG.start, PREREG.end]).toEqual(['2018-06-01', '2019-01-07T00:00:00.000Z', '2026-10-04T23:59:59.999Z']);
    expect(PREREG.halves).toEqual([
      { from: '2019-01-07T00:00:00.000Z', to: '2022-12-25T23:59:59.999Z' },
      { from: '2023-01-02T00:00:00.000Z', to: '2026-10-04T23:59:59.999Z' },
    ]);
    expect([PREREG.emaFast, PREREG.emaSlow, PREREG.stAtrPeriod, PREREG.stFactor]).toEqual([10, 21, 10, 3]);
    expect([PREREG.warmupDaysAfterListing, PREREG.minShiftDays, PREREG.costBpsPerSide]).toEqual([126, 56, 6]);
    // Metade do α do item 268: 2ª tentativa da família de tendência nos mesmos dados.
    expect([PREREG.alphaFamily, PREREG.minAnnualExcess]).toEqual([0.0125, 0.02]);
    expect([PREREG.minCoPrimaryDays, PREREG.maxMissingDays]).toEqual([2500, 3]);
    expect(PREREG.robustness.map((v) => v.label)).toEqual(['EMA 8/21', 'EMA 12/26', 'Supertrend fator 2,5', 'Supertrend fator 3,5']);
  });
});

describe('Supertrend no padrão do ta.supertrend do Pine', () => {
  it('caso calculado à mão (ATR 2, fator 1)', () => {
    const c = [candle(0, 10, 11, 9, 10), candle(1, 10, 12, 10, 11), candle(2, 11, 14, 12, 13.5), candle(3, 13.5, 13, 11, 11.5), candle(4, 11.5, 11, 9, 10)];
    const st = supertrend(c, { atrPeriod: 2, factor: 1 });
    // 1ª vela com ATR começa de baixa (linha = banda de cima); vira de alta ao
    // fechar acima da banda de cima; a banda de baixo segura com a catraca; vira
    // de baixa ao fechar abaixo dela.
    expect(st.up).toEqual([null, false, true, true, false]);
    expect(st.line).toEqual([null, 13, 10.5, 10.5, 12.5]);
  });

  it('causal: o valor da vela i é o mesmo com a série inteira ou só até i', () => {
    const days = buildDays(marketFor(5, 'adverse').ETHUSDT, { endMs: Date.parse(FAST.end) }).slice(0, 400);
    const full = supertrend(days, { atrPeriod: 10, factor: 3 });
    const fullSig = dailySignals(days, FAST);
    // Começa em 10: um prefixo de exatamente 10 velas fica abaixo do mínimo de
    // calculateATRSeries (período + 1) e volta vazio; na série inteira o
    // índice 9 já tem valor, mas só com as velas 0..9 (não é olhar à frente).
    expect(full.up[9]).not.toBeNull();
    for (const i of [10, 11, 25, 120, 250, 399]) {
      const pre = supertrend(days.slice(0, i + 1), { atrPeriod: 10, factor: 3 });
      expect(pre.up[i]).toBe(full.up[i]);
      expect(pre.line[i]).toBe(full.line[i]);
      expect(dailySignals(days.slice(0, i + 1), FAST)[i]).toBe(fullSig[i]);
    }
  });
});

describe('posição, retorno e janela', () => {
  it('o dia j usa o sinal do fechamento de j−1 e o retorno fechamento de j−1 → fechamento de j', () => {
    const days = buildDays(marketFor(6, 'iid').BTCUSDT, { endMs: Date.parse(FAST.end) });
    const signals = dailySignals(days, FAST);
    const entries = symbolDailySeries(days, signals, { startMs: Date.parse(FAST.start), endMs: Date.parse(FAST.end), warmupDays: 126 });
    const idx = new Map(days.map((d, i) => [d.openTime, i]));
    for (const e of entries.slice(0, 50)) {
      const j = idx.get(e.weekStart);
      expect(e.pos).toBe(signals[j - 1]);
      expect(e.ret).toBeCloseTo(days[j].close / days[j - 1].close - 1, 12);
    }
    expect(entries[0].weekStart).toBe(Date.parse(FAST.start));
    expect(entries.at(-1).weekStart).toBe(Date.parse(FAST.end) + 1 - DAY);
  });

  it('retorno inclui o salto entre o fechamento de ontem e a abertura de hoje (posição mantida)', () => {
    const days = [candle(0, 100, 101, 99, 100), candle(1, 104, 106, 103, 105)];
    const [e] = symbolDailySeries(days, [1, 1], { startMs: 0, endMs: 2 * DAY, warmupDays: 0 });
    expect(e.ret).toBeCloseTo(0.05, 12); // 100 → 105, não 104 → 105
  });

  it('mudar o futuro não muda a posição de hoje (sem olhar à frente)', () => {
    const days = buildDays(marketFor(7, 'adverse').FETUSDT, { endMs: Date.parse(FAST.end) });
    const cut = 900;
    const tampered = days.map((d, i) => (i > cut ? { ...d, close: d.close * 3, high: d.high * 3, low: d.low * 0.2 } : d));
    const a = dailySignals(days, FAST);
    const b = dailySignals(tampered, FAST);
    expect(b.slice(0, cut + 1)).toEqual(a.slice(0, cut + 1));
  });

  it('dia sem o dia anterior não entra; aquecimento após a listagem é respeitado', () => {
    const days = buildDays(marketFor(8, 'iid').ZROUSDT, { endMs: Date.parse(FAST.end) });
    const signals = dailySignals(days, FAST);
    const holed = days.filter((_, i) => i !== 500);
    const holedSignals = dailySignals(holed, FAST);
    const opts = { startMs: Date.parse(FAST.start), endMs: Date.parse(FAST.end), warmupDays: 126 };
    const entries = symbolDailySeries(holed, holedSignals, opts);
    expect(entries.some((e) => e.weekStart === days[501].openTime)).toBe(false);
    expect(symbolDailySeries(days, signals, opts)[0].weekStart).toBe(days[126].openTime);
  });

  it('excesso ao ano usa 365 períodos no diário', () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ weekStart: i * DAY, pos: i % 40 < 20 ? 1 : 0, ret: i % 40 < 20 ? 0.001 : -0.001 }));
    const r = evaluateTiming([{ symbol: 'X', entries }], { minShift: 56, costPerSide: 0, periodsPerYear: 365 });
    expect(r.excessAnnual).toBeCloseTo((r.observed - r.nullMedian) * 365, 12);
    const weekly = evaluateTiming([{ symbol: 'X', entries }], { minShift: 56, costPerSide: 0 });
    expect(weekly.excessAnnual).toBeCloseTo((weekly.observed - weekly.nullMedian) * 52, 12);
  });
});

describe('runDailyTrend — acha o que existe, não inventa o que não existe', () => {
  it('tendência forte plantada → TREND_FOUND', () => {
    const r = runDailyTrend(marketFor(11, 'trend', 0.006), FAST, { descriptive: false });
    expect(r.verdict).toBe('TREND_FOUND');
    expect(formatDailyTrendMarkdown(r)).toMatch(/Achei tendência diária/);
  });

  it('ruído com cauda gorda, volatilidade em blocos e deriva → NO_TREND_EDGE, com a parte descritiva', () => {
    const r = runDailyTrend(marketFor(12, 'adverse'), FAST);
    expect(r.verdict).toBe('NO_TREND_EDGE');
    expect(r.descriptive.robustness).toHaveLength(4);
    expect(formatDailyTrendMarkdown(r)).toMatch(/Não achei vantagem/);
  });

  it('moeda primária sem dado, cortada no fim, com buracos ou BTC tardio → INCOMPLETE', () => {
    const missing = marketFor(13, 'iid');
    delete missing.ETHUSDT;
    expect(runDailyTrend(missing, FAST, { descriptive: false }).untested.join(' ')).toMatch(/ETHUSDT: sem dado/);

    const truncated = marketFor(14, 'iid');
    truncated.FETUSDT = truncated.FETUSDT.filter((c) => c.openTime < Date.parse(FAST.end) - 30 * DAY);
    const rt = runDailyTrend(truncated, FAST, { descriptive: false });
    expect(rt.verdict).toBe('INCOMPLETE');
    expect(rt.untested.join(' ')).toMatch(/FETUSDT: termina/);

    const holes = (n) => {
      const d = marketFor(15, 'iid');
      const drop = new Set(Array.from({ length: n }, (_, i) => Date.parse('2024-03-01T00:00:00Z') + i * 40 * DAY));
      d.ETHUSDT = d.ETHUSDT.filter((c) => !drop.has(c.openTime));
      return runDailyTrend(d, FAST, { descriptive: false });
    };
    expect(holes(3).coverage.ETHUSDT.missingDays).toBe(3);
    expect(holes(3).verdict).not.toBe('INCOMPLETE');
    const r4 = holes(4);
    expect(r4.verdict).toBe('INCOMPLETE');
    expect(r4.untested.join(' ')).toMatch(/ETHUSDT: 4 dias faltando/);

    const late = marketFor(16, 'iid');
    late.BTCUSDT = late.BTCUSDT.filter((c) => c.openTime >= Date.parse('2023-01-01T00:00:00Z'));
    const rl = runDailyTrend(late, FAST, { descriptive: false });
    expect(rl.verdict).toBe('INCOMPLETE');
    expect(rl.untested.join(' ')).toMatch(/BTCUSDT: começa/);
  });
}, 120000);

// Item 272 — replicação em 13 moedas novas: mesma regra, sem co-primário.
const FAST_REP = { ...REPLICATION_PREREG, start: FAST.start, halves: FAST.halves };
const repMarketFor = (seed, scenario, drift) => synthMarket({ seed, scenario, drift, prereg: FAST_REP, symbols: FAST_REP.primarySymbols });

describe('replicação (item 272)', () => {
  it('universo = carteira de referência de 20 (docs/roadmap.md) menos as 7 do item 271; regra idêntica', () => {
    const reference20 = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'XRPUSDT', 'SOLUSDT', 'AVAXUSDT', 'LINKUSDT',
      'DOTUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'NEARUSDT', 'AAVEUSDT', 'ONDOUSDT', 'FETUSDT',
      'PENDLEUSDT', 'ZROUSDT', 'DYDXUSDT', 'PAXGUSDT'];
    const used271 = [...PREREG.primarySymbols, ...PREREG.descriptiveSymbols];
    expect(REPLICATION_PREREG.primarySymbols).toEqual(reference20.filter((s) => !used271.includes(s)));
    expect(REPLICATION_PREREG.coPrimarySymbol).toBeNull();
    expect(REPLICATION_PREREG.descriptiveSymbols).toEqual([]);
    for (const k of ['fetchFrom', 'start', 'end', 'halves', 'emaFast', 'emaSlow', 'stAtrPeriod', 'stFactor',
      'warmupDaysAfterListing', 'minShiftDays', 'costBpsPerSide', 'minAnnualExcess', 'maxMissingDays', 'robustness']) {
      expect(REPLICATION_PREREG[k]).toEqual(PREREG[k]);
    }
    // Um teste só, confirmatório: α 0,025 sem divisão de família.
    expect(REPLICATION_PREREG.alphaFamily).toBe(0.025);
    expect(REPLICATION_PREREG.costSensitivityBps).toEqual([10, 20]);
  });

  it('sem co-primário: um teste só (a carteira), com o α inteiro', () => {
    const r = runDailyTrend(repMarketFor(21, 'adverse'), FAST_REP, { descriptive: false });
    expect(r.tests.map((t) => t.name)).toEqual(['carteira']);
    expect(r.tests[0].holm.threshold).toBe(0.025);
    expect(r.verdict).not.toBe('INCOMPLETE');
    expect(r.title).toBe('replicação em 13 moedas novas');
  });

  it('carteira cujo dado mais antigo começa depois do início → INCOMPLETE', () => {
    const d = repMarketFor(22, 'iid');
    for (const s of Object.keys(d)) d[s] = d[s].filter((c) => c.openTime >= Date.parse('2023-01-01T00:00:00Z'));
    const r = runDailyTrend(d, FAST_REP, { descriptive: false });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.untested.join(' ')).toMatch(/carteira: a moeda mais antiga começa/);
  });

  it('descritivos: trocas, composto e custo maior (com excesso e p recalculados)', () => {
    const r = runDailyTrend(repMarketFor(23, 'trend', 0.006), FAST_REP);
    const d = r.descriptive;
    expect(d.perSymbol.every((x) => Number.isInteger(x.switches) && x.switches > 0)).toBe(true);
    expect(d.switchesPerSymbolYear).toBeGreaterThan(0);
    expect(Number.isFinite(d.strategy.cagr) && Number.isFinite(d.buyAndHold.cagr)).toBe(true);
    expect(d.costSensitivity.map((c) => c.bpsPerSide)).toEqual([10, 20]);
    expect(d.costSensitivity[0].meanDaily).toBeLessThan(r.tests[0].full.observed);
    expect(d.costSensitivity[1].meanDaily).toBeLessThan(d.costSensitivity[0].meanDaily);
    expect(d.costSensitivity.every((c) => Number.isFinite(c.excessAnnual) && c.p > 0 && c.p <= 1)).toBe(true);
    const md = formatDailyTrendMarkdown(r);
    expect(md).toMatch(/Trocas de posição: .* por moeda por ano/);
    expect(md).toMatch(/10 bps\/lado → líquido .*, excesso .*\/ano \(p /);
    expect(md).not.toMatch(/não muda com o custo/);
  });

  it('custo do descritivo no valor pré-registrado reproduz o teste que decide', () => {
    const r = runDailyTrend(repMarketFor(24, 'adverse'), { ...FAST_REP, costSensitivityBps: [FAST_REP.costBpsPerSide] });
    const [c] = r.descriptive.costSensitivity;
    expect(c.meanDaily).toBe(r.tests[0].full.observed);
    expect(c.excessAnnual).toBe(r.tests[0].full.excessAnnual);
    expect(c.p).toBe(r.tests[0].full.p);
  });

  // Custo circular: por moeda, toda rotação paga o mesmo número de trocas.
  const posSeries = (symbol, n, seed, offsetDays = 0) => {
    const rand = mulberry32(seed);
    let pos = 0;
    return { symbol, entries: Array.from({ length: n }, (_, i) => {
      if (rand() < 0.15) pos = 1 - pos;
      return { weekStart: (offsetDays + i) * DAY, pos, ret: 0.02 * (rand() - 0.5) };
    }) };
  };

  it('uma moeda: custo maior baixa o líquido e deixa o excesso igual', () => {
    const series = [posSeries('X', 240, 7)];
    const cheap = evaluateTiming(series, { minShift: 10, costPerSide: 0.0006, periodsPerYear: 365 });
    const dear = evaluateTiming(series, { minShift: 10, costPerSide: 0.002, periodsPerYear: 365 });
    expect(dear.observed).toBeLessThan(cheap.observed);
    expect(dear.excessAnnual).toBeCloseTo(cheap.excessAnnual, 10);
  });

  it('carteira com entradas em datas diferentes: o excesso MUDA com o custo (por isso é recalculado)', () => {
    // A tem 240 dias; B entra no dia 120. Antes disso A pesa 1, depois 1/2:
    // deslocar as trocas de A entre os dois trechos muda o custo da nula.
    const series = [posSeries('A', 240, 7), posSeries('B', 120, 8, 120)];
    const cheap = evaluateTiming(series, { minShift: 10, costPerSide: 0.0006, periodsPerYear: 365 });
    const dear = evaluateTiming(series, { minShift: 10, costPerSide: 0.002, periodsPerYear: 365 });
    expect(Math.abs(dear.excessAnnual - cheap.excessAnnual)).toBeGreaterThan(1e-4);
  });
}, 120000);

// Item 274 — venda espelhada: vendido quando EMA10 < EMA21 E Supertrend de baixa.
describe('venda espelhada (item 274)', () => {
  const SHORT = { ...FAST_REP, side: 'short', requirePositiveNet: true };
  const shortMarket = (seed, scenario, drift) => synthMarket({ seed, scenario, drift, prereg: SHORT, symbols: SHORT.primarySymbols });

  it('sinal: −1 só com EMA rápida abaixo da lenta E Supertrend de baixa; nunca junto com o comprado', () => {
    const closes = Array.from({ length: 400 }, (_, i) => 100 * Math.exp(0.25 * Math.sin(i / 30) + 0.0003 * i));
    const days = closes.map((c, i) => candle(i, c, c * 1.01, c * 0.99, c));
    const long = dailySignals(days, FAST);
    const short = dailyShortSignals(days, FAST);
    expect(new Set(short.filter((x) => x !== null))).toEqual(new Set([-1, 0]));
    for (let i = 0; i < days.length; i += 1) {
      if (short[i] === -1) expect(long[i]).toBe(0);
      expect(short[i] === null).toBe(long[i] === null);
    }
    // "Fora" da compra não é "vendido": há dias neutros (nem 1 nem −1).
    expect(long.some((x, i) => x === 0 && short[i] === 0)).toBe(true);
    // Causal: a série completa é igual ao cálculo só com o prefixo.
    for (const i of [150, 250, 399]) expect(dailyShortSignals(days.slice(0, i + 1), FAST)[i]).toBe(short[i]);
  });

  it('tendência plantada (±0,6%/dia) → a venda passa, com retorno líquido positivo', () => {
    const r = runDailyTrend(shortMarket(31, 'trend', 0.006), SHORT);
    expect(r.side).toBe('short');
    expect(r.verdict).toBe('TREND_FOUND');
    expect(r.tests[0].netPass).toBe(true);
    expect(r.descriptive.longShort).toBeNull();
    expect(Number.isFinite(r.descriptive.shortAndHold.cagr)).toBe(true);
    const md = formatDailyTrendMarkdown(r);
    expect(md).toMatch(/Venda espelhada diária/);
    expect(md).toMatch(/Retorno líquido positivo \(exigido para a venda\): carteira sim/);
    expect(md).not.toMatch(/Comprado\/vendido/);
  });

  it('ganhar do sorteio não basta: timing que passa mas perde dinheiro → NO_TREND_EDGE', () => {
    const r = runDailyTrend(shortMarket(36, 'trend', 0.006), SHORT, { descriptive: false });
    const t = r.tests[0];
    expect(t.holm.pass && t.halvesPass && t.effectPass).toBe(true);
    expect(t.full.observed).toBeLessThan(0);
    expect(t.netPass).toBe(false);
    expect(r.verdict).toBe('NO_TREND_EDGE');
  });

  it('mercado que só sobe (nula hostil, deriva +0,1%/dia) → a venda não passa', () => {
    const r = runDailyTrend(shortMarket(31, 'adverse'), SHORT, { descriptive: false });
    expect(r.tests[0].netPass).toBe(false);
    expect(r.verdict).toBe('NO_TREND_EDGE');
  });

  it('sem `side`, nada muda: a regra de compra não ganha `side` nem `netPass` na saída', () => {
    const r = runDailyTrend(repMarketFor(37, 'trend', 0.006), FAST_REP, { descriptive: false });
    expect(r.side).toBeUndefined();
    expect('netPass' in r.tests[0]).toBe(false);
  });
}, 120000);

// Item 274 — acompanhamento em tempo novo: pré-registros congelados ANTES do período.
describe('tempo novo (item 274) — pré-registros travados', () => {
  const read = (f) => JSON.parse(readFileSync(resolve(__dirname, `../docs/experiments/${f}`), 'utf8'));
  const LONG = read('daily-ema-supertrend-forward-prereg.json');
  const SHORT_FWD = read('daily-ema-supertrend-forward-short-prereg.json');
  const SAME = ['fetchFrom', 'emaFast', 'emaSlow', 'stAtrPeriod', 'stFactor', 'warmupDaysAfterListing', 'minShiftDays',
    'costBpsPerSide', 'minAnnualExcess', 'maxMissingDays', 'robustness'];

  it('compra: mesma regra do 271, as 19 moedas dos itens 271/272 e só dias nunca vistos', () => {
    for (const k of SAME) expect(LONG[k]).toEqual(PREREG[k]);
    expect(LONG.primarySymbols).toEqual([...PREREG.primarySymbols, ...REPLICATION_PREREG.primarySymbols]);
    expect(LONG.descriptiveSymbols).toEqual(PREREG.descriptiveSymbols);
    expect(LONG.coPrimarySymbol).toBeNull();
    // Prospectivo de verdade (review do Codex, PR #499): começa no 1º dia UTC
    // inteiro DEPOIS do registro — nenhuma vela do período existia ao congelar.
    expect(Date.parse(LONG.start)).toBeGreaterThanOrEqual(Date.parse(`${LONG.registeredAt}T00:00:00Z`) + DAY);
    expect(Date.parse(LONG.start)).toBeGreaterThan(Date.parse(PREREG.end));
    expect([LONG.registeredAt, LONG.start, LONG.end]).toEqual(['2026-10-16', '2026-10-17T00:00:00.000Z', '2028-10-16T23:59:59.999Z']);
    expect((Date.parse(LONG.end) + 1 - Date.parse(LONG.start)) / DAY).toBe(731); // 2 anos, o horizonte calibrado
    expect(LONG.halves).toEqual([
      { from: '2026-10-17T00:00:00.000Z', to: '2027-10-16T23:59:59.999Z' },
      { from: '2027-10-17T00:00:00.000Z', to: '2028-10-16T23:59:59.999Z' },
    ]);
    // Calibração: com 2 anos, α 0,025 dava 2,5% de alarme falso, sem folga.
    expect(LONG.alphaFamily).toBe(0.0125);
    expect(LONG.costSensitivityBps).toEqual([10, 20]);
    expect(LONG.side).toBeUndefined();
  });

  it('venda: teste próprio, igual à compra exceto o lado, o retorno positivo exigido e o α', () => {
    const { name, title, note, side, requirePositiveNet, alphaFamily, ...rest } = SHORT_FWD;
    const { name: n2, title: t2, note: o2, alphaFamily: a2, ...restLong } = LONG;
    expect(rest).toEqual(restLong);
    expect([side, requirePositiveNet, alphaFamily]).toEqual(['short', true, 0.025]);
    expect([name, n2]).toEqual(['daily-ema-supertrend-forward-short-274', 'daily-ema-supertrend-forward-274']);
    expect([title, t2, note, o2].every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
  });

  it('rodar antes do fim pré-registrado → INCOMPLETE (o dado termina antes)', () => {
    const early = { ...LONG, fetchFrom: '2025-06-01' };
    const m = synthMarket({ seed: 41, scenario: 'iid', prereg: { ...early, end: '2027-04-30T23:59:59.999Z' }, symbols: early.primarySymbols });
    const r = runDailyTrend(m, early, { descriptive: false });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.untested.join(' ')).toMatch(/19 moedas terminam antes do fim pré-registrado \(máximo 3\)/);
  });

  it('moeda deslistada antes do fim sai da carteira inteira (até 3); mais que isso → INCOMPLETE', () => {
    expect([LONG.maxDelisted, SHORT_FWD.maxDelisted]).toEqual([3, 3]);
    const fast = { ...LONG, fetchFrom: '2025-06-01' };
    const market = () => synthMarket({ seed: 42, scenario: 'iid', prereg: fast, symbols: fast.primarySymbols });
    const cut = Date.parse('2027-06-30T00:00:00Z');
    const one = market();
    one.ZROUSDT = one.ZROUSDT.filter((c) => c.openTime <= cut);
    const r1 = runDailyTrend(one, fast, { descriptive: false });
    expect(r1.delisted).toEqual(['ZROUSDT']);
    expect(r1.verdict).not.toBe('INCOMPLETE');
    expect(r1.tests[0].full.usable).not.toContain('ZROUSDT');
    expect(r1.tests[0].full.usable).toHaveLength(18);
    expect(formatDailyTrendMarkdown(r1)).toMatch(/Deslistadas antes do fim .*: ZROUSDT \(última vela 2027-06-30\)/);

    const four = market();
    for (const s of ['ZROUSDT', 'DYDXUSDT', 'ONDOUSDT', 'ARBUSDT']) four[s] = four[s].filter((c) => c.openTime <= cut);
    const r4 = runDailyTrend(four, fast, { descriptive: false });
    expect(r4.verdict).toBe('INCOMPLETE');
    expect(r4.untested.join(' ')).toMatch(/4 moedas terminam antes do fim pré-registrado \(máximo 3\)/);
  });

  it('buraco perto do fim NÃO é deslistagem (review do Codex, PR #499): última vela presente → INCOMPLETE', () => {
    const fast = { ...LONG, fetchFrom: '2025-06-01' };
    const m = synthMarket({ seed: 43, scenario: 'iid', prereg: fast, symbols: fast.primarySymbols });
    // Falta só a penúltima vela: o dado não parou, tem buraco.
    const penult = Date.parse(fast.end) + 1 - 2 * DAY;
    m.ZROUSDT = m.ZROUSDT.filter((c) => c.openTime !== penult);
    const r = runDailyTrend(m, fast, { descriptive: false });
    expect(r.delisted).toEqual([]);
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.untested.join(' ')).toMatch(/ZROUSDT: termina em .*, antes do fim pré-registrado/);

    // Dado que para cedo mas com buraco grande antes da parada também não conta como deslistagem.
    const g = synthMarket({ seed: 43, scenario: 'iid', prereg: fast, symbols: fast.primarySymbols });
    const cut = Date.parse('2027-06-30T00:00:00Z');
    g.ZROUSDT = g.ZROUSDT.filter((c) => c.openTime <= cut && (c.openTime < cut - 20 * DAY || c.openTime > cut - 10 * DAY));
    const rg = runDailyTrend(g, fast, { descriptive: false });
    expect(rg.delisted).toEqual([]);
    expect(rg.verdict).toBe('INCOMPLETE');
    expect(rg.untested.join(' ')).toMatch(/ZROUSDT: velas param em 2027-06-30 com \d+ dias faltando antes/);
  });
}, 120000);

