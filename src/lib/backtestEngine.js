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

  // Tallies the SMC 1h→5m cascade's structure-event funnel across the whole
  // replay — answers "why zero SMC trades?" with real counts instead of
  // silence. docs/known-risks.md item 38: the old 1h Premium/Discount zone
  // gate (item 35) was removed outright — every 1h structure break now
  // becomes a SignalEvent, so confirmedSignals (newSignals filtered to
  // source === 'smc_structure') IS structureEventsTotal now, not a fraction
  // of it. Zone-awareness moved to the 5m entry trigger instead
  // (check5mSmcConfirmation, evaluated against the break's own leg) —
  // smcOteZoneRejectionKeys mirrors persistScanResults' smc5mZoneRejections
  // (sampled from the entry motor's first evaluation of each signal only,
  // not the silent retry loop — see the comment on smc5mZoneRejections in
  // scanner.js for why). Deduplicated by `dedup_key` (same key
  // SystemLog.createUnique/SignalEvent.createUnique already dedupe by in
  // persistScanResults) — scanAsset is stateless and re-evaluates the SAME
  // last-closed 1h candle on every tick until the next one closes, so at the
  // real default cadence (5min while any asset has smc_enabled,
  // inferStepMs) a single event would otherwise be tallied once per tick
  // (~12x/hour) instead of once. Sets, not counters: scanAsset's own
  // `results`/`newSignals` stay per-tick and discarded after persisting,
  // same as before this change — only these key sets survive the loop.
  const smcConfirmedSignalKeys = new Set();
  const smcOteZoneRejectionKeys = new Set();
  // Cross-cascade arbitration outcomes (src/lib/signalArbitration.js),
  // surfaced so a replay makes the new "intelligent" blocking/promotion
  // visible instead of only inferable from op counts. Keyed by dedup_key —
  // a given signal reaches handleActiveOpArbitration at most once across the
  // whole replay (same SignalEvent.createUnique dedup smcConfirmedSignalKeys
  // above relies on), so a Map is defensive rather than strictly required.
  const arbitrationOutcomesByKey = new Map();
  // Fase 2 rodada 1 retest gate (docs/known-risks.md item 40) — same
  // dedup-by-key/last-write-wins convention as arbitrationOutcomesByKey
  // above, so a later "retested:true" recorded by the retry loop correctly
  // overwrites the "pending" outcome the 1st pass recorded for the same
  // signal. Empty for the whole replay whenever pineConfig.retestEnabled is
  // off (the default) — nothing ever pushes into it — which is also how the
  // report below infers whether the flag was on, without backtestEngine.js
  // needing its own redirected pineParser import.
  const retestOutcomesByKey = new Map();
  // Fase 2 rodada 2 displacement gate (docs/known-risks.md item 41) — same
  // convention as retestOutcomesByKey above. SMC 1h_5m only.
  const displacementOutcomesByKey = new Map();
  // Fase 3 SMC tier/regime gate (docs/known-risks.md item 42) — same
  // convention as retestOutcomesByKey above. SMC 1h_5m only.
  const smcRegimeOutcomesByKey = new Map();

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
          for (const sig of (result.newSignals || [])) {
            if (sig.source === 'smc_structure') smcConfirmedSignalKeys.add(sig.dedup_key);
          }
          const persistResult = await persistScanResults(result);
          for (const rejection of (persistResult.smc5mZoneRejections || [])) {
            smcOteZoneRejectionKeys.add(rejection.dedup_key);
          }
          for (const outcome of (persistResult.arbitrationOutcomes || [])) {
            arbitrationOutcomesByKey.set(outcome.dedup_key, outcome);
          }
          for (const outcome of (persistResult.retestOutcomes || [])) {
            retestOutcomesByKey.set(outcome.dedup_key, outcome);
          }
          for (const outcome of (persistResult.displacementOutcomes || [])) {
            displacementOutcomesByKey.set(outcome.dedup_key, outcome);
          }
          for (const outcome of (persistResult.smcRegimeOutcomes || [])) {
            smcRegimeOutcomesByKey.set(outcome.dedup_key, outcome);
          }
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
  return buildReport(allOps, {
    fromMs, toMs,
    smcConfirmedSignals: smcConfirmedSignalKeys.size,
    smcRejectedByOteZone: smcOteZoneRejectionKeys.size,
    arbitrationOutcomes: [...arbitrationOutcomesByKey.values()],
    retestOutcomes: [...retestOutcomesByKey.values()],
    displacementOutcomes: [...displacementOutcomesByKey.values()],
    smcRegimeOutcomes: [...smcRegimeOutcomesByKey.values()],
  });
}

