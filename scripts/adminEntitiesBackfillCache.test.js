// Comportamento do wrapper de cache do backfill (docs/known-risks.md item
// 137 addendum, 2026-08-31): AssetState/MonitoredAsset nunca tocam o
// Firestore real durante um replay — só as outras entidades (TradeOperation
// incluída) continuam passando direto pro backend real. Ver o header de
// adminEntitiesBackfillCache.js para o relato completo do incidente que
// motivou isto, e adminEntitiesBackfillCacheTripwire.test.js para a garantia
// estrutural equivalente lendo o texto-fonte.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  assetStateFilterMock, assetStateCreateMock, assetStateUpdateMock,
  monitoredAssetUpdateMock, monitoredAssetFilterMock, tradeOperationCreateMock,
} = vi.hoisted(() => ({
  assetStateFilterMock: vi.fn(),
  assetStateCreateMock: vi.fn(),
  assetStateUpdateMock: vi.fn(),
  monitoredAssetUpdateMock: vi.fn(),
  monitoredAssetFilterMock: vi.fn(),
  tradeOperationCreateMock: vi.fn(),
}));

vi.mock('./adminEntities.js', () => ({
  backend: {
    entities: {
      AssetState: {
        list: vi.fn(), filter: assetStateFilterMock, create: assetStateCreateMock,
        createUnique: vi.fn(), update: assetStateUpdateMock, delete: vi.fn(),
        bulkCreate: vi.fn(), deleteMany: vi.fn(),
      },
      MonitoredAsset: {
        list: vi.fn(), filter: monitoredAssetFilterMock, create: vi.fn(),
        createUnique: vi.fn(), update: monitoredAssetUpdateMock, delete: vi.fn(),
        bulkCreate: vi.fn(), deleteMany: vi.fn(),
      },
      TradeOperation: { create: tradeOperationCreateMock },
    },
    locks: {},
    tradeOps: {},
  },
  getAndResetOpCounts: vi.fn(() => ({ reads: 0, writes: 0 })),
}));

beforeEach(() => {
  vi.resetModules();
  assetStateFilterMock.mockReset();
  assetStateCreateMock.mockReset();
  assetStateUpdateMock.mockReset();
  monitoredAssetUpdateMock.mockReset();
  monitoredAssetFilterMock.mockReset();
  tradeOperationCreateMock.mockReset();
});

describe('adminEntitiesBackfillCache.js', () => {
  it('AssetState.filter serve a mesma chave asset_id/timeframe do cache — só 1 leitura real', async () => {
    assetStateFilterMock.mockResolvedValue([{ id: 'doc1', asset_id: 'a1', timeframe: '4h', last_close: 1 }]);
    const { backend } = await import('./adminEntitiesBackfillCache.js');
    const r1 = await backend.entities.AssetState.filter({ asset_id: 'a1', timeframe: '4h' });
    const r2 = await backend.entities.AssetState.filter({ asset_id: 'a1', timeframe: '4h' });
    expect(assetStateFilterMock).toHaveBeenCalledTimes(1);
    expect(r2).toBe(r1);
  });

  it('AssetState.update nunca chama o real update — fica só em memória, mas o próximo filter vê o valor novo', async () => {
    assetStateFilterMock.mockResolvedValue([{ id: 'doc1', asset_id: 'a1', timeframe: '4h', last_close: 1 }]);
    const { backend } = await import('./adminEntitiesBackfillCache.js');
    await backend.entities.AssetState.filter({ asset_id: 'a1', timeframe: '4h' });
    await backend.entities.AssetState.update('doc1', { last_close: 2 });
    expect(assetStateUpdateMock).not.toHaveBeenCalled();
    const [after] = await backend.entities.AssetState.filter({ asset_id: 'a1', timeframe: '4h' });
    expect(after.last_close).toBe(2);
  });

  it('AssetState.create nunca chama o real create — próxima filter da mesma chave já vê o doc cacheado', async () => {
    assetStateFilterMock.mockResolvedValue([]);
    const { backend } = await import('./adminEntitiesBackfillCache.js');
    expect(await backend.entities.AssetState.filter({ asset_id: 'a2', timeframe: '1h' })).toEqual([]);
    const created = await backend.entities.AssetState.create({ asset_id: 'a2', timeframe: '1h', last_close: 5 });
    expect(assetStateCreateMock).not.toHaveBeenCalled();
    expect(created).toMatchObject({ asset_id: 'a2', timeframe: '1h', last_close: 5 });
    const [after] = await backend.entities.AssetState.filter({ asset_id: 'a2', timeframe: '1h' });
    expect(after.last_close).toBe(5);
  });

  it('AssetState.filter com formato diferente de {asset_id, timeframe} passa direto pro real (sem cache)', async () => {
    assetStateFilterMock.mockResolvedValue([{ id: 'x' }]);
    const { backend } = await import('./adminEntitiesBackfillCache.js');
    await backend.entities.AssetState.filter({ symbol: 'BTCUSDT' });
    await backend.entities.AssetState.filter({ symbol: 'BTCUSDT' });
    expect(assetStateFilterMock).toHaveBeenCalledTimes(2);
  });

  it('MonitoredAsset.update nunca chama o real update — retorna o mesmo formato do adaptador real', async () => {
    const { backend } = await import('./adminEntitiesBackfillCache.js');
    const result = await backend.entities.MonitoredAsset.update('m1', { scan_status: 'success' });
    expect(monitoredAssetUpdateMock).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'm1', scan_status: 'success' });
  });

  it('MonitoredAsset.filter continua real — leitura de config/estado ativo tem que refletir produção', async () => {
    monitoredAssetFilterMock.mockResolvedValue([{ id: 'm1', symbol: 'BTCUSDT' }]);
    const { backend } = await import('./adminEntitiesBackfillCache.js');
    const result = await backend.entities.MonitoredAsset.filter({ is_active: true });
    expect(monitoredAssetFilterMock).toHaveBeenCalledWith({ is_active: true });
    expect(result[0].symbol).toBe('BTCUSDT');
  });

  it('TradeOperation.create passa direto pro backend real — uma op retroativa é uma op real', async () => {
    tradeOperationCreateMock.mockResolvedValue({ id: 'op1' });
    const { backend } = await import('./adminEntitiesBackfillCache.js');
    const result = await backend.entities.TradeOperation.create({ symbol: 'ETHUSDT' });
    expect(tradeOperationCreateMock).toHaveBeenCalledWith({ symbol: 'ETHUSDT' });
    expect(result).toEqual({ id: 'op1' });
  });
});
