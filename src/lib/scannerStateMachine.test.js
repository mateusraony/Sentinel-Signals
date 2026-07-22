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
  isTelegramConfigured: vi.fn(() => false),
  // Production code chains `.catch(() => {})` off these — a bare vi.fn()
  // returns undefined, not a promise, so any test that actually reaches a
  // notify call (isTelegramConfigured mocked true) needs it thenable.
  notifyNewSignal: vi.fn().mockResolvedValue(undefined),
  notifyTradeCreated: vi.fn().mockResolvedValue(undefined),
  notifyTP1Hit: vi.fn().mockResolvedValue(undefined),
  notifyTP2Hit: vi.fn().mockResolvedValue(undefined),
  notifyStopHit: vi.fn().mockResolvedValue(undefined),
  notifyInvalidated: vi.fn().mockResolvedValue(undefined),
  notifyTimeStop: vi.fn().mockResolvedValue(undefined),
  notifyChopExit: vi.fn().mockResolvedValue(undefined),
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
import { fetchCurrentPrice, fetchCandles } from './marketDataProvider';
import { isTelegramConfigured, notifyNewSignal, notifyInvalidated, notifyTimeStop, notifyChopExit } from './telegram';
import { persistScanResults, priceCheckActiveOps, hasActiveTradeOps, buildTradeOpData, buildSmcTradeOpData, resolveIndicatorParams, resolveRsiZoneThresholds, firstPositive, firstPositiveInteger } from './scanner.js';

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

describe('buildSmcTradeOpData — structural initial stop (1h→5m cascade)', () => {
  const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', price_at_signal: 99, context: { score: 70 } };
  const tf1h = makeTfData({ atrValue: 2 });

  it('places the stop beyond the 5m sweep wick with the ATR buffer, and TPs scale from that risk', () => {
    const op = buildSmcTradeOpData(sig, tf1h, makePineConfig(), {
      entryPrice: 100, entryCandleTime: '2026-07-16T11:55:00.000Z', trigger: 'sweep', structuralLevel: 98.5,
    });
    expect(op.initial_stop).toBeCloseTo(98.3); // 98.5 − 0.1·ATR(2)
    expect(op.current_stop).toBeCloseTo(98.3);
    expect(op.stop_basis).toBe('structural');
    expect(op.structural_level).toBe(98.5);
    expect(op.tp1).toBeCloseTo(100 + 1.7 * 1.5); // riskR 1.7 · tp1R
    expect(op.tp2).toBeCloseTo(100 + 1.7 * 3.0);
  });

  it('falls back to the legacy 2×ATR stop when the confirmation carries no structural level', () => {
    const op = buildSmcTradeOpData(sig, tf1h, makePineConfig(), {
      entryPrice: 100, entryCandleTime: '2026-07-16T11:55:00.000Z', trigger: 'structure',
    });
    expect(op.initial_stop).toBeCloseTo(96); // entry − 2.0·ATR — comportamento pré-migração
    expect(op.stop_basis).toBe('atr_fallback');
    expect(op.structural_level).toBe(null);
  });

  it('never risks more than the legacy model: an over-wide structure is capped at 2×ATR', () => {
    const op = buildSmcTradeOpData(sig, tf1h, makePineConfig(), {
      entryPrice: 100, entryCandleTime: '2026-07-16T11:55:00.000Z', trigger: 'structure', structuralLevel: 90,
    });
    expect(op.initial_stop).toBeCloseTo(96);
    expect(op.stop_basis).toBe('structural_capped');
  });

  // docs/known-risks.md item 38: additive observability fields — must never
  // change the stop/TP math asserted above.
  it('carries the OTE leg and entry zone as observability fields, untouched by stop/TP math', () => {
    const sigWithLeg = { ...sig, context: { ...sig.context, ote_leg_high: 105, ote_leg_low: 95 } };
    const op = buildSmcTradeOpData(sigWithLeg, tf1h, makePineConfig(), {
      entryPrice: 100, entryCandleTime: '2026-07-16T11:55:00.000Z', trigger: 'sweep', structuralLevel: 98.5, oteZone: 'discount',
    });
    expect(op.ote_leg_high).toBe(105);
    expect(op.ote_leg_low).toBe(95);
    expect(op.ote_zone_at_entry).toBe('discount');
    expect(op.initial_stop).toBeCloseTo(98.3); // unchanged from the first test in this describe
  });

  it('defaults the OTE fields to null when the signal/confirmation carry none (legacy data)', () => {
    const op = buildSmcTradeOpData(sig, tf1h, makePineConfig(), {
      entryPrice: 100, entryCandleTime: '2026-07-16T11:55:00.000Z', trigger: 'structure',
    });
    expect(op.ote_leg_high).toBeNull();
    expect(op.ote_leg_low).toBeNull();
    expect(op.ote_zone_at_entry).toBeNull();
  });
});

