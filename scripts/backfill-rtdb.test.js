// docs/known-risks.md item 152 addendum — covers the actual logic of
// scripts/backfill-rtdb.mjs (chunking, key sanitization, which collections
// get copied). main()'s forceExit wrapper isn't tested directly, same
// convention as run-scan.mjs/run-backfill-check.mjs in this repo.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listMock, updateMock, refMock } = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const refMock = vi.fn(() => ({ update: updateMock }));
  return { listMock: vi.fn(), updateMock, refMock };
});

vi.mock('./adminEntitiesFirestoreLegacy.js', () => ({
  backend: { entities: { AssetState: { list: listMock }, TradeOperation: { list: listMock }, SystemLog: { list: listMock } } },
  rtdb: { ref: refMock },
}));

beforeEach(() => {
  listMock.mockReset();
  updateMock.mockReset().mockResolvedValue(undefined);
  refMock.mockClear();
});

describe('backfillCollection', () => {
  it('lê tudo do Firestore (sem filtro) e escreve num único update() com todas as chaves sanitizadas', async () => {
    listMock.mockResolvedValue([
      { id: 'trade_BTCUSDT_4h_BUY_raw_2026-09-03T12:00:00.000Z', status: 'STOP_HIT' },
      { id: 'BTCUSDT::4h', asset_id: 'BTCUSDT', timeframe: '4h' },
    ]);
    const { backfillCollection } = await import('./backfill-rtdb.mjs');
    await backfillCollection('TradeOperation', 'tradeOperations');

    expect(listMock).toHaveBeenCalledWith();
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [updates] = updateMock.mock.calls[0];
    const keys = Object.keys(updates);
    expect(keys).toHaveLength(2);
    // A chave sanitizada nunca contém os caracteres proibidos do RTDB, mas o
    // doc guardado como valor preserva o id REAL — é dele que a leitura via
    // RTDB recuperaria .id pra uma mutação subsequente.
    keys.forEach((k) => expect(k.split('/')[1]).not.toMatch(/[.#$/[\]]/));
    expect(Object.values(updates).map((v) => v.id)).toEqual([
      'trade_BTCUSDT_4h_BUY_raw_2026-09-03T12:00:00.000Z',
      'BTCUSDT::4h',
    ]);
  });

  it('nó vazio (0 docs) não chama update() nenhuma vez', async () => {
    listMock.mockResolvedValue([]);
    const { backfillCollection } = await import('./backfill-rtdb.mjs');
    await backfillCollection('AssetState', 'assetStates');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('mais de 500 docs vira múltiplos update() em chunks — nunca um payload gigante único', async () => {
    const docs = Array.from({ length: 1200 }, (_, i) => ({ id: `op_${i}`, status: 'CLOSED' }));
    listMock.mockResolvedValue(docs);
    const { backfillCollection } = await import('./backfill-rtdb.mjs');
    await backfillCollection('TradeOperation', 'tradeOperations');

    expect(updateMock).toHaveBeenCalledTimes(3); // 500 + 500 + 200
    const sizes = updateMock.mock.calls.map(([updates]) => Object.keys(updates).length);
    expect(sizes).toEqual([500, 500, 200]);
  });

  it('a chave escrita usa o rtdbPath certo como prefixo', async () => {
    listMock.mockResolvedValue([{ id: 'BTCUSDT::1h' }]);
    const { backfillCollection } = await import('./backfill-rtdb.mjs');
    await backfillCollection('AssetState', 'assetStates');
    const [updates] = updateMock.mock.calls[0];
    expect(Object.keys(updates)[0]).toMatch(/^assetStates\//);
  });

  // Incidente ao vivo 2026-09-07 (docs/known-risks.md item 152/169
  // addendum): SystemLog tem ~49.700 docs no Firestore — um .list() sem
  // limite sozinho quase esgota a cota diária inteira (~50k leituras/dia no
  // Spark) e derrubou o próximo scan agendado. SystemLog precisa ler com um
  // limite; qualquer outra entidade (sem esse achado de escala) continua lendo
  // tudo, sem limite.
  it('SystemLog lê com um limite (mais recentes), NUNCA a coleção inteira sem limite', async () => {
    listMock.mockResolvedValue([]);
    const { backfillCollection } = await import('./backfill-rtdb.mjs');
    await backfillCollection('SystemLog', 'systemLogs');
    expect(listMock).toHaveBeenCalledWith('-created_date', expect.any(Number));
    expect(listMock).not.toHaveBeenCalledWith();
  });

  it('entidades sem achado de escala (AssetState/TradeOperation) continuam lendo tudo, sem limite', async () => {
    listMock.mockResolvedValue([]);
    const { backfillCollection } = await import('./backfill-rtdb.mjs');
    await backfillCollection('AssetState', 'assetStates');
    await backfillCollection('TradeOperation', 'tradeOperations');
    expect(listMock).toHaveBeenNthCalledWith(1);
    expect(listMock).toHaveBeenNthCalledWith(2);
  });
});
