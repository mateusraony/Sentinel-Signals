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
import { uptrendCandles, downtrendCandles } from './indicators/__fixtures__/candles.js';

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
  MARKET_SOURCE: 'futures',
  DATA_EXCHANGE: 'binance',
  EXECUTOR: 'browser',
}));

import * as entitiesModule from '@/api/entities';
import { fetchCurrentPrice, fetchCandles } from './marketDataProvider';
import { isTelegramConfigured, notifyNewSignal, notifyInvalidated, notifyTimeStop, notifyChopExit } from './telegram';
import { persistScanResults, priceCheckActiveOps, activateSignalManually, hasActiveTradeOps, buildTradeOpData, buildSmcTradeOpData, resolveIndicatorParams, resolveRsiZoneThresholds, resolveRangeFilterParams, firstPositive, firstPositiveInteger } from './scanner.js';
import { calculateSmcSignalStrength } from './indicators/smcConfluence.js';
import { closesFullyAtTp1 } from './opExitRules.js';

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

  // docs/known-risks.md items 53/54 — decision frozen at creation, same
  // reasoning as partial_percent/runnerEnabled: pineConfig read here, never
  // again at exit time (see persistScanResults reading op.* instead).
  it('stamps pre_tp1_stop_protection_enabled/_trigger_atr_mult from pineConfig, defaulting off', () => {
    const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', price_at_signal: 100, context: {} };
    const tf4hData = makeTfData({ atrValue: 2, tier: { atrStopMult: 2.0 } });

    const offByDefault = buildTradeOpData(sig, tf4hData, makePineConfig(), { entryPrice: 100 });
    expect(offByDefault.pre_tp1_stop_protection_enabled).toBe(false);
    expect(offByDefault.pre_tp1_stop_advance_trigger_atr_mult).toBe(1.0);

    const explicitlyOn = buildTradeOpData(
      sig, tf4hData,
      makePineConfig({ preTp1StopProtectionEnabled: true, preTp1StopProtectionAtrMult: 1.5 }),
      { entryPrice: 100 },
    );
    expect(explicitlyOn.pre_tp1_stop_protection_enabled).toBe(true);
    expect(explicitlyOn.pre_tp1_stop_advance_trigger_atr_mult).toBe(1.5);
  });

  // Codex review (PR #128, P1) — tf4hData.tier.timeStopBars is always
  // calibrated in 4h bars. The exit loop's SIGNAL_TF_MS[op.signal_timeframe]
  // lookup reads this raw count against whatever unit signal_timeframe
  // implies, so stamping signal_timeframe:'1h' (Fase 1 cascade) without
  // converting the count would fire the Time Stop 4x too early. Same
  // precedent already used by the SMC->4h promotion (scanner.js ~2192-2194).
  it('tier_time_stop_bars stays unconverted when cascadeInfo is absent (native 4h path, byte-identical)', () => {
    const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', price_at_signal: 100, context: {} };
    const tf4hData = makeTfData({ atrValue: 2, tier: { tier: 'T1', atrStopMult: 2.0, timeStopBars: 48 } });

    const op = buildTradeOpData(sig, tf4hData, makePineConfig(), { entryPrice: 100 });

    expect(op.signal_timeframe).toBe('4h');
    expect(op.tier_time_stop_bars).toBe(48); // NOT multiplied
  });

  it('tier_time_stop_bars is multiplied by 4 when cascadeInfo.signalTimeframe is 1h (Fase 1, rf1hCondEnabled)', () => {
    const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', price_at_signal: 100, context: {} };
    const tf4hData = makeTfData({ atrValue: 2, tier: { tier: 'T1', atrStopMult: 2.0, timeStopBars: 48 } });

    const op = buildTradeOpData(sig, tf4hData, makePineConfig(), { entryPrice: 100 }, { cascade: 'rf1h_cond4h_15m', signalTimeframe: '1h' });

    expect(op.signal_timeframe).toBe('1h');
    expect(op.tier_time_stop_bars).toBe(192); // 48 * 4 — real duration stays 192h, matching the 4h-calibrated tier
  });

  // known-risks.md item 67 — resolveEntryConfirmation15m's synthetic
  // confirmation object carries bypassed15m:true; buildTradeOpData must
  // record entry_candle_time_4h (not entry_candle_time_15m) and the
  // skip_15m_confirmation audit flag when it sees that marker.
  it('records entry_candle_time_4h/skip_15m_confirmation, not entry_candle_time_15m, when confirmation15m.bypassed15m is true (item 67)', () => {
    const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', price_at_signal: 100, context: {} };
    const tf4hData = makeTfData({ atrValue: 2, tier: { atrStopMult: 2.0 } });

    const bypassed = buildTradeOpData(sig, tf4hData, makePineConfig(), {
      entryPrice: 100, entryCandleTime: '2026-07-16T08:00:00.000Z', bypassed15m: true,
    });
    expect(bypassed.entry_candle_time_4h).toBe('2026-07-16T08:00:00.000Z');
    expect(bypassed.entry_candle_time_15m).toBeUndefined();
    expect(bypassed.skip_15m_confirmation).toBe(true);

    const real15m = buildTradeOpData(sig, tf4hData, makePineConfig(), {
      entryPrice: 100, entryCandleTime: '2026-07-16T08:15:00.000Z',
    });
    expect(real15m.entry_candle_time_15m).toBe('2026-07-16T08:15:00.000Z');
    expect(real15m.entry_candle_time_4h).toBeUndefined();
    expect(real15m.skip_15m_confirmation).toBe(false);
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

// docs/known-risks.md item 6 (2026-08-03): antes desta função, o cálculo RF
// principal (scanAsset) e a confirmação 15m (check15mConfirmation)
// resolviam rf_period/rf_multiplier por caminhos diferentes — o principal
// já usava firstPositiveInteger/firstPositive, a confirmação usava um
// `asset.rf_period || 20` simples (só bloqueia falsy — aceita -10, 14.5).
describe('resolveRangeFilterParams', () => {
  it('usa os valores do ativo quando válidos', () => {
    expect(resolveRangeFilterParams({ rf_period: 50, rf_multiplier: 2.5 })).toEqual({ period: 50, multiplier: 2.5 });
  });

  it('cai pros defaults 20/3.5 quando ausente', () => {
    expect(resolveRangeFilterParams({})).toEqual({ period: 20, multiplier: 3.5 });
    expect(resolveRangeFilterParams(undefined)).toEqual({ period: 20, multiplier: 3.5 });
  });

  // O bug real: `asset.rf_period || 20` aceitava -10/14.5 (só bloqueia
  // falsy), diferente de firstPositiveInteger/firstPositive usados no
  // cálculo RF principal. resolveRangeFilterParams tem que rejeitar os
  // MESMOS valores que o caminho principal já rejeitava.
  it('rejeita rf_period negativo/fracionário/NaN, cai pro default 20', () => {
    expect(resolveRangeFilterParams({ rf_period: -10 }).period).toBe(20);
    expect(resolveRangeFilterParams({ rf_period: 14.5 }).period).toBe(20);
    expect(resolveRangeFilterParams({ rf_period: NaN }).period).toBe(20);
    expect(resolveRangeFilterParams({ rf_period: 0 }).period).toBe(20);
  });

  it('rejeita rf_multiplier negativo/NaN, cai pro default 3.5', () => {
    expect(resolveRangeFilterParams({ rf_multiplier: -1 }).multiplier).toBe(3.5);
    expect(resolveRangeFilterParams({ rf_multiplier: NaN }).multiplier).toBe(3.5);
    expect(resolveRangeFilterParams({ rf_multiplier: 0 }).multiplier).toBe(3.5);
  });

  it('multiplier fracionário É válido (RF usa como constante de suavização, não índice)', () => {
    expect(resolveRangeFilterParams({ rf_multiplier: 2.75 }).multiplier).toBe(2.75);
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

  // known-risks.md item 67 — entry_candle_time_4h must feed the exact same
  // getEntryReferenceTime fallback as entry_candle_time_15m/_5m, for both
  // protections that read it (the temporal guard above and Time Stop here).
  it('P0-g guard also honours entry_candle_time_4h (skip15mConfirmationEnabled ops)', async () => {
    const op = makeOp({
      candle_close_time: '2026-07-15T08:00:00.000Z',
      entry_candle_time_4h: '2026-07-15T08:00:00.000Z', // same instant here (no dedicated confirming candle)
    });
    backend._seed('TradeOperation', op);

    // Contaminated candle: opens BEFORE the entry reference — must stay unusable.
    const contaminated = makeTfData({
      lastCandleOpenTime: '2026-07-15T04:00:00.000Z',
      lastCandleTime: '2026-07-15T08:00:00.000Z',
      lastCandleLow: 90, lastCandleHigh: 99, lastClose: 95,
    });
    await persistScanResults(makeScanResult({ results: { '4h': contaminated } }));
    let stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('SIGNAL_CONFIRMED');

    // Clean candle: opens AT/after the entry reference — must fire.
    const clean = makeTfData({
      lastCandleOpenTime: '2026-07-15T08:00:00.000Z',
      lastCandleTime: '2026-07-15T12:00:00.000Z',
      lastCandleLow: 90, lastCandleHigh: 99, lastClose: 95,
    });
    await persistScanResults(makeScanResult({ results: { '4h': clean } }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('STOP_HIT');
  });

  it('Time Stop ages from entry_candle_time_4h (skip15mConfirmationEnabled ops)', async () => {
    const op = makeOp({
      candle_close_time: '2026-07-01T00:00:00.000Z', // far in the past
      entry_candle_time_4h: '2026-07-16T04:00:00.000Z', // recent real entry
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

// docs/known-risks.md items 53/54 — opt-in pre-TP1 stop protection. Default
// op: BUY, entry 100, initial_stop 98 (risk 2), tp1 103. Default tfData
// atrValue 2 -> with the default trigger 1.0x, breakeven fires once price
// closes >= entry + 2 = 102 (still short of tp1's 103).
describe('persistScanResults — pre-TP1 stop protection (opt-in, docs/known-risks.md items 53/54)', () => {
  it('off by default: a favorable candle short of TP1 never moves current_stop', async () => {
    backend._seed('TradeOperation', makeOp()); // pre_tp1_stop_protection_enabled absent -> falsy
    const favorable = makeTfData({ lastCandleHigh: 102.5, lastCandleLow: 99, lastClose: 102.5 });
    await persistScanResults(makeScanResult({ results: { '4h': favorable } }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('SIGNAL_CONFIRMED');
    expect(stored.current_stop).toBe(98); // unchanged — today's default behavior preserved
    expect(stored.pre_tp1_stop_advanced_at).toBeUndefined();
  });

  it('enabled: advances current_stop to breakeven once price clears the ATR threshold, before TP1', async () => {
    backend._seed('TradeOperation', makeOp({
      pre_tp1_stop_protection_enabled: true,
      pre_tp1_stop_advance_trigger_atr_mult: 1.0,
    }));
    // High 102.5 clears entry(100) + 1.0*ATR(2) = 102, but stays short of tp1 (103).
    const favorable = makeTfData({ lastCandleHigh: 102.5, lastCandleLow: 99, lastClose: 102.5 });
    await persistScanResults(makeScanResult({ results: { '4h': favorable } }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('SIGNAL_CONFIRMED'); // still pre-TP1, no exit fired
    expect(stored.tp1_hit).toBe(false);
    expect(stored.current_stop).toBe(100); // breakeven, not the original 98
    expect(stored.pre_tp1_stop_advanced_at).toBeTruthy();
  });

  it('enabled: a subsequent reversal stops at breakeven instead of the original stop (the scenario the mechanism targets)', async () => {
    backend._seed('TradeOperation', makeOp({
      pre_tp1_stop_protection_enabled: true,
      pre_tp1_stop_advance_trigger_atr_mult: 1.0,
    }));
    const favorable = makeTfData({ lastCandleHigh: 102.5, lastCandleLow: 99, lastClose: 102.5 });
    await persistScanResults(makeScanResult({ results: { '4h': favorable } }));
    expect(backend._get('TradeOperation', 'op1').current_stop).toBe(100);

    // Next candle reverses hard: low 99 is BELOW the new breakeven stop (100)
    // but still ABOVE the original stop (98) — only fires because of the advance.
    const reversal = makeTfData({
      lastCandleHigh: 101, lastCandleLow: 99, lastClose: 99.5,
      lastCandleTime: '2026-07-16T16:00:00.000Z', lastCandleOpenTime: '2026-07-16T12:00:00.000Z',
    });
    await persistScanResults(makeScanResult({ results: { '4h': reversal } }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('STOP_HIT');
    expect(stored.exit_price).toBe(100); // scratched at breakeven, not a full loss at 98
  });

  it('P0-d discipline: the advance is calculated from THIS close but only protects starting the NEXT candle (no look-ahead)', async () => {
    backend._seed('TradeOperation', makeOp({
      pre_tp1_stop_protection_enabled: true,
      pre_tp1_stop_advance_trigger_atr_mult: 1.0,
    }));
    // Single candle: low 99 dips toward (but not below) initial_stop(98), high
    // 102.5 clears the breakeven threshold in the SAME candle. Stop must be
    // evaluated against the STORED stop (98) first — the candle's own low
    // (99) never crosses it — before the advance to breakeven is computed.
    const sameCandle = makeTfData({ lastCandleHigh: 102.5, lastCandleLow: 99, lastClose: 102.5 });
    await persistScanResults(makeScanResult({ results: { '4h': sameCandle } }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('SIGNAL_CONFIRMED'); // not stopped — 99 never crossed the stored stop 98
    expect(stored.current_stop).toBe(100); // advance applied for the NEXT candle only
  });

  // Codex review (PR #106, P1) — the cron re-runs persistScanResults every
  // ~5 minutes while a 4h/1h candle stays the "latest closed" one for hours
  // (same reason rf_reverse_bars_count needs its own candle dedup). Without
  // excluding the candle that caused the advance, a SECOND pass over the
  // exact same still-latest candle would re-test its low against the just-
  // advanced breakeven stop and produce a false STOP_HIT — using data
  // already safely evaluated against the OLD stop one pass earlier.
  it('a repeated pass over the SAME still-latest candle never re-tests it against the just-advanced stop', async () => {
    backend._seed('TradeOperation', makeOp({
      pre_tp1_stop_protection_enabled: true,
      pre_tp1_stop_advance_trigger_atr_mult: 1.0,
    }));
    const sameCandle = makeTfData({ lastCandleHigh: 102.5, lastCandleLow: 99, lastClose: 102.5 });

    // Pass 1: advances to breakeven (100), correctly not stopped (99 > 98).
    await persistScanResults(makeScanResult({ results: { '4h': sameCandle } }));
    let stored = backend._get('TradeOperation', 'op1');
    expect(stored.current_stop).toBe(100);
    expect(stored.status).toBe('SIGNAL_CONFIRMED');

    // Pass 2: cron re-runs 5 minutes later — SAME candle (identical object)
    // is still the latest closed one. Without the fix, low(99) <= newly
    // stored stop(100) would falsely fire STOP_HIT here.
    await persistScanResults(makeScanResult({ results: { '4h': sameCandle } }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('SIGNAL_CONFIRMED'); // still open — the bug this test guards against
    expect(stored.current_stop).toBe(100); // unchanged, still monotonic

    // A genuinely NEW candle (later timestamp) whose low is below the
    // breakeven stop must still fire normally — the fix only protects the
    // specific candle that caused the advance, not stop-hits in general.
    const nextCandle = makeTfData({
      lastCandleTime: '2026-07-16T16:00:00.000Z', lastCandleOpenTime: '2026-07-16T12:00:00.000Z',
      lastCandleHigh: 101, lastCandleLow: 99, lastClose: 99.5,
    });
    await persistScanResults(makeScanResult({ results: { '4h': nextCandle } }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('STOP_HIT');
    expect(stored.exit_price).toBe(100); // breakeven, not the original stop
  });
});

// known-risks item 47.2 — MFE/MAE tracked incrementally from THIS candle's
// high/low, gated by the same candleUsable guard as stop/TP (P0-c/P0-g).
// Default makeOp: BUY, entry 100, initial_stop 98 -> risk 2. Default
// makeTfData: lastCandleTime 2026-07-16T12:00, op's candle_close_time
// 2026-07-16T08:00 (no entry_candle_time_15m/5m set) -> entryRef falls back
// to candle_close_time -> barsSinceEntry = (12:00-08:00)/4h = 1.
describe('persistScanResults — MFE/MAE (item 47.2)', () => {
  it('computes mfe_r/mae_r/bars_to_mfe/bars_to_mae from the candle range and never regresses on a smaller excursion', async () => {
    backend._seed('TradeOperation', makeOp());
    // high 102 (below tp1=103, no TP1), low 99 (above stop=98, no stop hit).
    await persistScanResults(makeScanResult({
      results: { '4h': makeTfData({ lastCandleHigh: 102, lastCandleLow: 99 }) },
    }));
    let stored = backend._get('TradeOperation', 'op1');
    expect(stored.mfe_r).toBeCloseTo(1.0, 6); // (102-100)/2
    expect(stored.mae_r).toBeCloseTo(-0.5, 6); // (99-100)/2
    expect(stored.bars_to_mfe).toBe(1);
    expect(stored.bars_to_mae).toBe(1);

    // Bigger favorable excursion on a LATER candle — mfe_r advances, bars_to_mfe updates.
    await persistScanResults(makeScanResult({
      results: {
        '4h': makeTfData({ lastCandleHigh: 102.5, lastCandleLow: 99.5, lastCandleTime: '2026-07-16T16:00:00.000Z' }),
      },
    }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.mfe_r).toBeCloseTo(1.25, 6); // (102.5-100)/2
    expect(stored.bars_to_mfe).toBe(2);
    expect(stored.mae_r).toBeCloseTo(-0.5, 6); // unchanged — this candle's low is a SMALLER adverse move

    // Smaller favorable excursion on the NEXT candle — mfe_r must NOT regress.
    await persistScanResults(makeScanResult({
      results: {
        '4h': makeTfData({ lastCandleHigh: 100.5, lastCandleLow: 99.8, lastCandleTime: '2026-07-16T20:00:00.000Z' }),
      },
    }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.mfe_r).toBeCloseTo(1.25, 6); // still the previous high, never regresses
    expect(stored.bars_to_mfe).toBe(2); // unchanged — no new extreme
  });

  it('never counts a pre-entry (not candleUsable) candle toward MFE/MAE', async () => {
    // Same P0-g contaminated-candle setup as the guard's own test above:
    // signal candle closes 08:00, real entry (15m confirmation) only at
    // 11:45; a candle opening 08:00/closing 12:00 contains pre-entry action
    // and must not move mfe_r/mae_r even though its range is favorable.
    const op = makeOp({
      candle_close_time: '2026-07-15T08:00:00.000Z',
      entry_candle_time_15m: '2026-07-15T11:45:00.000Z',
    });
    backend._seed('TradeOperation', op);
    const contaminated = makeTfData({
      lastCandleOpenTime: '2026-07-15T08:00:00.000Z',
      lastCandleTime: '2026-07-15T12:00:00.000Z',
      lastCandleLow: 99, lastCandleHigh: 102, lastClose: 100,
    });
    await persistScanResults(makeScanResult({ results: { '4h': contaminated } }));
    let stored = backend._get('TradeOperation', 'op1');
    expect(stored.mfe_r).toBeUndefined();
    expect(stored.mae_r).toBeUndefined();

    // Next (clean, post-entry) candle — now it counts.
    const clean = makeTfData({
      lastCandleOpenTime: '2026-07-15T12:00:00.000Z',
      lastCandleTime: '2026-07-15T16:00:00.000Z',
      lastCandleLow: 99, lastCandleHigh: 102, lastClose: 100,
    });
    await persistScanResults(makeScanResult({ results: { '4h': clean } }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.mfe_r).toBeCloseTo(1.0, 6);
  });

  it('stamps bars_to_tp1 once, at the TP1 transition', async () => {
    backend._seed('TradeOperation', makeOp());
    await persistScanResults(makeScanResult({
      results: { '4h': makeTfData({ lastCandleHigh: 103, lastCandleLow: 99 }) }, // touches tp1 exactly
    }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.tp1_hit).toBe(true);
    expect(stored.bars_to_tp1).toBe(1);
  });

  it('stamps bars_to_stop once, at the STOP_HIT transition (pre-TP1)', async () => {
    backend._seed('TradeOperation', makeOp());
    await persistScanResults(makeScanResult({
      results: { '4h': makeTfData({ lastCandleHigh: 99, lastCandleLow: 97 }) }, // touches stop (98)
    }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('STOP_HIT');
    expect(stored.bars_to_stop).toBe(1);
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
    expect(stored.runner_stop_advanced_candle_time).toBe(results['4h'].lastCandleTime);
  });

  // known-risks.md item 59 — the post-TP1 trailing stop had the identical
  // multi-pass-same-candle vulnerability that PR #106/P1 fixed for the
  // pre-TP1 gate above, but was never given the same guard. Same shape as
  // that regression test: pass 1 advances the trail; pass 2 re-runs over the
  // SAME still-latest candle and must not re-test its low against the
  // newly-tightened stop; a genuinely new candle stops normally.
  it('a repeated pass over the SAME still-latest candle never re-tests the runner against the just-advanced trail (known-risks item 59)', async () => {
    backend._seed('TradeOperation', makeRunner({ current_stop: 100 }));
    const sameCandle = makeTfData({ lastCandleHigh: 105, lastCandleLow: 103, lastClose: 105, atrValue: 1 });
    const pineConfig = makePineConfig({ trailAtrMult: 2.0 });

    // Pass 1: advances the trail to 103 (105 - 1*2), correctly not stopped
    // (low 103 > old stop 100).
    await persistScanResults(makeScanResult({ results: { '4h': sameCandle }, pineConfig }));
    let stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('RUNNER_ACTIVE');
    expect(stored.current_stop).toBe(103);

    // Pass 2: cron re-runs 5 minutes later — SAME candle (identical object)
    // is still the latest closed one. Without the fix, low(103) <= newly
    // stored stop(103) would falsely fire STOP_HIT here.
    await persistScanResults(makeScanResult({ results: { '4h': sameCandle }, pineConfig }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('RUNNER_ACTIVE'); // still open — the bug this test guards against
    expect(stored.current_stop).toBe(103); // unchanged, still monotonic

    // A genuinely NEW candle (later timestamp) whose low is below the
    // advanced stop must still fire normally — the fix only protects the
    // specific candle that caused the advance, not stop-hits in general.
    const nextCandle = makeTfData({
      lastCandleTime: '2026-07-16T16:00:00.000Z', lastCandleOpenTime: '2026-07-16T12:00:00.000Z',
      lastCandleHigh: 104, lastCandleLow: 101, lastClose: 101.5,
    });
    await persistScanResults(makeScanResult({ results: { '4h': nextCandle }, pineConfig }));
    stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('STOP_HIT');
    expect(stored.exit_price).toBe(103); // the advanced stop, not the original 100
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

// docs/known-risks.md item 46. A gestão é congelada NA CRIAÇÃO
// (partial_percent), não lida do pineConfig na saída — por isso todo teste
// aqui manipula a op, nunca o config, exceto os dois de buildTradeOpData.
describe('TP1 sem runner — saída terminal (item 46)', () => {
  const semRunner = (o = {}) => makeOp({ partial_percent: 100, runner_percent: 0, ...o });

  // O TESTE MAIS IMPORTANTE DO LOTE: o default não pode mudar nada. Um `it`
  // por caso (e não um laço com 4 ops semeadas) porque 4 operações ativas no
  // MESMO ativo disparam a guarda de duplicidade do item 39.1 — que suspende o
  // loop inteiro e faria este teste passar/falhar pelo motivo errado.
  it.each([
    ['ausente (op legada)', undefined],
    ['50 (o default)', 50],
    ['30', 30],
    ['99.9 — abaixo de 100 ainda deixa runner', 99.9],
  ])('REGRESSÃO — partial_percent %s mantém TP1 → RUNNER_ACTIVE com stop no breakeven', async (_label, partial) => {
    backend._seed('TradeOperation', makeOp({ partial_percent: partial }));
    const results = { '4h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 99, lastClose: 103 }) };
    await persistScanResults(makeScanResult({ results }));
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('RUNNER_ACTIVE');
    expect(op.current_stop).toBe(100);
    expect(op.closed_reason).toBeUndefined();
  });

  it('loop por CANDLE: fecha em CLOSED/TP1_FULL no preço do TP1, não em RUNNER_ACTIVE', async () => {
    backend._seed('TradeOperation', semRunner());
    const results = { '4h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 99, lastClose: 103 }) };
    await persistScanResults(makeScanResult({ results }));
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('CLOSED');
    expect(op.closed_reason).toBe('TP1_FULL');
    expect(op.tp1_hit).toBe(true);
    expect(op.exit_price).toBe(103); // o TP1, não o high do candle (104)
    expect(op.closed_at).toBeTruthy();
    // Nunca move o stop para breakeven: não sobrou posição para proteger.
    expect(op.current_stop).toBe(98);
  });

  it('loop por PREÇO: mesma decisão — os dois loops não podem divergir (lição do item 39.1)', async () => {
    backend._seed('TradeOperation', semRunner());
    vi.mocked(fetchCurrentPrice).mockResolvedValue(104);
    await priceCheckActiveOps();
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('CLOSED');
    expect(op.closed_reason).toBe('TP1_FULL');
    expect(op.exit_price).toBe(103);
  });

  it('libera o ponteiro assetActiveOps na MESMA transação — o ativo volta a poder operar', async () => {
    const created = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'op1', semRunner());
    expect(created.created).toBe(true);
    expect(backend._getActiveOp('asset1')).toBe('op1');

    const results = { '4h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 99, lastClose: 103 }) };
    await persistScanResults(makeScanResult({ results }));

    expect(backend._get('TradeOperation', 'op1').status).toBe('CLOSED');
    expect(backend._getActiveOp('asset1')).toBe(null);
    // É este o ganho concreto sobre o bug latente: com RUNNER_ACTIVE em 0% de
    // posição o ativo ficava bloqueado por dias sem nada aberto.
    const next = await backend.tradeOps.createTradeOpIfNoneActive('asset1', 'op2', semRunner({ id: 'op2' }));
    expect(next.created).toBe(true);
  });

  it('CLOSED é terminal — uma segunda passada não re-transiciona a op', async () => {
    backend._seed('TradeOperation', semRunner());
    const results = { '4h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 99, lastClose: 103 }) };
    await persistScanResults(makeScanResult({ results }));
    const depoisDaPrimeira = { ...backend._get('TradeOperation', 'op1') };
    await persistScanResults(makeScanResult({ results }));
    expect(backend._get('TradeOperation', 'op1')).toEqual(depoisDaPrimeira);
  });

  it('op JÁ em RUNNER_ACTIVE segue sendo gerida — o flag nunca abandona posição viva', async () => {
    // Cenário do deploy: a op nasceu com runner e o flag virou depois. Como a
    // decisão é lida da op (partial_percent 50), ela continua no fluxo antigo.
    backend._seed('TradeOperation', makeOp({ status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 100 }));
    const results = { '4h': makeTfData({ lastCandleHigh: 107, lastCandleLow: 101, lastClose: 106 }) };
    await persistScanResults(makeScanResult({ results }));
    expect(backend._get('TradeOperation', 'op1').status).toBe('TP2_HIT');
  });

  it('stop vence TP1 também sem runner (a política de ambiguidade não muda)', async () => {
    backend._seed('TradeOperation', semRunner());
    const results = { '4h': makeTfData({ lastCandleHigh: 104, lastCandleLow: 97, lastClose: 100 }) };
    await persistScanResults(makeScanResult({ results }));
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('STOP_HIT');
    expect(op.exit_ambiguous).toBe(true);
  });

  it('buildTradeOpData congela a gestão na criação quando runnerEnabled é false', () => {
    const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', price_at_signal: 100, context: { score: 80, rf_value: 90, reasons: [] } };
    const tf4hData = makeTfData({ atrValue: 2, tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48 } });
    const conf = { entryPrice: 100, entryCandleTime: '2026-07-16T08:15:00.000Z' };

    const comRunner = buildTradeOpData(sig, tf4hData, makePineConfig(), conf);
    expect(comRunner.partial_percent).toBe(50);
    expect(closesFullyAtTp1(comRunner)).toBe(false);

    const semRunnerOp = buildTradeOpData(sig, tf4hData, makePineConfig({ runnerEnabled: false }), conf);
    expect(semRunnerOp.partial_percent).toBe(100);
    expect(semRunnerOp.runner_percent).toBe(0);
    expect(closesFullyAtTp1(semRunnerOp)).toBe(true);
  });

  it('bug latente: tp1QtyPercent 100 já produzia runner de 0% e mesmo assim ia para RUNNER_ACTIVE', () => {
    const sig = { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', price_at_signal: 100, context: { score: 80, rf_value: 90, reasons: [] } };
    const tf4hData = makeTfData({ atrValue: 2, tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48 } });
    const op = buildTradeOpData(sig, tf4hData, makePineConfig({ tp1QtyPercent: 100 }), { entryPrice: 100, entryCandleTime: '2026-07-16T08:15:00.000Z' });
    expect(op.runner_percent).toBe(0);
    expect(closesFullyAtTp1(op)).toBe(true); // antes: seguia para RUNNER_ACTIVE
  });
});

// Codex, PR #95 (known-risks item 46.5). O botão "Ativar agora" do painel
// criava a operação com TradeOperation.create cru: sem stop, sem alvo e sem o
// ponteiro assetActiveOps. Estes testes provam que os três defeitos sumiram.
describe('activateSignalManually — ativação pelo painel passa pelo motor', () => {
  const sinal = (o = {}) => ({
    id: 'sig_manual_1',
    symbol: 'BTCUSDT',
    asset_id: 'asset1',
    timeframe: '4h',
    signal_type: 'BUY',
    price_at_signal: 90, // deliberadamente DEFASADO em relação ao preço atual
    reason: 'RF virou para cima',
    context: { score: 80, rf_value: 88, reasons: ['rf'] },
    ...o,
  });

  // activateSignalManually chama scanAsset de verdade — precisa de candles
  // suficientes para o ATR do 4h existir. É justamente esse ATR que o botão
  // antigo não tinha e por isso criava operação sem stop.
  beforeEach(() => {
    vi.mocked(fetchCandles).mockImplementation(async () => uptrendCandles(200));
  });

  // `vi.clearAllMocks()` do beforeEach global limpa CHAMADAS, não
  // IMPLEMENTAÇÕES — sem este reset a implementação acima vaza para os
  // describes seguintes (o de arbitragem passou a promover direto para
  // CONFIRMED porque a confirmação 15m encontrava candles sempre).
  afterEach(() => {
    vi.mocked(fetchCandles).mockReset();
  });

  it('cria com stop, alvos e tier — o defeito central era a operação nascer inoperável', async () => {
    vi.mocked(fetchCurrentPrice).mockResolvedValue(100);
    const res = await activateSignalManually(sinal(), makeAsset());

    expect(res.created).toBe(true);
    const op = backend._get('TradeOperation', res.opId);
    expect(op.initial_stop).toBeGreaterThan(0);
    expect(op.current_stop).toBe(op.initial_stop);
    expect(op.tp1).toBeGreaterThan(op.entry_price);
    expect(op.tp2).toBeGreaterThan(op.tp1);
    expect(op.tier).toBeTruthy();
    expect(op.source).toBe('manual');
  });

  it('usa o preço ATUAL como entrada, não o preço defasado do sinal', async () => {
    vi.mocked(fetchCurrentPrice).mockResolvedValue(100);
    const res = await activateSignalManually(sinal({ price_at_signal: 90 }), makeAsset());
    expect(backend._get('TradeOperation', res.opId).entry_price).toBe(100);
  });

  it('grava o ponteiro assetActiveOps — sem ele o scanner abriria uma segunda op no mesmo ativo', async () => {
    vi.mocked(fetchCurrentPrice).mockResolvedValue(100);
    const res = await activateSignalManually(sinal(), makeAsset());
    expect(backend._getActiveOp('asset1')).toBe(res.opId);

    // A consequência concreta: uma segunda criação no mesmo ativo é recusada,
    // em vez de gerar o par duplicado que suspende a gestão (item 39.1).
    const segunda = await activateSignalManually(sinal({ id: 'sig_manual_2' }), makeAsset());
    expect(segunda.created).toBe(false);
    expect(segunda.reason).toBe('active_op_exists');
  });

  // `runnerEnabled` chega à operação manual porque activateSignalManually
  // chama buildTradeOpData — a MESMA função da cascata automática. O
  // threading do flag já é provado direto ali, no describe do item 46
  // ("buildTradeOpData congela a gestão na criação"); aqui basta garantir que
  // a gestão vem daquela função e não de um literal, como era antes.
  it('a gestão vem de buildTradeOpData, não de um 50/50 hardcoded no componente', async () => {
    vi.mocked(fetchCurrentPrice).mockResolvedValue(100);
    const res = await activateSignalManually(sinal(), makeAsset());
    const op = backend._get('TradeOperation', res.opId);
    expect(op.partial_percent + op.runner_percent).toBe(100);
    expect(op.exit_mode).toBe('HYBRID_RF_ATR');
    expect(op.cascade).toBe('4h_15m'); // gerida pelas regras do 4h, declarado
  });

  it('a entrada é carimbada AGORA — nenhum candle já em andamento pode disparar stop/TP (P0-g)', async () => {
    vi.mocked(fetchCurrentPrice).mockResolvedValue(100);
    const antes = Date.now();
    const res = await activateSignalManually(sinal(), makeAsset());
    const t = new Date(backend._get('TradeOperation', res.opId).entry_candle_time_15m).getTime();
    expect(t).toBeGreaterThanOrEqual(antes);
  });

  it('falha FECHADO quando não há ATR no 4h — nunca cria operação sem stop', async () => {
    vi.mocked(fetchCurrentPrice).mockResolvedValue(100);
    vi.mocked(fetchCandles).mockImplementation(async () => uptrendCandles(5)); // curto demais para ATR
    const res = await activateSignalManually(sinal(), makeAsset());
    expect(res.created).toBe(false);
    expect(res.reason).toBe('no_4h_atr');
    expect(backend._getActiveOp('asset1')).toBe(null);
  });

  it('sem preço atual também falha fechado', async () => {
    vi.mocked(fetchCurrentPrice).mockResolvedValue(null);
    const res = await activateSignalManually(sinal(), makeAsset());
    expect(res.created).toBe(false);
    expect(res.reason).toBe('no_price');
    expect(backend._getActiveOp('asset1')).toBe(null);
  });

  it('entrada inválida não lança', async () => {
    expect((await activateSignalManually(null, makeAsset())).created).toBe(false);
    expect((await activateSignalManually(sinal(), null)).created).toBe(false);
  });
});

describe('priceCheckActiveOps — operações ativas duplicadas (guarda estendida, known-risks item 39.1)', () => {
  it('uma única operação ativa continua sendo processada normalmente', async () => {
    backend._seed('TradeOperation', makeOp());
    vi.mocked(fetchCurrentPrice).mockResolvedValue(104);
    await priceCheckActiveOps();
    expect(backend._get('TradeOperation', 'op1').status).toBe('RUNNER_ACTIVE');
  });

  it('duas operações ativas do mesmo ativo não são processadas', async () => {
    const opA = makeOp({ id: 'op_a', status: 'SIGNAL_CONFIRMED' });
    const opB = makeOp({ id: 'op_b', status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 100 });
    backend._seed('TradeOperation', opA);
    backend._seed('TradeOperation', opB);
    // Preço cruzaria TP1/TP2/stop de qualquer uma das duas — prova que a
    // ausência de mudança é pela guarda, não por acaso do preço escolhido.
    vi.mocked(fetchCurrentPrice).mockResolvedValue(200);
    await priceCheckActiveOps();
    expect(backend._get('TradeOperation', 'op_a')).toEqual(opA);
    expect(backend._get('TradeOperation', 'op_b')).toEqual(opB);
  });

  it('nenhuma das duas duplicadas recebe stop, TP ou mudança de status', async () => {
    const opA = makeOp({ id: 'op_a', status: 'SIGNAL_CONFIRMED', current_stop: 98 });
    const opB = makeOp({ id: 'op_b', status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 100 });
    backend._seed('TradeOperation', opA);
    backend._seed('TradeOperation', opB);
    vi.mocked(fetchCurrentPrice).mockResolvedValue(97); // cruzaria o stop de op_a
    await priceCheckActiveOps();
    const storedA = backend._get('TradeOperation', 'op_a');
    const storedB = backend._get('TradeOperation', 'op_b');
    expect(storedA.status).toBe('SIGNAL_CONFIRMED');
    expect(storedA.current_stop).toBe(98);
    expect(storedB.status).toBe('RUNNER_ACTIVE');
    expect(storedB.current_stop).toBe(100);
  });

  it('outro ativo válido continua sendo processado normalmente na mesma passada', async () => {
    const opA = makeOp({ id: 'op_a', status: 'SIGNAL_CONFIRMED' });
    const opB = makeOp({ id: 'op_b', status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 100 });
    const opValid = makeOp({ id: 'op_c', asset_id: 'asset2', symbol: 'ETHUSDT' });
    backend._seed('TradeOperation', opA);
    backend._seed('TradeOperation', opB);
    backend._seed('TradeOperation', opValid);
    vi.mocked(fetchCurrentPrice).mockResolvedValue(104);
    await priceCheckActiveOps();
    expect(backend._get('TradeOperation', 'op_a')).toEqual(opA);
    expect(backend._get('TradeOperation', 'op_b')).toEqual(opB);
    expect(backend._get('TradeOperation', 'op_c').status).toBe('RUNNER_ACTIVE');
  });

  it('grava um log crítico com todos os IDs, status, cascatas e lados envolvidos', async () => {
    const opA = makeOp({ id: 'op_a', cascade: '4h_15m', side: 'BUY', status: 'SIGNAL_CONFIRMED' });
    const opB = makeOp({ id: 'op_b', cascade: '1h_5m', side: 'SELL', status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 100 });
    backend._seed('TradeOperation', opA);
    backend._seed('TradeOperation', opB);
    vi.mocked(fetchCurrentPrice).mockResolvedValue(104);
    await priceCheckActiveOps();
    const logs = await backend.entities.SystemLog.filter({});
    const critical = logs.find(l => l.details?.reason === 'duplicate_active_ops_detected' && l.details?.source === 'price_check');
    expect(critical).toBeTruthy();
    expect(critical.level).toBe('error');
    expect(critical.details.op_ids.sort()).toEqual(['op_a', 'op_b']);
    expect(critical.details.op_statuses.sort()).toEqual(['RUNNER_ACTIVE', 'SIGNAL_CONFIRMED']);
    expect(critical.details.op_cascades.sort()).toEqual(['1h_5m', '4h_15m']);
    expect(critical.details.op_sides.sort()).toEqual(['BUY', 'SELL']);
  });

  it('o mesmo conjunto de duplicidade não gera log repetido em passadas seguidas (sem spam)', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_a' }));
    backend._seed('TradeOperation', makeOp({ id: 'op_b', status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 100 }));
    vi.mocked(fetchCurrentPrice).mockResolvedValue(104);
    await priceCheckActiveOps();
    await priceCheckActiveOps();
    await priceCheckActiveOps();
    const logs = await backend.entities.SystemLog.filter({});
    const criticalLogs = logs.filter(l => l.details?.reason === 'duplicate_active_ops_detected' && l.details?.source === 'price_check');
    expect(criticalLogs).toHaveLength(1);
  });

  it('um novo conjunto de IDs duplicados (op resolvida manualmente) gera um novo evento', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_a' }));
    backend._seed('TradeOperation', makeOp({ id: 'op_b', status: 'RUNNER_ACTIVE', tp1_hit: true, current_stop: 100 }));
    vi.mocked(fetchCurrentPrice).mockResolvedValue(104);
    await priceCheckActiveOps();

    // "Resolução manual": op_b passa a terminal, uma nova op_c ativa surge —
    // o conjunto duplicado do ativo1 passa a ser {op_a, op_c}.
    backend._seed('TradeOperation', { ...backend._get('TradeOperation', 'op_b'), status: 'CLOSED' });
    backend._seed('TradeOperation', makeOp({ id: 'op_c' }));
    await priceCheckActiveOps();

    const logs = await backend.entities.SystemLog.filter({});
    const criticalLogs = logs.filter(l => l.details?.reason === 'duplicate_active_ops_detected' && l.details?.source === 'price_check');
    expect(criticalLogs).toHaveLength(2);
    expect(criticalLogs[1].details.op_ids.sort()).toEqual(['op_a', 'op_c']);
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

describe('cross-cascade arbitration — promoção em dois estágios, continuidade e risco crítico', () => {
  // vi.clearAllMocks() (global beforeEach) clears call history but NOT a
  // configured mockResolvedValue/mockImplementation — several tests below
  // configure fetchCandles for Stage B confirmation checks, which would
  // otherwise leak into every later test in the file (including unrelated
  // ones elsewhere in this suite). Local afterEach keeps that leakage
  // contained to this describe block.
  afterEach(() => { fetchCandles.mockReset(); });

  function makeRfSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY',
      timeframe: '4h', source: 'range_filter', dedup_key: 'sig_rf_arb',
      price_at_signal: 100, context: { score: 80 },
      ...overrides,
    };
  }
  function makeSmcSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY',
      timeframe: '1h', source: 'smc_structure', dedup_key: 'sig_smc_arb',
      price_at_signal: 100, context: { score: 80, structure_type: 'BOS' },
      ...overrides,
    };
  }
  // check15mConfirmation needs >=40 closed candles whose Range Filter
  // direction actually reflects the trend — reusing the same synthetic
  // generators backtestEngine.test.js derives its flip instants from
  // (uptrend -> RF direction 1 -> aligns with BUY), not hand-picked values.
  const ALIGNED_15M = () => uptrendCandles(60, 100, 1);
  const MISALIGNED_15M = () => downtrendCandles(60, 100, 1);

  describe('Estágio A — sinal 4H alinhado só abre um PENDING, nunca promove direto', () => {
    it('cria promotion_status=PENDING_15M, NÃO altera trade_mode/management_timeframe/time_stop ainda', async () => {
      backend._seed('TradeOperation', makeOp({
        id: 'op_1h', cascade: '1h_5m', side: 'BUY', score: 60, entry_score: 60, current_confidence_score: 60,
        trade_mode: 'TACTICAL_1H', management_timeframe: '1h', promotion_status: 'NONE',
        current_stop: 97, tier_time_stop_bars: 96,
      }));
      const pineConfig = makePineConfig({ useADX: false, useChop: false, arbPromoteMinScore: 75 });
      const results = { '4h': makeTfData({ tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48 } }) };

      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal({ context: { score: 80 } })] });

      const ops = await backend.entities.TradeOperation.filter({});
      expect(ops).toHaveLength(1); // nunca duplica
      const op = ops[0];
      expect(op.id).toBe('op_1h');
      expect(op.promotion_status).toBe('PENDING_15M');
      expect(op.promotion_candidate_score_4h).toBe(80);
      expect(op.promotion_candidate_signal_id).toBe('sig_rf_arb');
      expect(op.promotion_candidate_at).toBeTruthy();
      // Stage A must NOT yet touch management — that's Stage B's job.
      expect(op.trade_mode).toBe('TACTICAL_1H');
      expect(op.management_timeframe).toBe('1h');
      expect(op.tier_time_stop_bars).toBe(96); // intocado
      expect(op.current_stop).toBe(97); // intocado
      expect(op.arbitration_outcome).not.toBe('promoted'); // ainda não é uma promoção concluída
    });

    it('score abaixo do mínimo de promoção mas acima do de reforço -> reinforcement_accepted, sem PENDING', async () => {
      backend._seed('TradeOperation', makeOp({ id: 'op_1h', cascade: '1h_5m', side: 'BUY', score: 60 }));
      const pineConfig = makePineConfig({ useADX: false, useChop: false, arbPromoteMinScore: 75, arbReinforceMinScore: 50 });
      const results = { '4h': makeTfData() };

      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal({ context: { score: 60 } })] });

      const op = backend._get('TradeOperation', 'op_1h');
      expect(op.promotion_status).toBeUndefined();
    });
  });

  describe('Estágio B — confirmação 15m resolve o pendente (reaproveita check15mConfirmation)', () => {
    it('15m alinhado dentro da janela conclui a promoção: PROMOTED_4H, gestão 4h, time stop alongado', async () => {
      backend._seed('TradeOperation', makeOp({
        id: 'op_1h', cascade: '1h_5m', side: 'BUY', signal_timeframe: '1h',
        entry_score: 60, current_confidence_score: 60,
        trade_mode: 'TACTICAL_1H', management_timeframe: '1h',
        promotion_status: 'PENDING_15M',
        promotion_candidate_at: '2026-07-16T11:00:00.000Z', // 1h antes do relógio congelado do teste (12:00)
        promotion_candidate_score_4h: 80,
        promotion_candidate_signal_id: 'sig_rf_arb',
        current_stop: 97, tier_time_stop_bars: 96,
        entry_price: 100, partial_percent: 50, runner_percent: 50,
      }));
      fetchCandles.mockResolvedValue(ALIGNED_15M());
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const results = { '4h': makeTfData({ tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48 } }) };

      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      const op = backend._get('TradeOperation', 'op_1h');
      expect(op.promotion_status).toBe('CONFIRMED');
      expect(op.trade_mode).toBe('PROMOTED_4H');
      expect(op.management_timeframe).toBe('4h');
      expect(op.arbitration_outcome).toBe('promoted');
      expect(op.promoted_at).toBeTruthy();
      expect(op.score_at_promotion_1h).toBe(60);
      expect(op.score_at_promotion_4h).toBe(80);
      // Nunca duplica, nunca altera a origem, nunca mexe no stop/posição:
      expect((await backend.entities.TradeOperation.filter({}))).toHaveLength(1);
      expect(op.signal_timeframe).toBe('1h'); // NUNCA vira '4h' — usado p/ localizar results[] no loop de saída
      expect(op.cascade).toBe('1h_5m'); // origem imutável
      expect(op.current_stop).toBe(97); // promoção nunca afasta o stop
      expect(op.entry_price).toBe(100); // nunca recalcula a entrada
      expect(op.partial_percent).toBe(50);
      expect(op.runner_percent).toBe(50); // nunca aumenta posição/runner
      expect(op.tier_time_stop_bars).toBe(192); // alongado (48*4), nunca encurtaria os 96 originais
    });

    it('sem confirmação 15m ainda (nem alinhado nem expirado) permanece PENDING_15M — não conclui promoção', async () => {
      backend._seed('TradeOperation', makeOp({
        id: 'op_1h', cascade: '1h_5m', side: 'BUY', promotion_status: 'PENDING_15M',
        promotion_candidate_at: '2026-07-16T11:00:00.000Z',
        trade_mode: 'TACTICAL_1H', management_timeframe: '1h',
      }));
      fetchCandles.mockResolvedValue(MISALIGNED_15M()); // 15m contrário — não confirma
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const results = { '4h': makeTfData() };

      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      const op = backend._get('TradeOperation', 'op_1h');
      expect(op.promotion_status).toBe('PENDING_15M'); // ainda pendente
      expect(op.trade_mode).toBe('TACTICAL_1H'); // gestão não mudou
    });

    it('confirmação 15m CONTRÁRIA à direção da operação nunca promove (não confirma, só)', async () => {
      backend._seed('TradeOperation', makeOp({
        id: 'op_1h', cascade: '1h_5m', side: 'BUY', promotion_status: 'PENDING_15M',
        promotion_candidate_at: '2026-07-16T11:00:00.000Z',
      }));
      fetchCandles.mockResolvedValue(MISALIGNED_15M()); // 15m aponta para baixo, op é BUY
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const results = { '4h': makeTfData() };

      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      expect(backend._get('TradeOperation', 'op_1h').promotion_status).not.toBe('CONFIRMED');
    });

    it('NÃO confirma se o regime do 4h deixou de ser válido, mesmo com o 15m alinhado (Codex review, PR #79)', async () => {
      // Reproduz o gap: este retry checava só o 15m, nunca o contexto 4h em
      // si — diferente do retry irmão pra sinais 4h novos, que reavalia
      // direção + regime a cada passada. Uma reversão de DIREÇÃO dispara um
      // SignalEvent novo (já coberto por critical_opposite), mas uma falha
      // só de regime (ADX fraco/Choppiness alto) nunca dispara sinal nenhum
      // — o RF só emite em mudança de direção. Sem essa checagem, um 15m
      // coincidente confirmaria a promoção mesmo com o mercado tendo ficado
      // choppy — algo que a própria cascata nativa 4h_15m bloquearia numa
      // entrada nova agora.
      backend._seed('TradeOperation', makeOp({
        id: 'op_1h', cascade: '1h_5m', side: 'BUY', promotion_status: 'PENDING_15M',
        promotion_candidate_at: '2026-07-16T11:00:00.000Z',
        trade_mode: 'TACTICAL_1H', management_timeframe: '1h',
      }));
      fetchCandles.mockResolvedValue(ALIGNED_15M()); // 15m alinhado — sozinho, confirmaria
      const pineConfig = makePineConfig({ useADX: true, useChop: false }); // regime ADX ligado
      const results = {
        // Direção 4h ainda BUY (1) — não é uma reversão — mas ADX (5) fica
        // abaixo do mínimo do tier (25): regime reprovado.
        '4h': makeTfData({ adx: { adx: 5 }, tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48, adxMinVal: 25 } }),
      };

      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      const op = backend._get('TradeOperation', 'op_1h');
      expect(op.promotion_status).toBe('PENDING_15M'); // NÃO confirmou — continua pendente, não vira CONFIRMED nem REJECTED
      expect(op.trade_mode).toBe('TACTICAL_1H'); // gestão não mudou
    });

    it('expira sem confirmação dentro da janela -> promotion_status=EXPIRED, opção segue TACTICAL_1H', async () => {
      backend._seed('TradeOperation', makeOp({
        id: 'op_1h', cascade: '1h_5m', side: 'BUY', promotion_status: 'PENDING_15M',
        promotion_candidate_at: '2026-07-16T07:00:00.000Z', // 5h antes do relógio congelado (12:00) — além da janela de 4h
        trade_mode: 'TACTICAL_1H', management_timeframe: '1h',
      }));
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const results = { '4h': makeTfData() };

      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      const op = backend._get('TradeOperation', 'op_1h');
      expect(op.promotion_status).toBe('EXPIRED');
      expect(op.trade_mode).toBe('TACTICAL_1H'); // nunca chegou a ser promovida

      const logs = await backend.entities.SystemLog.filter({});
      expect(logs.find(l => l.details?.reason === 'promotion_expired')).toBeTruthy();
    });

    it('promoção expirada NÃO reaparece sozinha sem um novo sinal 4H', async () => {
      backend._seed('TradeOperation', makeOp({
        id: 'op_1h', cascade: '1h_5m', side: 'BUY', promotion_status: 'EXPIRED',
      }));
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const results = { '4h': makeTfData() };

      // Nenhum newSignals — nenhum candidato 4H novo chegou.
      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      expect(backend._get('TradeOperation', 'op_1h').promotion_status).toBe('EXPIRED'); // continua EXPIRED, não volta a PENDING sozinho
      expect(fetchCandles).not.toHaveBeenCalled(); // sem PENDING_15M, o retry de confirmação nem roda
    });
  });

  it('promoção não mexe no stop mesmo quando o time stop já era maior que o equivalente 4h (nunca encurta)', async () => {
    backend._seed('TradeOperation', makeOp({
      id: 'op_1h', cascade: '1h_5m', side: 'BUY', promotion_status: 'PENDING_15M',
      promotion_candidate_at: '2026-07-16T11:00:00.000Z', tier_time_stop_bars: 300,
    }));
    fetchCandles.mockResolvedValue(ALIGNED_15M());
    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '4h': makeTfData({ tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48 } }) };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

    expect(backend._get('TradeOperation', 'op_1h').tier_time_stop_bars).toBe(300); // 48*4=192 < 300, mantém 300
  });

  it('4h_15m ativa + 1h_5m mesma direção (menor) -> continuation_confirmation, nunca abre nem toca a operação', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_4h', cascade: '4h_15m', side: 'BUY', current_stop: 98 }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig();
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].id).toBe('op_4h');
    expect(ops[0].current_stop).toBe(98); // intocado — continuation_confirmation não escreve na op
    expect(ops[0].arbitration_outcome).toBeUndefined(); // action 'none' nunca grava na op

    const logs = await backend.entities.SystemLog.filter({});
    const entry = logs.find(l => l.details?.arbitration_outcome === 'continuation_confirmation');
    expect(entry).toBeTruthy();
  });

  it('candidato de reforço/correção abaixo do piso de gestão não altera a operação (candidate_below_arbitration_threshold)', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_4h', cascade: '4h_15m', side: 'BUY', current_stop: 98, score: 50 }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ arbReinforceMinScore: 50 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({
      ...makeScanResult({ asset, results, pineConfig }),
      newSignals: [makeSmcSignal({ context: { score: 20, structure_type: 'BOS' } })],
    });

    const op = backend._get('TradeOperation', 'op_4h');
    expect(op.current_stop).toBe(98);
    expect(op.score).toBe(50); // não mudou
    const logs = await backend.entities.SystemLog.filter({});
    expect(logs.find(l => l.details?.arbitration_outcome === 'candidate_below_arbitration_threshold')).toBeTruthy();
  });

  it('4h_15m ativa + 1h_5m direção oposta (menor) -> correction_warning: reduz SÓ a confiança atual, nunca o score de entrada', async () => {
    backend._seed('TradeOperation', makeOp({
      id: 'op_4h', cascade: '4h_15m', side: 'BUY', score: 50, entry_score: 50, current_confidence_score: 50,
    }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ arbOppositeScorePenalty: 15, arbReinforceMinScore: 50 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({
      ...makeScanResult({ asset, results, pineConfig }),
      newSignals: [makeSmcSignal({ signal_type: 'SELL', dedup_key: 'sig_smc_opp' })],
    });

    const op = backend._get('TradeOperation', 'op_4h');
    expect(op.status).toBe('SIGNAL_CONFIRMED'); // nunca fecha sozinho por um único sinal oposto
    expect(op.score).toBe(50); // score de entrada É IMUTÁVEL
    expect(op.entry_score).toBe(50); // idem
    expect(op.current_confidence_score).toBe(35); // 50 - 15 — só a confiança atual muda
    expect(op.confidence_penalty_total).toBe(15);
    expect(op.last_opposing_signal_at).toBeTruthy();
    expect(op.arbitration_outcome).toBe('correction_warning');

    const logs = await backend.entities.SystemLog.filter({});
    const entry = logs.find(l => l.details?.arbitration_outcome === 'correction_warning');
    expect(entry.level).toBe('warn');
  });

  it('múltiplos sinais opostos acumulam penalidade em current_confidence_score sem nunca tocar o score de entrada', async () => {
    backend._seed('TradeOperation', makeOp({
      id: 'op_4h', cascade: '4h_15m', side: 'BUY', score: 80, entry_score: 80, current_confidence_score: 80, confidence_penalty_total: 0,
    }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ arbOppositeScorePenalty: 15, arbReinforceMinScore: 50 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({
      ...makeScanResult({ asset, results, pineConfig }),
      newSignals: [makeSmcSignal({ signal_type: 'SELL', dedup_key: 'sig_smc_opp_1' })],
    });
    await persistScanResults({
      ...makeScanResult({ asset, results, pineConfig }),
      newSignals: [makeSmcSignal({ signal_type: 'SELL', dedup_key: 'sig_smc_opp_2' })],
    });

    const op = backend._get('TradeOperation', 'op_4h');
    expect(op.entry_score).toBe(80); // ainda imutável após 2 penalidades
    expect(op.current_confidence_score).toBe(50); // 80 - 15 - 15
    expect(op.confidence_penalty_total).toBe(30);
  });

  it('dois candidatos opostos na MESMA passada acumulam penalidade em vez de a segunda sobrescrever a primeira (Codex review, PR #79)', async () => {
    // Reproduz o bug: sem refrescar `activeOp` localmente após cada escrita
    // aplicada dentro da mesma passada, as duas chamadas de arbitragem
    // calculariam `base`/`confidence_penalty_total` a partir do MESMO
    // snapshot pré-passada — a segunda escrita venceria e "apagaria" a
    // primeira penalidade em vez de somar (current_confidence_score
    // terminaria em 65, não 50).
    backend._seed('TradeOperation', makeOp({
      id: 'op_4h', cascade: '4h_15m', side: 'BUY', score: 80, entry_score: 80, current_confidence_score: 80, confidence_penalty_total: 0,
    }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ useADX: false, useChop: false, arbOppositeScorePenalty: 15, arbReinforceMinScore: 50 });
    const results = {
      '4h': makeTfData({ rf: { filterValue: 90, direction: -1, signal: 'none', highBand: 105, lowBand: 95, condIni: false } }),
      '1h': makeTfData({ atrValue: 2 }),
    };

    await persistScanResults({
      ...makeScanResult({ asset, results, pineConfig }),
      newSignals: [
        { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'SELL', timeframe: '4h', source: 'range_filter', dedup_key: 'sig_rf_opp_same_pass', price_at_signal: 100, context: { score: 90 } },
        makeSmcSignal({ signal_type: 'SELL', dedup_key: 'sig_smc_opp_same_pass', context: { score: 90, structure_type: 'BOS' } }),
      ],
    });

    const op = backend._get('TradeOperation', 'op_4h');
    expect(op.entry_score).toBe(80); // imutável
    expect(op.current_confidence_score).toBe(50); // 80 - 15 - 15, nunca 65
    expect(op.confidence_penalty_total).toBe(30);
  });

  it('current_confidence_score nunca fica abaixo de 0', async () => {
    backend._seed('TradeOperation', makeOp({
      id: 'op_4h', cascade: '4h_15m', side: 'BUY', score: 10, entry_score: 10, current_confidence_score: 10,
    }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ arbOppositeScorePenalty: 30, arbReinforceMinScore: 50 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({
      ...makeScanResult({ asset, results, pineConfig }),
      newSignals: [makeSmcSignal({ signal_type: 'SELL', dedup_key: 'sig_smc_opp_floor' })],
    });

    expect(backend._get('TradeOperation', 'op_4h').current_confidence_score).toBe(0);
  });

  it('operação legada sem entry_score/current_confidence_score ainda recebe a penalidade (fallback em score)', async () => {
    // Simula uma TradeOperation criada ANTES desta correção — só tem `score`.
    backend._seed('TradeOperation', makeOp({ id: 'op_legacy', cascade: '4h_15m', side: 'BUY', score: 50 }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ arbOppositeScorePenalty: 15, arbReinforceMinScore: 50 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({
      ...makeScanResult({ asset, results, pineConfig }),
      newSignals: [makeSmcSignal({ signal_type: 'SELL', dedup_key: 'sig_smc_legacy' })],
    });

    const op = backend._get('TradeOperation', 'op_legacy');
    expect(op.current_confidence_score).toBe(35); // 50 (fallback de entry_score) - 15
    expect(op.score).toBe(50); // legado nunca mexido
  });

  it('1h_5m ativa + 4h_15m direção oposta (maior) -> critical_opposite, NUNCA promove, por padrão só alerta (mesmo com score baixo)', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_1h', cascade: '1h_5m', side: 'BUY', status: 'SIGNAL_CONFIRMED' }));
    const pineConfig = makePineConfig({ useADX: false, useChop: false }); // arbInvalidateOnOppositeMajor não definido -> default false
    // rf.direction=-1 para bater com o signal_type SELL do candidato — o
    // gate de alinhamento 4h/sinal (scanner.js) roda ANTES da arbitragem.
    const results = { '4h': makeTfData({ rf: { filterValue: 90, direction: -1, signal: 'none', highBand: 105, lowBand: 95, condIni: false } }) };

    await persistScanResults({
      ...makeScanResult({ results, pineConfig }),
      newSignals: [makeRfSignal({ signal_type: 'SELL', dedup_key: 'sig_rf_opp', context: { score: 5 } })],
    });

    const op = backend._get('TradeOperation', 'op_1h');
    expect(op.status).toBe('SIGNAL_CONFIRMED'); // não invalida por padrão
    expect(op.arbitration_outcome).toBeUndefined(); // action 'none' -> nunca grava na op

    const logs = await backend.entities.SystemLog.filter({});
    const entry = logs.find(l => l.details?.arbitration_outcome === 'critical_opposite');
    expect(entry).toBeTruthy(); // sempre alerta, mesmo com score de candidato baixo (isento do piso de gestão)
    expect(entry.level).toBe('warn');
  });

  it('1h_5m ativa + 4h_15m direção oposta (maior), com arbInvalidateOnOppositeMajor:true -> invalida a operação', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_1h', cascade: '1h_5m', side: 'BUY', status: 'SIGNAL_CONFIRMED' }));
    const pineConfig = makePineConfig({ useADX: false, useChop: false, arbInvalidateOnOppositeMajor: true });
    const results = { '4h': makeTfData({ rf: { filterValue: 90, direction: -1, signal: 'none', highBand: 105, lowBand: 95, condIni: false } }) };

    await persistScanResults({
      ...makeScanResult({ results, pineConfig }),
      newSignals: [makeRfSignal({ signal_type: 'SELL', dedup_key: 'sig_rf_opp_inv' })],
    });

    const op = backend._get('TradeOperation', 'op_1h');
    expect(op.status).toBe('INVALIDATED');
    expect(op.closed_reason).toBe('INVALIDATION');
    expect(op.arbitration_outcome).toBe('critical_opposite');
  });

  it('oposto maior cancela uma promoção PENDENTE (reject_pending_promotion) em vez de deixá-la solta', async () => {
    backend._seed('TradeOperation', makeOp({
      id: 'op_1h', cascade: '1h_5m', side: 'BUY', status: 'SIGNAL_CONFIRMED', promotion_status: 'PENDING_15M',
      promotion_candidate_at: '2026-07-16T11:00:00.000Z',
    }));
    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '4h': makeTfData({ rf: { filterValue: 90, direction: -1, signal: 'none', highBand: 105, lowBand: 95, condIni: false } }) };

    await persistScanResults({
      ...makeScanResult({ results, pineConfig }),
      newSignals: [makeRfSignal({ signal_type: 'SELL', dedup_key: 'sig_rf_opp_pending' })],
    });

    const op = backend._get('TradeOperation', 'op_1h');
    expect(op.status).toBe('SIGNAL_CONFIRMED'); // não invalida
    expect(op.promotion_status).toBe('REJECTED');
  });

  it('CAS rejeitado durante a arbitragem não lança ReferenceError e não corrompe a operação', async () => {
    // Reproduz o bug relatado em auditoria externa: quando transitionTradeOp
    // retorna applied:false (outro worker venceu a corrida entre a leitura
    // de activeOp e esta escrita), o log da rejeição usava uma variável
    // (`logPayload`) nunca declarada no escopo, lançando ReferenceError bem
    // no caminho que deveria só REGISTRAR a rejeição. Força a rejeição
    // deterministicamente substituindo transitionTradeOp, em vez de tentar
    // cronometrar uma corrida real.
    backend._seed('TradeOperation', makeOp({ id: 'op_1h', cascade: '1h_5m', side: 'BUY', status: 'RUNNER_ACTIVE', score: 60 }));
    const pineConfig = makePineConfig({ useADX: false, useChop: false, arbPromoteMinScore: 75 });
    const results = { '4h': makeTfData() };

    const realTransition = backend.tradeOps.transitionTradeOp;
    backend.tradeOps.transitionTradeOp = vi.fn(async () => ({ applied: false, currentStatus: 'TP2_HIT' }));
    try {
      await expect(
        persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal({ context: { score: 80 } })] })
      ).resolves.not.toThrow();
    } finally {
      backend.tradeOps.transitionTradeOp = realTransition;
    }

    // Nenhuma segunda operação foi criada (a arbitragem nunca cria op).
    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);

    const logs = await backend.entities.SystemLog.filter({});
    const casLog = logs.find(l => l.details?.reason === 'arbitration_cas_rejected');
    expect(casLog).toBeTruthy(); // o log de rejeição foi produzido com sucesso, sem exceção
    expect(casLog.details.candidate_signal).toBe('sig_rf_arb'); // logPayload real, não undefined
    expect(casLog.details.current_status).toBe('TP2_HIT');
  });

  it('operação que virou terminal antes do CAS de confirmação nunca recebe promoção (guarda estrutural — CAS)', async () => {
    // Simula "encerrada durante o retry": ativeOp foi lido como
    // SIGNAL_CONFIRMED+PENDING_15M, mas um price-check concorrente já
    // fechou a operação (STOP_HIT) antes do write de confirmação da
    // promoção. Exercita a mesma garantia genérica de opTransition.test.js,
    // mas contra o formato exato do patch de promoção.
    backend._seed('TradeOperation', makeOp({
      id: 'op_1h', cascade: '1h_5m', side: 'BUY', status: 'STOP_HIT',
      promotion_status: 'PENDING_15M',
    }));
    const result = await backend.tradeOps.transitionTradeOp('op_1h', 'SIGNAL_CONFIRMED', {
      promotion_status: 'CONFIRMED', trade_mode: 'PROMOTED_4H', management_timeframe: '4h',
    }, { assetId: 'asset1' });

    expect(result.applied).toBe(false);
    const op = backend._get('TradeOperation', 'op_1h');
    expect(op.status).toBe('STOP_HIT'); // não regride
    expect(op.promotion_status).toBe('PENDING_15M'); // nunca virou CONFIRMED numa op já terminal
  });

  it('duas execuções concorrentes (dois candidatos 4H diferentes) nunca criam uma segunda operação', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_1h', cascade: '1h_5m', side: 'BUY', score: 60 }));
    const pineConfig = makePineConfig({ useADX: false, useChop: false, arbPromoteMinScore: 75 });
    const results = { '4h': makeTfData() };

    // Duas passadas "simultâneas" do scanner (ex.: browser + cron), cada
    // uma vendo um candidato 4H diferente qualificado para promoção. Como o
    // CAS do transitionTradeOp protege por `status` (que este patch não
    // altera), ambas as escritas podem passar — last-write-wins nos
    // METADADOS do pendente, igual ao já documentado para current_stop em
    // opTransition.js. O que nunca pode acontecer é uma segunda operação.
    await Promise.all([
      persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal({ dedup_key: 'sig_rf_race_a', context: { score: 80 } })] }),
      persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal({ dedup_key: 'sig_rf_race_b', context: { score: 85 } })] }),
    ]);

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1); // nunca duplica, não importa a corrida
    expect(['PENDING_15M']).toContain(ops[0].promotion_status); // estado único e válido, não corrompido
  });

  it('retry do mesmo sinal 4H é deduplicado — não reinicia a janela do pendente', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_1h', cascade: '1h_5m', side: 'BUY', score: 60 }));
    const pineConfig = makePineConfig({ useADX: false, useChop: false, arbPromoteMinScore: 75 });
    const results = { '4h': makeTfData() };
    const signal = makeRfSignal({ context: { score: 80 } });

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [signal] });
    const firstCandidateAt = backend._get('TradeOperation', 'op_1h').promotion_candidate_at;

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [signal] }); // mesmo dedup_key
    const secondCandidateAt = backend._get('TradeOperation', 'op_1h').promotion_candidate_at;

    expect(secondCandidateAt).toBe(firstCandidateAt); // a segunda passada nem chegou a re-avaliar (SignalEvent.createUnique bloqueia antes)
  });

  it('logs de arbitragem incluem IDs correlacionáveis (arbitration_version/arbitration_event_id)', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_4h', cascade: '4h_15m', side: 'BUY' }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig();
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const logs = await backend.entities.SystemLog.filter({});
    const entry = logs.find(l => l.details?.arbitration_outcome === 'continuation_confirmation');
    expect(entry.details.arbitration_version).toBe(1);
    expect(entry.details.arbitration_event_id).toBe('sig_smc_arb::op_4h');
    expect(entry.details.relation_direction).toBe('same');
    expect(entry.details.relation_tf).toBe('smaller');
  });

  it('uma entrada nova (sem operação ativa) registra rr_gate_mode/rr_target_basis honestamente', async () => {
    fetchCandles.mockResolvedValue(ALIGNED_15M());
    const pineConfig = makePineConfig({ useADX: false, useChop: false, minRR: 1.2 });
    const results = { '4h': makeTfData() };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].rr_gate_mode).toBe('CONFIGURED_MULTIPLE');
    expect(ops[0].rr_target_basis).toBe('R_MULTIPLE');
    expect(ops[0].rr_at_entry).toBeGreaterThan(0);
  });

  // Regressão do comportamento sem sinal concorrente (sem operação ativa):
  // já coberta extensivamente pelo resto da suíte (ex.: "buildTradeOpData —
  // entry into SIGNAL_CONFIRMED" e os describes de criação de op logo
  // acima) — todos continuam passando sem alteração, provando que a
  // arbitragem só entra em jogo quando hasActiveOp já é true.
});

describe('cross-cascade arbitration — operações ativas duplicadas (anomalia crítica)', () => {
  it('mais de uma operação ativa para o mesmo ativo suspende arbitragem e criação de novas entradas', async () => {
    backend._seed('TradeOperation', makeOp({ id: 'op_a', cascade: '1h_5m', side: 'BUY', status: 'SIGNAL_CONFIRMED' }));
    backend._seed('TradeOperation', makeOp({ id: 'op_b', cascade: '4h_15m', side: 'SELL', status: 'RUNNER_ACTIVE' }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '4h': makeTfData(), '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({
      ...makeScanResult({ asset, results, pineConfig }),
      newSignals: [
        { symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY', timeframe: '4h', source: 'range_filter', dedup_key: 'sig_rf_dup', price_at_signal: 100, context: { score: 90 } },
      ],
    });

    // Nem op_a nem op_b foram alteradas — nenhuma arbitragem rodou.
    expect(backend._get('TradeOperation', 'op_a').status).toBe('SIGNAL_CONFIRMED');
    expect(backend._get('TradeOperation', 'op_a').arbitration_outcome).toBeUndefined();
    expect(backend._get('TradeOperation', 'op_b').status).toBe('RUNNER_ACTIVE');
    expect(backend._get('TradeOperation', 'op_b').arbitration_outcome).toBeUndefined();
    // Nenhuma terceira operação foi criada.
    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(2);

    const logs = await backend.entities.SystemLog.filter({});
    const critical = logs.find(l => l.details?.reason === 'duplicate_active_ops_detected');
    expect(critical).toBeTruthy();
    expect(critical.level).toBe('error');
    expect(critical.details.op_ids.sort()).toEqual(['op_a', 'op_b']);
  });
});

describe('Fase 2 rodada 1 — gatilho de reteste (opt-in, docs/known-risks.md item 40)', () => {
  // Same reasoning as the arbitration/OTE-zone describes above: several
  // tests here configure fetchCandles with mockImplementationOnce chains,
  // which must not leak into unrelated tests elsewhere in this file.
  afterEach(() => { fetchCandles.mockReset(); });

  function mk15m(open, high, low, close, i) {
    return { open, high, low, close, openTime: i * 900000, closeTime: (i + 1) * 900000, isClosed: true };
  }
  function mk5m(open, high, low, close, i) {
    return { open, high, low, close, openTime: i * 300000, closeTime: (i + 1) * 300000, isClosed: true };
  }

  // Stays within a hair of `level` from the very first candle — retests
  // immediately (barsToConfirm=1). A generous retestToleranceAtrMult in the
  // tests below makes the exact ATR derived from these candles irrelevant to
  // the assertions (only the sign/order of the touch matters).
  const retestingCandles15m = (level = 100) =>
    Array.from({ length: 20 }, (_, i) => mk15m(level, level + 0.3, level - 0.3, level + i * 0.01, i));
  const retestingCandles5m = (level = 100) =>
    Array.from({ length: 20 }, (_, i) => mk5m(level, level + 0.3, level - 0.3, level + i * 0.01, i));
  // Stays far from level=100 for the whole series — never retests.
  const neverRetestingCandles15m = () =>
    Array.from({ length: 20 }, (_, i) => mk15m(200, 200.3, 199.7, 200 + i, i));

  const ALIGNED_15M = () => uptrendCandles(60, 100, 1);

  // Same known-good recipe as the "5m OTE zone gate" describe above:
  // 59 flat candles + 1 bullish-sweep candle, entry close pinned at 96.5.
  function bullishSweepCandles5m() {
    const candles = [];
    for (let i = 0; i < 59; i++) candles.push(mk5m(100, 105, 95, 100, i));
    candles.push(mk5m(96, 97, 93, 96.5, 59));
    return candles;
  }

  // candle_time = epoch 0 so every synthetic candle above (closeTime > 0)
  // reads as strictly after the signal — real production signals carry a
  // 2026-dated ISO string, but these fixtures use small epoch-relative
  // closeTime values (same convention as every other candle fixture in this
  // file), so anchoring the signal at epoch 0 keeps the "after the signal"
  // ordering correct without needing 2026-scale synthetic candles.
  function makeRfSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY',
      timeframe: '4h', source: 'range_filter', dedup_key: 'sig_rf_retest',
      price_at_signal: 100, candle_time: new Date(0).toISOString(),
      context: { score: 80, rf_value: 100 },
      ...overrides,
    };
  }
  function makeSmcSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY',
      timeframe: '1h', source: 'smc_structure', dedup_key: 'sig_smc_retest',
      price_at_signal: 100, candle_time: new Date(0).toISOString(),
      context: { score: 80, structure_type: 'BOS', smc_broken_level: 100, ote_leg_high: 200, ote_leg_low: 50 },
      ...overrides,
    };
  }

  it('flag desligado (default): comportamento idêntico ao anterior, sem campos retest_* na op nem fetch extra', async () => {
    fetchCandles.mockResolvedValue(ALIGNED_15M());
    const pineConfig = makePineConfig({ useADX: false, useChop: false }); // retestEnabled ausente -> falsy
    const results = { '4h': makeTfData() };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].retest_gate_enabled).toBeUndefined();
    expect(fetchCandles).toHaveBeenCalledTimes(1); // só check15mConfirmation — nenhum fetch do gate
  });

  it('RF: gate ligado sem reteste ainda -> nenhuma operação criada, log de espera com o nível certo', async () => {
    // Persistent (not "once"): a signal that never confirms in the 1st-pass
    // loop is immediately re-evaluated by the retry loop within this SAME
    // persistScanResults call (it already exists as a SignalEvent within the
    // 4h window by the time that loop runs) — so the gate genuinely fires
    // more than once per call here. mockResolvedValue makes every one of
    // those calls see the same "never retests" data instead of only the
    // first.
    fetchCandles.mockResolvedValue(neverRetestingCandles15m());
    const pineConfig = makePineConfig({ useADX: false, useChop: false, retestEnabled: true });
    const results = { '4h': makeTfData() };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(0);

    const logs = await backend.entities.SystemLog.filter({});
    const waiting = logs.find(l => l.details?.reason === 'awaiting_retest');
    expect(waiting).toBeTruthy();
    expect(waiting.details.anchor_level).toBe(100);
  });

  it('RF: gate ligado com reteste confirmado -> operação criada com os 6 campos de auditoria corretos', async () => {
    fetchCandles
      .mockImplementationOnce(async () => retestingCandles15m(100))
      .mockImplementationOnce(async () => ALIGNED_15M());
    const pineConfig = makePineConfig({ useADX: false, useChop: false, retestEnabled: true, retestToleranceAtrMult: 5 });
    const results = { '4h': makeTfData() };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.retest_gate_enabled).toBe(true);
    expect(op.retest_anchor_level).toBe(100);
    expect(op.retest_touch_mode).toBe('close');
    expect(op.retest_bars_to_confirm).toBe(1);
    expect(op.retest_price).toBeCloseTo(100, 5);
    expect(op.retest_candle_time).toBeTruthy();
  });

  it('SMC: gate ligado usa smc_broken_level como âncora — NÃO structural_level (93, o stop) nem ote_leg_low (50)', async () => {
    fetchCandles
      .mockImplementationOnce(async () => retestingCandles5m(100))
      .mockImplementationOnce(async () => bullishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ retestEnabled: true, retestToleranceAtrMult: 5 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.retest_gate_enabled).toBe(true);
    expect(op.retest_anchor_level).toBe(100);
  });

  it('SMC: smc_broken_level ausente (sinal legado) falha FECHADO — nunca reteste, mesmo com o 5m favorável', async () => {
    fetchCandles.mockImplementation(async () => bullishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ retestEnabled: true });
    const results = { '1h': makeTfData({ atrValue: 2 }) };
    const signal = makeSmcSignal({
      context: { score: 80, structure_type: 'BOS', ote_leg_high: 200, ote_leg_low: 50 }, // sem smc_broken_level
    });

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [signal] });

    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
  });

  it('RF: confirma pelo loop de retry (não só na 1a passada), sem duplicar operação', async () => {
    const pineConfig = makePineConfig({ useADX: false, useChop: false, retestEnabled: true, retestToleranceAtrMult: 5 });
    const results = { '4h': makeTfData() };

    // Passada 1: reteste ainda não aconteceu — sinal persiste, sem op. Uses
    // a persistent mock (see the previous test's comment) since this same
    // signal is evaluated by both the 1st-pass loop and the retry loop
    // within this one persistScanResults call.
    fetchCandles.mockResolvedValue(neverRetestingCandles15m());
    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });
    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);

    // Passada 2 (retry): preço já retestou — confirma via o loop de retry.
    // newSignals é vazio aqui, então só o loop de retry roda (uma única
    // avaliação) — a sequência gate->confirmação de exatamente 2 respostas
    // é segura.
    fetchCandles.mockReset();
    fetchCandles
      .mockImplementationOnce(async () => retestingCandles15m(100))
      .mockImplementationOnce(async () => ALIGNED_15M());
    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].retest_gate_enabled).toBe(true);
  });
});