// Groups closed ops by cascade (4h_15m vs 1h_5m) and feeds each group (plus
// the overall set) into tradeMetrics.summarizeOps — the exact same win
// rate/profit factor/expectancy-in-R/drawdown calculation the app's own UI
// already trusts, not reinvented here. Ops still non-terminal at the cutoff
// are reported separately, never force-closed and never counted in win/
// loss/BE (summarizeOps already excludes them via isTerminalStatus).
export function buildReport(ops, { fromMs, toMs, smcConfirmedSignals = 0, smcRejectedByOteZone = 0, arbitrationOutcomes = [], retestOutcomes = [], displacementOutcomes = [], smcRegimeOutcomes = [] } = {}) {
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
    // Answers "why zero SMC (1h_5m) trades?" with real counts instead of an
    // empty byCascade entry — see docs/known-risks.md items 34/35/38.
    // structureEventsTotal === confirmedSignals BY DESIGN post-item-38 (every
    // 1h break becomes a SignalEvent, no gate left between the two) — kept
    // as a separate field for report-shape stability and as a regression
    // signal: the concrete tests in backtestEngine.test.js assert both
    // against a known ground-truth event count, so a future reintroduction
    // of 1h-stage gating would show up as confirmedSignals (and this field)
    // dropping below that count. rejectedByOteZone is a DIFFERENT, later
    // pipeline stage (the 5m entry trigger) — not subtracted from this total.
    smcDiagnostics: {
      structureEventsTotal: smcConfirmedSignals,
      confirmedSignals: smcConfirmedSignals,
      rejectedByOteZone: smcRejectedByOteZone,
      tradeOpsCreated: ops.filter(op => op.cascade === '1h_5m').length,
    },
    // Cross-cascade arbitration (src/lib/signalArbitration.js) — counts by
    // outcome and by the CANDIDATE cascade that triggered each decision
    // (not the active op's cascade). Empty/all-zero when no competing
    // signal ever arrived during the replay, which is the common case for a
    // short window or a single-cascade asset — not itself a sign of a bug.
    arbitration: (() => {
      const byOutcome = {};
      const byCascade = {};
      for (const { cascade, outcome } of arbitrationOutcomes) {
        byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;
        (byCascade[cascade] ||= {});
        byCascade[cascade][outcome] = (byCascade[cascade][outcome] || 0) + 1;
      }
      return { total: arbitrationOutcomes.length, byOutcome, byCascade };
    })(),
    // Fase 2 rodada 1 retest gate (src/lib/indicators/retest.js,
    // docs/known-risks.md item 40) — opt-in, off by default. `enabled` is
    // inferred from retestOutcomes being non-empty (nothing is ever pushed
    // while pineConfig.retestEnabled is false), so a report from a replay
    // with the flag off reads `{enabled:false, total:0, ...}` — matching the
    // no-op guarantee the gate has in production. This section is the whole
    // point of the "compare before activating" workflow: run twice
    // (--pine-config with/without retestEnabled) and diff this block against
    // the win-rate/R:R numbers above, per known-risks.md item 40 / the
    // backtest-usage.md recipe.
    retest: (() => {
      const confirmed = retestOutcomes.filter(o => o.retested).length;
      const barsSum = retestOutcomes.reduce((sum, o) => sum + (o.retested ? (o.barsToConfirm || 0) : 0), 0);
      const byCascade = {};
      const byReason = {};
      for (const { cascade, retested, reason } of retestOutcomes) {
        (byCascade[cascade] ||= { total: 0, confirmed: 0, pending: 0 });
        byCascade[cascade].total += 1;
        byCascade[cascade][retested ? 'confirmed' : 'pending'] += 1;
        // Auditoria pós-#81/#82: "pending" sozinho conflava motivos distintos
        // (ainda aguardando vs. parâmetros inválidos vs. sem candles) num só
        // número — byReason separa cada `reason` de detectRetest.
        if (!retested) byReason[reason] = (byReason[reason] || 0) + 1;
      }
      return {
        enabled: retestOutcomes.length > 0,
        total: retestOutcomes.length,
        confirmed,
        pending: retestOutcomes.length - confirmed,
        avgBarsToConfirm: confirmed > 0 ? +(barsSum / confirmed).toFixed(1) : null,
        byCascade,
        byReason,
      };
    })(),
    // Fase 2 rodada 2 displacement gate (src/lib/indicators/displacement.js,
    // docs/known-risks.md item 41) — opt-in, off by default, SMC 1h_5m
    // cascade only. Same `enabled`-inferred-from-non-empty convention as
    // `retest` above, and the same purpose: the number to diff between two
    // --pine-config runs (with/without displacementEnabled) before deciding
    // to activate. avgBodyRatio is only over CONFIRMED outcomes — the
    // metric to look at when calibrating displacementBodyAtrMult.
    displacement: (() => {
      const confirmedD = displacementOutcomes.filter(o => o.isDisplacement).length;
      const bodyRatioSum = displacementOutcomes.reduce((sum, o) => sum + (o.isDisplacement ? (o.bodyRatio || 0) : 0), 0);
      const byCascade = {};
      const byReason = {};
      for (const { cascade, isDisplacement, reason } of displacementOutcomes) {
        (byCascade[cascade] ||= { total: 0, confirmed: 0, pending: 0 });
        byCascade[cascade].total += 1;
        byCascade[cascade][isDisplacement ? 'confirmed' : 'pending'] += 1;
        if (!isDisplacement) byReason[reason] = (byReason[reason] || 0) + 1;
      }
      return {
        enabled: displacementOutcomes.length > 0,
        total: displacementOutcomes.length,
        confirmed: confirmedD,
        pending: displacementOutcomes.length - confirmedD,
        avgBodyRatio: confirmedD > 0 ? +(bodyRatioSum / confirmedD).toFixed(2) : null,
        byCascade,
        byReason,
      };
    })(),
    // Fase 3 SMC tier/regime gate (src/lib/indicators/tier.js,
    // docs/known-risks.md item 42) — opt-in, off by default, SMC 1h_5m
    // cascade only. Same `enabled`-inferred-from-non-empty convention as
    // `retest`/`displacement` above — the number to diff between two
    // --pine-config runs (with/without smcTierEnabled) before deciding to
    // activate.
    smcRegime: (() => {
      const passed = smcRegimeOutcomes.filter(o => o.ok).length;
      const byReason = {};
      for (const { ok, adxOk, chopOk } of smcRegimeOutcomes) {
        if (ok) continue;
        const reason = !adxOk && !chopOk ? 'adx_and_chop' : !adxOk ? 'adx_weak' : 'choppy';
        byReason[reason] = (byReason[reason] || 0) + 1;
      }
      return {
        enabled: smcRegimeOutcomes.length > 0,
        total: smcRegimeOutcomes.length,
        passed,
        rejected: smcRegimeOutcomes.length - passed,
        byReason,
      };
    })(),
  };
}
