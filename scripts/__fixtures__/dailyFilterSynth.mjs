// Dados sintéticos para scripts/dailyFilter.test.mjs e para a calibração do
// item 273 (erro tipo I e poder ANTES do run real) — só teste, nunca produção.
//
// Diferente do item 269, o R de cada operação sai do PRÓPRIO caminho de preço
// (o mesmo que decide a regra diária), como no backtest real:
//   R = lado · (fechamento[e+h] / fechamento[e] − 1) / stop,  stop = 1,25·σ20
// cortado em [−1, 3] (stop e alvo distante). e = última vela diária fechada até
// a entrada; h = 1 a 3 dias. Os braços (R0 + seeds) sorteiam moeda, dia, vela de
// 4h e lado sobre o MESMO mercado.
//
// Cenários de preço (os de scripts/__fixtures__/dailyTrendSynth.mjs):
//   'adverse' — nula: cauda gorda, volatilidade em blocos, fator comum, deriva
//               fixa de +0,1%/dia. A regra diária não sabe nada do futuro, mas
//               BUY rende mais que SELL (a armadilha da mistura de lados).
//   'trend'   — poder: deriva em regimes de ±`drift`/dia (comuns às moedas).
//
// Uso como CLI (calibração; imprime JSON):
//   node scripts/__fixtures__/dailyFilterSynth.mjs --scenario adverse --n 50 --seed-offset 0 [--drift 0.003]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../../src/lib/seededRandom.js';
import { synthMarket } from './dailyTrendSynth.mjs';
import { regimeLookup, runDailyFilterWindow, combineWindows } from '../dailyFilter.mjs';

const DAY = 24 * 60 * 60 * 1000;
const H4 = 4 * 60 * 60 * 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PREREG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/experiments/daily-filter-prereg.json'), 'utf8'));

function sigma20(candles, e) {
  if (e < 20) return null;
  const rets = [];
  for (let k = e - 19; k <= e; k += 1) rets.push(Math.log(candles[k].close / candles[k - 1].close));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / (rets.length - 1));
}

/**
 * Relatórios no formato do backtest (R0 + nSeeds) e velas diárias, para uma
 * janela do pré-registro.
 */