describe('Bypass da confirmação 15m (opt-in, RF 4h_15m only, docs/known-risks.md item 67)', () => {
  afterEach(() => { fetchCandles.mockReset(); });

  function makeRfSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY',
      timeframe: '4h', source: 'range_filter', dedup_key: 'sig_skip15m',
      price_at_signal: 100, candle_time: '2026-07-16T08:00:00.000Z',
      context: { score: 80 },
      ...overrides,
    };
  }

  it('flag desligado (default): fetchCandles chamado para 15m, entry_candle_time_4h/skip_15m_confirmation ausentes', async () => {
    fetchCandles.mockResolvedValue(uptrendCandles(60, 100, 1));
    const pineConfig = makePineConfig({ useADX: false, useChop: false }); // skip15mConfirmationEnabled ausente -> falsy
    const results = { '4h': makeTfData() };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].skip_15m_confirmation).toBe(false);
    expect(ops[0].entry_candle_time_4h).toBeUndefined();
    expect(ops[0].entry_candle_time_15m).toBeTruthy();
    expect(fetchCandles).toHaveBeenCalledTimes(1); // check15mConfirmation buscou candles de 15m
  });

  it('flag ligado: abre na 1a passada sem nenhum fetch de candle 15m; entry_price/entry_candle_time_4h vêm do sinal original', async () => {
    const pineConfig = makePineConfig({ useADX: false, useChop: false, skip15mConfirmationEnabled: true });
    // results['4h'] tem um lastClose DIFERENTE do price_at_signal do sinal —
    // prova que o preço de entrada vem do sinal (a referência estável), não
    // de uma releitura de results['4h'] nesta passada.
    const results = { '4h': makeTfData({ lastClose: 999 }) };

    await persistScanResults({
      ...makeScanResult({ results, pineConfig }),
      newSignals: [makeRfSignal({ price_at_signal: 100, candle_time: '2026-07-16T08:00:00.000Z' })],
    });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.entry_price).toBe(100);
    expect(op.entry_candle_time_4h).toBe('2026-07-16T08:00:00.000Z');
    expect(op.entry_candle_time_15m).toBeUndefined();
    expect(op.skip_15m_confirmation).toBe(true);
    expect(fetchCandles).toHaveBeenCalledTimes(0); // nenhuma busca de 15m — bypass real, não "passa mais fácil"
  });

  // Codex review (PR #147, P1) — a retry can fire hours after the signal was
  // born (blocked earlier by some other gate; that delay is the retry loop's
  // whole reason for existing). Reusing the stale sig.price_at_signal would
  // open a position at a price that's no longer executable. Correct: use the
  // CURRENT pass's 4h candle (causal/executable), not the original signal.
  it('flag ligado no loop de retry: entry_price/entry_candle_time_4h vêm do candle 4h ATUAL da passada, nunca do preço obsoleto do sinal original', async () => {
    const pineConfig = makePineConfig({ useADX: false, useChop: false, skip15mConfirmationEnabled: true });
    backend._seed('SignalEvent', {
      id: 'sig_skip15m', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
      source: 'range_filter', dedup_key: 'sig_skip15m',
      created_date: '2026-07-16T09:00:00.000Z', // dentro da janela de retry de 4h
      price_at_signal: 100, candle_time: '2026-07-16T08:00:00.000Z', // obsoleto por design deste teste
      context: { score: 80 },
    });
    // Candle 4h ATUAL desta passada, mesma direção (uptrendCandles) — é o
    // que deve virar entry_price/entry_candle_time_4h, não os 100/08:00 acima.
    const results = { '4h': makeTfData({ lastClose: 999, lastCandleTime: '2026-07-16T12:00:00.000Z' }) };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].entry_price).toBe(999); // do candle 4h ATUAL, não do sinal (100)
    expect(ops[0].entry_candle_time_4h).toBe('2026-07-16T12:00:00.000Z'); // idem
    expect(fetchCandles).toHaveBeenCalledTimes(0);
  });

  it('flag ligado no loop de retry: rejeita (trend_reversed) em vez de abrir com preço obsoleto quando o 4h atual já reverteu', async () => {
    const pineConfig = makePineConfig({ useADX: false, useChop: false, skip15mConfirmationEnabled: true });
    backend._seed('SignalEvent', {
      id: 'sig_skip15m', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
      source: 'range_filter', dedup_key: 'sig_skip15m',
      created_date: '2026-07-16T09:00:00.000Z',
      price_at_signal: 100, candle_time: '2026-07-16T08:00:00.000Z',
      context: { score: 80 },
    });
    // 4h atual já reverteu (direction: -1) — o guard trend_reversed, que já
    // existia antes desta mudança, deve continuar barrando a entrada.
    const results = { '4h': makeTfData({ rf: { ...makeTfData().rf, direction: -1 } }) };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
  });
});

