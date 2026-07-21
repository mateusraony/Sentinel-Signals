// Tests for the historical backtest engine (docs/known-risks.md, phase 1 of
// the backtest→quality-tuning sequencing decision — see the PR that
// introduced this file for the community research behind it).
//
// Same integration pattern as scannerStateMachine.test.js: the REAL
// scanAsset/persistScanResults from ./scanner.js run against a fake backend
// (src/lib/__fixtures__/fakeBackend.js) and synthetic candles, proving the
// engine actually wires the simulated clock + no-look-ahead candle window
// into the real trading logic — not a re-implementation of it.
//
// The central property under test is stated in the file name: a signal must
// never be visible, and a TradeOperation must never be created, before the
// exact simulated instant where the underlying historical data actually
// produced it. Every fixture value below (flip bar index/timestamp, 15m
// alignment instant) was derived empirically by running the real
// calculateRangeFilter against these exact candle series (see the PR
// description) rather than guessed — a mismatch would make these tests fail
// loudly instead of silently passing on the wrong bar.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeBackend } from './__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('./telegram', () => ({
  isTelegramConfigured: vi.fn(() => false),
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
vi.mock('./pineParser', () => ({
  getPineConfig: vi.fn(),
}));

import * as entitiesModule from '@/api/entities';
import { fetchCandles } from './marketDataProvider';
import { getPineConfig } from './pineParser';
import {
  installSimClock, advanceSimClock, restoreClock, simNow,
  sliceClosedAsOf, inferStepMs, runBacktest, buildReport,
} from './backtestEngine.js';
import { scanAsset } from './scanner.js';
import { goldenCandles } from './indicators/__fixtures__/candles.js';

// ─── Candle generators (custom interval spacing, unlike the fixed 1h
// spacing of src/lib/indicators/__fixtures__/candles.js) ───
function mkCandle(open, high, low, close, openTime, closeTime) {
  return { open, high, low, close, volume: 100, openTime, closeTime, isClosed: true };
}
function downtrendCandles(n, start, step, startMs, intervalMs) {
  const candles = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price - step;
    const high = open + 0.2;
    const low = close - 0.2;
    candles.push(mkCandle(open, high, low, close, startMs + i * intervalMs, startMs + (i + 1) * intervalMs));
    price = close;
  }
  return candles;
}
function uptrendCandles(n, start, step, startMs, intervalMs) {
  const candles = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + step;
    const high = close + 0.2;
    const low = open - 0.2;
    candles.push(mkCandle(open, high, low, close, startMs + i * intervalMs, startMs + (i + 1) * intervalMs));
    price = close;
  }
  return candles;
}

const FOUR_H = 4 * 60 * 60 * 1000;
const FIFTEEN_M = 15 * 60 * 1000;

function makeAsset(overrides = {}) {
  return {
    id: 'asset1', symbol: 'TESTUSDT', is_active: true,
    smc_enabled: false, smc_confirm_4h15m: false,
    timeframes_enabled: { '1h': false, '4h': true, '1d': false },
    rf_period: 20, rf_multiplier: 3.5,
    ...overrides,
  };
}

function basePineConfig(overrides = {}) {
  return {
    // minScore: 0 isolates the property under test (no-look-ahead timing)
    // from the unrelated confluence-scoring gate in indicators/confluence.js
    // — followThrough alone (25pts) already passes any threshold <= 25.
    minScore: 0,
    tp1R: 1.5, tp1QtyPercent: 50, trailAtrMult: 2.0,
    useADX: false, useChop: false,
    useTimeStop: true, useChopExit: false, useInvalidation: false, invalidRFBars: 2,
    ...overrides,
  };
}

// restoreClock() is idempotent (no-op when nothing is installed) — cheap
// insurance against a failing assertion leaking FakeDate into later tests.
afterEach(() => restoreClock());

