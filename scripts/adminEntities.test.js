// Regressão do incidente real (docs/known-risks.md item 138 addendum):
// ENAUSDT ficou ~7h com scan_status:'error' porque UMA escrita não crítica
// em SystemLog.create() (observado: ALREADY_EXISTS espúrio num ID auto-
// gerado, o padrão documentado de retentativa de gRPC após confirmação
// perdida) lançava, e como persistScanResults (scanner.js) não protege
// nenhuma dessas ~30 chamadas com try/catch próprio, a exceção abortava a
// passada INTEIRA daquele ativo — descartando qualquer sinal/estado real já
// computado nessa passada. Este teste prova que SystemLog.create/
// createUnique agora engolem a própria falha (nunca propagam), sem afetar
// nenhuma outra entidade (TradeOperation etc. continuam propagando erro
// normalmente — P0-h, .claude/rules/trading-engine.md).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { addMock, runTransactionMock, collectionMock } = vi.hoisted(() => {
  const addMock = vi.fn();
  const runTransactionMock = vi.fn();
  const collectionMock = vi.fn(() => ({
    add: addMock,
    doc: vi.fn(() => ({})),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  }));
  return { addMock, runTransactionMock, collectionMock };
});

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  cert: vi.fn(),
  getApps: () => [{}], // pretend an app is already initialized — skip cert(JSON.parse(...))
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: collectionMock,
    runTransaction: runTransactionMock,
    batch: vi.fn(),
  }),
  FieldValue: {},
}));

beforeEach(() => {
  vi.resetModules();
  addMock.mockReset();
  runTransactionMock.mockReset();
  collectionMock.mockClear();
});

describe('adminEntities — SystemLog nunca propaga falha de escrita (item 138 addendum)', () => {
  it('create() engole ALREADY_EXISTS espúrio e devolve fallback em vez de lançar', async () => {
    addMock.mockRejectedValue(new Error(
      'Document already exists: projects/sentinel-signals/databases/(default)/documents/systemLogs/YBu5xHyWfnzuNBMUQjDh'
    ));
    const { backend } = await import('./adminEntities.js');
    await expect(
      backend.entities.SystemLog.create({ level: 'info', module: 'scanner', message: 'x' })
    ).resolves.toEqual(expect.objectContaining({ id: null, level: 'info' }));
  });

  it('createUnique() engole falha de transação e devolve { created: false } em vez de lançar', async () => {
    runTransactionMock.mockRejectedValue(new Error('ABORTED: contention'));
    const { backend } = await import('./adminEntities.js');
    await expect(
      backend.entities.SystemLog.createUnique('dedup-key', { level: 'error', message: 'x' })
    ).resolves.toEqual({ created: false, existing: null });
  });

  it('não afeta outras entidades — TradeOperation.create() continua propagando erro real', async () => {
    addMock.mockRejectedValue(new Error('PERMISSION_DENIED'));
    const { backend } = await import('./adminEntities.js');
    await expect(
      backend.entities.TradeOperation.create({ symbol: 'BTCUSDT' })
    ).rejects.toThrow('PERMISSION_DENIED');
  });
});