describe('Fase 2 rodada 2 — gatilho de deslocamento (opt-in, SMC 1h→5m only, docs/known-risks.md item 41)', () => {
  afterEach(() => { fetchCandles.mockReset(); });

  function mk5m(open, high, low, close, i, volume = 100) {
    return { open, high, low, close, openTime: i * 300000, closeTime: (i + 1) * 300000, isClosed: true, volume };
  }

  // 59 low-range flat candles (keeps ATR small and predictable) + 1 bullish
  // sweep candle whose body is controllable — same sweep/OTE-zone recipe
  // proven in the "5m OTE zone gate" describe above (ote_leg_high:200,
  // ote_leg_low:50 -> discount, which BUY favors), just with a smaller flat
  // range so a moderate body still clears a displacementBodyAtrMult of 1.5.
  function displacementCandles5m({ finalBody = 6.6, finalVolume = 100 } = {}) {
    const candles = [];
    for (let i = 0; i < 59; i++) candles.push(mk5m(100, 100.5, 99.5, 100, i));
    // close must clear swLow (99.5, the flat candles' low) for
    // calculateLiquiditySweep to register a bullish sweep — same recipe as
    // bullishSweepCandles5m in the "5m OTE zone gate" describe above, just
    // with a controllable body (open varies, close fixed just above swLow).
    const close = 99.6;
    const open = close - finalBody;
    candles.push(mk5m(open, 100, 92, close, 59, finalVolume));
    return candles;
  }

  function makeSmcSignal(overrides = {}) {
    return {
      asset_id: 'asset1', symbol: 'BTCUSDT', signal_type: 'BUY',
      timeframe: '1h', source: 'smc_structure', dedup_key: 'smc_sig_displacement',
      price_at_signal: 100,
      context: { structure_type: 'BOS', ote_leg_high: 200, ote_leg_low: 50 },
      ...overrides,
    };
  }

  it('flag desligado (default): comportamento idêntico ao anterior, sem campos displacement_* na op', async () => {
    fetchCandles.mockResolvedValue(displacementCandles5m({ finalBody: 0.1 })); // corpo pequeno — irrelevante com o flag off
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig(); // displacementEnabled ausente -> falsy
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].displacement_gate_enabled).toBeUndefined();
  });

  it('gate ligado, corpo abaixo do limiar -> nenhuma operação criada, log de rejeição', async () => {
    fetchCandles.mockResolvedValue(displacementCandles5m({ finalBody: 0.1 })); // persistente: 1a passada + retry-na-mesma-chamada
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ displacementEnabled: true, displacementBodyAtrMult: 1.5 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(0);

    const logs = await backend.entities.SystemLog.filter({});
    const rejected = logs.find(l => l.details?.reason === 'displacement_gate_rejected');
    expect(rejected).toBeTruthy();
    expect(rejected.details.displacement_reason).toBe('body_too_small');
  });

  it('gate ligado, corpo suficiente, sem exigência de volume -> operação criada com os campos de auditoria', async () => {
    fetchCandles.mockResolvedValue(displacementCandles5m({ finalBody: 3.6 }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ displacementEnabled: true, displacementBodyAtrMult: 1.5 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.displacement_gate_enabled).toBe(true);
    expect(op.displacement_body_ratio).toBeGreaterThanOrEqual(1.5);
    expect(op.displacement_volume_ratio).toBeNull(); // nunca exigido nesta config
    expect(op.displacement_min_body_atr_mult).toBe(1.5);
    expect(op.displacement_min_volume_ratio).toBeNull();
  });

  // Codex review (PR #82): check5mSmcConfirmation fetches a fixed
  // ~150-candle window sized for its OWN sweep/structure needs — a
  // pineConfig.atrLen configured larger than that (plausible: the project's
  // own Pine reference uses ATR(200) for Order Block confirmation
  // elsewhere) used to make calculateATR silently return 0, which
  // detectDisplacement read as invalid_params — rejecting every SMC entry
  // regardless of body size. evaluateDisplacementGate must clamp the
  // period to what closedCandles actually holds instead.
  it('atrLen maior que o histórico disponível não trava o gate em invalid_params (clampado ao que o candle set tem)', async () => {
    fetchCandles.mockResolvedValue(displacementCandles5m({ finalBody: 3.6 }));
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ displacementEnabled: true, displacementBodyAtrMult: 1.5, atrLen: 200 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].displacement_gate_enabled).toBe(true);
  });

  it('gate ligado com volume exigido: corpo ok mas volume insuficiente -> nenhuma operação criada', async () => {
    fetchCandles.mockResolvedValue(displacementCandles5m({ finalBody: 3.6, finalVolume: 50 })); // volume abaixo da média (100)
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ displacementEnabled: true, displacementBodyAtrMult: 1.5, displacementMinVolumeRatio: 1.2 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
  });

  it('gate ligado com volume exigido: corpo e volume ok -> operação criada com displacement_volume_ratio correto', async () => {
    fetchCandles.mockResolvedValue(displacementCandles5m({ finalBody: 3.6, finalVolume: 200 })); // 2x a média (100)
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ displacementEnabled: true, displacementBodyAtrMult: 1.5, displacementMinVolumeRatio: 1.2 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].displacement_volume_ratio).toBeGreaterThanOrEqual(1.2);
  });

  it('confirma pelo loop de retry (não só na 1a passada), sem duplicar operação', async () => {
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ displacementEnabled: true, displacementBodyAtrMult: 1.5 });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    // Passada 1: candle de gatilho com corpo pequeno — sinal persiste, sem op.
    fetchCandles.mockResolvedValue(displacementCandles5m({ finalBody: 0.1 }));
    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });
    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);

    // Passada 2 (retry): candle de gatilho já tem corpo suficiente.
    fetchCandles.mockReset();
    fetchCandles.mockResolvedValue(displacementCandles5m({ finalBody: 3.6 }));
    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].displacement_gate_enabled).toBe(true);
  });
});

