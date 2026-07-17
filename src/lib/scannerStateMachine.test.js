// Integration-level tests for the TradeOperation state machine, exercising
// the REAL scanner.js functions (persistScanResults, priceCheckActiveOps,
// buildTradeOpData) against an in-memory fake backend (see
// src/lib/__fixtures__/fakeBackend.js) instead of a re-implementation of the
// rules. Complements the pure-function tests already covering the pieces in
// isolation (opTransition.test.js — CAS decision; opExitRules.test.js —
// temporal guard/trailing/RF counter) by proving scanner.js actually WIRES
// them together correctly end to end. See .claude/rules/trading-engine.md
// for the state machine this exercises.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeBackend } from './__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('./telegram', () => ({
  isTelegramConfigured: () => false,
  notifyNewSignal: vi.fn(),
  notifyTradeCreated: vi.fn(),
  notifyTP1Hit: vi.fn(),
  notifyTP2Hit: vi.fn(),
  notifyStopHit: vi.fn(),
}));
vi.mock('./logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('./marketDataProvider', () => ({
  fetchCandles: vi.fn(),
  fetchCurrentPrice: vi.fn(),
}));

import * as entitiesModule from '@/api/entities';
import { fetchCurrentPrice } from './marketDataProvider';
import { persistScanResults, priceCheckActiveOps, buildTradeOpData } from './scanner.js';

let backend;
beforeEach(() => {
  backend = createFakeBackend();
  Object.assign(entitiesModule.backend, backend);
  vi.clearAllMocks();
  // Freeze Date.now() — persistScanResults's Time Stop check compares
  // op.candle_close_time against the REAL wall clock (barsOpen = elapsed
  // time / bar duration). Fixtures below use hardcoded ISO timestamps near
  // this frozen instant; without freezing, every fixture's "recent" candle
  // eventually crosses the 48-bar (~8 day) Time Stop threshold as real time
  // passes, silently flipping unrelated tests to CLOSED/TIME_STOP.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function makeAsset(overrides = {}) {
  return { id: 'asset1', symbol: 'BTCUSDT', is_active: true, smc_enabled: false, ...overrides };
}

function makeTfData(overrides = {}) {
  return {
    rf: { filterValue: 90, direction: 1, signal: 'none', highBand: 105, lowBand: 95, condIni: false },
    rsi: { value: 55, zone: 'neutral' },
    macd: { macdLine: 0, signalLine: 0, histogram: 0, cross: 'none' },
    ema: { shortValue: 100, longValue: 99, cross: 'none', trend: 'bullish' },
    volumeData: { current: 100, ma: 100 },
    atrValue: 2,
    tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48 },
    adx: { adx: 30 },
    chop: 40,
    smc: { trend: 1, lastBull: {}, lastBear: {}, pdZone: 'discount' },
    lastClose: 100,
    lastCandleHigh: 100,
    lastCandleLow: 100,
    lastCandleTime: '2026-07-16T12:00:00.000Z',
    lastCandleOpenTime: '2026-07-16T08:00:00.000Z',
    candleCount: 150,
    ...overrides,
  };
}

function makePineConfig(overrides = {}) {
  return {
    tp1R: 1.5,
    tp1QtyPercent: 50,
    trailAtrMult: 2.0,
    useTimeStop: true,
    useChopExit: false,
    useInvalidation: false,
    invalidRFBars: 2,
    ...overrides,
  };
}

function makeOp(overrides = {}) {
  return {
    id: 'op1',
    asset_id: 'asset1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    status: 'SIGNAL_CONFIRMED',
    entry_price: 100,
    initial_stop: 98,
    current_stop: 98,
    tp1: 103,
    tp2: 106,
    tp1_hit: false,
    tp2_hit: false,
    signal_timeframe: '4h',
    cascade: '4h_15m',
    exit_mode: 'HYBRID_RF_ATR',
    // Strictly before tfData.lastCandleTime by default, so candleUsable=true
    // (P0-c) — tests that need the entry-candle guard override this.
    candle_close_time: '2026-07-16T08:00:00.000Z',
    rf_reverse_bars_count: 0,
    rf_reverse_last_candle: null,
    ...overrides,
  };
}

function makeScanResult({ asset = makeAsset(), results, pineConfig = makePineConfig() } = {}) {
  return { asset, results, alignment: {}, newSignals: [], errors: [], duration: 10, pineConfig };
}

