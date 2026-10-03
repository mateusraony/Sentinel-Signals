// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeBackend } from './__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('./telegram', () => ({
  isTelegramConfigured: vi.fn(() => false),
  notifyAssetStale: vi.fn().mockResolvedValue(undefined),
  notifyLockDegraded: vi.fn().mockResolvedValue(undefined),
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
  EXECUTOR: 'browser',
}));
// getPineConfig roda ANTES do try/catch por-timeframe dentro de scanAsset
// (scanner.js:1317) — é o caminho mais simples pra forçar uma exceção
// escapar até o catch de scanAllAssetsInner sem precisar simular uma falha
// de rede real por timeframe (essas são engolidas e viram `errors.push`,
// nunca chegam lá).
vi.mock('./pineParser', () => ({
  getPineConfig: vi.fn(),
  getPineConfigStatus: vi.fn(() => ({ source: 'postgres', version: null, hash: null, degraded: false })),
}));

// item 255 — no NAVEGADOR o erro de scan grava também o estado da aba/rede
// (online/visibility) para decidir com dado entre as hipóteses do "Failed to
// fetch" (rede caída, aba em segundo plano, volta de suspensão). No cron o
// objeto fica de fora (scanErrorLogging.test.js cobre o formato do cron).
import * as entitiesModule from '@/api/entities';
import { getPineConfig } from './pineParser';
import { scanAllAssets } from './scanner.js';

let backend;
beforeEach(() => {
  backend = createFakeBackend();
  Object.assign(entitiesModule.backend, backend);
  vi.clearAllMocks();
});

describe('scanAllAssets (navegador) — erro de scan grava online/visibility', () => {
  it('details inclui online e visibility do momento do erro', async () => {
    backend._seed('MonitoredAsset', { id: 'a1', symbol: 'ARBUSDT', is_active: true, scan_status: 'ok' });
    getPineConfig.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    try {
      await scanAllAssets();
    } finally {
      vi.unstubAllGlobals();
    }

    const logs = await backend.entities.SystemLog.list('-created_date', 10);
    const entry = logs.find((l) => l.symbol === 'ARBUSDT');
    expect(entry.executor).toBe('browser');
    expect(entry.details.online).toBe(false);
    expect(entry.details.visibility).toBe('hidden');
    expect(entry.details.error_class).toBe('NETWORK');
  });
});