// Hardening round (resposta à auditoria externa da Fase 2, PRs #81/#82) —
// os dois gates novos nunca foram exercitados JUNTOS antes: o reteste roda
// ANTES de check5mSmcConfirmation, o deslocamento DEPOIS — só um teste de
// integração real prova que a saída de um alimenta corretamente a entrada
// do outro (e que uma rejeição do segundo ainda impede a operação mesmo
// com o primeiro já satisfeito).
describe('Fase 2 — reteste + deslocamento combinados (hardening pós-auditoria)', () => {
  afterEach(() => { fetchCandles.mockReset(); });

  function mk5m(open, high, low, close, i, volume = 100) {
    return { open, high, low, close, openTime: i * 300000, closeTime: (i + 1) * 300000, isClosed: true, volume };
  }
  // Same recipe as the retest-only describe above — stays within a hair of
  // level=100 from the first candle, retests immediately.
  const retestingCandles5m = (level = 100) =>
    Array.from({ length: 20 }, (_, i) => mk5m(level, level + 0.3, level - 0.3, level + i * 0.01, i));
  // Same recipe as the displacement-only describe above — 59 flat candles +
  // 1 controllable-body bullish-sweep candle.
  function displacementSweepCandles5m({ finalBody = 3.6 } = {}) {
    const candles = [];
    for (let i = 0; i < 59; i++) candles.push(mk5m(100, 100.5, 99.5, 100, i));
    const close = 99.6;
    const open = close - finalBody;
    candles.push(mk5m(open, 100, 92, close, 59));
    return candles;
  }

  function makeSmcSignal(overrides = {}) {
    return {
      asset_id: 'asset1', symbol: 'BTCUSDT', signal_type: 'BUY',
      timeframe: '1h', source: 'smc_structure', dedup_key: 'smc_sig_combined',
      price_at_signal: 100, candle_time: new Date(0).toISOString(),
      context: { structure_type: 'BOS', smc_broken_level: 100, ote_leg_high: 200, ote_leg_low: 50 },
      ...overrides,
    };
  }

  // evaluateRetestGate fetches limit=100 (scanner.js:463); check5mSmcConfirmation
  // fetches limit=150 (scanner.js:363) — distinguishing by that argument
  // (rather than call order) keeps this correct across both the 1st-pass
  // evaluation AND the same-call retry loop, which re-fetches everything for
  // any signal that didn't yet produce an op (see the "persistent, not once"
  // comments in the two describes above).
  function mockCandlesByLimit({ retestLevel = 100, finalBody = 3.6 } = {}) {
    fetchCandles.mockImplementation(async (_symbol, _tf, limit) =>
      (limit === 100 ? retestingCandles5m(retestLevel) : displacementSweepCandles5m({ finalBody })));
  }

  it('os dois gates ligados e ambos aprovando -> operação criada com os campos de auditoria dos DOIS', async () => {
    mockCandlesByLimit({ finalBody: 3.6 }); // corpo suficiente para displacementBodyAtrMult:1.5
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({
      retestEnabled: true, retestToleranceAtrMult: 5, displacementEnabled: true, displacementBodyAtrMult: 1.5,
    });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.retest_gate_enabled).toBe(true);
    expect(op.retest_anchor_level).toBe(100);
    expect(op.displacement_gate_enabled).toBe(true);
    expect(op.displacement_body_ratio).toBeGreaterThanOrEqual(1.5);
  });

  it('reteste confirma mas deslocamento reprova -> nenhuma operação criada', async () => {
    mockCandlesByLimit({ finalBody: 0.1 }); // reteste ok, corpo insuficiente pro deslocamento
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({
      retestEnabled: true, retestToleranceAtrMult: 5, displacementEnabled: true, displacementBodyAtrMult: 1.5,
    });
    const results = { '1h': makeTfData({ atrValue: 2 }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
    const logs = await backend.entities.SystemLog.filter({});
    const rejected = logs.find(l => l.details?.reason === 'displacement_gate_rejected');
    expect(rejected).toBeTruthy();
    expect(rejected.details.displacement_reason).toBe('body_too_small');
  });
});

describe('Fase 3 — tier/regime na cascata SMC (opt-in, docs/known-risks.md item 42)', () => {
  afterEach(() => { fetchCandles.mockReset(); });

  function mk5m(open, high, low, close, i) {
    return { open, high, low, close, openTime: i * 300000, closeTime: (i + 1) * 300000, isClosed: true };
  }
  // Same known-good recipe as the other SMC describes above: 59 flat candles
  // + 1 bullish-sweep candle, entry close pinned at 96.5.
  function bullishSweepCandles5m() {
    const candles = [];
    for (let i = 0; i < 59; i++) candles.push(mk5m(100, 105, 95, 100, i));
    candles.push(mk5m(96, 97, 93, 96.5, 59));
    return candles;
  }

  function makeSmcSignal(overrides = {}) {
    return {
      asset_id: 'asset1', symbol: 'BTCUSDT', signal_type: 'BUY',
      timeframe: '1h', source: 'smc_structure', dedup_key: 'smc_sig_tier',
      price_at_signal: 100, candle_time: new Date(0).toISOString(),
      context: { structure_type: 'BOS', ote_leg_high: 200, ote_leg_low: 50 },
      ...overrides,
    };
  }

  const TIER_T1 = { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48, adxMinVal: 25 };
  const TIER_T2 = { tier: 'T2', atrStopMult: 2.5, chopMaxVal: 58, timeStopBars: 64, adxMinVal: 22 };

  it('flag desligado (default): comportamento idêntico ao anterior — tier_time_stop_bars=96, sem tier/adx_at_entry novos, sem log de regime', async () => {
    fetchCandles.mockResolvedValue(bullishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig(); // smcTierEnabled ausente -> falsy
    // Replica fielmente o que scanAsset produziria com o flag desligado — o
    // guard em scanAsset:882 nem roda o bloco de tier/adx/chop pra 1h.
    const results = { '1h': makeTfData({ atrValue: 2, tier: null, adx: null, chop: null }) };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.tier).toBeUndefined();
    expect(op.adx_at_entry).toBeUndefined();
    expect(op.chop_at_entry).toBeNull();
    expect(op.tier_time_stop_bars).toBe(96);
    const logs = await backend.entities.SystemLog.filter({});
    expect(logs.some(l => l.message?.includes('regime bloqueado'))).toBe(false);
  });

  it('flag ligado, regime reprovado (ADX fraco) -> nenhuma operação criada, log correto, arbitragem cross-cascade também pulada', async () => {
    fetchCandles.mockResolvedValue(bullishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ smcTierEnabled: true });
    const results = {
      '1h': makeTfData({ atrValue: 2, tier: { ...TIER_T2 }, adx: { adx: 5 }, chop: 40 }), // ADX 5 < mínimo 22; chop 40 <= 58 (ok)
    };
    // Op ativa de OUTRA cascata (RF) — prova que o gate fica ANTES de
    // hasActiveOp, mesma posição da RF: quando o regime reprova, a
    // arbitragem cross-cascade nem chega a ser avaliada pra esse sinal.
    backend._seed('TradeOperation', makeOp({ id: 'op_rf', cascade: '4h_15m', side: 'SELL' }));

    const result = await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(1); // só a op seedada, nenhuma nova
    expect(result.arbitrationOutcomes).toHaveLength(0); // handleActiveOpArbitration nunca foi chamado
    expect(result.smcRegimeOutcomes).toEqual([
      { dedup_key: 'smc_sig_tier', cascade: '1h_5m', ok: false, adxOk: false, chopOk: true, adx: 5, chop: 40, tier: 'T2' },
    ]);

    const logs = await backend.entities.SystemLog.filter({});
    const rejected = logs.find(l => l.message?.includes('regime bloqueado'));
    expect(rejected).toBeTruthy();
    expect(rejected.message).toContain('ADX fraco');
    expect(rejected.details.adx).toBe(5);
    expect(rejected.details.tier).toBe('T2');
  });

  it('flag ligado, regime aprovado -> operação criada com tier/adx_at_entry/chop_at_entry/tier_time_stop_bars corretos', async () => {
    fetchCandles.mockResolvedValue(bullishSweepCandles5m());
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ smcTierEnabled: true });
    const results = {
      '1h': makeTfData({ atrValue: 2, tier: { ...TIER_T2 }, adx: { adx: 30 }, chop: 45 }), // ambos ok
    };

    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.tier).toBe('T2');
    expect(op.adx_at_entry).toBe(30);
    expect(op.chop_at_entry).toBe(45);
    expect(op.tier_time_stop_bars).toBe(64);
  });

  it('confirma pelo loop de retry (não só na 1a passada) quando o regime só recupera depois, sem duplicar operação', async () => {
    const asset = makeAsset({ smc_enabled: true });
    const pineConfig = makePineConfig({ smcTierEnabled: true });

    // Passada 1: ADX fraco — sinal persiste, sem op.
    fetchCandles.mockResolvedValue(bullishSweepCandles5m());
    let results = { '1h': makeTfData({ atrValue: 2, tier: { ...TIER_T1 }, adx: { adx: 5 }, chop: 40 }) };
    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [makeSmcSignal()] });
    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);

    // Passada 2 (retry): ADX já recuperou acima do mínimo do tier.
    fetchCandles.mockReset();
    fetchCandles.mockResolvedValue(bullishSweepCandles5m());
    results = { '1h': makeTfData({ atrValue: 2, tier: { ...TIER_T1 }, adx: { adx: 30 }, chop: 40 }) };
    await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].tier).toBe('T1');
  });

  // Achado da investigação de código (não hipótese): o loop de gestão de ops
  // ativas já lê `results[op.signal_timeframe]` de forma genérica pro Chop
  // Exit (scanner.js) — populando results['1h'].tier via smcTierEnabled faz
  // o Chop Exit (useChopExit, flag independente e já existente) passar a
  // valer pra operações SMC "de graça", sem nenhuma linha de código nova
  // além da própria populaçao do tier. Par de testes prova que o efeito
  // fica isolado ao estado real de `tier` no resultado — não ao flag em si.
  it('Chop Exit passa a valer pra operações SMC quando results[1h].tier está populado (efeito colateral documentado, known-risks item 42)', async () => {
    vi.mocked(isTelegramConfigured).mockReturnValue(true);
    backend._seed('TradeOperation', makeOp({ signal_timeframe: '1h', cascade: '1h_5m' }));
    const results = {
      '1h': makeTfData({ lastCandleHigh: 101, lastCandleLow: 99, chop: 60, tier: { ...TIER_T1, chopMaxVal: 55 } }),
    };
    await persistScanResults(makeScanResult({ results, pineConfig: makePineConfig({ useChopExit: true, smcTierEnabled: true }) }));
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('CLOSED');
    expect(stored.closed_reason).toBe('CHOP_EXIT');
    vi.mocked(isTelegramConfigured).mockReturnValue(false);
  });

  it('sem tier populado (flag desligado), Chop Exit NÃO afeta operações SMC', async () => {
    backend._seed('TradeOperation', makeOp({ signal_timeframe: '1h', cascade: '1h_5m' }));
    const results = {
      '1h': makeTfData({ lastCandleHigh: 101, lastCandleLow: 99, chop: 60, tier: null, adx: null }),
    };
    await persistScanResults(makeScanResult({ results, pineConfig: makePineConfig({ useChopExit: true }) })); // smcTierEnabled ausente
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.status).toBe('SIGNAL_CONFIRMED'); // não fechou
  });

  it('buildSmcTradeOpData: tier/adx_at_entry/chop_at_entry/tier_time_stop_bars refletem tf1hData.tier quando presente', () => {
    const sig = makeSmcSignal();
    const tf1hData = makeTfData({ atrValue: 2, tier: { ...TIER_T2 }, adx: { adx: 30 }, chop: 45 });
    const confirmation5m = { entryPrice: 100, entryCandleTime: '2026-07-16T12:00:00.000Z', structuralLevel: 95, trigger: 'sweep', oteZone: 'discount' };

    const opData = buildSmcTradeOpData(sig, tf1hData, makePineConfig(), confirmation5m);

    expect(opData.tier).toBe('T2');
    expect(opData.adx_at_entry).toBe(30);
    expect(opData.chop_at_entry).toBe(45);
    expect(opData.tier_time_stop_bars).toBe(64);
  });

  it('buildSmcTradeOpData: tier_time_stop_bars cai pro literal 96 quando tf1hData.tier está ausente', () => {
    const sig = makeSmcSignal();
    const tf1hData = makeTfData({ atrValue: 2, tier: null, adx: null, chop: null });
    const confirmation5m = { entryPrice: 100, entryCandleTime: '2026-07-16T12:00:00.000Z', structuralLevel: 95, trigger: 'sweep', oteZone: 'discount' };

    const opData = buildSmcTradeOpData(sig, tf1hData, makePineConfig(), confirmation5m);

    expect(opData.tier).toBeUndefined();
    expect(opData.adx_at_entry).toBeUndefined();
    expect(opData.chop_at_entry).toBeNull();
    expect(opData.tier_time_stop_bars).toBe(96);
  });
});

