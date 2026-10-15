// docs/known-risks.md item 273 — filtro de tendência diária sobre as entradas.
// Dados sintéticos com a resposta conhecida: efeito plantado tem que ser
// achado; ruído e a mistura de lados não.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { regimeLookup, sidedOpsFromReport, armContributions, runDailyFilterWindow, combineWindows, formatWindowMarkdown, formatCombinedMarkdown } from './dailyFilter.mjs';
import { buildDays, dailySignals, symbolDailySeries } from './dailyTrend.mjs';
import { synthFilterWindow, PREREG } from './__fixtures__/dailyFilterSynth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readPrereg = (name) => JSON.parse(readFileSync(resolve(__dirname, `../docs/experiments/${name}`), 'utf8'));
const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.parse('2026-01-01T00:00:00Z');
const RULE = PREREG.rule;
const candles = (closes) => closes.map((close, i) => ({ openTime: D0 + i * DAY, closeTime: D0 + (i + 1) * DAY - 1, open: close, high: close * 1.01, low: close * 0.99, close }));
const wave = (n) => Array.from({ length: n }, (_, i) => 100 * Math.exp(0.15 * Math.sin(i / 25) + 0.0005 * i));
const both = (opts = {}) => PREREG.windows.map((w) => {
  const s = synthFilterWindow({ ...opts, windowLabel: w.label });
  return { ...runDailyFilterWindow({ ...s, prereg: PREREG }), preregSha256: 'x' };
});

describe('pré-registro travado (mudar exige mudar este teste, à vista no PR)', () => {
  it('janelas, moedas, seeds e probabilidade iguais aos itens 264/269; régua do item 269', () => {
    const vol = readPrereg('vol-sizing-prereg.json');
    expect(PREREG.windows).toEqual(vol.windows);
    expect(PREREG.symbols).toEqual(vol.symbols);
    expect([PREREG.nSeeds, PREREG.randomProb]).toEqual([vol.nSeeds, vol.randomProb]);
    expect([PREREG.clusterBy, PREREG.alpha, PREREG.minEffectR]).toEqual([vol.clusterBy, vol.alpha, vol.minEffectR]);
    expect([PREREG.unknownRegime, PREREG.normalization]).toEqual(['kept', 'withinArmSide']);
    // Diferença do 269, decidida pela calibração antes do run: o R0 não decide.
    expect([PREREG.decisive, PREREG.r0Role]).toEqual([['significance', 'effect', 'eachWindow'], 'descriptive']);
  });

  it('a regra diária é a dos itens 271/272, com os mesmos parâmetros', () => {
    const daily = readPrereg('daily-ema-supertrend-prereg.json');
    expect(RULE).toEqual({ emaFast: daily.emaFast, emaSlow: daily.emaSlow, stAtrPeriod: daily.stAtrPeriod, stFactor: daily.stFactor, warmupDays: daily.warmupDaysAfterListing });
    expect(RULE).toEqual({ emaFast: 10, emaSlow: 21, stAtrPeriod: 10, stFactor: 3, warmupDays: 126 });
  });
});

describe('regra diária no horário da entrada — só vela fechada', () => {
  it('usa a última vela diária fechada até a entrada, com o mesmo sinal do item 271', () => {
    const c = candles(wave(400));
    const lk = regimeLookup(c, RULE);
    const sig = dailySignals(buildDays(c, { endMs: Infinity }), RULE);
    // Entrada às 23:59:59.999 do dia 300 (fecha junto com a vela diária) vê o dia 300.
    expect(lk.at(c[300].closeTime).state).toBe(sig[300]);
    // Entrada no meio do dia 301 ainda vê o dia 300.
    expect(lk.at(c[301].openTime + 12 * 60 * 60 * 1000).state).toBe(sig[300]);
    expect(new Set(c.slice(130).map((_, i) => lk.at(c[130 + i].closeTime).state))).toEqual(new Set([0, 1]));
  });

  it('causal: mudar a vela em formação ou o futuro não muda a regra no horário da entrada', () => {
    const c = candles(wave(400));
    const t = c[300].openTime + 5 * 60 * 60 * 1000; // vela 300 ainda em formação
    const changed = c.map((x, i) => (i >= 300 ? { ...x, close: x.close * 3, high: x.high * 3, low: x.low * 3 } : x));
    for (let k = 0; k < 40; k += 1) {
      const tk = t + k * DAY;
      const cut = c.filter((x) => x.closeTime <= tk);
      expect(regimeLookup(cut, RULE).at(tk).state).toBe(regimeLookup(c, RULE).at(tk).state);
    }
    expect(regimeLookup(changed, RULE).at(t).state).toBe(regimeLookup(c, RULE).at(t).state);
  });

  it('mesma posição do item 271 em todo dia, inclusive o 1º depois do aquecimento (review do Codex, PR #497)', () => {
    const c = candles(wave(300));
    const lk = regimeLookup(c, RULE);
    const days = buildDays(c, { endMs: Infinity });
    const series = symbolDailySeries(days, dailySignals(days, RULE), { startMs: 0, endMs: Infinity, warmupDays: RULE.warmupDays });
    // O 271 começa no dia de índice 126 com o sinal do fechamento da vela 125.
    expect(series[0].weekStart).toBe(c[RULE.warmupDays].openTime);
    for (const d of series) expect(lk.at(d.weekStart + 6 * 60 * 60 * 1000).state).toBe(d.pos);
    // Um dia antes ainda é aquecimento.
    expect(lk.at(c[RULE.warmupDays - 1].openTime + 6 * 60 * 60 * 1000).state).toBeNull();
  });

  it('antes do aquecimento (126 velas) não há regra; buraco recente é detectado', () => {
    const c = candles(wave(300));
    const lk = regimeLookup(c, RULE);
    expect(lk.at(c[100].closeTime)).toEqual({ state: null, reason: 'aquecimento' });
    expect(lk.at(c[0].openTime)).toEqual({ state: null, reason: 'sem vela diária antes da entrada' });
    const holed = c.filter((_, i) => i !== 200 && i !== 201);
    const lh = regimeLookup(holed, RULE);
    expect(lh.gapDays).toEqual([c[200].openTime, c[201].openTime]);
    expect(lh.at(c[201].closeTime).reason).toBe('vela diária velha (buraco)');
  });
});