describe('buildTradeOpData — entry into SIGNAL_CONFIRMED', () => {
  it('computes stop/tp1/tp2 from ATR and tier multiplier for a BUY', () => {
    const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', price_at_signal: 100, context: { score: 80, rf_value: 90, reasons: ['x'] } };
    const tf4hData = makeTfData({ atrValue: 2, tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48 } });
    const op = buildTradeOpData(sig, tf4hData, makePineConfig(), { entryPrice: 100, entryCandleTime: '2026-07-16T08:15:00.000Z' });

    expect(op.status).toBe('SIGNAL_CONFIRMED');
    expect(op.side).toBe('BUY');
    expect(op.entry_price).toBe(100);
    expect(op.initial_stop).toBe(96); // entry - atr(2)*mult(2.0)
    expect(op.current_stop).toBe(96);
    expect(op.tp1).toBe(106); // entry + riskR(4)*tp1R(1.5)
    expect(op.tp2).toBe(112); // entry + riskR(4)*tp2R(3.0)
  });

  it('mirrors the math for a SELL (stop above entry, targets below)', () => {
    const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'SELL', price_at_signal: 100, context: {} };
    const tf4hData = makeTfData({ atrValue: 2, tier: { tier: 'T1', atrStopMult: 2.0 } });
    const op = buildTradeOpData(sig, tf4hData, makePineConfig(), { entryPrice: 100 });

    expect(op.initial_stop).toBe(104);
    expect(op.tp1).toBe(94);
    expect(op.tp2).toBe(88);
  });

  it('uses the 15m confirmation entry price, not the stale 4h signal price', () => {
    const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', price_at_signal: 90, context: {} };
    const tf4hData = makeTfData({ atrValue: 1, tier: { atrStopMult: 2.0 } });
    const op = buildTradeOpData(sig, tf4hData, makePineConfig(), { entryPrice: 100 });
    expect(op.entry_price).toBe(100);
    expect(op.origin_4h_price).toBe(90);
  });
});

