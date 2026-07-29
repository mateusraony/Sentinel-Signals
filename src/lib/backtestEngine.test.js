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
  MARKET_SOURCE: 'futures',
  DATA_EXCHANGE: 'binance',
  EXECUTOR: 'browser',
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
  summarizeAttempts, EMPTY_ATTEMPTS,
} from './backtestEngine.js';
import { scanAsset } from './scanner.js';
import { ZERO_COST } from './tradeMetrics.js';
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

  // A implementação virou busca binária porque a varredura linear de trás para
  // frente tornava o replay QUADRÁTICO no período (run 30218382227: 4 anos
  // bateram o timeout de 350 min). Este bloco existe para provar que a troca
  // mudou só a velocidade — o resultado tem que ser idêntico ao do laço
  // original, em toda posição possível do cursor.
  describe('equivalência com a varredura linear original', () => {
    // Referência: exatamente o algoritmo que estava em produção antes.
    const linearRef = (candles, asOfMs, limit) => {
      let end = candles.length;
      while (end > 0 && candles[end - 1].closeTime > asOfMs) end--;
      const start = limit ? Math.max(0, end - limit) : 0;
      return candles.slice(start, end).map(c => ({ ...c, isClosed: true }));
    };

    it('idêntica em TODA posição do cursor, inclusive fora das bordas', () => {
      const candles = [0, 1000, 2000, 3000, 4000, 5000]
        .map((t) => mkCandle(1, 1, 1, 1, t, t + 1000));
      // Varre exaustivamente: antes do 1º candle, exatamente em cada closeTime,
      // entre cada par, e depois do último. É mais forte que casos escolhidos
      // a dedo — se houver um off-by-one, ele aparece aqui.
      for (let cursor = -500; cursor <= 7000; cursor += 250) {
        for (const limit of [undefined, 1, 2, 100]) {
          expect(sliceClosedAsOf(candles, cursor, limit).map(c => c.closeTime))
            .toEqual(linearRef(candles, cursor, limit).map(c => c.closeTime));
        }
      }
    });

    it('idêntica em arrays degenerados (vazio, um elemento)', () => {
      expect(sliceClosedAsOf([], 1000)).toEqual(linearRef([], 1000));
      const um = [mkCandle(1, 1, 1, 1, 0, 1000)];
      for (const cursor of [-1, 0, 999, 1000, 1001]) {
        expect(sliceClosedAsOf(um, cursor).map(c => c.closeTime))
          .toEqual(linearRef(um, cursor).map(c => c.closeTime));
      }
    });

    it('candles com closeTime repetido não quebram a fronteira', () => {
      // Não deveria acontecer com dado real da Binance, mas a busca binária
      // precisa ser estável se acontecer — a fronteira é o PRIMEIRO índice com
      // closeTime > cursor, e duplicatas não podem fazer o resultado divergir.
      const candles = [1000, 1000, 2000, 2000, 3000]
        .map((t) => mkCandle(1, 1, 1, 1, t - 1000, t));
      for (const cursor of [500, 1000, 1500, 2000, 2500, 3000, 3500]) {
        expect(sliceClosedAsOf(candles, cursor).map(c => c.closeTime))
          .toEqual(linearRef(candles, cursor).map(c => c.closeTime));
      }
    });

    it('a garantia anti-look-ahead vale para qualquer cursor', () => {
      const candles = Array.from({ length: 200 }, (_, i) => mkCandle(1, 1, 1, 1, i * 60, (i + 1) * 60));
      for (let cursor = 0; cursor <= 12100; cursor += 37) {
        const visiveis = sliceClosedAsOf(candles, cursor);
        // A propriedade que todo o replay depende: nenhuma vela do futuro.
        expect(visiveis.every(c => c.closeTime <= cursor)).toBe(true);
        // E nenhuma vela do passado deixada de fora.
        expect(visiveis.length).toBe(candles.filter(c => c.closeTime <= cursor).length);
      }
    });
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

  // Armadilha real, encontrada por revisão externa depois de eu cair nela
  // (Codex, PR #93): `onStep` roda DENTRO do escopo do relógio simulado, então
  // `Date.now()` ali devolve o cursor do replay, não a hora de parede. Um
  // callback que tente medir tempo decorrido com `Date.now()` produz valor
  // negativo numa janela histórica. Este teste existe para a próxima pessoa
  // que escrever um onStep descobrir isso por um teste e não por um log com
  // número absurdo.
  it('onStep roda com o relógio simulado ativo — Date.now() ali é o cursor, não a hora real', async () => {
    const backend = createFakeBackend();
    Object.assign(entitiesModule.backend, backend);
    const amostras = [];
    const fromMs = Date.parse('2020-01-01T00:00:00Z');
    await runBacktest({
      assets: [makeAsset()], backend,
      fromMs, toMs: fromMs + 3 * FIFTEEN_M, stepMs: FIFTEEN_M,
      onStep: (t, err) => { if (!err) amostras.push({ t, dateNow: Date.now(), perf: performance.now() }); },
    });

    expect(amostras.length).toBeGreaterThan(0);
    for (const { t, dateNow, perf } of amostras) {
      // Date.now() dentro do onStep É o cursor simulado.
      expect(dateNow).toBe(t);
      // performance.now() não é afetado pela troca do Date global — conta ms
      // desde o início do processo, então fica em ordem de grandeza
      // completamente diferente de um timestamp epoch (~1.5e12). É a fonte
      // que um callback deve usar para medir tempo decorrido de verdade.
      expect(perf).toBeGreaterThan(0);
      expect(perf).toBeLessThan(1e9);
    }
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
  // Op fechada mínima com risco = 10 (entry 100, stop 90) — os testes de
  // custo da Fase 5 usam este shape para valores calculáveis à mão.
  const closedOp = (o = {}) => ({
    status: 'STOP_HIT', cascade: '4h_15m', side: 'BUY',
    entry_price: 100, initial_stop: 90, current_stop: 90,
    closed_at: '2026-07-16T09:00:00.000Z', candle_close_time: '2026-07-16T08:00:00.000Z',
    ...o,
  });

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
      structureEventsTotal: 0, confirmedSignals: 0, rejectedByOteZone: 0, tradeOpsCreated: 0,
    });
  });

  // docs/known-risks.md item 38: structureEventsTotal now mirrors
  // confirmedSignals directly (no gate left between 1h detection and
  // SignalEvent creation) — rejectedByOteZone is a separate, later-stage
  // counter (the 5m entry trigger), not subtracted from the total.
  it('smcDiagnostics mirrors confirmedSignals as structureEventsTotal and counts 1h_5m ops regardless of open/closed status', () => {
    const ops = [
      { status: 'SIGNAL_CONFIRMED', cascade: '1h_5m' }, // still open — must still count as "created"
      { status: 'STOP_HIT', cascade: '1h_5m', entry_price: 100, initial_stop: 90, exit_price: 90, side: 'BUY' },
      { status: 'STOP_HIT', cascade: '4h_15m', entry_price: 100, initial_stop: 90, exit_price: 90, side: 'BUY' }, // different cascade — must not count
    ];
    const report = buildReport(ops, { fromMs: 0, toMs: 1000, smcConfirmedSignals: 2, smcRejectedByOteZone: 4 });
    expect(report.smcDiagnostics).toEqual({
      structureEventsTotal: 2, confirmedSignals: 2, rejectedByOteZone: 4, tradeOpsCreated: 2,
    });
  });

  it('arbitration defaults to empty/all-zero when the caller passes nothing (legacy call shape)', () => {
    const report = buildReport([], { fromMs: 0, toMs: 1000 });
    expect(report.arbitration).toEqual({ total: 0, attempts: EMPTY_ATTEMPTS, byOutcome: {}, byCascade: {} });
  });

  it('arbitration counts outcomes by outcome and by the CANDIDATE cascade that triggered each decision', () => {
    const arbitrationOutcomes = [
      { dedup_key: 'a', cascade: '4h_15m', outcome: 'promoted' },
      { dedup_key: 'b', cascade: '4h_15m', outcome: 'reinforcement_rejected' },
      { dedup_key: 'c', cascade: '1h_5m', outcome: 'continuation_confirmation' },
      { dedup_key: 'd', cascade: '1h_5m', outcome: 'continuation_confirmation' },
    ];
    const report = buildReport([], { fromMs: 0, toMs: 1000, arbitrationOutcomes });
    expect(report.arbitration.total).toBe(4);
    expect(report.arbitration.byOutcome).toEqual({
      promoted: 1, reinforcement_rejected: 1, continuation_confirmation: 2,
    });
    expect(report.arbitration.byCascade).toEqual({
      '4h_15m': { promoted: 1, reinforcement_rejected: 1 },
      '1h_5m': { continuation_confirmation: 2 },
    });
  });

  // docs/known-risks.md item 46 — a seção diz QUAL gestão o run usou (não
  // quanto ela rendeu; isso é do diagnóstico). Sem ela, dois relatórios podem
  // ser comparados sem notar que a geometria de saída mudou entre eles, o que
  // atribuiria à estratégia uma diferença que veio da gestão.
  it('runner é inferido das operações, não do pineConfig — reflete a gestão realmente aplicada', () => {
    const comRunner = { status: 'STOP_HIT', partial_percent: 50 };
    const sem = { status: 'CLOSED', closed_reason: 'TP1_FULL', partial_percent: 100 };
    const legada = { status: 'TP2_HIT' }; // sem partial_percent → fallback 50%

    expect(buildReport([], { fromMs: 0, toMs: 1000 }).runner).toEqual({
      enabled: false, opsWithRunner: 0, opsFullyClosedAtTp1: 0, closedByTp1Full: 0,
    });
    expect(buildReport([comRunner, legada], { fromMs: 0, toMs: 1000 }).runner).toEqual({
      enabled: true, opsWithRunner: 2, opsFullyClosedAtTp1: 0, closedByTp1Full: 0,
    });
    expect(buildReport([sem, sem], { fromMs: 0, toMs: 1000 }).runner).toEqual({
      enabled: false, opsWithRunner: 0, opsFullyClosedAtTp1: 2, closedByTp1Full: 2,
    });
    // Run em que o flag virou no meio: as duas gestões aparecem lado a lado em
    // vez de o relatório afirmar uma só.
    expect(buildReport([comRunner, sem], { fromMs: 0, toMs: 1000 }).runner).toEqual({
      enabled: true, opsWithRunner: 1, opsFullyClosedAtTp1: 1, closedByTp1Full: 1,
    });
  });

  // Fase 2 rodada 1 (docs/known-risks.md item 40) — retest.enabled is
  // inferred from retestOutcomes being non-empty (nothing is ever pushed by
  // persistScanResults while pineConfig.retestEnabled is off), so a report
  // from a replay with the flag off reads exactly like the pre-Fase-2
  // shape — no separate "enabled" flag needs to be threaded through
  // buildReport's own params.
  it('retest defaults to disabled/all-zero when the caller passes nothing (legacy call shape, flag off)', () => {
    const report = buildReport([], { fromMs: 0, toMs: 1000 });
    expect(report.retest).toEqual({
      enabled: false, total: 0, attempts: EMPTY_ATTEMPTS, confirmed: 0, pending: 0, avgBarsToConfirm: null, byCascade: {}, byReason: {},
    });
  });

  it('retest counts confirmed vs pending by cascade, averages barsToConfirm over CONFIRMED outcomes only, and tallies pending reasons', () => {
    const retestOutcomes = [
      { dedup_key: 'a', cascade: '4h_15m', retested: true, barsToConfirm: 2, reason: null },
      { dedup_key: 'b', cascade: '4h_15m', retested: true, barsToConfirm: 4, reason: null },
      { dedup_key: 'c', cascade: '4h_15m', retested: false, barsToConfirm: null, reason: 'not_yet' },
      { dedup_key: 'd', cascade: '1h_5m', retested: false, barsToConfirm: null, reason: 'invalid_params' },
    ];
    const report = buildReport([], { fromMs: 0, toMs: 1000, retestOutcomes });
    expect(report.retest.enabled).toBe(true);
    expect(report.retest.total).toBe(4);
    expect(report.retest.confirmed).toBe(2);
    expect(report.retest.pending).toBe(2);
    expect(report.retest.avgBarsToConfirm).toBe(3); // (2+4)/2 — the pending entries don't dilute the average
    expect(report.retest.byCascade).toEqual({
      '4h_15m': { total: 3, confirmed: 2, pending: 1 },
      '1h_5m': { total: 1, confirmed: 0, pending: 1 },
    });
    // Auditoria pós-#81/#82: um único "pending" conflava motivos distintos
    // (ainda aguardando vs. parâmetro inválido) — byReason os separa.
    expect(report.retest.byReason).toEqual({ not_yet: 1, invalid_params: 1 });
  });

  // Fase 2 rodada 2 (docs/known-risks.md item 41) — same enabled-inferred-
  // from-non-empty convention as retest.
  it('displacement defaults to disabled/all-zero when the caller passes nothing (legacy call shape, flag off)', () => {
    const report = buildReport([], { fromMs: 0, toMs: 1000 });
    expect(report.displacement).toEqual({
      enabled: false, total: 0, attempts: EMPTY_ATTEMPTS, confirmed: 0, pending: 0, avgBodyRatio: null, byCascade: {}, byReason: {},
    });
  });

  it('displacement counts confirmed vs pending by cascade, averages bodyRatio over CONFIRMED outcomes only, and tallies pending reasons', () => {
    const displacementOutcomes = [
      { dedup_key: 'a', cascade: '1h_5m', isDisplacement: true, bodyRatio: 2, reason: null },
      { dedup_key: 'b', cascade: '1h_5m', isDisplacement: true, bodyRatio: 4, reason: null },
      { dedup_key: 'c', cascade: '1h_5m', isDisplacement: false, bodyRatio: 0.5, reason: 'body_too_small' },
    ];
    const report = buildReport([], { fromMs: 0, toMs: 1000, displacementOutcomes });
    expect(report.displacement.enabled).toBe(true);
    expect(report.displacement.total).toBe(3);
    expect(report.displacement.confirmed).toBe(2);
    expect(report.displacement.pending).toBe(1);
    expect(report.displacement.avgBodyRatio).toBe(3); // (2+4)/2 — the rejected entry doesn't dilute the average
    expect(report.displacement.byCascade).toEqual({
      '1h_5m': { total: 3, confirmed: 2, pending: 1 },
    });
    expect(report.displacement.byReason).toEqual({ body_too_small: 1 });
  });

  // Fase 3 (docs/known-risks.md item 42) — same enabled-inferred-from-non-
  // empty convention as retest/displacement above.
  it('smcRegime defaults to disabled/all-zero when the caller passes nothing (legacy call shape, flag off)', () => {
    const report = buildReport([], { fromMs: 0, toMs: 1000 });
    expect(report.smcRegime).toEqual({
      enabled: false, total: 0, attempts: EMPTY_ATTEMPTS, passed: 0, rejected: 0, byReason: {},
    });
  });

  // Fase 5 (docs/known-risks.md item 44) — custo real e gate de amostra.
  it('costs: ecoa o modelo aplicado e marca applied:true no default', () => {
    const report = buildReport([], { fromMs: 0, toMs: 1000 });
    expect(report.costs.model.applied).toBe(true);
    expect(report.costs.model.feeBpsEntry).toBe(5); // 0.05% taker
    expect(report.costs.model.slippageBpsPerSide).toBe(1);
  });

  it('costs: --no-costs (ZERO_COST) marca applied:false e zera o custo', () => {
    const ops = [closedOp({ exit_price: 95 })];
    const report = buildReport(ops, { fromMs: 0, toMs: 1000, costModel: ZERO_COST });
    expect(report.costs.model.applied).toBe(false);
    expect(report.costs.totalCostPct).toBe(0);
    expect(report.costs.avgCostR).toBe(0);
    // REGRESSÃO: com custo zero o resultado tem que ser o bruto de sempre.
    expect(report.costs.netExpectancyR).toBeCloseTo(report.costs.grossExpectancyR, 10);
  });

  it('costs: com o default, o líquido é PIOR que o bruto exatamente pelo custo', () => {
    const ops = [closedOp({ exit_price: 95 })];
    const report = buildReport(ops, { fromMs: 0, toMs: 1000 });
    expect(report.costs.avgCostR).toBeGreaterThan(0);
    expect(report.costs.netExpectancyR).toBeCloseTo(
      report.costs.grossExpectancyR - report.costs.avgCostR, 10,
    );
  });

  it('costs: poucas operações -> relatório INCONCLUSIVO', () => {
    const ops = [closedOp({ exit_price: 95 })];
    const report = buildReport(ops, { fromMs: 0, toMs: 1000 });
    expect(report.costs.conclusive).toBe(false);
    expect(report.costs.inconclusiveReason).toBe('sample_too_small');
    expect(report.costs.countedTrades).toBe(1);
    expect(report.costs.minTrades).toBe(30);
    // O veredito tem que descrever o MESMO agregado que `overall`.
    expect(report.costs.countedTrades).toBe(report.overall.counted);
  });

  // Fase 4 (docs/known-risks.md item 43) — mesma convenção enabled-inferido-
  // de-array-não-vazio. Com os pesos do score em 0, ESTA seção é o único
  // efeito observável de ligar smcObFvgEnabled.
  // Achado da revisão externa (documento de arquitetura quantitativa, §10.3),
  // confirmado contra o código: os outcomes eram acumulados num Map por
  // dedup_key, último-escreve-ganha, então N avaliações do MESMO sinal (o loop
  // de retry recomputa cada gate do zero a cada passada) colapsavam em 1 e o
  // relatório não conseguia distinguir "1 sinal que tentou 5x e falhou" de
  // "1 sinal que falhou 1x".
  it('summarizeAttempts separa avaliações de sinais únicos', () => {
    const attempts = new Map([['a', 1], ['b', 5], ['c', 3]]);
    expect(summarizeAttempts(attempts)).toEqual({ evaluations: 9, retried: 2, maxAttempts: 5 });
  });

  it('summarizeAttempts devolve tudo zero para mapa vazio ou ausente', () => {
    expect(summarizeAttempts(new Map())).toEqual(EMPTY_ATTEMPTS);
    expect(summarizeAttempts(null)).toEqual(EMPTY_ATTEMPTS);
    expect(summarizeAttempts(undefined)).toEqual(EMPTY_ATTEMPTS);
  });

  it('attempts sobrevive ao colapso por dedup_key — o número que estava invisível', () => {
    // 3 sinais únicos, 7 avaliações. Antes desta mudança o relatório só
    // conseguia dizer "3" e as outras 4 passadas sumiam sem deixar rastro.
    const attemptStats = {
      retest: summarizeAttempts(new Map([['a', 4], ['b', 2], ['c', 1]])),
    };
    const retestOutcomes = [
      { dedup_key: 'a', cascade: '4h_15m', retested: true, barsToConfirm: 3, reason: null },
      { dedup_key: 'b', cascade: '4h_15m', retested: false, barsToConfirm: null, reason: 'not_yet' },
      { dedup_key: 'c', cascade: '4h_15m', retested: false, barsToConfirm: null, reason: 'not_yet' },
    ];
    const report = buildReport([], { fromMs: 0, toMs: 1000, retestOutcomes, attemptStats });
    expect(report.retest.total).toBe(3); // sinais únicos
    expect(report.retest.attempts).toEqual({ evaluations: 7, retried: 2, maxAttempts: 4 });
  });

  it('smcObFvg defaults to disabled/all-zero when the caller passes nothing (legacy call shape, flag off)', () => {
    const report = buildReport([], { fromMs: 0, toMs: 1000 });
    expect(report.smcObFvg).toEqual({
      enabled: false, total: 0, attempts: EMPTY_ATTEMPTS, obActive: 0, fvgActive: 0, both: 0, neither: 0,
    });
  });

  it('smcObFvg conta OB/FVG ativos, a interseção e os sinais sem nenhum dos dois', () => {
    const smcObFvgOutcomes = [
      { dedup_key: 'a', cascade: '1h_5m', obActive: true, fvgActive: true },
      { dedup_key: 'b', cascade: '1h_5m', obActive: true, fvgActive: false },
      { dedup_key: 'c', cascade: '1h_5m', obActive: false, fvgActive: true },
      { dedup_key: 'd', cascade: '1h_5m', obActive: false, fvgActive: false },
    ];
    const report = buildReport([], { fromMs: 0, toMs: 1000, smcObFvgOutcomes });
    expect(report.smcObFvg.enabled).toBe(true);
    expect(report.smcObFvg.total).toBe(4);
    expect(report.smcObFvg.obActive).toBe(2);
    expect(report.smcObFvg.fvgActive).toBe(2);
    expect(report.smcObFvg.both).toBe(1);
    expect(report.smcObFvg.neither).toBe(1);
  });

  it('smcRegime counts passed vs rejected and tallies rejection reasons (adx-only, chop-only, both)', () => {
    const smcRegimeOutcomes = [
      { dedup_key: 'a', cascade: '1h_5m', ok: true, adxOk: true, chopOk: true },
      { dedup_key: 'b', cascade: '1h_5m', ok: true, adxOk: true, chopOk: true },
      { dedup_key: 'c', cascade: '1h_5m', ok: false, adxOk: false, chopOk: true },
      { dedup_key: 'd', cascade: '1h_5m', ok: false, adxOk: true, chopOk: false },
      { dedup_key: 'e', cascade: '1h_5m', ok: false, adxOk: false, chopOk: false },
    ];
    const report = buildReport([], { fromMs: 0, toMs: 1000, smcRegimeOutcomes });
    expect(report.smcRegime.enabled).toBe(true);
    expect(report.smcRegime.total).toBe(5);
    expect(report.smcRegime.passed).toBe(2);
    expect(report.smcRegime.rejected).toBe(3);
    expect(report.smcRegime.byReason).toEqual({ adx_weak: 1, choppy: 1, adx_and_chop: 1 });
  });
});

