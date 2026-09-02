// Espelho browser do regression test em scripts/adminEntities.test.js — mesmo
// incidente real (docs/known-risks.md item 138 addendum): uma falha de
// escrita não crítica em SystemLog.create()/createUnique() (observado:
// ALREADY_EXISTS espúrio num ID auto-gerado) não pode mais abortar
// persistScanResults inteiro. Ver aquele arquivo para o relato completo do
// incidente.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { addDocMock, runTransactionMock, getDocsMock, whereMock } = vi.hoisted(() => ({
  addDocMock: vi.fn(),
  runTransactionMock: vi.fn(),
  getDocsMock: vi.fn(),
  whereMock: vi.fn((field, op, operand) => ({ field, op, operand })),
}));

vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, functions: {} }));

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

vi.mock('@/api/agents', () => ({ strategyReviewerAgent: {} }));

beforeEach(() => {
  vi.resetModules();
  addDocMock.mockReset();
  runTransactionMock.mockReset();
  getDocsMock.mockReset();
  getDocsMock.mockResolvedValue({ docs: [] });
  whereMock.mockClear();
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