describe('sliceClosedAsOf', () => {
  it('never returns a candle whose closeTime is after the cursor', () => {
    const candles = [
      mkCandle(1, 1, 1, 1, 0, 1000),
      mkCandle(1, 1, 1, 1, 1000, 2000),
      mkCandle(1, 1, 1, 1, 2000, 3000),
    ];
    expect(sliceClosedAsOf(candles, 1500).map(c => c.closeTime)).toEqual([1000]);
    expect(sliceClosedAsOf(candles, 1999).map(c => c.closeTime)).toEqual([1000]);
    expect(sliceClosedAsOf(candles, 2000).map(c => c.closeTime)).toEqual([1000, 2000]);
    expect(sliceClosedAsOf(candles, 0).map(c => c.closeTime)).toEqual([]);
  });

  it('marks every returned candle isClosed: true regardless of input', () => {
    const candles = [mkCandle(1, 1, 1, 1, 0, 1000)];
    candles[0].isClosed = false;
    expect(sliceClosedAsOf(candles, 1000)[0].isClosed).toBe(true);
  });

  it('respects the limit by taking the most recent N, not the oldest N', () => {
    const candles = [0, 1000, 2000, 3000].map((t, i) => mkCandle(1, 1, 1, 1, t, t + 1000));
    const sliced = sliceClosedAsOf(candles, 4000, 2);
    expect(sliced.map(c => c.closeTime)).toEqual([3000, 4000]);
  });
});