export function synthFilterWindow({ prereg = PREREG, windowLabel = 'W1', seed: baseSeed = 1, scenario = 'adverse', drift = 0.003, opsPerArm = 110 }) {
  const w = prereg.windows.find((x) => x.label === windowLabel);
  // Cada janela com o próprio mercado (senão W1 e W2 seriam cópias).
  const seed = baseSeed * 2 + prereg.windows.indexOf(w);
  const fromMs = Date.parse(`${w.from}T00:00:00Z`);
  const toMs = Date.parse(`${w.to}T00:00:00Z`);
  const marketPrereg = { fetchFrom: new Date(fromMs - 520 * DAY).toISOString().slice(0, 10), end: new Date(toMs - 1).toISOString(), primarySymbols: prereg.symbols, descriptiveSymbols: [] };
  const candlesBySymbol = synthMarket({ seed, scenario, drift, prereg: marketPrereg, symbols: prereg.symbols });
  const symbolsArg = [...prereg.symbols].join(',');

  const makeReport = (armSeed) => {
    const rand = mulberry32(seed * 7919 + (armSeed ?? 0) * 31 + 5);
    const curve = [];
    let guard = 0;
    while (curve.length < opsPerArm && guard < opsPerArm * 50) {
      guard += 1;
      const symbol = prereg.symbols[Math.floor(rand() * prereg.symbols.length)];
      const c = candlesBySymbol[symbol];
      const j = Math.floor(rand() * c.length);
      const k = 1 + Math.floor(rand() * 6);
      const side = rand() < 0.5 ? 'BUY' : 'SELL';
      const h = 1 + Math.floor(rand() * 3);
      const openedMs = c[j].openTime + k * H4 - 1;
      const e = k === 6 ? j : j - 1;
      if (!(openedMs >= fromMs - 1 && openedMs < toMs) || e < 21 || e + h >= c.length) continue;
      const s = sigma20(c, e);
      const raw = (side === 'BUY' ? 1 : -1) * (c[e + h].close / c[e].close - 1) / (1.25 * s);
      const r = Math.max(-1, Math.min(3, raw));
      curve.push({ r, op: { id: `op_${armSeed ?? 'r0'}_${curve.length}`, symbol, side, entry_candle_time_4h: new Date(openedMs).toISOString(), closed_at: new Date(c[e + h].closeTime).toISOString() } });
    }
    return {
      trialLabel: armSeed == null ? 'R0' : `rand_${armSeed}`,
      trialArgs: `--symbols ${symbolsArg} --from ${w.from} --to ${w.to}`,
      range: { fromMs, toMs, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      dataIntegrity: { valid: true },
      reproducibility: {
        commitSha: 'a'.repeat(40),
        pineConfig: armSeed == null
          ? { tp1R: 1.5 }
          : { tp1R: 1.5, randomEntryEnabled: true, randomEntrySeed: armSeed, randomEntryProb: prereg.randomProb, skip15mConfirmationEnabled: true, useADX: false, useChop: false },
      },
      costs: { model: { feeBpsEntry: 5 }, netExpectancyR: curve.reduce((a, x) => a + x.r, 0) / curve.length, countedTrades: curve.length },
      overall: { curve, expectancyR: 0, expectancyRSd: 1, profitFactor: 1, winRate: 40 },
      equityCurve: { totalReturnPct: 0, maxDrawdownPct: 10 },
    };
  };
  return {
    control: makeReport(null),
    randoms: Array.from({ length: prereg.nSeeds }, (_, i) => makeReport(i + 1)),
    candlesBySymbol,
  };
}

/**
 * Tamanho do efeito diário no mercado sintético (para comparar com o real dos
 * itens 271/272): retorno médio do dia seguinte com a regra comprada menos com a
 * regra fora, dentro da janela, juntando as moedas.
 */
export function dailyInOutGap(candlesBySymbol, prereg, windowLabel) {
  const w = prereg.windows.find((x) => x.label === windowLabel);
  const fromMs = Date.parse(`${w.from}T00:00:00Z`);
  const toMs = Date.parse(`${w.to}T00:00:00Z`);
  const ins = []; const outs = [];
  for (const c of Object.values(candlesBySymbol)) {
    const lk = regimeLookup(c, prereg.rule);
    for (let i = 1; i < c.length; i += 1) {
      if (c[i].openTime < fromMs || c[i].openTime >= toMs) continue;
      const { state } = lk.at(c[i].openTime - 1);
      if (state === null) continue;
      (state === 1 ? ins : outs).push(c[i].close / c[i - 1].close - 1);
    }
  }
  const m = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return m(ins) - m(outs);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[argv[i].slice(2)] = next; i += 1; } else args[argv[i].slice(2)] = true;
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const scenario = args.scenario || 'adverse';
  const n = Number(args.n || 50);
  const offset = Number(args['seed-offset'] || 0);
  const drift = Number(args.drift || 0.003);
  const rows = [];
  for (let k = 0; k < n; k += 1) {
    const seed = offset + k + 1;
    const windows = PREREG.windows.map((w) => {
      const synth = synthFilterWindow({ seed, scenario, drift, windowLabel: w.label });
      const s = runDailyFilterWindow({ ...synth, prereg: PREREG });
      return { ...s, preregSha256: 'x', gap: dailyInOutGap(synth.candlesBySymbol, PREREG, w.label) };
    });
    const c = combineWindows(windows, PREREG, { preregSha256: 'x' });
    rows.push({ seed, verdict: c.verdict, observed: c.observed ?? null, t: c.inference?.t ?? null, checks: c.checks ?? null, gap: windows.map((x) => x.gap), errors: c.errors });
  }
  console.log(JSON.stringify({ scenario, drift: scenario === 'trend' ? drift : null, n, offset, rows }));
}
