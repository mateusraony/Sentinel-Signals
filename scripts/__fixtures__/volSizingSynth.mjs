// Dados sintéticos para scripts/volSizing.test.mjs e para a medição de poder do
// item 269 — só teste, nunca produção. Velas diárias com regimes de
// volatilidade persistentes e braços (R0 + seeds) com operações sorteadas no
// MESMO caminho de preço, como no backtest real.
import { mulberry32 } from '../../src/lib/seededRandom.js';
import { dailySigma, weightSeries } from '../volSizing.mjs';

const DAY = 24 * 60 * 60 * 1000;

function gaussFrom(rand) {
  return () => { const u = Math.max(rand(), 1e-12); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
}

/** Velas diárias de `fromMs` (inclusive) a `toMs` (exclusive), vol em blocos de 30–90 dias entre 1,5% e 6%. */
export function synthCandles({ seed, fromMs, toMs }) {
  const rand = mulberry32(seed);
  const g = gaussFrom(rand);
  const out = [];
  let price = 100;
  let vol = 0.03;
  let left = 0;
  for (let t = fromMs; t < toMs; t += DAY) {
    if (left <= 0) { vol = 0.015 + rand() * 0.045; left = 30 + Math.floor(rand() * 60); }
    left -= 1;
    const open = price;
    price *= Math.exp(vol * g());
    out.push({ openTime: t, closeTime: t + DAY - 1, open, high: Math.max(open, price), low: Math.min(open, price), close: price });
  }
  return out;
}

/**
 * Relatórios no formato do backtest (R0 + nSeeds) e velas, para uma janela do
 * pré-registro. `beta` planta R' = R + beta·(w − 1): operação em regime calmo
 * (peso alto) rende mais — é o efeito que o teste tem que achar.
 */
// `regimeR` (adversário da nula): soma ao R de TODAS as operações um desvio
// comum que muda em blocos de 20–80 dias, independente da volatilidade —
// meses bons e ruins iguais para todos os braços, como no mercado real.
// `sharedFrac` (adversário): com essa probabilidade o resultado-base vem de um
// sorteio comum a todos os braços que entram na mesma moeda no mesmo bloco de
// 3 dias — as seeds do backtest real atravessam o mesmo caminho de preço.
export function synthWindow({ prereg, windowLabel = 'W1', seed: baseSeed = 1, beta = 0, opsPerArm = 100, regimeR = 0, sharedFrac = 0 }) {
  const w = prereg.windows.find((x) => x.label === windowLabel);
  // Cada janela com o próprio sorteio (senão W1 e W2 seriam cópias).
  const seed = baseSeed * 2 + prereg.windows.indexOf(w);
  const fromMs = Date.parse(`${w.from}T00:00:00Z`);
  const toMs = Date.parse(`${w.to}T00:00:00Z`);
  const candlesBySymbol = Object.fromEntries(prereg.symbols.map((s, i) => [s, synthCandles({ seed: seed * 101 + i, fromMs: fromMs - 520 * DAY, toMs })]));
  const weights = Object.fromEntries(prereg.symbols.map((s) => [s, weightSeries(dailySigma(candlesBySymbol[s], prereg.lookbackDays), {
    fromMs, toMs, refDays: prereg.refDays, minRefDays: prereg.minRefDays, clamp: prereg.weightClamp,
  })]));
  const n = Math.round((toMs - fromMs) / DAY);
  const regimeRand = mulberry32(seed * 13 + 7);
  const regimeShift = [];
  for (let left = 0, cur = 0; regimeShift.length < n; left -= 1) {
    if (left <= 0) { cur = (regimeRand() * 2 - 1) * regimeR; left = 20 + Math.floor(regimeRand() * 60); }
    regimeShift.push(cur);
  }
  const symbolsArg = [...prereg.symbols].join(',');
  const makeReport = (armSeed) => {
    const rand = mulberry32(seed * 7919 + (armSeed ?? 0) * 31 + 5);
    const curve = [];
    for (let k = 0; k < opsPerArm; k += 1) {
      const symbol = prereg.symbols[Math.floor(rand() * prereg.symbols.length)];
      const idx = Math.floor(rand() * n);
      const openedMs = fromMs + idx * DAY + Math.floor(rand() * DAY);
      // R ~ perda de 1R em metade das vezes, ganho exponencial de média 1R no resto (média ≈ 0).
      const draw = (rng) => (rng() < 0.5 ? -1 : -Math.log(Math.max(rng(), 1e-12)));
      const base = rand() < sharedFrac
        ? draw(mulberry32(seed * 104729 + prereg.symbols.indexOf(symbol) * 100003 + Math.floor(idx / 3)))
        : draw(rand);
      const r = base + regimeShift[idx] + beta * (weights[symbol][idx].w - 1);
      curve.push({ r, op: { id: `op_${armSeed ?? 'r0'}_${k}`, symbol, entry_candle_time_15m: new Date(openedMs).toISOString(), closed_at: new Date(openedMs + 2 * DAY).toISOString() } });
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
      costs: { model: { feeBpsEntry: 5 }, netExpectancyR: curve.reduce((a, c) => a + c.r, 0) / curve.length, countedTrades: curve.length },
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