describe('sim clock', () => {
  it('Date.now()/new Date() reflect the simulated instant, not the wall clock', () => {
    installSimClock(1_700_000_000_000);
    expect(Date.now()).toBe(1_700_000_000_000);
    expect(new Date().getTime()).toBe(1_700_000_000_000);
    advanceSimClock(1_700_000_100_000);
    expect(Date.now()).toBe(1_700_000_100_000);
    expect(new Date().toISOString()).toBe(new Date(1_700_000_100_000).toISOString());
    // Multi-arg / explicit-ms construction must pass through untouched.
    expect(new Date(123456).getTime()).toBe(123456);
    restoreClock();
  });

  it('simNow() mirrors the installed cursor', () => {
    installSimClock(42);
    expect(simNow()).toBe(42);
    advanceSimClock(99);
    expect(simNow()).toBe(99);
    restoreClock();
  });

  it('restoreClock() always returns the real Date, even after an exception mid-run', async () => {
    const RealDateRef = Date;
    getPineConfig.mockResolvedValue(basePineConfig());
    fetchCandles.mockImplementation(async () => { throw new Error('boom'); });
    const backend = createFakeBackend();
    Object.assign(entitiesModule.backend, backend);

    // scanAsset's per-timeframe fetch errors are caught internally (pushed to
    // `errors`), so this doesn't actually throw — runBacktest's own finally
    // is what we're really proving here: even if it HAD thrown, the real
    // Date must come back.
    await runBacktest({
      assets: [makeAsset()], backend,
      fromMs: 0, toMs: FIFTEEN_M, stepMs: FIFTEEN_M,
    });
    expect(globalThis.Date).toBe(RealDateRef);
  });

  it('restoreClock() runs even when an asset callback keeps throwing (onStep reports it, loop continues)', async () => {
    const RealDateRef = Date;
    // Deliberately missing SignalEvent/AssetState/SystemLog — persistScanResults'
    // retry-loop query for pending 4h signals throws on this incomplete
    // backend, exercising runBacktest's per-asset try/catch (not scanAsset's
    // own internal per-timeframe one, which the previous test already covers).
    const backend = { entities: { TradeOperation: { filter: async () => [] } } };
    Object.assign(entitiesModule.backend, backend);
    const badAssets = [{ symbol: 'BAD' }];
    const errors = [];
    await runBacktest({
      assets: badAssets, backend,
      fromMs: 0, toMs: FIFTEEN_M, stepMs: FIFTEEN_M,
      onStep: (t, err) => { if (err) errors.push(err); },
    });
    expect(globalThis.Date).toBe(RealDateRef);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('runBacktest — no-look-ahead (4h Range Filter flip)', () => {
  // Downtrend 100 bars (start 300, step 1) then uptrend 60 bars (step 3,
  // continuing from the downtrend's last close) — empirically produces
  // exactly one RF flip in this window, a BUY at bar index 102.
  const START_4H = new Date('2026-01-01T00:00:00.000Z').getTime();
  const FLIP_CLOSE_TIME = new Date('2026-01-18T04:00:00.000Z').getTime();

  function build4hCandles() {
    const down = downtrendCandles(100, 300, 1, START_4H, FOUR_H);
    const upStart = START_4H + 100 * FOUR_H;
    const up = uptrendCandles(60, down[down.length - 1].close, 3, upStart, FOUR_H);
    return [...down, ...up];
  }
  // Pure uptrend ending exactly at the 4h flip's close time — empirically
  // RF-aligned (direction=1) on this window, satisfying check15mConfirmation.
  function build15mCandlesAligned() {
    const start = FLIP_CLOSE_TIME - 100 * FIFTEEN_M;
    return uptrendCandles(100, 100, 0.5, start, FIFTEEN_M);
  }

  function setCandles(symbol, fifteenMinuteBuilder) {
    const store = new Map();
    store.set(`${symbol}:4h`, build4hCandles());
    store.set(`${symbol}:15m`, fifteenMinuteBuilder());
    fetchCandles.mockImplementation(async (sym, tf, limit) =>
      sliceClosedAsOf(store.get(`${sym}:${tf}`) || [], simNow(), limit)
    );
  }

  beforeEach(() => {
    getPineConfig.mockResolvedValue(basePineConfig());
  });

  it('creates no SignalEvent/TradeOperation before the flip bar closes', async () => {
    setCandles('TESTUSDT', build15mCandlesAligned);
    const backend = createFakeBackend();
    Object.assign(entitiesModule.backend, backend);

    await runBacktest({
      assets: [makeAsset()], backend,
      fromMs: FLIP_CLOSE_TIME - 2 * FOUR_H,
      toMs: FLIP_CLOSE_TIME - FIFTEEN_M, // one tick short of the flip — must see nothing
      stepMs: FIFTEEN_M,
    });

    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
    const sigs = await backend.entities.SignalEvent.filter({ source: 'range_filter', signal_type: 'BUY', timeframe: '4h' });
    expect(sigs).toHaveLength(0);
  });

  it('creates exactly one TradeOperation at the exact simulated flip instant', async () => {
    setCandles('TESTUSDT', build15mCandlesAligned);
    const backend = createFakeBackend();
    Object.assign(entitiesModule.backend, backend);

    const report = await runBacktest({
      assets: [makeAsset()], backend,
      fromMs: FLIP_CLOSE_TIME - 2 * FOUR_H,
      toMs: FLIP_CLOSE_TIME,
      stepMs: FIFTEEN_M,
    });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].side).toBe('BUY');
    expect(ops[0].cascade).toBe('4h_15m');
    expect(ops[0].candle_close_time).toBe(new Date(FLIP_CLOSE_TIME).toISOString());
    expect(ops[0].entry_candle_time_15m).toBe(new Date(FLIP_CLOSE_TIME).toISOString());
    expect(ops[0].status).toBe('SIGNAL_CONFIRMED');

    // Report groups by cascade and never force-closes a still-open op.
    expect(report.totalOps).toBe(1);
    expect(report.stillOpenAtCutoff).toBe(1);
    expect(report.overall.total).toBe(0); // summarizeOps only counts CLOSED ops
  });

  it('running well past the last available candle does not crash or duplicate the op', async () => {
    // Dedicated short-tail series: the 4h data ends AT the flip bar itself
    // (only 3 uptrend bars — the minimum needed for the flip to occur inside
    // the data at all, see the empirical derivation in the PR description).
    // Once the sim clock runs past it, sliceClosedAsOf keeps returning that
    // same flip candle forever — its own open time is necessarily before the
    // entry (P0-g's isCandleUsableForExits guard), so TP/stop can never be
    // evaluated against it. This is the real "no more data" case: not a
    // continuing trend the clock hasn't reached yet, but the actual end of
    // the series.
    function build4hCandlesShort() {
      const down = downtrendCandles(100, 300, 1, START_4H, FOUR_H);
      const upStart = START_4H + 100 * FOUR_H;
      const up = uptrendCandles(3, down[down.length - 1].close, 3, upStart, FOUR_H);
      return [...down, ...up];
    }
    const store = new Map();
    store.set('TESTUSDT:4h', build4hCandlesShort());
    store.set('TESTUSDT:15m', build15mCandlesAligned());
    fetchCandles.mockImplementation(async (sym, tf, limit) =>
      sliceClosedAsOf(store.get(`${sym}:${tf}`) || [], simNow(), limit)
    );
    const backend = createFakeBackend();
    Object.assign(entitiesModule.backend, backend);
    // useTimeStop:false isolates "replay past data exhaustion" from the
    // separate, already-covered Time Stop mechanism — both are real
    // scanner.js behaviors, but only one is this test's concern.
    getPineConfig.mockResolvedValue(basePineConfig({ useTimeStop: false }));

    await runBacktest({
      assets: [makeAsset()], backend,
      fromMs: FLIP_CLOSE_TIME - FOUR_H,
      toMs: FLIP_CLOSE_TIME + 20 * FOUR_H, // far beyond the series' last bar
      stepMs: FIFTEEN_M,
    });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe('SIGNAL_CONFIRMED'); // never force-closed by running out of data
  });

  it('delayed 15m confirmation: retries on later scans until the 15m data aligns (scanner.js retry loop)', async () => {
    // 15m series misaligned (downtrend, direction=-1) exactly at the flip
    // instant, then continuing as an uptrend afterward — empirically flips
    // to aligned (direction=1) 1 hour later (4 ticks of 15m), well inside
    // the 4-hour staleness window the retry loop checks against.
    function build15mDelayed() {
      const downStart = FLIP_CLOSE_TIME - 200 * FIFTEEN_M;
      const down = downtrendCandles(200, 300, 0.5, downStart, FIFTEEN_M);
      const up = uptrendCandles(40, down[down.length - 1].close, 1, FLIP_CLOSE_TIME, FIFTEEN_M);
      return [...down, ...up];
    }
    setCandles('TESTUSDT', build15mDelayed);
    const backend = createFakeBackend();
    Object.assign(entitiesModule.backend, backend);

    // Stop just short of the alignment instant — confirms the retry loop
    // genuinely hasn't created the op yet (misaligned every tick so far).
    await runBacktest({
      assets: [makeAsset()], backend,
      fromMs: FLIP_CLOSE_TIME,
      toMs: FLIP_CLOSE_TIME + 3 * FIFTEEN_M,
      stepMs: FIFTEEN_M,
    });
    expect(await backend.entities.TradeOperation.filter({})).toHaveLength(0);
    const pending = await backend.entities.SignalEvent.filter({ source: 'range_filter', signal_type: 'BUY', timeframe: '4h' });
    expect(pending).toHaveLength(1); // the 4h signal was persisted even though entry hasn't confirmed

    // Continue the SAME backend/candle state past the alignment instant.
    await runBacktest({
      assets: [makeAsset()], backend,
      fromMs: FLIP_CLOSE_TIME + 3 * FIFTEEN_M + FIFTEEN_M,
      toMs: FLIP_CLOSE_TIME + 5 * FIFTEEN_M,
      stepMs: FIFTEEN_M,
    });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
    expect(ops[0].entry_candle_time_15m).toBe(new Date(FLIP_CLOSE_TIME + 4 * FIFTEEN_M).toISOString());
    // The 4h signal itself is unchanged — only the ENTRY was delayed.
    expect(ops[0].candle_close_time).toBe(new Date(FLIP_CLOSE_TIME).toISOString());
  });

  // confirmBars (docs/known-risks.md item 27) wiring proof: scanAsset must
  // actually resolve pineConfig.confirmBars and gate newSignals through
  // calculateConfirmedSignal, not just have the pure function be correct in
  // isolation (see rangeFilterConfirmation.test.js for that). Reuses this
  // describe block's own empirically-known flip (BUY at bar index 102 of
  // build4hCandles(), a clean uptrend the whole way through) — no new candle
  // fixture needed. minScore:0 (basePineConfig) isolates this from the
  // unrelated confluence-scoring gate, same reasoning as the sibling tests
  // above.
  describe('scanAsset — confirmBars gates the RF signal', () => {
    it('confirmBars=1 (default, synced today): fires exactly on the flip bar — same as before this feature existed', async () => {
      getPineConfig.mockResolvedValue(basePineConfig({ confirmBars: 1 }));
      fetchCandles.mockImplementation(async () => build4hCandles().slice(0, 103)); // ends exactly at bar 102, the flip
      const result = await scanAsset(makeAsset());
      const rf = result.newSignals.filter(s => s.source === 'range_filter');
      expect(rf).toHaveLength(1);
      expect(rf[0].signal_type).toBe('BUY');
    });

    it('confirmBars=3: no signal yet exactly on the flip bar (freshBuy needs 2 more bars)', async () => {
      getPineConfig.mockResolvedValue(basePineConfig({ confirmBars: 3 }));
      fetchCandles.mockImplementation(async () => build4hCandles().slice(0, 103));
      const result = await scanAsset(makeAsset());
      expect(result.newSignals.filter(s => s.source === 'range_filter')).toHaveLength(0);
    });

    it('confirmBars=3: still nothing 1 bar after the flip — fires exactly 2 bars after, not before/after', async () => {
      getPineConfig.mockResolvedValue(basePineConfig({ confirmBars: 3 }));

      fetchCandles.mockImplementation(async () => build4hCandles().slice(0, 104)); // flip + 1 bar
      const oneShort = await scanAsset(makeAsset());
      expect(oneShort.newSignals.filter(s => s.source === 'range_filter')).toHaveLength(0);

      fetchCandles.mockImplementation(async () => build4hCandles().slice(0, 105)); // flip + 2 bars = confirmBars-1
      const result = await scanAsset(makeAsset());
      const rf = result.newSignals.filter(s => s.source === 'range_filter');
      expect(rf).toHaveLength(1);
      expect(rf[0].signal_type).toBe('BUY');
      // Same uptrend continuing cleanly the whole way — the clean uptrend
      // that follows the flip in build4hCandles() means it never stops being
      // "fresh" at exactly bar 104; the point under test is that it isn't
      // fresh any EARLIER than that, proven by the previous assertion.
    });
  });
});

describe('inferStepMs', () => {
  it('uses 15m when no asset has smc_enabled', () => {
    expect(inferStepMs([makeAsset()])).toBe(15 * 60 * 1000);
  });
  it('uses 5m when any asset has smc_enabled', () => {
    expect(inferStepMs([makeAsset(), makeAsset({ smc_enabled: true })])).toBe(5 * 60 * 1000);
  });
});

describe('runBacktest — input validation', () => {
  it('rejects an empty asset list', async () => {
    await expect(runBacktest({ assets: [], backend: {}, fromMs: 0, toMs: 1 }))
      .rejects.toThrow(/non-empty array/);
  });
  it('rejects a missing backend', async () => {
    await expect(runBacktest({ assets: [makeAsset()], fromMs: 0, toMs: 1 }))
      .rejects.toThrow(/backend is required/);
  });
  it('rejects toMs <= fromMs', async () => {
    await expect(runBacktest({ assets: [makeAsset()], backend: {}, fromMs: 100, toMs: 100 }))
      .rejects.toThrow(/valid range/);
  });
});

describe('buildReport', () => {
  it('separates still-open ops from closed ones and groups closed ops by cascade', () => {
    const ops = [
      { status: 'SIGNAL_CONFIRMED', cascade: '4h_15m' },
      { status: 'STOP_HIT', cascade: '4h_15m', entry_price: 100, initial_stop: 90, exit_price: 90, side: 'BUY' },
      { status: 'TP2_HIT', cascade: '1h_5m', entry_price: 100, initial_stop: 90, exit_price: 130, side: 'BUY' },
    ];
    const report = buildReport(ops, { fromMs: 0, toMs: 1000 });
    expect(report.totalOps).toBe(3);
    expect(report.stillOpenAtCutoff).toBe(1);
    expect(Object.keys(report.byCascade).sort()).toEqual(['1h_5m', '4h_15m']);
    expect(report.byCascade['4h_15m'].total).toBe(1); // only the closed one
    expect(report.overall.total).toBe(2);
  });

  it('smcDiagnostics defaults to all-zero when the caller passes nothing (legacy call shape)', () => {
    const report = buildReport([{ status: 'STOP_HIT', cascade: '4h_15m', entry_price: 100, initial_stop: 90, exit_price: 90, side: 'BUY' }], { fromMs: 0, toMs: 1000 });
    expect(report.smcDiagnostics).toEqual({
      structureEventsTotal: 0, rejectedByZoneGate: 0, confirmedSignals: 0, tradeOpsCreated: 0,
    });
  });

  it('smcDiagnostics sums the funnel and counts 1h_5m ops regardless of open/closed status', () => {
    const ops = [
      { status: 'SIGNAL_CONFIRMED', cascade: '1h_5m' }, // still open — must still count as "created"
      { status: 'STOP_HIT', cascade: '1h_5m', entry_price: 100, initial_stop: 90, exit_price: 90, side: 'BUY' },
      { status: 'STOP_HIT', cascade: '4h_15m', entry_price: 100, initial_stop: 90, exit_price: 90, side: 'BUY' }, // different cascade — must not count
    ];
    const report = buildReport(ops, { fromMs: 0, toMs: 1000, smcRejectedByZoneGate: 4, smcConfirmedSignals: 2 });
    expect(report.smcDiagnostics).toEqual({
      structureEventsTotal: 6, rejectedByZoneGate: 4, confirmedSignals: 2, tradeOpsCreated: 2,
    });
  });
});

// docs/known-risks.md items 34/35: real backtests (BTCUSDT, PENDLEUSDT, ~18
// months each) keep showing zero 1h_5m operations, and until now there was
// no way to tell from the report whether that meant "no structure event
// ever happened" or "one happened and the zone gate silently ate it" — the
// exact question the user asked. Reproduces the known, already-characterized
// scenario from smcStructure.test.js's item 34/35 coverage: goldenCandles(800)
// contains exactly ONE swingLen=50 structure event (a bearChoch at bar 418)
// whose zone is 'discount' — the zone zoneOk rejects for SELL. Driven through
// the REAL runBacktest (not just the pure functions) so this proves the
// counters are wired end to end, not just correct in isolation.
describe('runBacktest — smcDiagnostics answers "why zero SMC ops?" with real counts', () => {
  it('counts the one known structure event as rejected-by-zone-gate, not confirmed, no TradeOperation', async () => {
    const candles = goldenCandles(800);
    getPineConfig.mockResolvedValue(basePineConfig());
    const store = new Map([[`TESTUSDT:1h`, candles]]);
    fetchCandles.mockImplementation(async (sym, tf, limit) =>
      sliceClosedAsOf(store.get(`${sym}:${tf}`) || [], simNow(), limit));
    const backend = createFakeBackend();
    Object.assign(entitiesModule.backend, backend);

    const asset = makeAsset({
      symbol: 'TESTUSDT',
      smc_enabled: true,
      timeframes_enabled: { '1h': true, '4h': false, '1d': false },
    });

    // Bar 418 closes at (418+1)*3600000ms — run a little past it so the
    // event's own tick is definitely inside the replay window.
    const ONE_H = 60 * 60 * 1000;
    const report = await runBacktest({
      assets: [asset], backend,
      fromMs: 0, toMs: 425 * ONE_H,
      stepMs: ONE_H, // no need for the 5m default cadence here
    });

    expect(report.smcDiagnostics).toEqual({
      structureEventsTotal: 1,
      rejectedByZoneGate: 1,
      confirmedSignals: 0,
      tradeOpsCreated: 0,
    });
  });
});
