// Espelho browser do regression test em scripts/adminEntities.test.js — mesmo
// incidente real (docs/known-risks.md item 138 addendum): uma falha de
// escrita não crítica em SystemLog.create()/createUnique() (observado:
// ALREADY_EXISTS espúrio num ID auto-gerado) não pode mais abortar
// persistScanResults inteiro. Ver aquele arquivo para o relato completo do
// incidente.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  addDocMock, runTransactionMock, getDocsMock, whereMock,
  rtdbSetMock, rtdbUpdateMock, rtdbRemoveMock,
} = vi.hoisted(() => ({
  addDocMock: vi.fn(),
  runTransactionMock: vi.fn(),
  getDocsMock: vi.fn(),
  whereMock: vi.fn((field, op, operand) => ({ field, op, operand })),
  rtdbSetMock: vi.fn(),
  rtdbUpdateMock: vi.fn(),
  rtdbRemoveMock: vi.fn(),
}));

// rtdb: {} (truthy) so the mirror wrappers actually attempt calls — the
// `rtdb === null` no-op guard itself is covered by
// entitiesRtdbTripwire.test.js (reads the source directly).
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, functions: {}, rtdb: {} }));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(),
  getDocs: getDocsMock,
  addDoc: addDocMock,
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  query: vi.fn((...args) => args),
  where: whereMock,
  orderBy: vi.fn(),
  limit: vi.fn(),
  writeBatch: vi.fn(),
  runTransaction: runTransactionMock,
}));

vi.mock('firebase/database', () => ({
  ref: vi.fn((db, path) => ({ path })),
  set: rtdbSetMock,
  update: rtdbUpdateMock,
  remove: rtdbRemoveMock,
}));

vi.mock('@/api/agents', () => ({ strategyReviewerAgent: {} }));

beforeEach(() => {
  vi.resetModules();
  addDocMock.mockReset();
  runTransactionMock.mockReset();
  getDocsMock.mockReset();
  getDocsMock.mockResolvedValue({ docs: [] });
  whereMock.mockClear();
  rtdbSetMock.mockReset();
  rtdbSetMock.mockResolvedValue(undefined);
  rtdbUpdateMock.mockReset();
  rtdbUpdateMock.mockResolvedValue(undefined);
  rtdbRemoveMock.mockReset();
  rtdbRemoveMock.mockResolvedValue(undefined);
});