describe('estatística por lado', () => {
  const op = (side, state, r, i = 0) => ({ side, state, pass: state === null ? true : side === 'BUY' ? state === 1 : state === 0, r, openedMs: D0 + i * DAY });

  it('T do braço = Σ_lado (n_lado/n)·[R̄(lado, passa) − R̄(lado)]', () => {
    const ops = [op('BUY', 1, 2), op('BUY', 0, -1), op('BUY', 1, 1), op('SELL', 0, 0.5), op('SELL', 1, -0.5), op('SELL', null, 1)];
    const T = armContributions(ops).reduce((a, x) => a + x.c, 0);
    const buy = (3 / 6) * ((2 + 1) / 2 - (2 - 1 + 1) / 3);
    const sell = (3 / 6) * ((0.5 + 1) / 2 - (0.5 - 0.5 + 1) / 3);
    expect(T).toBeCloseTo(buy + sell, 12);
  });

  it('a mistura de lados não conta: R que depende só do lado dá T = 0 mesmo com o filtro tirando quase todo SELL', () => {
    const ops = [
      ...Array.from({ length: 30 }, (_, i) => op('BUY', i % 3 ? 1 : 0, 1, i)),
      ...Array.from({ length: 30 }, (_, i) => op('SELL', i % 10 ? 1 : 0, -1, i)),
    ];
    const kept = ops.filter((o) => o.pass);
    // O R médio "com filtro" sobe muito (sobra mais BUY), mas o T é zero.
    expect(kept.reduce((a, o) => a + o.r, 0) / kept.length).toBeGreaterThan(0.5);
    expect(Math.abs(armContributions(ops).reduce((a, x) => a + x.c, 0))).toBeLessThan(1e-12);
  });

  it('sem regra conhecida a operação passa (o filtro não age)', () => {
    const report = { overall: { curve: [{ r: 1, op: { symbol: 'X', side: 'SELL', entry_candle_time_4h: '2026-01-01T03:59:59.999Z' } }] } };
    expect(sidedOpsFromReport(report)).toEqual([{ symbol: 'X', side: 'SELL', openedMs: Date.parse('2026-01-01T03:59:59.999Z'), r: 1 }]);
  });
});