// docs/known-risks.md item 38: the Premium/Discount zone gate now lives at
// the 5m entry trigger (check5mSmcConfirmation), evaluated against the LEG
// of the 1h break (SignalEvent.context.ote_leg_high/low) instead of the old
// self-contradictory 1h-candle gate. Driven through the real
// persistScanResults entry motor (not the pure function in isolation) to
// prove the wiring — legBounds actually reaching check5mSmcConfirmation from
// the signal's context, and the TradeOperation/SystemLog outcome depending
// on it.
describe('5m OTE zone gate — leg-relative (known-risks item 38)', () => {
  function mk5m(open, high, low, close, i) {
    return { open, high, low, close, openTime: i * 300000, closeTime: (i + 1) * 300000, isClosed: true };
  }

  // Same recipe as calculateLiquiditySweep's own bullish-sweep test
  // (smcStructure.test.js): 59 flat candles + 1 that wicks below the recent
  // low and closes back above it — deterministic bullishSweep=true, entry
  // close pinned at 96.5 so the OTE leg bounds alone decide the outcome.
  function bullishSweepCandles5m() {
    const candles = [];
    for (let i = 0; i < 59; i++) candles.push(mk5m(100, 105, 95, 100, i));
    candles.push(mk5m(96, 97, 93, 96.5, 59));
    return candles;
  }

  // Mirror of bullishSweepCandles5m for SELL-direction triggers: wicks ABOVE
  // the recent high and closes back below it, bearish candle.
  function bearishSweepCandles5m() {
    const candles = [];
    for (let i = 0; i < 59; i++) candles.push(mk5m(100, 105, 95, 100, i));
    candles.push(mk5m(104, 107, 103, 103.5, 59));
    return candles;
  }

  function makeSmcSignal(overrides = {}) {
    return {
      asset_id: 'asset1', symbol: 'BTCUSDT', signal_type: 'BUY',
      timeframe: '1h', source: 'smc_structure', dedup_key: 'smc_sig_1',
      price_at_signal: 100,
      context: { structure_type: 'BOS', pd_zone: 'premium' },
      ...overrides,
    };
  }

  afterEach(() => {
    fetchCandles.mockReset(); // local override — other describes rely on the file-wide no-op default
  });

  it('confirms and creates a TradeOperation when the 5m entry lands in a favorable zone of the leg', async () => {
    fetchCandles.mockImplementation(async () => bullishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const results = { '1h': makeTfData({ atrValue: 2 }) };
    // legHigh=200/legLow=50 -> eqTop=132.5/eqBtm=117.5; entry close 96.5 is
    // well below eqBtm -> 'discount', which BUY favors (rejects only 'premium').
    const signal = makeSmcSignal({ context: { structure_type: 'BOS', pd_zone: 'premium', ote_leg_high: 200, ote_leg_low: 50 } });

    await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].cascade).toBe('1h_5m');
    expect(ops[0].ote_zone_at_entry).toBe('discount');
  });

  it('rejects the entry (no TradeOperation) when the 5m trigger lands in the unfavorable zone of the leg', async () => {
    fetchCandles.mockImplementation(async () => bullishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const results = { '1h': makeTfData({ atrValue: 2 }) };
    // legHigh=100/legLow=0 -> eqTop=55; entry close 96.5 is well above it ->
    // 'premium', which BUY rejects.
    const signal = makeSmcSignal({ context: { structure_type: 'BOS', pd_zone: 'discount', ote_leg_high: 100, ote_leg_low: 0 } });

    await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(0);

    const logs = await backend.entities.SystemLog.filter({ symbol: 'BTCUSDT' });
    const rejectLog = logs.find(l => l.details?.reason === 'ote_zone_unfavorable');
    expect(rejectLog).toBeDefined();
    expect(rejectLog.details.ote_zone).toBe('premium');
  });

  // Codex review (PR #77): classifyZone has no upper/lower bound — a close
  // BELOW legLow still reads as 'discount' (unboundedly), and 'discount' is
  // the zone BUY favors. That let a candidate confirm even after price broke
  // BELOW the protected pivot (legLow = lastSwingLow for BUY) that defines
  // the leg's own validity — not a pullback into a cheaper price anymore,
  // the bullish structure itself is invalidated at that point. Mirror for
  // SELL: a close ABOVE legHigh (the protected swing high) reads as
  // 'premium', which SELL favors, even though the bearish structure is
  // invalidated there too.
  it('rejects a BUY entry whose close broke below the protected leg low (out-of-leg, not a pullback)', async () => {
    fetchCandles.mockImplementation(async () => bullishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const results = { '1h': makeTfData({ atrValue: 2 }) };
    // legHigh=200/legLow=100 -> the sweep's entry close (96.5) is BELOW
    // legLow itself, not merely in the leg's discount portion.
    const signal = makeSmcSignal({ context: { structure_type: 'BOS', pd_zone: 'premium', ote_leg_high: 200, ote_leg_low: 100 } });

    await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(0);
    const logs = await backend.entities.SystemLog.filter({ symbol: 'BTCUSDT' });
    expect(logs.some(l => l.details?.reason === 'ote_zone_unfavorable')).toBe(true);
  });

  it('rejects a SELL entry whose close broke above the protected leg high (out-of-leg, not a pullback)', async () => {
    fetchCandles.mockImplementation(async () => bearishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const results = { '1h': makeTfData({ atrValue: 2 }) };
    // legHigh=100/legLow=0 -> the sweep's entry close (103.5) is ABOVE
    // legHigh itself, not merely in the leg's premium portion.
    const signal = makeSmcSignal({
      signal_type: 'SELL',
      context: { structure_type: 'BOS', pd_zone: 'discount', ote_leg_high: 100, ote_leg_low: 0 },
    });

    await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(0);
    const logs = await backend.entities.SystemLog.filter({ symbol: 'BTCUSDT' });
    expect(logs.some(l => l.details?.reason === 'ote_zone_unfavorable')).toBe(true);
  });

  it('fails open (still confirms) when the leg is not evaluable — missing ote_leg_high/low', async () => {
    fetchCandles.mockImplementation(async () => bullishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const results = { '1h': makeTfData({ atrValue: 2 }) };
    // No ote_leg_high/low at all — simulates a SignalEvent persisted before
    // item 38 shipped. Must not block: "not evaluable" is not a verdict.
    const signal = makeSmcSignal({ context: { structure_type: 'BOS', pd_zone: 'premium' } });

    await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].ote_zone_at_entry).toBeNull();
  });
});

describe('resolveIndicatorParams — Pine×scanner unification (P1, known-risks item 27)', () => {
  const pine = { rsiLen: 20, emaFastLen: 20, emaSlowLen: 50, volLen: 20, atrLen: 14 };

  it('per-asset override wins when set, regardless of Pine', () => {
    const asset = { rsi_period: 21, ema_short: 8, ema_long: 34 };
    const p = resolveIndicatorParams(asset, pine);
    expect(p.rsiPeriod).toBe(21);
    expect(p.emaFast).toBe(8);
    expect(p.emaSlow).toBe(34);
  });

  it('falls back to the REAL Pine value (not the old hardcoded 9/21) when the asset field is unset', () => {
    const p = resolveIndicatorParams({}, { rsiLen: 20, emaFastLen: 20, emaSlowLen: 50 });
    expect(p.rsiPeriod).toBe(20);
    expect(p.emaFast).toBe(20);
    expect(p.emaSlow).toBe(50);
  });

  it('falls back to the documented literal when neither the asset nor pineConfig has a value', () => {
    const p = resolveIndicatorParams({}, {});
    expect(p.rsiPeriod).toBe(14);
    expect(p.emaFast).toBe(20);
    expect(p.emaSlow).toBe(50);
    expect(p.volPeriod).toBe(20);
    expect(p.atrStopPeriod).toBe(14);
  });

  it('volume and stop-ATR periods have no per-asset override — always Pine, else literal', () => {
    const p = resolveIndicatorParams({ rsi_period: 99 /* unrelated override, must not leak */ }, { volLen: 30, atrLen: 21 });
    expect(p.volPeriod).toBe(30);
    expect(p.atrStopPeriod).toBe(21);
  });

  it('a real signal is unaffected by unrelated pineConfig noise — regression matches the current production shape', () => {
    const p = resolveIndicatorParams({}, pine);
    expect(p).toEqual({ rsiPeriod: 20, emaFast: 20, emaSlow: 50, volPeriod: 20, atrStopPeriod: 14 });
  });

  // Codex review (PR #58): a cleared number input in AssetConfigPanel saves
  // 0 (Number('') === 0); `??` alone would treat that as a "real" override
  // and feed period 0 into RSI/EMA (NaN/garbage). Zero/negative/NaN must
  // fall through to the next candidate exactly like "unset" does.
  it('rejects a zero/negative/NaN per-asset override — falls through to Pine, then literal', () => {
    const zeroed = { rsi_period: 0, ema_short: -5, ema_long: NaN };
    const p1 = resolveIndicatorParams(zeroed, pine);
    expect(p1.rsiPeriod).toBe(20); // pine.rsiLen, not 0
    expect(p1.emaFast).toBe(20); // pine.emaFastLen, not -5
    expect(p1.emaSlow).toBe(50); // pine.emaSlowLen, not NaN

    const zeroedNoPine = { rsi_period: 0, ema_short: 0, ema_long: 0 };
    const p2 = resolveIndicatorParams(zeroedNoPine, { rsiLen: 0, emaFastLen: 0, emaSlowLen: 0 });
    expect(p2.rsiPeriod).toBe(14); // both asset and pine are 0 → literal
    expect(p2.emaFast).toBe(20);
    expect(p2.emaSlow).toBe(50);
  });

  // known-risks.md item 31: emaFast >= emaSlow doesn't fail calculateEMAs —
  // it still fires a cross, just with the golden/death label INVERTED,
  // which scanner.js turns straight into the wrong BUY/SELL signal_type.
  // Unlike the zero/negative case above, an inverted-but-otherwise-valid
  // pair isn't caught by firstPositive (both values are positive) — needs
  // its own pair-level guard.
  it('rejects an inverted ema_short/ema_long pair — falls back to the Pine/literal pair entirely', () => {
    const inverted = { ema_short: 50, ema_long: 20 }; // swapped by mistake
    const p = resolveIndicatorParams(inverted, pine);
    expect(p.emaFast).toBe(20); // pine.emaFastLen, not the inverted 50
    expect(p.emaSlow).toBe(50); // pine.emaSlowLen, not the inverted 20

    // Equal values are just as invalid (no real "fast" side) — same fallback.
    const equal = { ema_short: 30, ema_long: 30 };
    const p2 = resolveIndicatorParams(equal, {});
    expect(p2.emaFast).toBe(20); // literal, not 30
    expect(p2.emaSlow).toBe(50);
  });

  // Codex review (PR #61): calculateRSI/calculateATR use `period` as an
  // array index/loop bound — a fractional period like 14.5 never lands on
  // an integer index at or past that point, silently freezing the series at
  // its .fill() default instead of erroring. A fractional asset override
  // must fall through to Pine/literal exactly like zero/negative/NaN already do.
  it('rejects a fractional per-asset override — falls through to Pine, then literal', () => {
    const fractional = { rsi_period: 14.5, ema_short: 20.5, ema_long: 50.5 };
    const p = resolveIndicatorParams(fractional, pine);
    expect(p.rsiPeriod).toBe(20); // pine.rsiLen, not 14.5
    expect(p.emaFast).toBe(20); // pine.emaFastLen, not 20.5
    expect(p.emaSlow).toBe(50); // pine.emaSlowLen, not 50.5
  });
});

describe('resolveRsiZoneThresholds — RSI overbought/oversold wiring (P1, known-risks item 30)', () => {
  it('uses the per-asset pair when both are set and form a valid overbought > oversold band', () => {
    const t = resolveRsiZoneThresholds({ rsi_overbought: 80, rsi_oversold: 20 });
    expect(t).toEqual({ overbought: 80, oversold: 20 });
  });

  it('falls back to 70/30 when neither field is set', () => {
    expect(resolveRsiZoneThresholds({})).toEqual({ overbought: 70, oversold: 30 });
  });

  // The bug this whole item exists for: before the fix, calculateRSI never
  // read these fields at all, so any value here (valid or not) had zero
  // effect. Once wired, an invalid pair must not silently corrupt every
  // candle's zone classification — it should fall back to the full default
  // pair, never a partial mix of one custom side and one default side.
  it('falls back to the full 70/30 default pair when overbought <= oversold (inverted or equal)', () => {
    expect(resolveRsiZoneThresholds({ rsi_overbought: 20, rsi_oversold: 80 })).toEqual({ overbought: 70, oversold: 30 });
    expect(resolveRsiZoneThresholds({ rsi_overbought: 50, rsi_oversold: 50 })).toEqual({ overbought: 70, oversold: 30 });
  });

  it('falls back to the full default pair when either side is out of the (0,100) range', () => {
    expect(resolveRsiZoneThresholds({ rsi_overbought: 150, rsi_oversold: 30 })).toEqual({ overbought: 70, oversold: 30 });
    expect(resolveRsiZoneThresholds({ rsi_overbought: 70, rsi_oversold: 0 })).toEqual({ overbought: 70, oversold: 30 });
    expect(resolveRsiZoneThresholds({ rsi_overbought: 70, rsi_oversold: -10 })).toEqual({ overbought: 70, oversold: 30 });
  });

  it('falls back to the full default pair when only one side is set (partial config)', () => {
    expect(resolveRsiZoneThresholds({ rsi_overbought: 80 })).toEqual({ overbought: 70, oversold: 30 });
    expect(resolveRsiZoneThresholds({ rsi_oversold: 20 })).toEqual({ overbought: 70, oversold: 30 });
  });

  it('falls back to the full default pair when a side is NaN', () => {
    expect(resolveRsiZoneThresholds({ rsi_overbought: NaN, rsi_oversold: 30 })).toEqual({ overbought: 70, oversold: 30 });
  });
});

describe('firstPositive', () => {
  it('returns the first finite candidate greater than zero', () => {
    expect(firstPositive(0, -1, NaN, undefined, null, 5, 10)).toBe(5);
  });

  it('returns undefined when no candidate qualifies', () => {
    expect(firstPositive(0, -1, NaN, undefined, null)).toBe(undefined);
  });
});

describe('firstPositiveInteger', () => {
  it('returns the first finite integer candidate greater than zero', () => {
    expect(firstPositiveInteger(0, -1, NaN, undefined, null, 5, 10)).toBe(5);
  });

  // The bug this exists for: calculateRSI/calculateATR use the period as an
  // array index, so a fractional candidate must be skipped exactly like
  // zero/negative/NaN, not accepted as "positive."
  it('skips a fractional candidate even though it is positive', () => {
    expect(firstPositiveInteger(14.5, 20)).toBe(20);
  });

  it('returns undefined when no candidate qualifies', () => {
    expect(firstPositiveInteger(0, -1, NaN, undefined, null, 14.5)).toBe(undefined);
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

  // Formalizes the "stop wins" policy scanner.js already applied inline —
  // industry-standard conservative assumption (backtesting.py, QuantConnect,
  // NinjaTrader) when a closed candle's high AND low both cross the stop
  // and TP1: OHLC alone can't order the two intrabar. The outcome (STOP_HIT)
  // is unchanged either way; what's new is exit_ambiguous, distinguishing
  // this from a clean, unambiguous stop.
  it('exit_ambiguous: true when the same candle touches BOTH the stop and TP1 — stop still wins', async () => {
    backend._seed('TradeOperation', makeOp());
    // stop=98, tp1=103 (makeOp defaults) — candle range covers both.
    const results = { '4h': makeTfData({ lastCandleLow: 97, lastCandleHigh: 104, lastClose: 100 }) };
    await persistScanResults(makeScanResult({ results }));
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('STOP_HIT'); // policy unchanged
    expect(op.exit_ambiguous).toBe(true);
  });

  it('exit_ambiguous: absent on a clean stop that never touched TP1', async () => {
    backend._seed('TradeOperation', makeOp());
    const results = { '4h': makeTfData({ lastCandleLow: 97, lastCandleHigh: 99, lastClose: 98 }) }; // tp1=103 out of range
    await persistScanResults(makeScanResult({ results }));
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('STOP_HIT');
    expect(op.exit_ambiguous).toBeFalsy();
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

  it('P0-g: a candle contaminated by a delayed (retry) confirmation is never usable, even though its CLOSE is after the signal candle', async () => {
    // Signal candle closes 08:00; the 15m confirmation only arrives at
    // 11:45 (a realistic retry delay) — the op is created with BOTH
    // candle_close_time (the stale signal reference) and
    // entry_candle_time_15m (the real entry reference).
    const op = makeOp({
      candle_close_time: '2026-07-15T08:00:00.000Z',
      entry_candle_time_15m: '2026-07-15T11:45:00.000Z',
    });
    backend._seed('TradeOperation', op);

    // Contaminated candle: opens 08:00 (before the 11:45 entry), closes
    // 12:00. Under the OLD guard (close > signal close) this would have
    // been judged "usable" — 12:00 > 08:00 — despite containing price
    // action from 08:00 to 11:45, BEFORE the position existed. Its low
    // crosses the stop; if wrongly evaluated this closes the op.
    const contaminated = makeTfData({
      lastCandleOpenTime: '2026-07-15T08:00:00.000Z',
      lastCandleTime: '2026-07-15T12:00:00.000Z',
      lastCandleLow: 90, lastCandleHigh: 99, lastClose: 95,
    });
    await persistScanResults(makeScanResult({ results: { '4h': contaminated } }));
    let stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('SIGNAL_CONFIRMED'); // NOT stopped — guard correctly rejects this candle
    expect(stored.tp1_hit).toBe(false);

    // Next candle: opens 12:00 (after the 11:45 entry) — entirely
    // post-entry. Same stop-crossing low must now correctly fire.
    const clean = makeTfData({
      lastCandleOpenTime: '2026-07-15T12:00:00.000Z',
      lastCandleTime: '2026-07-15T16:00:00.000Z',
      lastCandleLow: 90, lastCandleHigh: 99, lastClose: 95,
    });
    await persistScanResults(makeScanResult({ results: { '4h': clean } }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('STOP_HIT');
  });

  it('CLOSED/TIME_STOP when the position has been open longer than the tier allows', async () => {
    vi.mocked(isTelegramConfigured).mockReturnValue(true);
    const op = makeOp({ candle_close_time: '2026-07-01T00:00:00.000Z' }); // far in the past
    backend._seed('TradeOperation', op);
    const results = { '4h': makeTfData({ lastCandleHigh: 101, lastCandleLow: 99 }) }; // no stop/TP1 hit
    await persistScanResults(makeScanResult({ results, pineConfig: makePineConfig({ useTimeStop: true }) }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('CLOSED');
    expect(stored.closed_reason).toBe('TIME_STOP');
    // known-risks item 29 — TIME_STOP was previously a silent closure.
    expect(notifyTimeStop).toHaveBeenCalledTimes(1);
    expect(notifyTimeStop).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }), expect.any(Number));
    vi.mocked(isTelegramConfigured).mockReturnValue(false);
  });

  it('P0-g: Time Stop ages from the REAL entry, not the stale signal candle', async () => {
    // candle_close_time is far in the past (would already trip Time Stop on
    // its own — same value the old code used to age the position from),
    // but entry_candle_time_15m says the position actually only started a
    // few hours ago (frozen "now" is 2026-07-16T12:00, tier default is 48
    // bars × 4h = 8 days — nowhere near tripped from a recent entry).
    const op = makeOp({
      candle_close_time: '2026-07-01T00:00:00.000Z',
      entry_candle_time_15m: '2026-07-16T04:00:00.000Z',
    });
    backend._seed('TradeOperation', op);
    const results = { '4h': makeTfData({ lastCandleHigh: 101, lastCandleLow: 99 }) }; // no stop/TP1 hit
    await persistScanResults(makeScanResult({ results, pineConfig: makePineConfig({ useTimeStop: true }) }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('SIGNAL_CONFIRMED'); // NOT closed — real entry is recent
  });

  it('CLOSED/CHOP_EXIT when enabled and choppiness exceeds the tier ceiling', async () => {
    vi.mocked(isTelegramConfigured).mockReturnValue(true);
    backend._seed('TradeOperation', makeOp());
    const results = {
      '4h': makeTfData({ lastCandleHigh: 101, lastCandleLow: 99, chop: 60, tier: { ...makeTfData().tier, chopMaxVal: 55 } }),
    };
    await persistScanResults(makeScanResult({ results, pineConfig: makePineConfig({ useChopExit: true }) }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('CLOSED');
    expect(stored.closed_reason).toBe('CHOP_EXIT');
    // known-risks item 29 — CHOP_EXIT was previously a silent closure.
    expect(notifyChopExit).toHaveBeenCalledTimes(1);
    expect(notifyChopExit).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }), expect.any(Number));
    vi.mocked(isTelegramConfigured).mockReturnValue(false);
  });

  it('rf_reverse_bars_count dedups by candle: repeated passes on the same candle do not double-count', async () => {
    vi.mocked(isTelegramConfigured).mockReturnValue(true);
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
    // known-risks item 29 — INVALIDATED was previously a silent closure.
    expect(notifyInvalidated).toHaveBeenCalledTimes(1);
    expect(notifyInvalidated).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }), expect.any(Number));
    vi.mocked(isTelegramConfigured).mockReturnValue(false);
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

  it('exit_ambiguous: true when the same candle touches BOTH the runner stop and TP2', async () => {
    backend._seed('TradeOperation', makeRunner({ current_stop: 100 })); // tp2=106
    const results = { '4h': makeTfData({ lastCandleHigh: 107, lastCandleLow: 99, lastClose: 103 }) };
    await persistScanResults(makeScanResult({ results }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('STOP_HIT'); // policy unchanged
    expect(stored.exit_ambiguous).toBe(true);
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
    vi.mocked(isTelegramConfigured).mockReturnValue(true);
    backend._seed('TradeOperation', makeRunner({ current_stop: 90, exit_mode: 'HYBRID_RF_ATR' }));
    const results = {
      '4h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 101, lastClose: 104, rf: { filterValue: 105, direction: -1 } }),
    };
    await persistScanResults(makeScanResult({ results }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('INVALIDATED');
    expect(stored.closed_reason).toBe('INVALIDATION');
    // known-risks item 29 — post-TP1 INVALIDATED (RF cascade) was previously
    // a silent closure, AND closed_reason was missing on this branch.
    expect(notifyInvalidated).toHaveBeenCalledTimes(1);
    expect(notifyInvalidated).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }), expect.any(Number));
    vi.mocked(isTelegramConfigured).mockReturnValue(false);
  });

  it('INVALIDATED when the 1h SMC structure reverses (SMC cascade, independent of RF)', async () => {
    vi.mocked(isTelegramConfigured).mockReturnValue(true);
    backend._seed('TradeOperation', makeRunner({ current_stop: 90, cascade: '1h_5m', signal_timeframe: '1h' }));
    const results = {
      '1h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 101, lastClose: 104, smc: { trend: -1 } }),
    };
    await persistScanResults(makeScanResult({ results }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('INVALIDATED');
    expect(stored.closed_reason).toBe('INVALIDATION');
    // known-risks item 29 — post-TP1 INVALIDATED (SMC cascade) was previously
    // a silent closure, AND closed_reason was missing on this branch.
    expect(notifyInvalidated).toHaveBeenCalledTimes(1);
    expect(notifyInvalidated).toHaveBeenCalledWith(expect.objectContaining({ id: 'op1' }), expect.any(Number));
    vi.mocked(isTelegramConfigured).mockReturnValue(false);
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

describe('hasActiveTradeOps — browser price-check gate (P1, known-risks item 32)', () => {
  it('finds a genuinely active op even when 50+ newer (terminal) ops were created since', async () => {
    // Reproduces the bug: useAutoScan.js used to read the 50 MOST RECENTLY
    // CREATED TradeOperations and check if any were active. An active op
    // OLDER (by creation) than 50 others created since fell outside that
    // window and was invisible to the old approach.
    const active = makeOp({ id: 'op_active', created_date: '2026-07-01T00:00:00.000Z' }); // old
    backend._seed('TradeOperation', active);
    for (let i = 0; i < 55; i++) {
      backend._seed('TradeOperation', makeOp({
        id: `op_terminal_${i}`,
        status: 'STOP_HIT',
        created_date: `2026-07-16T${String(i % 24).padStart(2, '0')}:00:00.000Z`, // all newer than the active op
      }));
    }
    expect(await hasActiveTradeOps()).toBe(true);
  });

  it('returns false when there are no active ops at all', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_terminal', status: 'TP2_HIT' }));
    expect(await hasActiveTradeOps()).toBe(false);
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
    // The 15m confirmation is deliberately not fetched for a blocked
    // candidate — the log must say so instead of implying entry-readiness.
    expect(discard.details.confirmation_checked).toBe(false);
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

describe('cooldown gates the Telegram notification only, never persistence/entry (P1, known-risks item 28)', () => {
  function makeSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY',
      timeframe: '4h', source: 'range_filter', dedup_key: 'sig_new_1',
      price_at_signal: 100, context: { score: 80 },
      ...overrides,
    };
  }

  afterEach(() => {
    // Local override — restore the file-wide default so later describe
    // blocks aren't affected by what this one sets.
    vi.mocked(isTelegramConfigured).mockReturnValue(false);
  });

  it('suppresses the notification during cooldown but still persists the signal and reaches the entry motor', async () => {
    vi.mocked(isTelegramConfigured).mockReturnValue(true);
    // A same-type signal already notified/persisted recently (well inside
    // the 60-min default cooldown, frozen "now" is 12:00) — the NEW
    // candidate below must still be recorded and evaluated even though its
    // own notification gets suppressed by that recent one.
    backend._seed('SignalEvent', {
      id: 'sig_prev', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
      source: 'range_filter', dedup_key: 'sig_prev', created_date: '2026-07-16T11:30:00.000Z',
      notified: true,
    });

    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '4h': makeTfData() }; // rf.direction 1 — aligned with BUY

    const { persistedSignals } = await persistScanResults({
      ...makeScanResult({ results, pineConfig }),
      newSignals: [makeSignal()],
    });

    expect(persistedSignals).toBe(1); // persisted DESPITE the cooldown conflict
    expect(notifyNewSignal).not.toHaveBeenCalled(); // notification suppressed

    const persisted = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_new_1' });
    expect(persisted).toHaveLength(1); // really in the store, not just counted
    expect(persisted[0].notified).toBe(false); // persisted AS suppressed, for other alert channels to respect

    // Entry motor was reached (not silently skipped because of cooldown) —
    // check15mConfirmation runs against the mocked (candle-less) fetchCandles
    // and fails to confirm, logging "aguardando confirmação" — proof the
    // motor executed instead of being blocked by the cooldown continue.
    const logs = await backend.entities.SystemLog.filter({});
    expect(logs.some(l => l.message?.includes('aguardando confirmação no 15m'))).toBe(true);
  });

  it('does not suppress the notification once the cooldown window has passed', async () => {
    vi.mocked(isTelegramConfigured).mockReturnValue(true);
    backend._seed('SignalEvent', {
      id: 'sig_prev', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
      source: 'range_filter', dedup_key: 'sig_prev', created_date: '2026-07-16T10:00:00.000Z', // 2h before frozen "now" (12:00) — outside the 60-min default cooldown
      notified: true,
    });
    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '4h': makeTfData() };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeSignal()] });

    expect(notifyNewSignal).toHaveBeenCalledTimes(1);
  });

  // Codex review (PR #59): the cooldown query must anchor on the last
  // NOTIFIED signal, not the last PERSISTED one — since every signal
  // persists now regardless of cooldown outcome, anchoring on "most recent
  // persisted" would let a suppressed signal itself become the new anchor,
  // potentially stretching the "quiet window" indefinitely through a
  // streak of frequent same-type signals even though the last actual alert
  // was long ago.
  it('does not let a suppressed (unnotified) signal stretch the cooldown window', async () => {
    vi.mocked(isTelegramConfigured).mockReturnValue(true);
    // Last ACTUAL alert was 70 minutes ago (outside the 60-min cooldown) —
    // notifications should fire again NOW, even though a same-type signal
    // was persisted-but-suppressed only 40 minutes ago (inside the window
    // measured from ITSELF, but that one was never a real alert).
    backend._seed('SignalEvent', {
      id: 'sig_alerted', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
      source: 'range_filter', dedup_key: 'sig_alerted', created_date: '2026-07-16T10:50:00.000Z', // 70min before frozen "now" (12:00)
      notified: true,
    });
    backend._seed('SignalEvent', {
      id: 'sig_suppressed', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
      source: 'range_filter', dedup_key: 'sig_suppressed', created_date: '2026-07-16T11:20:00.000Z', // 40min before frozen "now"
      notified: false,
    });

    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '4h': makeTfData() };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeSignal()] });

    expect(notifyNewSignal).toHaveBeenCalledTimes(1); // NOT suppressed — anchored on the 70min-old real alert, not the 40min-old suppressed one
    const persisted = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_new_1' });
    expect(persisted[0].notified).toBe(true);
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

  // Item 20 of the 2026-07 hardening proposal, verified against the REAL
  // fakeBackend.transitionTradeOp (not a hand-mirrored harness): the status
  // CAS lets a same-status trailing-stop advance through even when the doc's
  // current_stop already moved since the caller's own pre-transaction read
  // (browser and cron each compute their candidate stop BEFORE calling
  // transitionTradeOp). Without clampMonotonicStop, whichever call commits
  // LAST wins outright, even carrying a worse stop than one already
  // committed — a real regression window, not just a theoretical one (see
  // .claude/rules/trading-engine.md).
  it('a same-status current_stop write can never regress one a concurrent worker already committed', async () => {
    backend._seed('TradeOperation', makeOp({ status: 'RUNNER_ACTIVE', current_stop: 100 }));

    // Worker A (e.g. browser, fresher price) commits the better trail first.
    const workerA = await backend.tradeOps.transitionTradeOp('op1', 'RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 105 });
    // Worker B (e.g. cron) computed its candidate from the stop=100 it read
    // BEFORE worker A committed — its own CAS on `status` still passes.
    const workerB = await backend.tradeOps.transitionTradeOp('op1', 'RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 102 });

    expect(workerA.applied).toBe(true);
    expect(workerB.applied).toBe(true); // CAS on status doesn't reject this — the stop itself must self-protect
    expect(backend._get('TradeOperation', 'op1').current_stop).toBe(105); // never regresses to 102
  });
});

// docs/known-risks.md item 35/38: the zoneOk gate that used to reject a 1h
// SMC structure break based on Premium/Discount zone (scanner.js:650, and
// the zoneGateDrops observability path built on top of it) has been REMOVED,
// not merely made observable — real backtest data showed it rejected 74/74
// real structure breaks over 18.5 months (self-contradictory by
// construction, see item 38). zoneGateDrops/smc_zone_gate_rejected no longer
// exist anywhere in scanner.js, so the describe block that used to live here
// (testing persistScanResults' handling of a fake zoneGateDrops payload) has
// no real mechanism left to test. The actual regression proving a structure
// break in an unfavorable zone still becomes a SignalEvent now lives in
// backtestEngine.test.js (runBacktest against the real scanAsset pipeline,
// goldenCandles(800) bar 418) — this file only exercises persistScanResults
// with synthetic scanResult objects, not the real candle-driven scanAsset
// logic where the old gate actually lived.