// docs/known-risks.md item 152 — comportamento do mirror Firestore→RTDB.
// Estrutura já verificada pelo tripwire (entitiesRtdbTripwire.test.js); aqui
// é o comportamento real com as primitivas mockadas.
describe('entities.js — mirror Firestore→RTDB (item 152)', () => {
  it('AssetState.create() espelha o doc criado (com id) na chave sanitizada', async () => {
    addDocMock.mockResolvedValue({ id: 'BTCUSDT::4h' });
    const { backend } = await import('./entities.js');
    const created = await backend.entities.AssetState.create({ asset_id: 'BTCUSDT', timeframe: '4h' });
    expect(created).toEqual(expect.objectContaining({ id: 'BTCUSDT::4h', asset_id: 'BTCUSDT' }));
    expect(rtdbSetMock).toHaveBeenCalledTimes(1);
    const [, value] = rtdbSetMock.mock.calls[0];
    expect(value).toEqual(created);
  });

  it('TradeOperation.update() espelha só o patch na chave sanitizada (dedup_key com timestamp ISO)', async () => {
    const { backend } = await import('./entities.js');
    const id = 'trade_BTCUSDT_4h_BUY_raw_2026-09-03T12:00:00.000Z';
    await backend.entities.TradeOperation.update(id, { status: 'CLOSED' });
    expect(rtdbUpdateMock).toHaveBeenCalledTimes(1);
    const [ref, patch] = rtdbUpdateMock.mock.calls[0];
    const sanitizedKey = ref.path.slice('tradeOperations/'.length);
    expect(sanitizedKey).not.toMatch(/[.#$/[\]]/);
    expect(patch).toEqual({ status: 'CLOSED' });
  });

  it('SignalEvent.create() (fora do escopo desta rodada) nunca toca o RTDB', async () => {
    addDocMock.mockResolvedValue({ id: 'sig1' });
    const { backend } = await import('./entities.js');
    await backend.entities.SignalEvent.create({ symbol: 'BTCUSDT' });
    expect(rtdbSetMock).not.toHaveBeenCalled();
  });

  it('createTradeOpIfNoneActive espelha o doc criado quando created === true', async () => {
    runTransactionMock.mockImplementation(async (db, cb) => cb({
      get: vi.fn().mockResolvedValue({ exists: () => false, data: () => ({}) }),
      set: vi.fn(),
    }));
    const { backend } = await import('./entities.js');
    await backend.tradeOps.createTradeOpIfNoneActive('BTCUSDT', 'trade_x', { symbol: 'BTCUSDT' });
    expect(rtdbSetMock).toHaveBeenCalledTimes(1);
  });

  it('createTradeOpIfNoneActive NÃO espelha quando bloqueado (created === false)', async () => {
    runTransactionMock.mockImplementation(async (db, cb) => cb({
      get: vi.fn().mockResolvedValue({ exists: () => true, data: () => ({ active_trade_op_id: 'trade_other', status: 'RUNNER_ACTIVE' }) }),
      set: vi.fn(),
    }));
    const { backend } = await import('./entities.js');
    await backend.tradeOps.createTradeOpIfNoneActive('BTCUSDT', 'trade_x', { symbol: 'BTCUSDT' });
    expect(rtdbSetMock).not.toHaveBeenCalled();
  });

  it('uma falha do RTDB (mockada) nunca impede a operação real de resolver — a promise rejeitada é engolida pelo .catch próprio', async () => {
    rtdbSetMock.mockRejectedValue(new Error('RTDB indisponível'));
    addDocMock.mockResolvedValue({ id: 'x1' });
    const { backend } = await import('./entities.js');
    await expect(backend.entities.AssetState.create({ asset_id: 'BTCUSDT', timeframe: '4h' }))
      .resolves.toEqual(expect.objectContaining({ id: 'x1' }));
  });
});

describe('entities.js — SystemLog nunca propaga falha de escrita (item 138 addendum)', () => {
  it('create() engole ALREADY_EXISTS espúrio e devolve fallback em vez de lançar', async () => {
    addDocMock.mockRejectedValue(new Error(
      'Document already exists: projects/sentinel-signals/databases/(default)/documents/systemLogs/YBu5xHyWfnzuNBMUQjDh'
    ));
    const { backend } = await import('./entities.js');
    await expect(
      backend.entities.SystemLog.create({ level: 'info', module: 'scanner', message: 'x' })
    ).resolves.toEqual(expect.objectContaining({ id: null, level: 'info' }));
  });

  it('createUnique() engole falha de transação e devolve { created: false } em vez de lançar', async () => {
    runTransactionMock.mockRejectedValue(new Error('ABORTED: contention'));
    const { backend } = await import('./entities.js');
    await expect(
      backend.entities.SystemLog.createUnique('dedup-key', { level: 'error', message: 'x' })
    ).resolves.toEqual({ created: false, existing: null });
  });

  it('não afeta outras entidades — TradeOperation.create() continua propagando erro real', async () => {
    addDocMock.mockRejectedValue(new Error('PERMISSION_DENIED'));
    const { backend } = await import('./entities.js');
    await expect(
      backend.entities.TradeOperation.create({ symbol: 'BTCUSDT' })
    ).rejects.toThrow('PERMISSION_DENIED');
  });
});

// docs/known-risks.md item 141/143: classifyFilter (src/lib/queryFilters.js)
// só descreve a SEMÂNTICA pretendida — a tradução real para where() nativo
// vive aqui, duplicada à mão nos 3 backends (entities.js/adminEntities.js/
// adminEntitiesShadow.js). Um bug de tradução (ex.: só aplicar a 1a
// constraint de um range de 2) derrotaria o fix do item 141 (MonthlyReport
// truncando meses antigos) silenciosamente, com CI verde — só
// classifyFilter/matchesFilter (a função pura) eram testados até agora, não
// a chamada onde() de verdade.
describe('entities.js — filter() traduz range para where() nativo (item 143)', () => {
  it('{ gte } vira uma única constraint where(field, ">=", operand)', async () => {
    const { backend } = await import('./entities.js');
    await backend.entities.TradeOperation.filter({ created_date: { gte: '2026-10-01T00:00:00.000Z' } });
    const calls = whereMock.mock.calls.filter(([field]) => field === 'created_date');
    expect(calls).toEqual([['created_date', '>=', '2026-10-01T00:00:00.000Z']]);
  });

  it('{ gte, lt } vira DUAS constraints where() no mesmo campo — intervalo [a, b)', async () => {
    const { backend } = await import('./entities.js');
    await backend.entities.TradeOperation.filter({
      created_date: { gte: '2026-10-01T00:00:00.000Z', lt: '2026-11-01T00:00:00.000Z' },
    });
    const calls = whereMock.mock.calls.filter(([field]) => field === 'created_date');
    expect(calls).toEqual(
      expect.arrayContaining([
        ['created_date', '>=', '2026-10-01T00:00:00.000Z'],
        ['created_date', '<', '2026-11-01T00:00:00.000Z'],
      ]),
    );
    expect(calls).toHaveLength(2);
  });

  it('igualdade simples continua where(field, "==", valor) — não regride', async () => {
    const { backend } = await import('./entities.js');
    await backend.entities.TradeOperation.filter({ status: 'RUNNER_ACTIVE' });
    expect(whereMock).toHaveBeenCalledWith('status', '==', 'RUNNER_ACTIVE');
  });
});