describe('persistScanResults — candle-based transitions (pre-TP1)', () => {
  it('STOP_HIT when the candle low crosses the stop before TP1', () => {
    backend._seed('TradeOperation', makeOp());
    const results = { '4h': makeTfData({ lastCandleLow: 97, lastCandleHigh: 99, lastClose: 98 }) };
    return persistScanResults(makeScanResult({ results })).then(() => {
      const op = backend._get('TradeOperation', 'op1');
      expect(op.status).toBe('STOP_HIT');
      expect(op.exit_price).toBe(98); // op.current_stop, not the touched price
    });
  });

  it('RUNNER_ACTIVE (TP1) when the candle high crosses tp1, moving stop to breakeven', async () => {
    backend._seed('TradeOperation', makeOp());
    const results = { '4h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 99, lastClose: 103 }) };
    await persistScanResults(makeScanResult({ results }));
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('RUNNER_ACTIVE');
    expect(op.tp1_hit).toBe(true);
    expect(op.current_stop).toBe(100); // entry_price
  });

  it('P0-c guard: the entry candle itself never triggers stop/TP retroactively', async () => {
    // candle_close_time === lastCandleTime → this IS the signal candle.
    const op = makeOp({ candle_close_time: '2026-07-16T12:00:00.000Z' });
    backend._seed('TradeOperation', op);
    const results = { '4h': makeTfData({ lastCandleTime: '2026-07-16T12:00:00.000Z', lastCandleHigh: 104, lastCandleLow: 90 }) };
    await persistScanResults(makeScanResult({ results }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('SIGNAL_CONFIRMED');
    expect(stored.tp1_hit).toBe(false);
  });

  it('CLOSED/TIME_STOP when the position has been open longer than the tier allows', async () => {
    const op = makeOp({ candle_close_time: '2026-07-01T00:00:00.000Z' }); // far in the past
    backend._seed('TradeOperation', op);
    const results = { '4h': makeTfData({ lastCandleHigh: 101, lastCandleLow: 99 }) }; // no stop/TP1 hit
    await persistScanResults(makeScanResult({ results, pineConfig: makePineConfig({ useTimeStop: true }) }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('CLOSED');
    expect(stored.closed_reason).toBe('TIME_STOP');
  });

  it('CLOSED/CHOP_EXIT when enabled and choppiness exceeds the tier ceiling', async () => {
    backend._seed('TradeOperation', makeOp());
    const results = {
      '4h': makeTfData({ lastCandleHigh: 101, lastCandleLow: 99, chop: 60, tier: { ...makeTfData().tier, chopMaxVal: 55 } }),
    };
    await persistScanResults(makeScanResult({ results, pineConfig: makePineConfig({ useChopExit: true }) }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('CLOSED');
    expect(stored.closed_reason).toBe('CHOP_EXIT');
  });

  it('rf_reverse_bars_count dedups by candle: repeated passes on the same candle do not double-count', async () => {
    backend._seed('TradeOperation', makeOp());
    const pineConfig = makePineConfig({ useInvalidation: true, invalidRFBars: 2 });
    const tfData = makeTfData({ rf: { filterValue: 90, direction: -1 }, lastCandleHigh: 101, lastCandleLow: 99 });

    await persistScanResults(makeScanResult({ results: { '4h': tfData }, pineConfig }));
    let stored = backend._get('TradeOperation', 'op1');
    expect(stored.rf_reverse_bars_count).toBe(1);
    expect(stored.status).toBe('SIGNAL_CONFIRMED'); // below invalidRFBars(2) still

    // Same candle again (5-min cron re-run) — must NOT increment further.
    await persistScanResults(makeScanResult({ results: { '4h': tfData }, pineConfig }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.rf_reverse_bars_count).toBe(1);

    // Next candle, still reversed — now crosses the threshold.
    const nextCandle = makeTfData({ rf: { filterValue: 90, direction: -1 }, lastCandleHigh: 101, lastCandleLow: 99, lastCandleTime: '2026-07-16T16:00:00.000Z' });
    await persistScanResults(makeScanResult({ results: { '4h': nextCandle }, pineConfig }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.rf_reverse_bars_count).toBe(2);
    expect(stored.status).toBe('INVALIDATED');
  });
});

describe('persistScanResults — candle-based transitions (post-TP1, RUNNER_ACTIVE)', () => {
  function makeRunner(overrides = {}) {
    return makeOp({ status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 100, ...overrides });
  }

  it('TP2_HIT when the candle high crosses tp2', async () => {
    backend._seed('TradeOperation', makeRunner());
    const results = { '4h': makeTfData({ lastCandleHigh: 107, lastCandleLow: 101, lastClose: 106 }) };
    await persistScanResults(makeScanResult({ results }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('TP2_HIT');
    expect(stored.exit_price).toBe(106); // tp2
  });

  it('STOP_HIT (runner) checks the STORED stop, not a same-candle trailing advance (P0-d)', async () => {
    backend._seed('TradeOperation', makeRunner({ current_stop: 100 }));
    const results = { '4h': makeTfData({ lastCandleHigh: 105, lastCandleLow: 99, lastClose: 104 }) };
    await persistScanResults(makeScanResult({ results }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('STOP_HIT');
    expect(stored.exit_price).toBe(100); // the stop that was active THIS candle
  });

  it('advances the trailing stop when no exit fires, without exiting on the newly advanced value the same pass', async () => {
    backend._seed('TradeOperation', makeRunner({ current_stop: 100 }));
    // atrValue=2, trailMult=2 → atrTrailStop = close(104) - 2*2 = 100 → max(100,100)=100.
    // Use a wider gap so the advance is visibly above the old stop.
    const results = { '4h': makeTfData({ lastCandleHigh: 105, lastCandleLow: 103, lastClose: 105, atrValue: 1 }) };
    await persistScanResults(makeScanResult({ results, pineConfig: makePineConfig({ trailAtrMult: 2.0 }) }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('RUNNER_ACTIVE');
    expect(stored.current_stop).toBe(103); // 105 - 1*2, advanced above old stop(100)
  });

  it('INVALIDATED when RF flips against the position (RF cascade)', async () => {
    backend._seed('TradeOperation', makeRunner({ current_stop: 90, exit_mode: 'HYBRID_RF_ATR' }));
    const results = {
      '4h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 101, lastClose: 104, rf: { filterValue: 105, direction: -1 } }),
    };
    await persistScanResults(makeScanResult({ results }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('INVALIDATED');
  });

  it('INVALIDATED when the 1h SMC structure reverses (SMC cascade, independent of RF)', async () => {
    backend._seed('TradeOperation', makeRunner({ current_stop: 90, cascade: '1h_5m', signal_timeframe: '1h' }));
    const results = {
      '1h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 101, lastClose: 104, smc: { trend: -1 } }),
    };
    await persistScanResults(makeScanResult({ results }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('INVALIDATED');
  });
});

describe('priceCheckActiveOps — price-based transitions', () => {
  it('RUNNER_ACTIVE when the live price crosses tp1', async () => {
    backend._seed('TradeOperation', makeOp());
    vi.mocked(fetchCurrentPrice).mockResolvedValue(104);
    await priceCheckActiveOps();
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('RUNNER_ACTIVE');
    expect(stored.tp1_hit).toBe(true);
    expect(stored.current_stop).toBe(100);
  });

  it('STOP_HIT when the live price crosses the stop before TP1', async () => {
    backend._seed('TradeOperation', makeOp());
    vi.mocked(fetchCurrentPrice).mockResolvedValue(97);
    await priceCheckActiveOps();
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('STOP_HIT');
  });

  it('TP2_HIT when the live price crosses tp2 post-TP1', async () => {
    backend._seed('TradeOperation', makeOp({ status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 100 }));
    vi.mocked(fetchCurrentPrice).mockResolvedValue(107);
    await priceCheckActiveOps();
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('TP2_HIT');
  });

  it('never re-processes a terminal op — it is excluded by the server-side status filter', async () => {
    const terminal = makeOp({ id: 'op-terminal', symbol: 'ETHUSDT', asset_id: 'asset2', status: 'STOP_HIT' });
    backend._seed('TradeOperation', terminal);
    backend._seed('TradeOperation', makeOp());
    vi.mocked(fetchCurrentPrice).mockImplementation(async (symbol) => (symbol === 'ETHUSDT' ? 1 : 104));
    await priceCheckActiveOps();
    expect(backend._get('TradeOperation', 'op-terminal')).toEqual(terminal); // byte-identical, untouched
    expect(backend._get('TradeOperation', 'op1').status).toBe('RUNNER_ACTIVE');
  });
});

describe('cross-cascade arbitration log — signal discarded because an op is already active', () => {
  function makeRfSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY',
      timeframe: '4h', source: 'range_filter', dedup_key: 'sig_rf_1',
      price_at_signal: 100, context: { score: 80 },
      ...overrides,
    };
  }

  it('logs active_op_exists (with the blocking op) instead of dropping the candidate silently', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_active', cascade: '1h_5m' }));
    // Regime gates off so the candidate passes every technical filter and
    // reaches the active-op gate itself.
    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '4h': makeTfData() }; // rf.direction 1 — aligned with BUY

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const logs = await backend.entities.SystemLog.filter({});
    const discard = logs.find(l => l.details?.reason === 'active_op_exists');
    expect(discard).toBeTruthy();
    expect(discard.details.candidate_cascade).toBe('4h_15m');
    expect(discard.details.candidate_signal).toBe('sig_rf_1');
    expect(discard.details.active_op_id).toBe('op_active');
    expect(discard.details.active_op_cascade).toBe('1h_5m');
    // The gate itself still holds: no new op was created.
    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
  });

  it('logs once per signal — the dedup makes a re-scan of the same signal silent', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_active' }));
    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '4h': makeTfData() };
    const scan = () => persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    await scan();
    await scan(); // same dedup_key → createUnique short-circuits before the entry motor

    const logs = await backend.entities.SystemLog.filter({});
    expect(logs.filter(l => l.details?.reason === 'active_op_exists')).toHaveLength(1);
  });
});

describe('createTradeOpIfNoneActive — assetActiveOps pointer vs terminal ops (P0-f)', () => {
  // The signal-retry loop reuses the op's deterministic doc ID. If the op
  // already reached a terminal state (e.g. a quick stop via the price check),
  // re-pointing assetActiveOps at it would block the asset forever: nothing
  // ever clears a pointer to an op that is already terminal
  // (transitionTradeOp's CAS rejects terminal ops, so its in-transaction
  // clear never runs again).
  it('retry of a signal whose op already hit a terminal state must NOT re-point the asset at it', async () => {
    const first = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'trade_sig1', makeOp({ id: 'trade_sig1' }));
    expect(first.created).toBe(true);
    expect(backend._getActiveOp('asset1')).toBe('trade_sig1');

    // Quick stop (price check) — terminal transition clears the pointer.
    const stop = await backend.tradeOps.transitionTradeOp('trade_sig1', 'SIGNAL_CONFIRMED', { status: 'STOP_HIT' }, { assetId: 'asset1' });
    expect(stop.applied).toBe(true);
    expect(backend._getActiveOp('asset1')).toBe(null);

    // Retry loop re-processes the same signal within its freshness window.
    const retry = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'trade_sig1', makeOp({ id: 'trade_sig1' }));
    expect(retry.created).toBe(false);
    expect(backend._getActiveOp('asset1')).toBe(null);

    // The asset must stay eligible: a NEW signal can still open a new op.
    const next = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'trade_sig2', makeOp({ id: 'trade_sig2' }));
    expect(next.created).toBe(true);
    expect(backend._getActiveOp('asset1')).toBe('trade_sig2');
  });

  it('self-heals a pre-existing orphan pointer to a terminal op on the next entry attempt', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'trade_old', status: 'TP2_HIT' }));
    backend._setActiveOp('asset1', 'trade_old'); // corrupted state left behind by the old bug

    const res = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'trade_new', makeOp({ id: 'trade_new' }));
    expect(res.created).toBe(true);
    expect(backend._getActiveOp('asset1')).toBe('trade_new');
  });

  it('self-heals a pointer to an op that no longer exists', async () => {
    backend._setActiveOp('asset1', 'trade_ghost'); // pointer without a backing doc

    const res = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'trade_new', makeOp({ id: 'trade_new' }));
    expect(res.created).toBe(true);
    expect(backend._getActiveOp('asset1')).toBe('trade_new');
  });

  it('clears an orphan pointer even when the deterministic op is itself terminal (no create)', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'trade_sig1', status: 'STOP_HIT' }));
    backend._setActiveOp('asset1', 'trade_sig1');

    const res = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'trade_sig1', makeOp({ id: 'trade_sig1' }));
    expect(res.created).toBe(false);
    expect(backend._getActiveOp('asset1')).toBe(null); // repaired, asset eligible again
  });

  it('restores the pointer for a LIVE op after a crash between op write and pointer write', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'trade_live', status: 'SIGNAL_CONFIRMED' }));
    // Pointer was never written (crash window) — the retry must re-point.
    const res = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'trade_live', makeOp({ id: 'trade_live' }));
    expect(res.created).toBe(false);
    expect(backend._getActiveOp('asset1')).toBe('trade_live');
  });

  it('still blocks a second entry while the pointed op is genuinely active', async () => {
    await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'trade_sig1', makeOp({ id: 'trade_sig1' }));
    const res = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'trade_sig2', makeOp({ id: 'trade_sig2' }));
    expect(res.created).toBe(false);
    expect(res.existingId).toBe('trade_sig1');
    expect(backend._getActiveOp('asset1')).toBe('trade_sig1');
  });
});

