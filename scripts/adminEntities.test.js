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

const { addMock, runTransactionMock, collectionMock, whereMock, getMock } = vi.hoisted(() => {
  const addMock = vi.fn();
  const runTransactionMock = vi.fn();
  const getMock = vi.fn();
  // where/orderBy/limit são compartilhados entre TODAS as instâncias de
  // collection() de propósito — cada filter() só chama col() uma vez, então
  // isso deixa whereMock.mock.calls como o registro fiel de toda constraint
  // emitida numa única chamada, sem precisar capturar a instância da query.
  const whereMock = vi.fn().mockReturnThis();
  const collectionMock = vi.fn(() => ({
    add: addMock,
    doc: vi.fn(() => ({})),
    where: whereMock,
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    get: getMock,
  }));
  return { addMock, runTransactionMock, collectionMock, whereMock, getMock };
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
  whereMock.mockClear();
  getMock.mockReset();
  getMock.mockResolvedValue({ docs: [] });
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

// docs/known-risks.md item 141/143: mesmo risco do espelho browser
// (src/api/entities.test.js) — classifyFilter só descreve a semântica
// pretendida, a tradução real para .where() encadeado do admin SDK é
// duplicada à mão aqui. Um bug nesta tradução (ex.: só aplicar a 1a
// constraint de um range de 2) derrotaria o fix do item 141 no CRON
// especificamente (é este arquivo, não entities.js, que roda no scan
// agendado) com CI verde.
describe('adminEntities — filter() traduz range para .where() nativo (item 143)', () => {
  it('{ gte } vira uma única constraint where(field, ">=", operand)', async () => {
    const { backend } = await import('./adminEntities.js');
    await backend.entities.TradeOperation.filter({ created_date: { gte: '2026-10-01T00:00:00.000Z' } });
    const calls = whereMock.mock.calls.filter(([field]) => field === 'created_date');
    expect(calls).toEqual([['created_date', '>=', '2026-10-01T00:00:00.000Z']]);
  });

  it('{ gte, lt } vira DUAS constraints where() no mesmo campo — intervalo [a, b)', async () => {
    const { backend } = await import('./adminEntities.js');
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
    const { backend } = await import('./adminEntities.js');
    await backend.entities.TradeOperation.filter({ status: 'RUNNER_ACTIVE' });
    expect(whereMock).toHaveBeenCalledWith('status', '==', 'RUNNER_ACTIVE');
  });
});
