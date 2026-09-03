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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  addMock, runTransactionMock, collectionMock, whereMock, getMock,
  rtdbRefMock, rtdbSetMock, rtdbUpdateMock, rtdbRemoveMock,
} = vi.hoisted(() => {
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
    doc: vi.fn(() => ({ update: vi.fn(), delete: vi.fn() })),
    where: whereMock,
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    get: getMock,
  }));
  const rtdbSetMock = vi.fn();
  const rtdbUpdateMock = vi.fn();
  const rtdbRemoveMock = vi.fn();
  const rtdbRefMock = vi.fn((path) => ({
    path,
    set: rtdbSetMock,
    update: rtdbUpdateMock,
    remove: rtdbRemoveMock,
  }));
  return { addMock, runTransactionMock, collectionMock, whereMock, getMock, rtdbRefMock, rtdbSetMock, rtdbUpdateMock, rtdbRemoveMock };
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

// FIREBASE_DATABASE_URL truthy so `rtdb` resolves non-null and the mirror
// wrappers actually attempt calls — the "unset -> rtdb stays null" no-op
// guard itself is covered by adminEntitiesRtdbTripwire.test.js (source read).
vi.mock('firebase-admin/database', () => ({ getDatabase: () => ({ ref: rtdbRefMock }) }));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.FIREBASE_DATABASE_URL = 'https://sentinel-signals-default-rtdb.firebaseio.com';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}';
  addMock.mockReset();
  runTransactionMock.mockReset();
  collectionMock.mockClear();
  whereMock.mockClear();
  getMock.mockReset();
  getMock.mockResolvedValue({ docs: [] });
  rtdbRefMock.mockClear();
  rtdbSetMock.mockReset();
  rtdbSetMock.mockResolvedValue(undefined);
  rtdbUpdateMock.mockReset();
  rtdbUpdateMock.mockResolvedValue(undefined);
  rtdbRemoveMock.mockReset();
  rtdbRemoveMock.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
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

// docs/known-risks.md item 152 — comportamento do mirror Firestore→RTDB no
// lado cron. Estrutura já verificada pelo tripwire
// (scripts/adminEntitiesRtdbTripwire.test.js); aqui é o comportamento real
// com as primitivas mockadas.
describe('adminEntities.js — mirror Firestore→RTDB (item 152)', () => {
  it('AssetState.create() espelha o doc criado (com id) na chave sanitizada', async () => {
    addMock.mockResolvedValue({ id: 'BTCUSDT::4h' });
    const { backend } = await import('./adminEntities.js');
    const created = await backend.entities.AssetState.create({ asset_id: 'BTCUSDT', timeframe: '4h' });
    expect(rtdbRefMock).toHaveBeenCalledWith('assetStates/BTCUSDT::4h');
    expect(rtdbSetMock).toHaveBeenCalledWith(created);
  });

  it('TradeOperation.update() espelha só o patch na chave sanitizada (dedup_key com timestamp ISO)', async () => {
    const { backend } = await import('./adminEntities.js');
    const id = 'trade_BTCUSDT_4h_BUY_raw_2026-09-03T12:00:00.000Z';
    await backend.entities.TradeOperation.update(id, { status: 'CLOSED' });
    expect(rtdbRefMock).toHaveBeenCalledTimes(1);
    const [path] = rtdbRefMock.mock.calls[0];
    const sanitizedKey = path.slice('tradeOperations/'.length);
    expect(sanitizedKey).not.toMatch(/[.#$/[\]]/);
    expect(rtdbUpdateMock).toHaveBeenCalledWith({ status: 'CLOSED' });
  });

  it('SignalEvent.create() (fora do escopo desta rodada) nunca toca o RTDB', async () => {
    addMock.mockResolvedValue({ id: 'sig1' });
    const { backend } = await import('./adminEntities.js');
    await backend.entities.SignalEvent.create({ symbol: 'BTCUSDT' });
    expect(rtdbSetMock).not.toHaveBeenCalled();
  });

  it('createTradeOpIfNoneActive espelha o doc criado quando created === true', async () => {
    runTransactionMock.mockImplementation(async (cb) => cb({
      get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      set: vi.fn(),
    }));
    const { backend } = await import('./adminEntities.js');
    await backend.tradeOps.createTradeOpIfNoneActive('BTCUSDT', 'trade_x', { symbol: 'BTCUSDT' });
    expect(rtdbSetMock).toHaveBeenCalledTimes(1);
  });

  it('transitionTradeOp espelha o patch aplicado quando o CAS aceita (applied === true)', async () => {
    runTransactionMock.mockImplementation(async (cb) => cb({
      get: vi.fn().mockResolvedValue({ exists: true, id: 'trade_x', data: () => ({ status: 'RUNNER_ACTIVE', side: 'BUY' }) }),
      update: vi.fn(),
    }));
    const { backend } = await import('./adminEntities.js');
    await backend.tradeOps.transitionTradeOp('trade_x', 'RUNNER_ACTIVE', { status: 'STOP_HIT' });
    expect(rtdbUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'STOP_HIT' }));
  });

  it('transitionTradeOp NÃO espelha quando o CAS rejeita (applied === false)', async () => {
    runTransactionMock.mockImplementation(async (cb) => cb({
      get: vi.fn().mockResolvedValue({ exists: true, id: 'trade_x', data: () => ({ status: 'STOP_HIT', side: 'BUY' }) }),
      update: vi.fn(),
    }));
    const { backend } = await import('./adminEntities.js');
    await backend.tradeOps.transitionTradeOp('trade_x', 'RUNNER_ACTIVE', { status: 'STOP_HIT' });
    expect(rtdbUpdateMock).not.toHaveBeenCalled();
  });

  it('uma falha do RTDB (mockada) nunca impede a operação real de resolver', async () => {
    rtdbSetMock.mockRejectedValue(new Error('RTDB indisponível'));
    addMock.mockResolvedValue({ id: 'x1' });
    const { backend } = await import('./adminEntities.js');
    await expect(backend.entities.AssetState.create({ asset_id: 'BTCUSDT', timeframe: '4h' }))
      .resolves.toEqual(expect.objectContaining({ id: 'x1' }));
  });

  it('sem FIREBASE_DATABASE_URL, o mirror é no-op (rtdb null) e a operação real continua funcionando', async () => {
    delete process.env.FIREBASE_DATABASE_URL;
    addMock.mockResolvedValue({ id: 'x1' });
    const { backend } = await import('./adminEntities.js');
    await expect(backend.entities.AssetState.create({ asset_id: 'BTCUSDT', timeframe: '4h' }))
      .resolves.toEqual(expect.objectContaining({ id: 'x1' }));
    expect(rtdbSetMock).not.toHaveBeenCalled();
  });
});
