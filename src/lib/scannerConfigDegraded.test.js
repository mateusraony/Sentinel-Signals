// CONFIG_DEGRADED (docs/known-risks.md) — quando getPineConfigStatus()
// (src/lib/pineParser.js) reporta degraded:true (StrategyConfig não
// confirmado no Postgres/Neon E sem cache de uma leitura anterior),
// persistScanResults deve suspender a criação de operação NOVA, mas nunca
// a detecção de sinal/AssetState nem o price-check de operações já abertas
// (essas usam o config CONGELADO na própria operação, não pineConfig ao
// vivo — ver .claude/rules/trading-engine.md).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeBackend } from './__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('./telegram', () => ({
  isTelegramConfigured: vi.fn(() => false),
  notifyNewSignal: vi.fn().mockResolvedValue(undefined),
  notifyVerificationTask: vi.fn().mockResolvedValue(undefined),
  notifyTradeCreated: vi.fn().mockResolvedValue(undefined),
  notifyLockDegraded: vi.fn().mockResolvedValue(undefined),
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
import { logWarn } from './logger';
import { persistScanResults } from './scanner.js';

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
    candleCount: 150,
    ...overrides,
  };
}

// skip15mConfirmationEnabled:true abre a operação na 1a passada sem buscar
// candle de 15m — isola este teste do mecanismo de confirmação/retry,
// irrelevante aqui (o que importa é só CONFIG_DEGRADED).
function makePineConfig(overrides = {}) {
  return {
    tp1R: 1.5, tp1QtyPercent: 50, trailAtrMult: 2.0,
    useTimeStop: true, useChopExit: false, useInvalidation: false, invalidRFBars: 2,
    useADX: false, useChop: false, skip15mConfirmationEnabled: true,
    ...overrides,
  };
}

function makeRfSignal(overrides = {}) {
  return {
    symbol: 'BTCUSDT', asset_id: 'asset1', signal_type: 'BUY',
    timeframe: '4h', source: 'range_filter', dedup_key: 'sig_1',
    price_at_signal: 100, candle_time: '2026-07-16T08:00:00.000Z',
    context: { score: 80 },
    ...overrides,
  };
}

function makeScanResult({ asset = makeAsset(), results, pineConfig = makePineConfig(), pineConfigStatus } = {}) {
  return { asset, results, alignment: {}, newSignals: [], errors: [], duration: 10, pineConfig, pineConfigStatus };
}

describe('CONFIG_DEGRADED — suspende só a criação de operação nova', () => {
  it('pineConfigStatus ausente (compat retroativa): comportamento normal, cria operação', async () => {
    const results = { '4h': makeTfData() };
    await persistScanResults({ ...makeScanResult({ results }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
  });

  it('degraded:false (source postgres/cache): comportamento normal, cria operação', async () => {
    const results = { '4h': makeTfData() };
    const pineConfigStatus = { source: 'cache', version: 12, hash: 'abc', degraded: false };
    await persistScanResults({ ...makeScanResult({ results, pineConfigStatus }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1);
  });

  it('degraded:true — NÃO cria operação nova, mas AssetState é persistido normalmente', async () => {
    const results = { '4h': makeTfData() };
    const pineConfigStatus = { source: 'defaults', version: null, hash: null, degraded: true };
    await persistScanResults({ ...makeScanResult({ results, pineConfigStatus }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(0);

    const states = await backend.entities.AssetState.filter({ asset_id: 'asset1' });
    expect(states.length).toBeGreaterThan(0); // detecção/estado continua normal

    expect(logWarn).toHaveBeenCalledWith(
      'scanner',
      expect.stringContaining('StrategyConfig não confirmado'),
      expect.objectContaining({ source: 'defaults' }),
      expect.objectContaining({ symbol: 'BTCUSDT' })
    );
  });

  it('degraded:true com uma operação JÁ ATIVA: price-check (loop separado) não é afetado — aqui só confirma que persistScanResults não tenta abrir uma 2a', async () => {
    backend._seed('TradeOperation', {
      id: 'op_existente', asset_id: 'asset1', symbol: 'BTCUSDT', side: 'BUY',
      status: 'SIGNAL_CONFIRMED', entry_price: 90, initial_stop: 85, current_stop: 85,
      tp1: 95, tp2: 100, cascade: '4h_15m',
    });
    const results = { '4h': makeTfData() };
    const pineConfigStatus = { source: 'defaults', version: null, hash: null, degraded: true };
    await persistScanResults({ ...makeScanResult({ results, pineConfigStatus }), newSignals: [makeRfSignal()] });

    const ops = await backend.entities.TradeOperation.filter({});
    expect(ops).toHaveLength(1); // só a pré-existente — nenhuma nova
    expect(ops[0].id).toBe('op_existente');
  });
});