describe('janela e veredito', () => {
  it('ruído (sem tendência nos preços) → janela feita e NO_FILTER_EDGE', () => {
    const w = both({ seed: 7, scenario: 'adverse' });
    expect(w.map((s) => s.verdict)).toEqual(['WINDOW_DONE', 'WINDOW_DONE']);
    expect(w[0].arms).toBe(41);
    expect(combineWindows(w, PREREG, { preregSha256: 'x' }).verdict).toBe('NO_FILTER_EDGE');
  });

  it('efeito plantado (+0,4R nas operações que passam) → FILTER_EDGE', () => {
    const plant = (rep) => ({ ...rep, overall: { ...rep.overall, curve: rep.overall.curve.map((c) => c) } });
    const windows = PREREG.windows.map((w) => {
      const s = synthFilterWindow({ seed: 7, scenario: 'adverse', windowLabel: w.label });
      const first = runDailyFilterWindow({ ...s, prereg: PREREG });
      expect(first.verdict).toBe('WINDOW_DONE');
      // Recalcula quem passa com a mesma regra e soma +0,4R nelas.
      const at = Object.fromEntries(Object.entries(s.candlesBySymbol).map(([k, c]) => [k, regimeLookup(c, PREREG.rule).at]));
      const bump = (rep) => {
        const r = plant(rep);
        r.overall.curve = rep.overall.curve.map((c) => {
          const { state } = at[c.op.symbol](Date.parse(c.op.entry_candle_time_4h));
          const pass = state === null ? true : c.op.side === 'BUY' ? state === 1 : state === 0;
          return { ...c, r: c.r + (pass ? 0.4 : 0) };
        });
        return r;
      };
      return { ...runDailyFilterWindow({ control: bump(s.control), randoms: s.randoms.map(bump), candlesBySymbol: s.candlesBySymbol, prereg: PREREG }), preregSha256: 'x' };
    });
    const c = combineWindows(windows, PREREG, { preregSha256: 'x' });
    expect(c.verdict).toBe('FILTER_EDGE');
    expect(Object.keys(c.checks)).toEqual(PREREG.decisive);
    expect(c.observed).toBeGreaterThan(0.1);
    expect(formatCombinedMarkdown(c)).toMatch(/melhorou as entradas/);
    expect(formatWindowMarkdown(windows[0])).toMatch(/Seeds por lado: BUY a favor/);
  });

  it('a operação da 1ª passada (1 ms antes do início) pertence à janela', () => {
    const s = synthFilterWindow({ seed: 8, windowLabel: 'W1' });
    const fromMs = Date.parse(`${PREREG.windows[0].from}T00:00:00Z`);
    s.randoms[0].overall.curve[0].op.entry_candle_time_4h = new Date(fromMs - 1).toISOString();
    expect(runDailyFilterWindow({ ...s, prereg: PREREG }).verdict).toBe('WINDOW_DONE');
    s.randoms[0].overall.curve[0].op.entry_candle_time_4h = new Date(fromMs - 4 * 60 * 60 * 1000 - 1).toISOString();
    const r = runDailyFilterWindow({ ...s, prereg: PREREG });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.errors.join(' ')).toMatch(/aberta fora da janela/);
  });

  it('INCOMPLETE: seed faltando, probabilidade diferente, Fibonacci ligada, operação sem lado, moeda sem vela diária, buraco recente', () => {
    const base = () => synthFilterWindow({ seed: 9, windowLabel: 'W2' });
    const run = (s) => runDailyFilterWindow({ ...s, prereg: PREREG });

    const missing = base(); missing.randoms.pop();
    expect(run(missing).verdict).toBe('INCOMPLETE');

    const prob = base(); for (const r of prob.randoms) r.reproducibility.pineConfig.randomEntryProb = 0.01;
    expect(run(prob).errors.join(' ')).toMatch(/randomEntryProb/);

    const fib = base(); fib.control.reproducibility.pineConfig.fibEntryEnabled = true;
    for (const r of fib.randoms) r.reproducibility.pineConfig.fibEntryEnabled = true;
    expect(run(fib).errors.join(' ')).toMatch(/Fibonacci/);

    const noSide = base(); delete noSide.randoms[3].overall.curve[0].op.side;
    expect(run(noSide).errors.join(' ')).toMatch(/sem lado/);

    const noCandles = base(); const sym = noCandles.randoms[0].overall.curve[0].op.symbol; delete noCandles.candlesBySymbol[sym];
    expect(run(noCandles).errors.join(' ')).toMatch(/sem velas diárias/);

    const hole = base(); const opSym = hole.randoms[0].overall.curve[0].op.symbol;
    const fromMs = Date.parse(`${PREREG.windows[1].from}T00:00:00Z`);
    hole.candlesBySymbol[opSym] = hole.candlesBySymbol[opSym].filter((c) => c.openTime !== fromMs + 30 * DAY);
    expect(run(hole).errors.join(' ')).toMatch(/dia\(s\) faltando nas velas diárias/);
  });

  it('juntar exige as duas janelas, o pré-registro atual e o mesmo commit', () => {
    const w = both({ seed: 10 });
    expect(combineWindows([w[0]], PREREG, { preregSha256: 'x' }).verdict).toBe('INCOMPLETE');
    expect(combineWindows(w, PREREG, { preregSha256: 'outro' }).errors.join(' ')).toMatch(/pré-registro diferente/);
    const other = [w[0], { ...w[1], reportCommitSha: 'b'.repeat(40) }];
    expect(combineWindows(other, PREREG, { preregSha256: 'x' }).errors.join(' ')).toMatch(/mesmo commit/);
  });
});
