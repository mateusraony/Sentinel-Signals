import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getMock, queryMock, refMock, orderByChildMock, limitToLastMock, startAtMock, endBeforeMock, equalToMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  queryMock: vi.fn((...args) => ({ __query: args })),
  refMock: vi.fn((db, path) => ({ path })),
  orderByChildMock: vi.fn((field) => ({ __orderByChild: field })),
  limitToLastMock: vi.fn((n) => ({ __limitToLast: n })),
  startAtMock: vi.fn((v) => ({ __startAt: v })),
  endBeforeMock: vi.fn((v) => ({ __endBefore: v })),
  equalToMock: vi.fn((v) => ({ __equalTo: v })),
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
  equalTo: equalToMock,
}));

const fallbackListMock = vi.fn();
const fallbackFilterMock = vi.fn();
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      AssetState: { list: fallbackListMock, filter: fallbackFilterMock },
      SignalEvent: { list: fallbackListMock, filter: fallbackFilterMock },
      SystemLog: { list: fallbackListMock, filter: fallbackFilterMock },
      TradeOperation: { list: fallbackListMock, filter: fallbackFilterMock },
      MonitoredAsset: { list: fallbackListMock, filter: fallbackFilterMock },
      VerificationTask: { list: fallbackListMock, filter: fallbackFilterMock },
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
  equalToMock.mockClear();
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

  it('SignalEvent (rodada 2, item 152 addendum) usa o path signalEvents', async () => {
    getMock.mockResolvedValue(snapshotOf({ s1: { id: 's1', symbol: 'BTCUSDT', created_date: '2026-01-01T00:00:00.000Z' } }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await rtdbEntities.SignalEvent.list('-created_date', 100);
    expect(refMock).toHaveBeenCalledWith({}, 'signalEvents');
  });

  // Rodada 3c (item 169): SystemLog usa o MESMO modo order+limit que
  // SignalEvent/TradeOperation (createRtdbReadEntity) — não o modo "nó
  // inteiro" da 3b — porque a coleção é grande (milhares de docs); Logs.jsx/
  // DebugLogButton.jsx só chamam .list('-created_date', N), sem .filter().
  it('SystemLog (rodada 3c) usa o path systemLogs, mesmo formato order+limit de SignalEvent/TradeOperation', async () => {
    getMock.mockResolvedValue(snapshotOf({
      l1: { id: 'l1', level: 'error', created_date: '2026-01-01T00:00:00.000Z' },
      l2: { id: 'l2', level: 'info', created_date: '2026-01-02T00:00:00.000Z' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.SystemLog.list('-created_date', 200);
    expect(refMock).toHaveBeenCalledWith({}, 'systemLogs');
    expect(orderByChildMock).toHaveBeenCalledWith('created_date');
    expect(limitToLastMock).toHaveBeenCalledWith(200);
    expect(result.map((r) => r.id)).toEqual(['l2', 'l1']);
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

  // Rodada 3 (RFHistoryChart.jsx: SignalEvent.filter({ asset_id }, '-created_date', 60))
  // — igualdade de campo único vira orderByChild+equalTo; sort/limit acontecem
  // em memória depois, porque o RTDB não combina equalTo com uma 2ª ordenação
  // por outro campo no servidor.
  it('igualdade de campo único ({ field: valor escalar }) vira orderByChild+equalTo, com sort/limit em memória', async () => {
    getMock.mockResolvedValue(snapshotOf({
      s1: { id: 's1', asset_id: 'BTCUSDT', created_date: '2026-01-01T00:00:00.000Z' },
      s2: { id: 's2', asset_id: 'BTCUSDT', created_date: '2026-01-03T00:00:00.000Z' },
      s3: { id: 's3', asset_id: 'BTCUSDT', created_date: '2026-01-02T00:00:00.000Z' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.SignalEvent.filter({ asset_id: 'BTCUSDT' }, '-created_date', 2);
    expect(orderByChildMock).toHaveBeenCalledWith('asset_id');
    expect(equalToMock).toHaveBeenCalledWith('BTCUSDT');
    // 3 docs voltam do equalTo (nó inteiro que casa); -created_date + limit 2
    // corta pros 2 mais recentes, em memória.
    expect(result.map((r) => r.id)).toEqual(['s2', 's3']);
    expect(fallbackFilterMock).not.toHaveBeenCalled();
  });

  it('igualdade sem sort/limit devolve todo o conjunto que casou o equalTo, sem ordem específica', async () => {
    getMock.mockResolvedValue(snapshotOf({
      s1: { id: 's1', asset_id: 'ETHUSDT' },
      s2: { id: 's2', asset_id: 'ETHUSDT' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.SignalEvent.filter({ asset_id: 'ETHUSDT' });
    expect(result).toHaveLength(2);
  });

  it('valor null no filtro de igualdade cai no fallback Firestore (não confundir com igualdade a null)', async () => {
    fallbackFilterMock.mockResolvedValue([]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await rtdbEntities.TradeOperation.filter({ status: null });
    expect(fallbackFilterMock).toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  // Auditoria pós-merge da 3a (pedido do usuário: confirmar que a 3a está
  // "blindada" antes de seguir pra 3b): classifyFilter() (src/lib/
  // queryFilters.js:83) trata uma chave `undefined` como "SEM filtro nesse
  // campo" — é assim que Verification.jsx monta
  // `{ status: statusFilter !== 'all' ? statusFilter : undefined }`, exatamente
  // o padrão que a etapa 3b vai apontar pro RTDB. singleFieldEqualityShape
  // tinha um buraco: só excluía `null`/objeto, não `undefined` — um filtro
  // como `{ status: undefined }` seria reconhecido como "igual a undefined" e
  // viraria `equalTo(undefined)` no RTDB, divergindo do "sem filtro" que o
  // Firestore sempre fez pra essa mesma forma.
  it('valor undefined no filtro de igualdade cai no fallback Firestore (mesma convenção de classifyFilter — "sem filtro", não "igual a undefined")', async () => {
    fallbackFilterMock.mockResolvedValue([{ id: 'x' }]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.TradeOperation.filter({ status: undefined });
    expect(result).toEqual([{ id: 'x' }]);
    expect(fallbackFilterMock).toHaveBeenCalledWith({ status: undefined }, undefined, undefined);
    expect(equalToMock).not.toHaveBeenCalled();
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

// Rodada 3b (item 169): MonitoredAsset/VerificationTask usam o modo "nó
// inteiro" — sempre buscam a árvore inteira do RTDB (sem orderByChild/query
// nenhuma) e filtram/ordenam/cortam em memória. Coleções pequenas o
// bastante (dezenas/poucas centenas de docs) que isso é sempre correto e
// mais simples que manter um reconhecedor de formato de query por campo.
describe('rtdbEntities — modo "nó inteiro" (MonitoredAsset/VerificationTask, rodada 3b)', () => {
  it('list() sem argumentos busca a árvore inteira, sem query nenhuma', async () => {
    getMock.mockResolvedValue(snapshotOf({ a1: { id: 'a1', symbol: 'BTCUSDT' }, a2: { id: 'a2', symbol: 'ETHUSDT' } }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.MonitoredAsset.list();
    expect(refMock).toHaveBeenCalledWith({}, 'monitoredAssets');
    expect(queryMock).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it('list("-created_date") ordena em memória (sem orderByChild no RTDB)', async () => {
    getMock.mockResolvedValue(snapshotOf({
      a: { id: 'a', created_date: '2026-01-01T00:00:00.000Z' },
      b: { id: 'b', created_date: '2026-01-02T00:00:00.000Z' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.MonitoredAsset.list('-created_date');
    expect(orderByChildMock).not.toHaveBeenCalled();
    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('filter({ is_active: true }) — igualdade de campo único (Dashboard.jsx/TickerBar.jsx) filtra em memória', async () => {
    getMock.mockResolvedValue(snapshotOf({
      a1: { id: 'a1', symbol: 'BTCUSDT', is_active: true },
      a2: { id: 'a2', symbol: 'ETHUSDT', is_active: false },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.MonitoredAsset.filter({ is_active: true });
    expect(equalToMock).not.toHaveBeenCalled();
    expect(result.map((r) => r.id)).toEqual(['a1']);
  });

  it('filter({ status, priority }) — igualdade de DOIS campos (Verification.jsx) filtra ambos em memória', async () => {
    getMock.mockResolvedValue(snapshotOf({
      v1: { id: 'v1', status: 'pending', priority: 'high' },
      v2: { id: 'v2', status: 'pending', priority: 'low' },
      v3: { id: 'v3', status: 'reviewed', priority: 'high' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.VerificationTask.filter({ status: 'pending', priority: 'high' }, '-created_date', 200);
    expect(result.map((r) => r.id)).toEqual(['v1']);
  });

  // A verificação central desta rodada: Verification.jsx monta
  // `{ status: statusFilter !== 'all' ? statusFilter : undefined, priority: ... }`
  // — o achado do addendum pós-3a (undefined = "sem filtro nesse campo",
  // nunca "igual a undefined") precisa valer aqui também, não só no modo de
  // igualdade de campo único.
  it('campo com valor undefined é IGNORADO (não filtra por ele) — mesma convenção de classifyFilter()', async () => {
    getMock.mockResolvedValue(snapshotOf({
      v1: { id: 'v1', status: 'pending', priority: 'high' },
      v2: { id: 'v2', status: 'reviewed', priority: 'low' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    // "Todas" as prioridades selecionado — priority vira undefined, exatamente
    // como Verification.jsx monta quando o filtro está em "all".
    const result = await rtdbEntities.VerificationTask.filter({ status: 'pending', priority: undefined }, '-created_date', 200);
    expect(result.map((r) => r.id)).toEqual(['v1']);
  });

  it('todos os campos undefined se comporta como list() — devolve tudo', async () => {
    getMock.mockResolvedValue(snapshotOf({
      v1: { id: 'v1', status: 'pending' },
      v2: { id: 'v2', status: 'reviewed' },
    }));
    const { rtdbEntities } = await import('./rtdbEntities.js');
    const result = await rtdbEntities.VerificationTask.filter({ status: undefined, priority: undefined });
    expect(result).toHaveLength(2);
  });

  it('valor null em qualquer campo cai no fallback Firestore inteiro (não busca o nó)', async () => {
    fallbackFilterMock.mockResolvedValue([]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await rtdbEntities.VerificationTask.filter({ status: 'pending', priority: null });
    expect(fallbackFilterMock).toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('valor array (Firestore `in`) em qualquer campo cai no fallback Firestore inteiro', async () => {
    fallbackFilterMock.mockResolvedValue([]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await rtdbEntities.VerificationTask.filter({ status: ['pending', 'reviewed'] });
    expect(fallbackFilterMock).toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('valor range ({gte,lt}) em qualquer campo cai no fallback Firestore inteiro', async () => {
    fallbackFilterMock.mockResolvedValue([]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await rtdbEntities.VerificationTask.filter({ created_date: { gte: '2026-01-01' } });
    expect(fallbackFilterMock).toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('sem rtdb provisionado (null), list() e filter() caem no fallback Firestore', async () => {
    vi.doMock('@/lib/firebaseClient', () => ({ rtdb: null }));
    fallbackListMock.mockResolvedValue([{ id: 'x' }]);
    fallbackFilterMock.mockResolvedValue([{ id: 'y' }]);
    const { rtdbEntities } = await import('./rtdbEntities.js');
    await expect(rtdbEntities.MonitoredAsset.list()).resolves.toEqual([{ id: 'x' }]);
    await expect(rtdbEntities.VerificationTask.filter({ status: 'pending' })).resolves.toEqual([{ id: 'y' }]);
    expect(getMock).not.toHaveBeenCalled();
  });
});
