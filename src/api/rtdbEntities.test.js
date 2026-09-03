import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getMock, queryMock, refMock, orderByChildMock, limitToLastMock, startAtMock, endBeforeMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  queryMock: vi.fn((...args) => ({ __query: args })),
  refMock: vi.fn((db, path) => ({ path })),
  orderByChildMock: vi.fn((field) => ({ __orderByChild: field })),
  limitToLastMock: vi.fn((n) => ({ __limitToLast: n })),
  startAtMock: vi.fn((v) => ({ __startAt: v })),
  endBeforeMock: vi.fn((v) => ({ __endBefore: v })),
}));

vi.mock('@/lib/firebaseClient', () => ({ rtdb: {} }));

vi.mock('firebase/database', () => ({
  ref: refMock,
  get: getMock,
  query: queryMock,
  orderByChild: orderByChildMock,
  limitToLast: limitToLastMock,
  startAt: startAtMock,
  endBefore: endBeforeMock,
}));

const fallbackListMock = vi.fn();
const fallbackFilterMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      AssetState: { list: fallbackListMock, filter: fallbackFilterMock },
      TradeOperation: { list: fallbackListMock, filter: fallbackFilterMock },
    },
  },
}));

function snapshotOf(valueByKey) {
  return { val: () => valueByKey };
}

beforeEach(() => {
  vi.resetModules();
  getMock.mockReset();
  queryMock.mockClear();
  refMock.mockClear();
  orderByChildMock.mockClear();
  limitToLastMock.mockClear();
  startAtMock.mockClear();
  endBeforeMock.mockClear();
  fallbackListMock.mockReset();
  fallbackFilterMock.mockReset();
  // Re-assert the default (rtdb truthy) on every test — vi.doMock from the
  // "sem rtdb" test below would otherwise leak rtdb:null past resetModules()
  // into every later test in this file.
  vi.doMock('@/lib/firebaseClient', () => ({ rtdb: {} }));
});

describe('rtdbEntities — list()', () => {
  it('sem sort/limit lê a árvore inteira sem query (AssetState.list())', async () => {
    getMock.mockResolvedValue(snapshotOf({ k1: { id: 'k1', asset_id: 'BTCUSDT' }, k2: { id: 'k2', asset_id: 'ETHUSDT' } }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.AssetState.list();
    expect(refMock).toHaveBeenCalledWith({}, 'assetStates');
    expect(queryMock).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(fallbackListMock).not.toHaveBeenCalled();
  });

  it('nó vazio devolve array vazio, nunca undefined/null', async () => {
    getMock.mockResolvedValue(snapshotOf(null));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await expect(rtdbEntities.AssetState.list()).resolves.toEqual([]);
  });

  it('"-created_date", N vira orderByChild+limitToLast, com reverse pra reconstruir desc', async () => {
    getMock.mockResolvedValue(snapshotOf({
      a: { id: 'a', created_date: '2026-01-01T00:00:00.000Z' },
      b: { id: 'b', created_date: '2026-01-02T00:00:00.000Z' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.TradeOperation.list('-created_date', 100);
    expect(orderByChildMock).toHaveBeenCalledWith('created_date');
    expect(limitToLastMock).toHaveBeenCalledWith(100);
    // RTDB só ordena ASC — limitToLast(N) devolve os N últimos em ordem ASC
    // (a, b); reverse() reconstrói -created_date (b, a).
    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('sort ascendente (sem "-") não inverte o resultado', async () => {
    getMock.mockResolvedValue(snapshotOf({
      a: { id: 'a', created_date: '2026-01-01T00:00:00.000Z' },
      b: { id: 'b', created_date: '2026-01-02T00:00:00.000Z' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.TradeOperation.list('created_date', 100);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('sem rtdb provisionado (null), cai no fallback Firestore', async () => {
    vi.doMock('@/lib/firebaseClient', () => ({ rtdb: null }));
    fallbackListMock.mockResolvedValue([{ id: 'x' }]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.AssetState.list('-created_date', 50);
    expect(result).toEqual([{ id: 'x' }]);
    expect(fallbackListMock).toHaveBeenCalledWith('-created_date', 50);
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('rtdbEntities — filter()', () => {
  it('filtro vazio delega pra list()', async () => {
    getMock.mockResolvedValue(snapshotOf({ a: { id: 'a' } }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.AssetState.filter({});
    expect(result).toEqual([{ id: 'a' }]);
    expect(fallbackFilterMock).not.toHaveBeenCalled();
  });

  it('range de um único campo ({ gte, lt }) vira orderByChild+startAt+endBefore, endBefore exclusivo', async () => {
    getMock.mockResolvedValue(snapshotOf({
      a: { id: 'a', created_date: '2026-10-01T00:00:00.000Z' },
      b: { id: 'b', created_date: '2026-10-15T00:00:00.000Z' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.TradeOperation.filter({
      created_date: { gte: '2026-10-01T00:00:00.000Z', lt: '2026-11-01T00:00:00.000Z' },
    }, '-created_date');
    expect(orderByChildMock).toHaveBeenCalledWith('created_date');
    expect(startAtMock).toHaveBeenCalledWith('2026-10-01T00:00:00.000Z');
    expect(endBeforeMock).toHaveBeenCalledWith('2026-11-01T00:00:00.000Z');
    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
    expect(fallbackFilterMock).not.toHaveBeenCalled();
  });

  it('só gte (sem lt) ainda funciona — startAt sem endBefore', async () => {
    getMock.mockResolvedValue(snapshotOf({ a: { id: 'a' } }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await rtdbEntities.TradeOperation.filter({ created_date: { gte: '2026-10-01T00:00:00.000Z' } });
    expect(startAtMock).toHaveBeenCalledWith('2026-10-01T00:00:00.000Z');
    expect(endBeforeMock).not.toHaveBeenCalled();
  });

  it('filtro de igualdade simples (formato não reconhecido) cai no fallback Firestore, nunca lança', async () => {
    fallbackFilterMock.mockResolvedValue([{ id: 'x', status: 'RUNNER_ACTIVE' }]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.TradeOperation.filter({ status: 'RUNNER_ACTIVE' });
    expect(result).toEqual([{ id: 'x', status: 'RUNNER_ACTIVE' }]);
    expect(fallbackFilterMock).toHaveBeenCalledWith({ status: 'RUNNER_ACTIVE' }, undefined, undefined);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('filtro composto (2+ campos, ex. verificationTasks status+priority) cai no fallback Firestore', async () => {
    fallbackFilterMock.mockResolvedValue([]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await rtdbEntities.TradeOperation.filter({ status: 'pending', priority: 'high' });
    expect(fallbackFilterMock).toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('valor array (Firestore `in`) cai no fallback Firestore', async () => {
    fallbackFilterMock.mockResolvedValue([]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await rtdbEntities.TradeOperation.filter({ status: ['RUNNER_ACTIVE', 'SIGNAL_CONFIRMED'] });
    expect(fallbackFilterMock).toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });
});
