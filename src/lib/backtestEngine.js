// Pure orchestration core for historical backtesting (docs/known-risks.md,
// .claude/rules/trading-engine.md). This does NOT reimplement the trading
// state machine or the indicator math — it drives the REAL scanAsset/
// persistScanResults from ./scanner.js against historical candle data
// instead of live Binance data, with a simulated clock so cooldowns/Time
// Stop/retry windows age correctly during replay. scanner.js itself is
// untouched: candles and pine config reach it exactly the way the
// browser/cron split already works — via import redirection at bundle time
// (scripts/build-backtest.mjs, a 5th redirect target alongside the 4
// scripts/build-scan.mjs already has) — not a new code path, not a third
// way to mutate a TradeOperation.
//
// priceCheckActiveOpsInner (the real-time spot-price loop) is deliberately
// NOT driven here — there's no tick data in a candle-only backtest, and
// persistScanResults' candle-based exits are already a conservative
// approximation of it (worst-case bar range, never faster to exit than live
// would be). That's a feature for this use case, not a gap: it can only
// make a backtested win rate look WORSE than live, never inflate it.
import { scanAsset, persistScanResults } from './scanner.js';
import { isTerminalStatus } from './opTransition.js';
import { summarizeOps } from './tradeMetrics.js';

const RealDate = Date;
let originalDate = null;
let currentMs = 0;

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(currentMs);
    else super(...args);
  }
  static now() {
    return currentMs;
  }
}

// Replaces the GLOBAL `Date` with one whose no-arg constructor and `.now()`
// report the simulated instant instead of the real wall clock — scanner.js
// calls `Date.now()`/`new Date()` directly in ~19 places (cooldowns, Time
// Stop bar-aging, retry windows, timestamps), with no clock ever injected.
// Replaying months of history with the real clock running would make Time
// Stop fire almost immediately (age computed from `Date.now() - entryRef`
// would read as months old) and would corrupt every cooldown/retry window.
// `new Date(x)`/multi-arg construction pass through unchanged — only the
// "what time is it right now" default is overridden, the same one property
// vi.setSystemTime() overrides for Vitest's fake timers.
export function installSimClock(initialMs) {
  if (originalDate) throw new Error('installSimClock: a sim clock is already installed — call restoreClock() first');
  originalDate = globalThis.Date;
  currentMs = initialMs;
  globalThis.Date = FakeDate;
}

export function advanceSimClock(ms) {
  currentMs = ms;
}

export function simNow() {
  return currentMs;
}

export function restoreClock() {
  if (originalDate) {
    globalThis.Date = originalDate;
    originalDate = null;
  }
}

// No-look-ahead candle windowing — the one property every consumer
// (scanAsset, via the redirected fetchCandles) depends on to avoid look-
// ahead bias. Never exposes a candle whose closeTime is after the simulated
// cursor. `candles` must be sorted ascending by closeTime. Marks every
// returned candle `isClosed: true` unconditionally — the real
// marketDataProvider.js derives isClosed from `Date.now() > candle.closeTime`,
// which is meaningless here (every historical bar is trivially "in the
// past" relative to REAL wall-clock time; only the simulated cursor matters,
// and this function already only returns bars at or before it).
export function sliceClosedAsOf(candles, asOfMs, limit) {
  let end = candles.length;
  while (end > 0 && candles[end - 1].closeTime > asOfMs) end--;
  const start = limit ? Math.max(0, end - limit) : 0;
  return candles.slice(start, end).map(c => ({ ...c, isClosed: true }));
}

// Finest enabled timeframe across all assets decides the replay cadence:
// between closes of that timeframe, fetchCandles for every OTHER timeframe
// returns an identical "last N closed candles" result (nothing scanAsset
// reads changes), so stepping any finer would just re-run no-ops — the same
// reason hasAssetStateChanged already skips redundant AssetState writes in
// production. 5m if any asset has the SMC 1h→5m cascade on, else 15m (the
// RF cascade's own confirmation timeframe).
export function inferStepMs(assets) {
  const anySmc = assets.some(a => a.smc_enabled);
  return (anySmc ? 5 : 15) * 60 * 1000;
}

export async function runBacktest({ assets, backend, fromMs, toMs, stepMs, onStep } = {}) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error('runBacktest: assets must be a non-empty array');
  }
  if (!backend) throw new Error('runBacktest: backend is required');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error('runBacktest: fromMs/toMs must form a valid range (toMs > fromMs)');
  }
  const step = stepMs || inferStepMs(assets);

  installSimClock(fromMs);
  try {
    for (let t = fromMs; t <= toMs; t += step) {
      advanceSimClock(t);
      for (const asset of assets) {
        // Per-asset isolation, mirroring scanAllAssetsInner's own try/catch —
        // one asset's failure at one simulated instant must not abort the
        // whole replay or contaminate other assets' results.
        try {
          const result = await scanAsset(asset);
          await persistScanResults(result);
        } catch (err) {
          if (onStep) onStep(t, { asset: asset.symbol, error: err.message });
        }
      }
      if (onStep) onStep(t);
    }
  } finally {
    restoreClock();
  }

  const allOps = await backend.entities.TradeOperation.filter({});
  return buildReport(allOps, { fromMs, toMs });
}

// Groups closed ops by cascade (4h_15m vs 1h_5m) and feeds each group (plus
// the overall set) into tradeMetrics.summarizeOps — the exact same win
// rate/profit factor/expectancy-in-R/drawdown calculation the app's own UI
// already trusts, not reinvented here. Ops still non-terminal at the cutoff
// are reported separately, never force-closed and never counted in win/
// loss/BE (summarizeOps already excludes them via isTerminalStatus).
export function buildReport(ops, { fromMs, toMs } = {}) {
  const stillOpen = ops.filter(op => !isTerminalStatus(op.status));
  const closed = ops.filter(op => isTerminalStatus(op.status));

  const byCascade = {};
  for (const op of closed) {
    const key = op.cascade || 'unknown';
    (byCascade[key] ||= []).push(op);
  }
  const cascades = {};
  for (const [cascade, group] of Object.entries(byCascade)) {
    cascades[cascade] = summarizeOps(group);
  }

  return {
    range: {
      fromMs, toMs,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    },
    totalOps: ops.length,
    stillOpenAtCutoff: stillOpen.length,
    overall: summarizeOps(closed),
    byCascade: cascades,
  };
}
