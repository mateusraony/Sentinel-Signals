// docs/known-risks.md item 57 addendum (2026-09-22/23) — o SystemLog gravado
// pelo catch de scanAllAssetsInner (scanner.js) só guardava err.message,
// descartando err.name/err.cause e nunca gravando EXECUTOR (cron vs
// navegador) — hoje impossível saber pelo log qual dos dois produziu um
// "Failed to fetch". Este teste prova que a próxima ocorrência já vem com
// esse detalhe, sem mudar dedupKey/gate/transição de estado nenhuma.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeBackend } from './__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('./telegram', () => ({
  isTelegramConfigured: vi.fn(() => false),
  notifyAssetStale: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock('./marketDataProvider', () => ({
  fetchCandles: vi.fn(),
  fetchCurrentPrice: vi.fn(),
  MARKET_SOURCE: 'spot',
  DATA_EXCHANGE: 'binance',
  EXECUTOR: 'cron',
}));
// getPineConfig roda ANTES do try/catch por-timeframe dentro de scanAsset
// (scanner.js:1317) — é o caminho mais simples pra forçar uma exceção
// escapar até o catch de scanAllAssetsInner sem precisar simular uma falha
// de rede real por timeframe (essas são engolidas e viram `errors.push`,
// nunca chegam lá).
vi.mock('./pineParser', () => ({
  getPineConfig: vi.fn(),
}));

import * as entitiesModule from '@/api/entities';
import { getPineConfig } from './pineParser';
import { scanAllAssets } from './scanner.js';

let backend;
beforeEach(() => {
  backend = createFakeBackend();
  Object.assign(entitiesModule.backend, backend);
  vi.clearAllMocks();
});

describe('scanAllAssets — SystemLog de erro grava executor + detalhe do erro (item 57 addendum)', () => {
  it('erro com name/cause conhecidos: SystemLog grava executor, error_name e error_cause', async () => {
    backend._seed('MonitoredAsset', {
      id: 'asset_1',
      symbol: 'ZROUSDT',
      is_active: true,
      scan_status: 'ok',
    });
    const cause = { code: 'ECONNRESET', errno: -104, syscall: 'read' };
    getPineConfig.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause }));

    await scanAllAssets();

    const logs = await backend.entities.SystemLog.list('-created_date', 10);
    const entry = logs.find((l) => l.module === 'scanner' && l.symbol === 'ZROUSDT');
    expect(entry).toBeDefined();
    expect(entry.message).toBe('Erro no scan de ZROUSDT: fetch failed');
    expect(entry.executor).toBe('cron');
    expect(entry.details.error_name).toBe('TypeError');
    expect(entry.details.error_cause).toEqual({
      message: null,
      code: 'ECONNRESET',
      errno: -104,
      syscall: 'read',
    });
  });

  it('erro sem cause (ex. mensagem simples de browser): error_cause fica null, sem quebrar', async () => {
    backend._seed('MonitoredAsset', {
      id: 'asset_2',
      symbol: 'FETUSDT',
      is_active: true,
      scan_status: 'ok',
    });
    getPineConfig.mockRejectedValue(new TypeError('Failed to fetch'));

    await scanAllAssets();

    const logs = await backend.entities.SystemLog.list('-created_date', 10);
    const entry = logs.find((l) => l.module === 'scanner' && l.symbol === 'FETUSDT');
    expect(entry).toBeDefined();
    expect(entry.message).toBe('Erro no scan de FETUSDT: Failed to fetch');
    expect(entry.executor).toBe('cron');
    expect(entry.details.error_name).toBe('TypeError');
    expect(entry.details.error_cause).toBeNull();
  });

  it('dedupKey continua chaveado só por err.message (contrato do item 39.1 intocado)', async () => {
    backend._seed('MonitoredAsset', {
      id: 'asset_3',
      symbol: 'BTCUSDT',
      is_active: true,
      scan_status: 'ok',
    });
    getPineConfig.mockRejectedValue(new TypeError('Failed to fetch'));

    await scanAllAssets();
    const today = new Date().toISOString().slice(0, 10);
    const dedupKey = `scan_error::asset_3::${today}::Failed to fetch`;
    expect(backend._get('SystemLog', dedupKey)).toBeDefined();
  });
});