describe('cross-loop concurrency invariant (persistScanResults vs priceCheckActiveOps)', () => {
  it('exactly one of the two racing transitions applies — the CAS rejects the loser, not last-write-wins', async () => {
    backend._seed('TradeOperation', makeOp());
    // Candle-based loop would drive this to STOP_HIT (low touches the stop);
    // price-based loop, racing at the same time, would drive it to
    // RUNNER_ACTIVE (price crossing tp1). Only one may ever apply — instrument
    // transitionTradeOp itself (not just the final stored doc) so a
    // regression back to plain read-modify-write (both writes "applying",
    // last one winning) is caught: the final doc alone can't distinguish
    // "CAS correctly rejected the loser" from "no CAS, last write wins",
    // since both scenarios can leave a self-consistent single-candidate
    // status behind.
    const originalTransition = backend.tradeOps.transitionTradeOp;
    const appliedLog = [];
    backend.tradeOps.transitionTradeOp = async (...args) => {
      const result = await originalTransition(...args);
      appliedLog.push(result.applied);
      return result;
    };

    const results = { '4h': makeTfData({ lastCandleHigh: 99, lastCandleLow: 97, lastClose: 98 }) };
    vi.mocked(fetchCurrentPrice).mockResolvedValue(104);

    await Promise.all([
      persistScanResults(makeScanResult({ results })),
      priceCheckActiveOps(),
    ]);

    expect(appliedLog).toHaveLength(2); // both loops attempted a transition
    expect(appliedLog.filter(Boolean)).toHaveLength(1); // exactly one applied

    const stored = backend._get('TradeOperation', 'op1');
    expect(['STOP_HIT', 'RUNNER_ACTIVE']).toContain(stored.status);
    if (stored.status === 'RUNNER_ACTIVE') {
      expect(stored.tp1_hit).toBe(true);
      expect(stored.current_stop).toBe(100);
    } else {
      expect(stored.tp1_hit).toBe(false);
    }
  });
});
