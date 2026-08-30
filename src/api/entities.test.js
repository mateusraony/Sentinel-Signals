// Espelho browser do regression test em scripts/adminEntities.test.js — mesmo
// incidente real (docs/known-risks.md item 138 addendum): uma falha de
// escrita não crítica em SystemLog.create()/createUnique() (observado:
// ALREADY_EXISTS espúrio num ID auto-gerado) não pode mais abortar
// persistScanResults inteiro. Ver aquele arquivo para o relato completo do
// incidente.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { addDocMock, runTransactionMock } = vi.hoisted(() => ({
  addDocMock: vi.fn(),
  runTransactionMock: vi.fn(),
}));

vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, functions: {} }));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  addDoc: addDocMock,
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
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