// Fase 4 (docs/known-risks.md item 43) — OB/FVG entram no score SMC como
// informação, nunca como gate. O teste mais importante do bloco é o de
// ATIVAÇÃO EM DOIS ESTÁGIOS: ligar o flag sozinho (pesos no default 0) tem que
// deixar o score NUMERICAMENTE IDÊNTICO, só produzindo campos de auditoria.
describe('Fase 4 — Order Block / FVG no score SMC (opt-in, docs/known-risks.md item 43)', () => {
  afterEach(() => { fetchCandles.mockReset(); });

  // buildSmcTradeOpData/persistScanResults leem sinais já prontos; para
  // exercitar a EMISSÃO (onde OB/FVG entram) o caminho é scanAsset, que é
  // testado em backtestEngine.test.js. Aqui validamos o contrato do score
  // diretamente — é onde a regra de peso 0 vive.
  const baseArgs = {
    structureType: 'BOS',
    signalType: 'BUY',
    rf1hDirection: 1,
    emaTrend: 'bullish',
    volumeData: { current: 200, ma: 100 },
    alignmentResult: { alignment: 'aligned', direction: 'bullish' },
    pdZone: 'discount',
  };

  it('flag desligado (obActive/fvgActive null): score idêntico ao de antes da Fase 4', () => {
    const before = calculateSmcSignalStrength({ ...baseArgs });
    const withNulls = calculateSmcSignalStrength({ ...baseArgs, obActive: null, fvgActive: null });
    expect(withNulls.score).toBe(before.score);
    expect(withNulls.reasons).toEqual(before.reasons);
  });

  it('ativação em 2 estágios: flag ligado com pesos 0 -> score IDÊNTICO, sem poluir reasons', () => {
    const off = calculateSmcSignalStrength({ ...baseArgs, obActive: null, fvgActive: null });
    const measuring = calculateSmcSignalStrength({ ...baseArgs, obActive: true, fvgActive: true });
    expect(measuring.score).toBe(off.score);
    expect(measuring.reasons).toEqual(off.reasons);
  });

  it('com peso configurado, cada componente soma exatamente o seu peso', () => {
    const base = calculateSmcSignalStrength({ ...baseArgs, obActive: false, fvgActive: false });
    const withOb = calculateSmcSignalStrength({
      ...baseArgs, obActive: true, fvgActive: false, weights: { obWeight: 7, fvgWeight: 5 },
    });
    const withBoth = calculateSmcSignalStrength({
      ...baseArgs, obActive: true, fvgActive: true, weights: { obWeight: 7, fvgWeight: 5 },
    });
    // baseArgs soma 15+20+15+15+15 = 80, com folga até o teto de 100.
    expect(withOb.score).toBe(base.score + 7);
    expect(withBoth.score).toBe(base.score + 12);
    expect(withBoth.reasons.some(r => r.includes('Order Block'))).toBe(true);
    expect(withBoth.reasons.some(r => r.includes('Fair Value Gap'))).toBe(true);
  });

  it('obActive/fvgActive false não somam nada mesmo com peso configurado', () => {
    const base = calculateSmcSignalStrength({ ...baseArgs, obActive: null, fvgActive: null });
    const inactive = calculateSmcSignalStrength({
      ...baseArgs, obActive: false, fvgActive: false, weights: { obWeight: 7, fvgWeight: 5 },
    });
    expect(inactive.score).toBe(base.score);
  });

  it('o teto de 100 continua valendo com os pesos novos', () => {
    const maxed = calculateSmcSignalStrength({
      ...baseArgs,
      structureType: 'CHoCH',
      sweepConfirmed: true,
      obActive: true,
      fvgActive: true,
      weights: { obWeight: 40, fvgWeight: 40 },
    });
    expect(maxed.score).toBe(100);
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
    // known-risks item 47 — the asset already in scope must be forwarded so
    // shouldSend can apply its per-asset notify_sources/notify_signal_types
    // override without an extra Firestore read.
    expect(notifyNewSignal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'asset1' }));
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

// known-risks item 47.2/45.4 — antes disso, um sinal que nunca confirmou
// entrada dentro da janela de retry (4h pra RF, 4x1h pra SMC) expirava
// mudo: sem TradeOperation, sem SystemLog, indistinguível de um sinal que
// nunca chegou a ser tentado.
describe('persistScanResults — expiração silenciosa de sinal (item 47.2)', () => {
  it('loga uma vez quando um sinal RF expira sem nunca confirmar entrada, e não repete no scan seguinte', async () => {
    backend._seed('SignalEvent', {
      id: 'sig_stale', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
      source: 'range_filter', dedup_key: 'sig_stale',
      created_date: '2026-07-16T07:00:00.000Z', // 5h antes do "now" congelado (12:00) — passou da janela de 4h
    });
    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '4h': makeTfData() };

    await persistScanResults(makeScanResult({ results, pineConfig }));

    const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_stale' });
    expect(stored[0].expired_logged).toBe(true);
    const logs = await backend.entities.SystemLog.filter({});
    const expiryLogs = logs.filter((l) => l.message?.includes('sinal expirou sem nunca confirmar entrada'));
    expect(expiryLogs).toHaveLength(1);

    // Segunda passada (o sinal continua no top-10 mais recente) — não deve
    // logar de novo, só porque expired_logged já é true.
    await persistScanResults(makeScanResult({ results, pineConfig }));
    const logsAfter = await backend.entities.SystemLog.filter({});
    const expiryLogsAfter = logsAfter.filter((l) => l.message?.includes('sinal expirou sem nunca confirmar entrada'));
    expect(expiryLogsAfter).toHaveLength(1);
  });

  it('loga uma vez quando um sinal SMC expira sem nunca confirmar entrada (4x1h)', async () => {
    const asset = makeAsset({ smc_enabled: true });
    backend._seed('SignalEvent', {
      id: 'sig_smc_stale', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '1h', signal_type: 'BUY',
      source: 'smc_structure', dedup_key: 'sig_smc_stale',
      created_date: '2026-07-16T07:00:00.000Z', // 5h antes do "now" (12:00) — passou da janela de 4x1h
    });
    const pineConfig = makePineConfig({ useADX: false, useChop: false });
    const results = { '1h': makeTfData() };

    await persistScanResults(makeScanResult({ asset, results, pineConfig }));

    const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_smc_stale' });
    expect(stored[0].expired_logged).toBe(true);
    const logs = await backend.entities.SystemLog.filter({});
    expect(logs.some((l) => l.message?.includes('sinal expirou sem nunca confirmar entrada'))).toBe(true);
  });
});

// known-risks item 45.3/49 — Round 1 do plano "fechar o processo do motor":
// nenhum gate do funil de confirmação registrava, de forma agregável, QUAL
// motivo bloqueou uma tentativa (o R:R já logava isolado, os demais gates só
// faziam `continue` mudo). Cobre: `last_rejection_reason` write-on-change
// (recordRejection, só usado nos loops de RETRY), `active_op_exists` sem
// I/O extra, a divisão de `no_trigger` em 3 causas em
// `check5mSmcConfirmation` (SMC), e o enriquecimento do log de expiração com
// o último motivo — nas duas cascatas.
describe('funil de confirmação de entrada — last_rejection_reason + entryFunnelOutcomes (known-risks item 45.3/49)', () => {
  afterEach(() => { fetchCandles.mockReset(); });

  function makeRfSignal(overrides = {}) {
    return {
      asset_id: 'asset1', symbol: 'BTCUSDT', signal_type: 'BUY',
      timeframe: '4h', source: 'range_filter', dedup_key: 'sig_funnel_rf',
      price_at_signal: 100, candle_time: new Date(0).toISOString(),
      context: { score: 80, rf_value: 100 },
      ...overrides,
    };
  }
  function makeSmcSignal(overrides = {}) {
    return {
      asset_id: 'asset1', symbol: 'BTCUSDT', signal_type: 'BUY',
      timeframe: '1h', source: 'smc_structure', dedup_key: 'sig_funnel_smc',
      price_at_signal: 100, candle_time: new Date(0).toISOString(),
      context: { structure_type: 'BOS', ote_leg_high: 200, ote_leg_low: 50 },
      ...overrides,
    };
  }
  function mk5m(open, high, low, close, i) {
    return { open, high, low, close, openTime: i * 300000, closeTime: (i + 1) * 300000, isClosed: true };
  }
  // Completely flat series (open=high=low=close for all bars) — no wick ever
  // breaks a swing extreme (calculateLiquiditySweep) and no swing high/low
  // ever forms (calculateStructure), so neither trigger fires. Length is the
  // only thing that varies between the insufficient_data and no_trigger cases.
  function flatCandles5m(n) {
    return Array.from({ length: n }, (_, i) => mk5m(100, 100, 100, 100, i));
  }
  // Same known-good recipe as the other SMC describes in this file: 59 flat
  // candles + 1 that wicks below the recent low and closes back above it —
  // deterministic bullishSweep=true, entry close pinned at 96.5.
  function bullishSweepCandles5m() {
    const candles = [];
    for (let i = 0; i < 59; i++) candles.push(mk5m(100, 105, 95, 100, i));
    candles.push(mk5m(96, 97, 93, 96.5, 59));
    return candles;
  }
  // Mirror of bullishSweepCandles5m for the opposite (bearish) side: wicks
  // ABOVE the recent high and closes back below it — deterministic
  // bearishSweep=true/bullishSweep=false, for wrong_direction_trigger below.
  function bearishSweepCandles5m() {
    const candles = [];
    for (let i = 0; i < 59; i++) candles.push(mk5m(100, 105, 95, 100, i));
    candles.push(mk5m(104, 107, 103, 103.5, 59));
    return candles;
  }

  describe('RF (4h_15m)', () => {
    it('retry grava last_rejection_reason já na 1ª passada (1º pass e retry avaliam o mesmo sinal no mesmo scan) e não regrava enquanto o motivo não mudar', async () => {
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const reversedResults = { '4h': makeTfData({ rf: { ...makeTfData().rf, direction: -1 } }) }; // tf4hDir=-1, sigDir(BUY)=1
      const signal = makeRfSignal();

      const r1 = await persistScanResults({ ...makeScanResult({ results: reversedResults, pineConfig }), newSignals: [signal] });

      expect(r1.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_rf', cascade: '4h_15m', reason: 'trend_reversed' });
      const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_rf' });
      expect(stored[0].last_rejection_reason).toBe('trend_reversed');

      const updateSpy = vi.spyOn(backend.entities.SignalEvent, 'update');
      // Passada 2 (só retry, newSignals vazio): motivo idêntico -> zero escrita nova.
      const r2 = await persistScanResults({ ...makeScanResult({ results: reversedResults, pineConfig }), newSignals: [] });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(r2.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_rf', cascade: '4h_15m', reason: 'trend_reversed' });
    });

    it('retry: motivo muda entre passadas -> nova escrita com o motivo novo', async () => {
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const signal = makeRfSignal();
      const reversedResults = { '4h': makeTfData({ rf: { ...makeTfData().rf, direction: -1 } }) };
      await persistScanResults({ ...makeScanResult({ results: reversedResults, pineConfig }), newSignals: [signal] });

      const updateSpy = vi.spyOn(backend.entities.SignalEvent, 'update');
      // Trend agora alinhado (direction default = 1), mas o regime reprova
      // (ADX 5 abaixo do adxMinVal 25 do tier, com useADX ligado).
      const regimeRejectedResults = {
        '4h': makeTfData({ adx: { adx: 5 }, chop: 40, tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48, adxMinVal: 25 } }),
      };
      const pineConfigAdxOn = makePineConfig({ useADX: true, useChop: false });
      await persistScanResults({ ...makeScanResult({ results: regimeRejectedResults, pineConfig: pineConfigAdxOn }), newSignals: [] });

      const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_rf' });
      expect(stored[0].last_rejection_reason).toBe('regime_rejected');
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    // Round 3 (docs/known-risks.md item 50) — rfRegimeOutcomes mirrors
    // smcRegimeOutcomes (Fase 3) for the RF cascade: unlike entryFunnelOutcomes
    // (only the string reason), this carries the actual adx/chop/tier that
    // produced the verdict, on BOTH the 1st pass and the retry loop.
    it('1ª passada grava rfRegimeOutcomes com adx/chop/tier reais (regime reprovado) — 1º pass + retry avaliam o mesmo sinal no mesmo scan', async () => {
      const pineConfig = makePineConfig({ useADX: true, useChop: false });
      const results = {
        '4h': makeTfData({ adx: { adx: 5 }, chop: 40, tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48, adxMinVal: 25 } }),
      };
      const signal = makeRfSignal();

      const result = await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [signal] });

      const expectedOutcome = { dedup_key: 'sig_funnel_rf', cascade: '4h_15m', ok: false, adxOk: false, chopOk: true, adx: 5, chop: 40, tier: 'T1' };
      // Mesma duplicidade já documentada pro last_rejection_reason (linha
      // acima): o 1º pass push e o retry loop (que também recolhe o mesmo
      // SignalEvent recém-criado dentro do MESMO scan) ambos avaliam
      // evaluateRegime e empurram pra rfRegimeOutcomes.
      expect(result.rfRegimeOutcomes).toEqual([expectedOutcome, expectedOutcome]);
    });

    it('retry grava rfRegimeOutcomes com adx/chop/tier reais quando o regime já recuperou', async () => {
      fetchCandles.mockResolvedValue(uptrendCandles(60, 100, 1));
      const pineConfig = makePineConfig({ useADX: true, useChop: false });
      backend._seed('SignalEvent', {
        id: 'sig_funnel_rf', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
        source: 'range_filter', dedup_key: 'sig_funnel_rf',
        created_date: '2026-07-16T09:00:00.000Z', // dentro da janela de 4h
      });
      const results = {
        '4h': makeTfData({ adx: { adx: 30 }, chop: 40, tier: { tier: 'T2', atrStopMult: 2.5, chopMaxVal: 58, timeStopBars: 64, adxMinVal: 22 } }),
      };

      const result = await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      expect(result.rfRegimeOutcomes).toEqual([
        { dedup_key: 'sig_funnel_rf', cascade: '4h_15m', ok: true, adxOk: true, chopOk: true, adx: 30, chop: 40, tier: 'T2' },
      ]);
    });

    it('active_op_exists no retry: conta no funil mas nunca escreve o campo (sem I/O extra)', async () => {
      backend._seed('TradeOperation', makeOp({ id: 'op_other', side: 'SELL' })); // qualquer op ativa no ativo já bloqueia
      backend._seed('SignalEvent', {
        id: 'sig_funnel_rf', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
        source: 'range_filter', dedup_key: 'sig_funnel_rf',
        created_date: '2026-07-16T09:00:00.000Z', // dentro da janela de 4h
      });
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const results = { '4h': makeTfData() };

      const updateSpy = vi.spyOn(backend.entities.SignalEvent, 'update');
      const result = await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      expect(result.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_rf', cascade: '4h_15m', reason: 'active_op_exists' });
      expect(updateSpy).not.toHaveBeenCalled();
      const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_rf' });
      expect(stored[0].last_rejection_reason).toBeUndefined();
    });

    // Codex review (PR #102, P1): a signal that just confirmed and created
    // its own op is re-evaluated by this SAME retry loop within this SAME
    // persistScanResults call (it's already a SignalEvent by the time the
    // retry loop's query runs) — hasActiveOp is true because of the op IT
    // ITSELF just created, not because a DIFFERENT op is blocking it. That
    // must never count as active_op_exists — it isn't a rejection.
    it('active_op_exists NÃO é contado pro sinal que acabou de criar a própria op (mesmo scan, retry reavalia o mesmo sinal)', async () => {
      fetchCandles.mockResolvedValue(uptrendCandles(60, 100, 1)); // aligned 15m confirmation
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const results = { '4h': makeTfData() }; // trend aligned, regime ok
      const signal = makeRfSignal();

      const result = await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [signal] });

      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(1); // confirmou
      const active = result.entryFunnelOutcomes.filter((o) => o.reason === 'active_op_exists');
      expect(active).toHaveLength(0);
    });

    // docs/known-risks.md item 6 (2026-08-03): antes desta correção, os 4
    // call sites de passesRiskReward gravavam o literal 'rr_below_min' em
    // entryFunnelOutcomes/last_rejection_reason mesmo quando o motivo real
    // era outro (missing_fields/invalid_stop_distance) — só o SystemLog
    // tinha o motivo certo. atrStopMult:0 no tier zera o risco calculado
    // (buildTradeOpData: risk = atrValue * ATR_MULT, ATR_MULT vem do tier)
    // sem zerar atrValue em si — scanner.js:1679 trata atrValue:0 como
    // "sem dado 4h" e pula o bloco inteiro, então o zero tem que vir do
    // multiplicador, não do ATR bruto. Com risk=0, initial_stop ===
    // entry_price e passesRiskReward cai no branch riskDistance <= 0 ->
    // reason: 'invalid_stop_distance', nunca 'rr_below_min'. Reproduz o
    // bug antes da correção (falharia contra o código anterior, que
    // hardcodeava 'rr_below_min' aqui).
    it('R:R rejeitado por distância de stop inválida grava o motivo REAL (invalid_stop_distance), não rr_below_min hardcoded', async () => {
      fetchCandles.mockResolvedValue(uptrendCandles(60, 100, 1)); // aligned 15m confirmation
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const results = { '4h': makeTfData({ tier: { tier: 'T1', atrStopMult: 0, chopMaxVal: 55, timeStopBars: 48 } }) }; // risk=0 -> initial_stop === entry_price
      const signal = makeRfSignal();

      const result = await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [signal] });

      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0); // não confirmou
      expect(result.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_rf', cascade: '4h_15m', reason: 'invalid_stop_distance' });
      expect(result.entryFunnelOutcomes).not.toContainEqual(expect.objectContaining({ reason: 'rr_below_min' }));
    });

    // docs/known-risks.md item 6 (2026-08-03): check15mConfirmation buscava
    // um limite FIXO de 100 candles e checava um piso hardcoded de 40,
    // cegos ao rf_period real. calculateRangeFilter exige
    // candles.length >= period + 10 (rangeFilter.js) e LANÇA exceção se não
    // tiver — capturada pelo catch de check15mConfirmation, virando
    // confirmed:false silenciosamente, indistinguível de "ainda não
    // confirmou". Com rf_period=95 (>90), o limite fixo de 100 nunca
    // bastava (95+10=105 > 100). Prova que o limite pedido agora escala com
    // o período: Math.max(100, period+10) = 105, não mais 100.
    it('busca candles 15m suficientes pro rf_period real, não mais o limite fixo de 100 (rf_period=95)', async () => {
      fetchCandles.mockResolvedValue(uptrendCandles(500, 100, 1)); // bem além do warm-up de period=95
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const asset = makeAsset({ rf_period: 95 });
      const results = { '4h': makeTfData() };
      const signal = makeRfSignal();

      await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [signal] });

      const [, , limitRequested] = fetchCandles.mock.calls.find((call) => call[1] === '15m');
      expect(limitRequested).toBe(105); // Math.max(100, 95 + 10), não mais o 100 fixo de antes
    });

    // mockResolvedValue simples (como o teste acima) devolve o MESMO array
    // não importa o limite pedido — não diferencia "código antigo pedindo
    // 100" de "código novo pedindo 105" na prática. mockImplementation
    // fatiando pelo limite pedido é o que reproduz o bug de verdade: com o
    // código ANTIGO (limite fixo 100), este teste falharia (100 < 105,
    // calculateRangeFilter lança, confirmed:false) mesmo com um provedor
    // que TINHA histórico de sobra (200 candles) — a exchange nunca chegou
    // a ser perguntada por eles.
    it('rf_period=95 (>90) confirma normalmente quando o provedor tem candles de sobra — não falha mais silenciosamente', async () => {
      const fullHistory = uptrendCandles(200, 100, 1); // provedor TEM de sobra — a pergunta é quanto o código PEDE
      fetchCandles.mockImplementation(async (symbol, tf, limit) => fullHistory.slice(0, limit));
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      const asset = makeAsset({ rf_period: 95 });
      const results = { '4h': makeTfData() };
      const signal = makeRfSignal();

      const result = await persistScanResults({ ...makeScanResult({ asset, results, pineConfig }), newSignals: [signal] });

      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(1); // confirmou
      expect(result.entryFunnelOutcomes.some((o) => o.reason === 'confirmation_15m_not_aligned')).toBe(false);
    });

    it('sinal RF expira carregando o último motivo de rejeição gravado por um retry anterior', async () => {
      const pineConfig = makePineConfig({ useADX: false, useChop: false });
      backend._seed('SignalEvent', {
        id: 'sig_funnel_rf', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
        source: 'range_filter', dedup_key: 'sig_funnel_rf',
        created_date: '2026-07-16T09:00:00.000Z', // 3h antes do relógio congelado (12:00) — dentro da janela
      });
      const reversedResults = { '4h': makeTfData({ rf: { ...makeTfData().rf, direction: -1 } }) };

      // Passada 1: ainda dentro da janela — grava o motivo via o retry.
      await persistScanResults({ ...makeScanResult({ results: reversedResults, pineConfig }), newSignals: [] });
      let stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_rf' });
      expect(stored[0].last_rejection_reason).toBe('trend_reversed');

      // Passada 2: relógio avança além da janela de 4h -> expira.
      vi.setSystemTime(new Date('2026-07-16T14:00:00.000Z'));
      await persistScanResults({ ...makeScanResult({ results: reversedResults, pineConfig }), newSignals: [] });

      stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_rf' });
      expect(stored[0].expired_logged).toBe(true);
      const logs = await backend.entities.SystemLog.filter({});
      const expiryLog = logs.find((l) => l.message?.includes('sinal expirou sem nunca confirmar entrada'));
      expect(expiryLog.message).toContain('último motivo: trend_reversed');
      expect(expiryLog.details.last_rejection_reason).toBe('trend_reversed');
    });
  });

  // Fase 1 (docs/known-risks.md item 56 "Fase 1") — RF 1h condicionado ao
  // 4h, backtest-only (pineConfig.rf1hCondEnabled só existe em
  // scripts/backtestPineConfig.js). Mesmo padrão de teste da seção
  // 'RF (4h_15m)' acima, mas com signal.timeframe:'1h' e o novo cascade
  // RF_1H_COND_CASCADE ('rf1h_cond4h_15m').
  describe('RF 1h condicionado ao 4h (Fase 1, rf1hCondEnabled)', () => {
    const RF_1H_COND_CASCADE = 'rf1h_cond4h_15m';

    function make1hCondSignal(overrides = {}) {
      return makeRfSignal({ timeframe: '1h', dedup_key: 'sig_funnel_rf1h', ...overrides });
    }

    it('com a flag DESLIGADA (default), sinal 1h continua bloqueado exatamente como hoje — nenhum outcome da cascata nova', async () => {
      fetchCandles.mockResolvedValue(uptrendCandles(60, 100, 1));
      const pineConfig = makePineConfig({ useADX: false, useChop: false }); // rf1hCondEnabled ausente
      const results = { '4h': makeTfData() }; // alinhado, regime ok — só a flag decide
      const signal = make1hCondSignal();

      const result = await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [signal] });

      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
      expect(result.entryFunnelOutcomes.filter((o) => o.cascade === RF_1H_COND_CASCADE)).toHaveLength(0);
      expect(result.rfRegimeOutcomes.filter((o) => o.cascade === RF_1H_COND_CASCADE)).toHaveLength(0);
      const logs = await backend.entities.SystemLog.filter({});
      expect(logs.some((l) => l.details?.reason === 'requires_4h_trend')).toBe(true); // caminho antigo intacto
    });

    it('flag LIGADA + 4h alinhado + regime ok + confirmação 15m ⇒ cria TradeOperation com cascade novo e signal_timeframe 1h', async () => {
      // Passo pequeno (0.01) pra manter o close final perto de 100 — com
      // step=1 (como ALIGNED_15M) o close chega a 160, longe do
      // low/high=100 do candle 4h de makeTfData(), o que na PRÓXIMA parte
      // do mesmo persistScanResults (gestão de saída) contaria como stop
      // hit imediato sobre a op recém-criada — artefato de fixture, não
      // comportamento sob teste aqui. useTimeStop:false pelo mesmo motivo:
      // uptrendCandles gera candle_time em época sintética (próxima de
      // 1970), muito distante do relógio congelado (2026) — sem isso, a
      // op recém-criada seria fechada por Time Stop no mesmo scan.
      fetchCandles.mockResolvedValue(uptrendCandles(60, 100, 0.01)); // 15m alinhado (BUY)
      const pineConfig = makePineConfig({ useADX: false, useChop: false, useTimeStop: false, rf1hCondEnabled: true });
      const results = { '4h': makeTfData() }; // direction:1, atrValue:2 — alinhado com BUY
      const signal = make1hCondSignal();

      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [signal] });

      const ops = await backend.entities.TradeOperation.filter({});
      expect(ops).toHaveLength(1);
      expect(ops[0].cascade).toBe(RF_1H_COND_CASCADE);
      expect(ops[0].origin_cascade).toBe(RF_1H_COND_CASCADE);
      expect(ops[0].signal_timeframe).toBe('1h');
      expect(ops[0].entry_price).toBeCloseTo(100.6, 5); // vem do close 15m de confirmação (uptrendCandles), não do preço do sinal 1h
      // Codex review (PR #128, P1): tier.timeStopBars é calibrado em barras
      // de 4h (makeTfData() default: 48); com signal_timeframe:'1h', o loop
      // de saída (SIGNAL_TF_MS[op.signal_timeframe]) leria esse número como
      // barras de 1h se não fosse convertido — Time Stop dispararia 4x cedo
      // demais. tier_time_stop_bars precisa ser 48*4=192, não 48.
      expect(ops[0].tier_time_stop_bars).toBe(192);
    });

    it('flag LIGADA + 4h DESALINHADO com a direção do sinal 1h ⇒ bloqueado, nenhuma operação', async () => {
      const pineConfig = makePineConfig({ useADX: false, useChop: false, rf1hCondEnabled: true });
      const results = { '4h': makeTfData({ rf: { ...makeTfData().rf, direction: -1 } }) }; // tf4hDir=-1, sinal é BUY (sigDir=1)
      const signal = make1hCondSignal();

      const result = await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [signal] });

      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
      expect(result.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_rf1h', cascade: RF_1H_COND_CASCADE, reason: 'trend_reversed' });
    });

    it('flag LIGADA + regime reprovado (ADX fraco no 4h) ⇒ bloqueado, rfRegimeOutcomes com o cascade novo, nunca misturado com 4h_15m', async () => {
      const pineConfig = makePineConfig({ useADX: true, useChop: false, rf1hCondEnabled: true });
      const results = {
        '4h': makeTfData({ adx: { adx: 5 }, chop: 40, tier: { tier: 'T1', atrStopMult: 2.0, chopMaxVal: 55, timeStopBars: 48, adxMinVal: 25 } }),
      };
      const signal = make1hCondSignal();

      const result = await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [signal] });

      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
      expect(result.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_rf1h', cascade: RF_1H_COND_CASCADE, reason: 'regime_rejected' });
      // 2, não 1 — mesma duplicidade já documentada pra cascata nativa
      // (1º pass push + retry loop reavaliando o MESMO SignalEvent recém-
      // criado dentro do MESMO scan, ver teste equivalente na seção
      // 'RF (4h_15m)' acima).
      const cond = result.rfRegimeOutcomes.filter((o) => o.cascade === RF_1H_COND_CASCADE);
      expect(cond).toHaveLength(2);
      for (const outcome of cond) expect(outcome).toMatchObject({ ok: false, adxOk: false, adx: 5 });
      expect(result.rfRegimeOutcomes.some((o) => o.cascade === '4h_15m')).toBe(false); // nenhum sinal 4h nativo neste teste
    });

    it('retry: sinal 1h expira após a janela de 4 barras (4h absolutas), mesmo mecanismo de expired_logged da cascata nativa', async () => {
      const pineConfig = makePineConfig({ useADX: false, useChop: false, rf1hCondEnabled: true });
      backend._seed('SignalEvent', {
        id: 'sig_funnel_rf1h', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '1h', signal_type: 'BUY',
        source: 'range_filter', dedup_key: 'sig_funnel_rf1h',
        created_date: '2026-07-16T07:00:00.000Z', // 5h antes do relógio congelado (12:00) — fora da janela de 4h
      });
      const results = { '4h': makeTfData() };

      await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_rf1h' });
      expect(stored[0].expired_logged).toBe(true);
      const logs = await backend.entities.SystemLog.filter({});
      expect(logs.some((l) => l.message?.includes('sinal expirou sem nunca confirmar entrada (15m, experimental)'))).toBe(true);
    });

    it('retry: sinal 1h dentro da janela de 4h ainda é reavaliado normalmente (não expira cedo demais)', async () => {
      fetchCandles.mockResolvedValue(uptrendCandles(60, 100, 1));
      const pineConfig = makePineConfig({ useADX: false, useChop: false, rf1hCondEnabled: true });
      backend._seed('SignalEvent', {
        id: 'sig_funnel_rf1h', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '1h', signal_type: 'BUY',
        source: 'range_filter', dedup_key: 'sig_funnel_rf1h',
        created_date: '2026-07-16T09:00:00.000Z', // 3h antes do relógio congelado (12:00) — dentro da janela de 4h
      });
      const results = { '4h': makeTfData() };

      const result = await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

      const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_rf1h' });
      expect(stored[0].expired_logged).toBeFalsy();
      expect(result.rfRegimeOutcomes.some((o) => o.cascade === RF_1H_COND_CASCADE)).toBe(true); // foi de fato reavaliado, não pulado
    });

    // Concorrência real (Promise.all sem await individual) — mesma disciplina
    // do teste "duas execuções concorrentes" da seção RF (4h_15m) acima,
    // agora com a cascata NATIVA e a EXPERIMENTAL disputando o MESMO slot
    // assetActiveOps no mesmo ativo. O CAS (createTradeOpIfNoneActive) tem
    // que continuar garantindo no máximo 1 operação ativa, não importa qual
    // cascata "vence" a corrida.
    it('RF 4h nativa e RF 1h condicionada disputando o mesmo ativo concorrentemente nunca criam 2 operações', async () => {
      // Mesmas 2 ressalvas de fixture do teste positivo acima (passo
      // pequeno + useTimeStop:false) — sem elas, a op recém-criada seria
      // fechada (stop ou Time Stop) dentro do MESMO scan, liberando o slot
      // pra uma 2ª criação legítima e mascarando o que este teste quer
      // provar (CAS sob corrida real).
      fetchCandles.mockResolvedValue(uptrendCandles(60, 100, 0.01));
      const pineConfig = makePineConfig({ useADX: false, useChop: false, useTimeStop: false, rf1hCondEnabled: true });
      const results = { '4h': makeTfData() };

      await Promise.all([
        persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal({ dedup_key: 'sig_race_4h', context: { score: 80 } })] }),
        persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [make1hCondSignal({ dedup_key: 'sig_race_1h', context: { score: 80 } })] }),
      ]);

      const ops = await backend.entities.TradeOperation.filter({});
      expect(ops).toHaveLength(1); // nunca duplica, não importa qual cascata venceu a corrida
      expect(['4h_15m', RF_1H_COND_CASCADE]).toContain(ops[0].cascade);
    });
  });

  describe('SMC (1h_5m)', () => {
    // Codex review (PR #102, P1) — mesmo raciocínio do teste equivalente na
    // seção RF acima: o sinal que acabou de confirmar não pode contar como
    // active_op_exists só porque o retry loop o reavalia no mesmo scan.
    it('active_op_exists NÃO é contado pro sinal que acabou de criar a própria op (mesmo scan, retry reavalia o mesmo sinal)', async () => {
      fetchCandles.mockResolvedValue(bullishSweepCandles5m());
      const asset = makeAsset({ smc_enabled: true });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      const signal = makeSmcSignal();

      const result = await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(1); // confirmou
      const active = result.entryFunnelOutcomes.filter((o) => o.reason === 'active_op_exists');
      expect(active).toHaveLength(0);
    });

    it('insufficient_data quando há menos de 60 candles 5m fechados — registrado no funil e gravado no sinal', async () => {
      fetchCandles.mockResolvedValue(flatCandles5m(30));
      const asset = makeAsset({ smc_enabled: true });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      const signal = makeSmcSignal();

      const result = await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

      expect(result.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_smc', cascade: '1h_5m', reason: 'insufficient_data' });
      const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].last_rejection_reason).toBe('insufficient_data');
      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
    });

    it('no_trigger quando há dado suficiente (60 candles) mas nenhum gatilho dispara — distinto de insufficient_data', async () => {
      fetchCandles.mockResolvedValue(flatCandles5m(60));
      const asset = makeAsset({ smc_enabled: true });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      const signal = makeSmcSignal();

      const result = await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

      expect(result.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_smc', cascade: '1h_5m', reason: 'no_trigger' });
      const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].last_rejection_reason).toBe('no_trigger');
    });

    // Round 3 (docs/known-risks.md item 50): sweep/structure already compute
    // BOTH sides — a signal asking for BUY that only sees a BEARISH sweep
    // fire now gets a distinct reason from "genuinely nothing happened"
    // (the no_trigger test right above, on flatCandles5m, is the regression
    // proving that case is unaffected).
    it('wrong_direction_trigger quando o sweep dispara, mas do lado OPOSTO ao sinal — distinto de no_trigger genuíno', async () => {
      fetchCandles.mockResolvedValue(bearishSweepCandles5m()); // bearishSweep=true, bullishSweep=false
      const asset = makeAsset({ smc_enabled: true });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      const signal = makeSmcSignal({ signal_type: 'BUY' }); // pede o lado bullish; só o bearish disparou

      const result = await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

      expect(result.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_smc', cascade: '1h_5m', reason: 'wrong_direction_trigger' });
      const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].last_rejection_reason).toBe('wrong_direction_trigger');
      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
    });

    // Round 3 (docs/known-risks.md item 50): smcTriggerOutcomes records
    // confirmed/trigger/rejectReason on EVERY check5mSmcConfirmation call —
    // the raw material buildReport's attemptsByKey.smcTrigger uses to prove
    // "signal exhausts the whole 4h retry window" instead of the aggregate
    // arithmetic inference (346 signals × 48 evaluations ≈ 17,024) that was
    // the only evidence for it before this round.
    it('smcTriggerOutcomes grava confirmed:true/trigger:sweep quando o gatilho dispara alinhado', async () => {
      fetchCandles.mockResolvedValue(bullishSweepCandles5m());
      const asset = makeAsset({ smc_enabled: true });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      const signal = makeSmcSignal();

      const result = await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(1);
      expect(result.smcTriggerOutcomes.length).toBeGreaterThanOrEqual(1);
      for (const outcome of result.smcTriggerOutcomes) {
        // 59 flat candles + 1 sweep candle (bullishSweepCandles5m) never
        // produces a structural swing to break — sweepAligned:true,
        // structureAligned:false is the deterministic outcome of this
        // fixture (docs/known-risks.md item 52, atualização 2026-08-02).
        expect(outcome).toEqual({ dedup_key: 'sig_funnel_smc', cascade: '1h_5m', confirmed: true, trigger: 'sweep', rejectReason: null, sweepAligned: true, structureAligned: false });
      }
    });

    it('smcTriggerOutcomes grava confirmed:false/trigger:null/rejectReason quando rejeitado (no_trigger)', async () => {
      fetchCandles.mockResolvedValue(flatCandles5m(60));
      const asset = makeAsset({ smc_enabled: true });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      const signal = makeSmcSignal();

      const result = await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

      expect(result.smcTriggerOutcomes.length).toBeGreaterThanOrEqual(1);
      for (const outcome of result.smcTriggerOutcomes) {
        // 60 perfectly flat candles: no wick beyond a swing (no sweep), no
        // structural break (no BOS/CHoCH) — both false by construction.
        expect(outcome).toEqual({ dedup_key: 'sig_funnel_smc', cascade: '1h_5m', confirmed: false, trigger: null, rejectReason: 'no_trigger', sweepAligned: false, structureAligned: false });
      }
    });

    it('fetch_error quando fetchCandles lança — distinto de no_trigger/insufficient_data', async () => {
      fetchCandles.mockRejectedValue(new Error('network down'));
      const asset = makeAsset({ smc_enabled: true });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      const signal = makeSmcSignal();

      const result = await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });

      expect(result.entryFunnelOutcomes).toContainEqual({ dedup_key: 'sig_funnel_smc', cascade: '1h_5m', reason: 'fetch_error' });
      const stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].last_rejection_reason).toBe('fetch_error');
    });

    // .claude/rules/testing.md, "Lacunas restantes": check5mSmcConfirmation
    // não tinha teste dedicado pra "mesma lógica de timing" que
    // check15mConfirmation já tem (backtestEngine.test.js, "cascata de
    // confirmação 15m atrasada") — os testes acima cobrem cada rejectReason
    // isoladamente e a troca de motivo entre passadas, mas nenhum prova que
    // o gatilho 5m em si pode ficar sem confirmar na 1ª passada e SÓ
    // confirmar (criando a TradeOperation) num retry posterior, dentro da
    // janela de 4x1h — o caminho positivo real, não só o de expiração.
    it('SMC: check5mSmcConfirmation rejeita (no_trigger) na 1a passada e confirma pelo retry, sem duplicar operação', async () => {
      const asset = makeAsset({ smc_enabled: true });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      const signal = makeSmcSignal();

      // Passada 1: 5m ainda sem gatilho (candles planos) — sinal persiste,
      // sem op.
      fetchCandles.mockResolvedValue(flatCandles5m(60));
      await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });
      expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
      let stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].last_rejection_reason).toBe('no_trigger');

      // Passada 2 (retry): o sweep bullish já aconteceu — confirma via o
      // loop de retry (newSignals vazio: só o retry reavalia o sinal já
      // persistido).
      fetchCandles.mockReset();
      fetchCandles.mockResolvedValue(bullishSweepCandles5m());
      await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [] });

      const ops = await backend.entities.TradeOperation.filter({});
      expect(ops).toHaveLength(1);
      expect(ops[0].cascade).toBe('1h_5m');
      stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].last_rejection_reason).toBe('no_trigger'); // write-on-change: motivo antigo não é limpo, a op já existe
    });

    it('retry: write-on-change — mesmo motivo não regrava, motivo novo regrava com o rejectReason exato de check5mSmcConfirmation', async () => {
      const asset = makeAsset({ smc_enabled: true });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      const signal = makeSmcSignal();

      fetchCandles.mockResolvedValue(flatCandles5m(30)); // insufficient_data
      await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [signal] });
      let stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].last_rejection_reason).toBe('insufficient_data');

      const updateSpy = vi.spyOn(backend.entities.SignalEvent, 'update');
      // Passada 2 (só retry): mesmo motivo -> zero escrita nova.
      await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [] });
      expect(updateSpy).not.toHaveBeenCalled();

      // Passada 3: motivo muda (dado agora suficiente, mas sem gatilho).
      fetchCandles.mockResolvedValue(flatCandles5m(60));
      await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [] });
      stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].last_rejection_reason).toBe('no_trigger');
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    it('sinal SMC expira carregando o último motivo de rejeição gravado por um retry anterior', async () => {
      const asset = makeAsset({ smc_enabled: true });
      backend._seed('SignalEvent', {
        id: 'sig_funnel_smc', asset_id: 'asset1', symbol: 'BTCUSDT', timeframe: '1h', signal_type: 'BUY',
        source: 'smc_structure', dedup_key: 'sig_funnel_smc',
        created_date: '2026-07-16T09:00:00.000Z', // 3h antes do relógio (12:00) — dentro da janela de 4x1h
        context: { structure_type: 'BOS', ote_leg_high: 200, ote_leg_low: 50 },
      });
      const results = { '1h': makeTfData({ atrValue: 2 }) };
      fetchCandles.mockResolvedValue(flatCandles5m(30)); // insufficient_data

      await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [] });
      let stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].last_rejection_reason).toBe('insufficient_data');

      // Relógio avança além da janela de 4x1h -> expira.
      vi.setSystemTime(new Date('2026-07-16T17:00:00.000Z'));
      await persistScanResults({ ...makeScanResult({ asset, results }), newSignals: [] });

      stored = await backend.entities.SignalEvent.filter({ dedup_key: 'sig_funnel_smc' });
      expect(stored[0].expired_logged).toBe(true);
      const logs = await backend.entities.SystemLog.filter({});
      const expiryLog = logs.find((l) => l.message?.includes('sinal expirou sem nunca confirmar entrada'));
      expect(expiryLog.message).toContain('último motivo: insufficient_data');
      expect(expiryLog.details.last_rejection_reason).toBe('insufficient_data');
    });
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

  // docs/known-risks.md item 59 addendum (external review, PR #116): the
  // candle-time marker paired with a stop advance must name the candle that
  // produced the STORED stop, not whichever candle the losing worker read.
  // Same race as the test above, but checking runner_stop_advanced_candle_time
  // instead of current_stop — without this fix, worker B's stale T1 marker
  // would overwrite worker A's correct T2 one even though current_stop
  // correctly stays at worker A's 105, un-defeating the same-candle
  // look-ahead guard the marker exists for (scanner.js's runnerStopHit).
  it('a losing candidate stop must not overwrite the candle-time marker with its own stale candle', async () => {
    backend._seed('TradeOperation', makeOp({ status: 'RUNNER_ACTIVE', current_stop: 100 }));

    // Worker A (fresher candle T2) commits the better trail first, tagging
    // the candle that produced it.
    const workerA = await backend.tradeOps.transitionTradeOp('op1', 'RUNNER_ACTIVE', {
      status: 'RUNNER_ACTIVE', current_stop: 105, runner_stop_advanced_candle_time: 'T2',
    }, { stopAdvanceMarkerField: 'runner_stop_advanced_candle_time' });

    // Worker B (stale — computed from the stop=100 it read BEFORE worker A
    // committed, off an OLDER candle T1) proposes a worse stop; its own CAS
    // on `status` still passes, and clampMonotonicStop correctly keeps 105.
    const workerB = await backend.tradeOps.transitionTradeOp('op1', 'RUNNER_ACTIVE', {
      status: 'RUNNER_ACTIVE', current_stop: 102, runner_stop_advanced_candle_time: 'T1',
    }, { stopAdvanceMarkerField: 'runner_stop_advanced_candle_time' });

    expect(workerA.applied).toBe(true);
    expect(workerB.applied).toBe(true);
    const stored = backend._get('TradeOperation', 'op1');
    expect(stored.current_stop).toBe(105); // never regresses to 102 (already covered above)
    expect(stored.runner_stop_advanced_candle_time).toBe('T2'); // marker matches the stop actually stored, not worker B's losing candle
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

describe('Gate de padrão de vela (opt-in, RF 4h_15m only, pedido do usuário 2026-08-02)', () => {
  afterEach(() => { fetchCandles.mockReset(); });

  const ALIGNED_15M = () => uptrendCandles(60, 100, 1);

  function makeRfSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY',
      timeframe: '4h', source: 'range_filter', dedup_key: 'sig_rf_candle_pattern',
      price_at_signal: 100, candle_time: new Date(0).toISOString(),
      context: { score: 80, rf_value: 100 },
      ...overrides,
    };
  }

  // Previous candle bearish (110 -> 100), current candle bullish and its
  // body fully covers the previous one (99 -> 112) — valid bullish engulfing.
  const BULLISH_ENGULFING = [
    { open: 110, high: 111, low: 99, close: 100, openTime: 0, closeTime: 14400000, isClosed: true },
    { open: 99, high: 113, low: 98, close: 112, openTime: 14400000, closeTime: 28800000, isClosed: true },
  ];
  // Both candles bullish — no reversal context, fails previous_not_opposite.
  const NO_ENGULFING = [
    { open: 100, high: 108, low: 99, close: 106, openTime: 0, closeTime: 14400000, isClosed: true },
    { open: 106, high: 110, low: 105, close: 109, openTime: 14400000, closeTime: 28800000, isClosed: true },
  ];
  // Previous bullish (fails engulfing's previous_not_opposite on purpose) —
  // current is a valid hammer (long lower wick, small body/upper wick) that
  // does NOT engulf the previous candle's body, so only pin bar matches.
  const HAMMER_ONLY = [
    { open: 100, high: 101, low: 99, close: 100.5, openTime: 0, closeTime: 14400000, isClosed: true },
    { open: 101, high: 103, low: 90, close: 102, openTime: 14400000, closeTime: 28800000, isClosed: true },
  ];
  // Previous bullish (same reason) — current is a valid bullish marubozu
  // (body ~96% of range) whose tiny wicks fail pin bar's 2x ratio, so only
  // marubozu matches.
  const MARUBOZU_ONLY = [
    { open: 95, high: 99.5, low: 94.5, close: 99, openTime: 0, closeTime: 14400000, isClosed: true },
    { open: 100, high: 110.2, low: 99.8, close: 110, openTime: 14400000, closeTime: 28800000, isClosed: true },
  ];

  it('flag desligado (default): comportamento idêntico ao anterior — entry_candle_pattern null, sem log de padrão de vela', async () => {
    fetchCandles.mockResolvedValue(ALIGNED_15M());
    const pineConfig = makePineConfig({ useADX: false, useChop: false }); // candlePatternEnabled ausente -> falsy
    const results = { '4h': makeTfData({ last2Candles: NO_ENGULFING }) }; // mesmo sem padrão válido, o flag off ignora isso

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].entry_candle_pattern).toBeNull();
    const logs = await backend.entities.SystemLog.filter({});
    expect(logs.some(l => l.message?.includes('padrão de vela'))).toBe(false);
  });

  it('flag ligado com engolfo válido -> operação criada com entry_candle_pattern correto', async () => {
    fetchCandles.mockResolvedValue(ALIGNED_15M());
    const pineConfig = makePineConfig({ useADX: false, useChop: false, candlePatternEnabled: true });
    const results = { '4h': makeTfData({ last2Candles: BULLISH_ENGULFING }) };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].entry_candle_pattern).toBe('bullish_engulfing');
  });

  it('flag ligado sem padrão válido -> nenhuma operação criada, log com o motivo certo', async () => {
    fetchCandles.mockResolvedValue(ALIGNED_15M());
    const pineConfig = makePineConfig({ useADX: false, useChop: false, candlePatternEnabled: true });
    const results = { '4h': makeTfData({ last2Candles: NO_ENGULFING }) };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
    const logs = await backend.entities.SystemLog.filter({});
    const rejected = logs.find(l => l.message?.includes('padrão de vela não confirmado'));
    expect(rejected).toBeTruthy();
    expect(rejected.details.reason).toBe('previous_not_opposite');
  });

  it('flag ligado com martelo (sem engolfo) -> operação criada via pin bar', async () => {
    fetchCandles.mockResolvedValue(ALIGNED_15M());
    const pineConfig = makePineConfig({ useADX: false, useChop: false, candlePatternEnabled: true });
    const results = { '4h': makeTfData({ last2Candles: HAMMER_ONLY }) };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].entry_candle_pattern).toBe('hammer');
  });

  it('flag ligado com marubozu (sem engolfo nem pin bar) -> operação criada via marubozu', async () => {
    fetchCandles.mockResolvedValue(ALIGNED_15M());
    const pineConfig = makePineConfig({ useADX: false, useChop: false, candlePatternEnabled: true });
    const results = { '4h': makeTfData({ last2Candles: MARUBOZU_ONLY }) };

    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].entry_candle_pattern).toBe('bullish_marubozu');
  });

  it('confirma pelo loop de retry (não só na 1a passada), sem duplicar operação', async () => {
    const pineConfig = makePineConfig({ useADX: false, useChop: false, candlePatternEnabled: true });
    const results = { '4h': makeTfData({ last2Candles: BULLISH_ENGULFING }) };

    // Passada 1: 15m ainda não confirma (candle desalinhado) — sinal
    // persiste como SignalEvent, sem op, mesmo com padrão de vela válido.
    fetchCandles.mockResolvedValue(downtrendCandles(60, 100, 1));
    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [makeRfSignal()] });
    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);

    // Passada 2 (retry): 15m agora alinha — confirma via o loop de retry,
    // reavaliando o MESMO gate de padrão de vela (que continua válido).
    fetchCandles.mockReset();
    fetchCandles.mockResolvedValue(ALIGNED_15M());
    await persistScanResults({ ...makeScanResult({ results, pineConfig }), newSignals: [] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].entry_candle_pattern).toBe('bullish_engulfing');
  });
});
