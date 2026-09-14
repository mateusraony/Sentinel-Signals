// Gate assimétrico Spot×Futures — lado CRON (pedido explícito do usuário,
// 2026-09-14 — docs/known-risks.md item 4/39). Arquivo próprio porque o mock
// de ./marketDataProvider é estático por arquivo (não dá pra mutar
// EXECUTOR/MARKET_SOURCE em runtime dentro de scannerStateMachine.test.js,
// que já mocka EXECUTOR:'browser'/MARKET_SOURCE:'futures' pro lado
// navegador). Prova a metade "cron NUNCA pula" do gate
// (shouldSkipCrossSourceManagement, opTransition.js) contra as funções REAIS
// do scanner — mesmo padrão de scannerStateMachine.test.js, backend fake em
// memória, sem reimplementar as regras.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeBackend } from './__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('./telegram', () => ({
  isTelegramConfigured: vi.fn(() => false),
  notifyNewSignal: vi.fn().mockResolvedValue(undefined),
  notifyVerificationTask: vi.fn().mockResolvedValue(undefined),
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
// A diferença que importa: lado cron real (scripts/adminMarketDataProvider.js).
vi.mock('./marketDataProvider', () => ({
  fetchCandles: vi.fn(),
  fetchCurrentPrice: vi.fn(),
  MARKET_SOURCE: 'spot',
  DATA_EXCHANGE: 'binance',
  EXECUTOR: 'cron',
}));

import * as entitiesModule from '@/api/entities';
import { fetchCurrentPrice } from './marketDataProvider';
import { persistScanResults, priceCheckActiveOps } from './scanner.js';

let backend;
beforeEach(() => {
  backend = createFakeBackend();
  Object.assign(entitiesModule.backend, backend);
  vi.clearAllMocks();
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
    ...overrides,
  };
}

function makePineConfig(overrides = {}) {
  return {
    minScore: 60, minAlignedTFs: 2, tp1R: 1.5, tp2R: 3.0, minRR: 1.2,
    exitMode: 'HYBRID_RF_ATR', runnerEnabled: true, ...overrides,
  };
}

function makeOp(overrides = {}) {
  return {
    id: 'op1', asset_id: 'asset1', symbol: 'BTCUSDT', side: 'BUY', status: 'SIGNAL_CONFIRMED',
    entry_price: 100, initial_stop: 98, current_stop: 98, tp1: 103, tp2: 106,
    tp1_hit: false, tp2_hit: false, signal_timeframe: '4h', cascade: '4h_15m',
    exit_mode: 'HYBRID_RF_ATR', candle_close_time: '2026-07-16T08:00:00.000Z',
    rf_reverse_bars_count: 0, rf_reverse_last_candle: null,
    ...overrides,
  };
}

function makeScanResult({ asset = makeAsset(), results, pineConfig = makePineConfig() } = {}) {
  return { asset, results, alignment: {}, newSignals: [], errors: [], duration: 10, pineConfig };
}

describe('gate assimétrico Spot×Futures — lado cron (EXECUTOR=cron/MARKET_SOURCE=spot)', () => {
  it('persistScanResults: cron NUNCA pula — gerencia normalmente uma op nascida no navegador (market_source=futures) e marca source_mismatch', async () => {
    backend._seed('TradeOperation', makeOp({ market_source: 'futures', executor: 'browser' }));
    const results = { '4h': makeTfData({ lastCandleLow: 97, lastCandleHigh: 99, lastClose: 98 }) }; // cruza o stop
    await persistScanResults(makeScanResult({ results }));
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('STOP_HIT'); // gerenciada normalmente, sem skip
    expect(op.source_mismatch).toBe(true);
    const logs = await backend.entities.SystemLog.filter({});
    expect(logs.find((l) => l.details?.reason === 'source_mismatch_skip')).toBeUndefined();
  });

  it('priceCheckActiveOps: cron NUNCA pula — gerencia normalmente uma op nascida no navegador (market_source=futures) via preço', async () => {
    backend._seed('TradeOperation', makeOp({ market_source: 'futures', executor: 'browser' }));
    vi.mocked(fetchCurrentPrice).mockResolvedValue(97); // cruza o stop
    await priceCheckActiveOps();
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('STOP_HIT');
    expect(op.source_mismatch).toBe(true);
  });

  it('persistScanResults: op com market_source=spot (bate com o cron) processa normalmente, sem source_mismatch', async () => {
    backend._seed('TradeOperation', makeOp({ market_source: 'spot', executor: 'cron' }));
    const results = { '4h': makeTfData({ lastCandleLow: 97, lastCandleHigh: 99, lastClose: 98 }) };
    await persistScanResults(makeScanResult({ results }));
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('STOP_HIT');
    expect(op.source_mismatch).toBeFalsy();
  });

  it('persistScanResults: op sem market_source (legada) processa normalmente, sem source_mismatch', async () => {
    backend._seed('TradeOperation', makeOp({ market_source: undefined, executor: undefined }));
    const results = { '4h': makeTfData({ lastCandleLow: 97, lastCandleHigh: 99, lastClose: 98 }) };
    await persistScanResults(makeScanResult({ results }));
    const op = backend._get('TradeOperation', 'op1');
    expect(op.status).toBe('STOP_HIT');
    expect(op.source_mismatch).toBeFalsy();
  });
});