// docs/known-risks.md items 34/35/38: real backtests (BTCUSDT, PENDLEUSDT,
// ~18 months each) kept showing zero 1h_5m operations. smcDiagnostics (item
// 35) revealed why: 74/74 real 1h structure breaks over 18.5 months of
// BTCUSDT were rejected by the zoneOk gate — not an occasional miss, a
// structural tautology (a break's close is, by definition, near the extreme
// of the same window the gate measures it against). Item 38 removed that
// gate outright instead of tuning it — no threshold fixes a self-referential
// rejection. Reproduces the known, already-characterized scenario from
// smcStructure.test.js's item 34/35 coverage: goldenCandles(800) contains
// exactly ONE swingLen=50 structure event (a bearChoch at bar 418, zone
// 'discount' — what the OLD gate rejected for SELL). Driven through the REAL
// runBacktest (not just the pure functions) so this proves the counters are
// wired end to end, not just correct in isolation.
describe('runBacktest — smcDiagnostics answers "why zero SMC ops?" with real counts', () => {
  it('counts the one known structure event as a confirmed signal now that the 1h zone gate is gone (item 38)', async () => {
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

    // No candles5m store is set up here, so the 5m entry trigger never
    // fires — tradeOpsCreated stays 0 for a reason unrelated to zone (no
    // 5m confirmation data), not because of the removed 1h gate.
    expect(report.smcDiagnostics).toEqual({
      structureEventsTotal: 1,
      confirmedSignals: 1,
      rejectedByOteZone: 0,
      tradeOpsCreated: 0,
    });
  });

  // Fase 4 (docs/known-risks.md item 43) — prova de wiring fim a fim contra o
  // scanAsset/persistScanResults REAIS, reusando o mesmo evento de estrutura
  // conhecido (barra 418) do teste acima: com smcObFvgEnabled ligado, o sinal
  // emitido tem que carregar ob_active/fvg_active e alimentar report.smcObFvg.
  it('smcObFvg: com o flag ligado, o sinal SMC emitido carrega ob_active/fvg_active', async () => {
    const candles = goldenCandles(800);
    getPineConfig.mockResolvedValue({ ...basePineConfig(), smcObFvgEnabled: true });
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

    const ONE_H = 60 * 60 * 1000;
    const report = await runBacktest({
      assets: [asset], backend, fromMs: 0, toMs: 425 * ONE_H, stepMs: ONE_H,
    });

    // O mesmo evento único do teste irmão acima, agora medido pela lente da
    // Fase 4: `enabled` é inferido do array não vazio, e os campos booleanos
    // são de fato populados (não null) — que é o que o flag entrega.
    expect(report.smcObFvg.enabled).toBe(true);
    expect(report.smcObFvg.total).toBe(1);

    const smcSignals = await backend.entities.SignalEvent.filter({ source: 'smc_structure' });
    expect(smcSignals).toHaveLength(1);
    const ctx = smcSignals[0].context;
    // Booleanos de verdade (não null): é isso que ligar o flag entrega.
    expect(typeof ctx.ob_active).toBe('boolean');
    expect(typeof ctx.fvg_active).toBe('boolean');
    // E o relatório tem que refletir exatamente o que o sinal carrega.
    expect(report.smcObFvg.obActive).toBe(ctx.ob_active ? 1 : 0);
    expect(report.smcObFvg.fvgActive).toBe(ctx.fvg_active ? 1 : 0);
    expect(report.smcObFvg.neither).toBe(!ctx.ob_active && !ctx.fvg_active ? 1 : 0);
  });

  it('smcObFvg: com o flag DESLIGADO (default), nada é medido e os campos ficam null', async () => {
    const candles = goldenCandles(800);
    getPineConfig.mockResolvedValue(basePineConfig()); // smcObFvgEnabled ausente
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

    const ONE_H = 60 * 60 * 1000;
    const report = await runBacktest({
      assets: [asset], backend, fromMs: 0, toMs: 425 * ONE_H, stepMs: ONE_H,
    });

    expect(report.smcObFvg.enabled).toBe(false);
    expect(report.smcObFvg.total).toBe(0);
    const smcSignals = await backend.entities.SignalEvent.filter({ source: 'smc_structure' });
    expect(smcSignals).toHaveLength(1);
    expect(smcSignals[0].context.ob_active).toBeNull();
    expect(smcSignals[0].context.fvg_active).toBeNull();
  });

  // Codex review on PR #74: scanAsset is stateless and re-evaluates the SAME
  // last-closed 1h candle on every tick until the next one closes. At the
  // REAL default cadence (5min, since asset.smc_enabled — inferStepMs), the
  // bar-418 event would be re-emitted into newSignals on every 5m tick for
  // the rest of that hour (~12x) if not deduplicated by dedup_key — the same
  // risk that used to apply to zoneGateDrops (item 35) now applies to
  // confirmedSignals instead, same dedup mechanism. Runs a narrow window
  // straddling just the event bar (not the full 425h of the sibling test
  // above) to keep this fast while still exercising the exact cadence that
  // exposed the original bug.
  it('does not over-count when the same 1h candle is re-evaluated every 5 minutes (default cadence)', async () => {
    const candles = goldenCandles(800);
    getPineConfig.mockResolvedValue(basePineConfig());
    const store = new Map([[`TESTUSDT:1h`, candles]]);
    fetchCandles.mockImplementation(async (sym, tf, limit) =>
      sliceClosedAsOf(store.get(`${sym}:${tf}`) || [], simNow(), limit));
    const backend = createFakeBackend();
    Object.assign(entitiesModule.backend, backend);

    const asset = makeAsset({
      symbol: 'TESTUSDT',
      smc_enabled: true, // -> inferStepMs picks the real 5-minute default cadence
      timeframes_enabled: { '1h': true, '4h': false, '1d': false },
    });

    const ONE_H = 60 * 60 * 1000;
    const report = await runBacktest({
      assets: [asset], backend,
      fromMs: 415 * ONE_H, toMs: 421 * ONE_H, // straddles bar 418's close, ~72 five-minute ticks
      // no stepMs override — exercises inferStepMs' real default cadence
    });

    expect(report.smcDiagnostics.confirmedSignals).toBe(1); // not ~12
    expect(report.smcDiagnostics.rejectedByOteZone).toBe(0);
    expect(report.smcDiagnostics.structureEventsTotal).toBe(1);
  });

  // docs/known-risks.md item 38: proves rejectedByOteZone (and, in the
  // sibling test below, tradeOpsCreated) are wired end to end through the
  // real persistScanResults→runBacktest plumbing (not just buildReport's
  // pure param passthrough, covered above) — a 1h structure event whose 5m
  // entry trigger lands in the unfavorable/favorable leg zone must be
  // counted/created here, deduplicated by the signal's own dedup_key so a
  // retried rejection across ticks doesn't inflate the count (see the "does
  // not over-count" test above for the equivalent proof on
  // confirmedSignals). bar 418 in goldenCandles(800) is a bearChoch (SELL)
  // with lastSwingHigh≈166.802/breakClose≈98.435 (verified against
  // calculateStructure directly) — the OTE leg for a SELL anchors legHigh to
  // the swing high and legLow to the break's own close, giving
  // eqTop≈136.037/eqBtm≈129.201. SELL rejects only 'discount' (close <
  // eqBtm) and accepts 'premium'/'equilibrium'.
  const ONE_H = 60 * 60 * 1000;
  const FIVE_M = 5 * 60 * 1000;
  const eventCloseMs = 419 * ONE_H; // bar 418 closes at (418+1)*ONE_H

  // Bearish sweep recipe (matches SELL): flat baseline then one candle that
  // wicks above the recent 20-bar 5m high and closes back below it, bearish
  // (close < open) — deterministic bearishSweep=true, with `closeAt` free to
  // choose since only classifyZone against the FIXED 1h leg decides the
  // outcome here, not the 5m window itself.
  function bearishSweepCandles5m(baseline, closeAt) {
    const candles = [];
    for (let i = 0; i < 60; i++) {
      const t = eventCloseMs - (60 - i) * FIVE_M;
      candles.push({ open: baseline, high: baseline + 5, low: baseline - 5, close: baseline, openTime: t - FIVE_M, closeTime: t, isClosed: true });
    }
    const t = eventCloseMs;
    candles.push({ open: baseline + 4, high: baseline + 7, low: closeAt - 0.5, close: closeAt, openTime: t - FIVE_M, closeTime: t, isClosed: true });
    return candles;
  }

  async function runWithCandles5m(candles5m) {
    getPineConfig.mockResolvedValue(basePineConfig());
    const store = new Map([[`TESTUSDT:1h`, goldenCandles(800)], [`TESTUSDT:5m`, candles5m]]);
    fetchCandles.mockImplementation(async (sym, tf, limit) =>
      sliceClosedAsOf(store.get(`${sym}:${tf}`) || [], simNow(), limit));
    const backend = createFakeBackend();
    Object.assign(entitiesModule.backend, backend);

    const asset = makeAsset({
      symbol: 'TESTUSDT',
      smc_enabled: true,
      timeframes_enabled: { '1h': true, '4h': false, '1d': false },
    });

    return runBacktest({
      assets: [asset], backend,
      fromMs: 418 * ONE_H, toMs: 420 * ONE_H,
      stepMs: FIVE_M,
    });
  }

  it('counts a real 5m OTE zone rejection through the full backtest pipeline (close in discount)', async () => {
    // Baseline ~100, sweep candle closes at 103.5 — comfortably below
    // eqBtm≈129.201, so 'discount': rejected for the SELL signal.
    const report = await runWithCandles5m(bearishSweepCandles5m(100, 103.5));

    expect(report.smcDiagnostics.confirmedSignals).toBe(1);
    expect(report.smcDiagnostics.rejectedByOteZone).toBe(1);
    expect(report.smcDiagnostics.tradeOpsCreated).toBe(0);
  });

  it('confirms and creates a TradeOperation when the 5m entry lands in a favorable zone (premium)', async () => {
    // Baseline ~140, sweep candle closes at 138 — above eqTop≈136.037, so
    // 'premium': favorable for SELL (only 'discount' is rejected).
    const report = await runWithCandles5m(bearishSweepCandles5m(140, 138));

    expect(report.smcDiagnostics.confirmedSignals).toBe(1);
    expect(report.smcDiagnostics.rejectedByOteZone).toBe(0);
    expect(report.smcDiagnostics.tradeOpsCreated).toBe(1);
  });
});
