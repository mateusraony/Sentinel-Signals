// Cobre a lógica pura de scripts/verify-postgres-migration.mjs
// (checksum/comparação de datasets/detecção de duplicata de TradeOperation)
// e a paginação de leitura do Firestore — mesma convenção de
// migrate-firestore-to-postgres.test.js/backfill-rtdb.test.js: mockar as
// dependências externas (Firestore/Postgres) e testar os wrappers
// exportados; main() (forceExit) não é testado diretamente.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { bulkImportEntityMock, closePoolMock, backendMock } = vi.hoisted(() => ({
  bulkImportEntityMock: vi.fn().mockResolvedValue({ upserted: 0 }),
  closePoolMock: vi.fn().mockResolvedValue(undefined),
  backendMock: { entities: {} },
}));
vi.mock('../db/pgEntitiesCore.mjs', () => ({
  bulkImportEntity: bulkImportEntityMock,
  closePool: closePoolMock,
  backend: backendMock,
}));
vi.mock('firebase-admin/firestore', () => ({ FieldPath: { documentId: () => 'id-marker' } }));

function makeDocSnap(id, data) {
  return { id, data: () => data };
}

function makeFakeDb(collections) {
  const snapsByCollection = Object.fromEntries(
    Object.entries(collections).map(([name, docs]) => [name, docs.map(({ id, data }) => makeDocSnap(id, data))])
  );
  return {
    collection(name) {
      const allDocs = snapsByCollection[name] || [];
      let startIndex = 0;
      let limitN = allDocs.length;
      const builder = {
        orderBy() { return builder; },
        limit(n) { limitN = n; return builder; },
        startAfter(cursorSnap) {
          startIndex = allDocs.indexOf(cursorSnap) + 1;
          return builder;
        },
        async get() {
          const page = allDocs.slice(startIndex, startIndex + limitN);
          return { empty: page.length === 0, docs: page };
        },
        doc(id) {
          return {
            async get() {
              const found = allDocs.find((d) => d.id === id);
              return found ? { exists: true, id: found.id, data: found.data } : { exists: false };
            },
          };
        },
      };
      return builder;
    },
  };
}

const { dbMock } = vi.hoisted(() => ({ dbMock: { collection: vi.fn() } }));
vi.mock('./adminEntitiesFirestoreLegacy.js', () => ({ db: dbMock }));

beforeEach(() => {
  bulkImportEntityMock.mockReset().mockResolvedValue({ upserted: 0 });
  closePoolMock.mockReset().mockResolvedValue(undefined);
});

describe('checksumDocs', () => {
  it('mesmo conteúdo, ordem de chegada diferente -> mesmo checksum', async () => {
    const { checksumDocs } = await import('./verify-postgres-migration.mjs');
    const a = [{ id: '2', symbol: 'ETHUSDT' }, { id: '1', symbol: 'BTCUSDT' }];
    const b = [{ id: '1', symbol: 'BTCUSDT' }, { id: '2', symbol: 'ETHUSDT' }];
    expect(checksumDocs(a)).toBe(checksumDocs(b));
  });

  it('conteúdo diferente em qualquer documento -> checksum diferente', async () => {
    const { checksumDocs } = await import('./verify-postgres-migration.mjs');
    const a = [{ id: '1', status: 'RUNNER_ACTIVE' }];
    const b = [{ id: '1', status: 'STOP_HIT' }];
    expect(checksumDocs(a)).not.toBe(checksumDocs(b));
  });

  it('lista vazia é determinística (hash do "nada")', async () => {
    const { checksumDocs } = await import('./verify-postgres-migration.mjs');
    expect(checksumDocs([])).toBe(checksumDocs([]));
  });
});

describe('compareDatasets', () => {
  it('contagem e checksum batem quando os dois lados são idênticos', async () => {
    const { compareDatasets } = await import('./verify-postgres-migration.mjs');
    const items = [{ id: '1', a: 1 }, { id: '2', a: 2 }];
    const result = compareDatasets(items, [...items]);
    expect(result.countMatch).toBe(true);
    expect(result.checksumMatch).toBe(true);
  });

  it('detecta divergência de CONTAGEM (documento faltando de um lado)', async () => {
    const { compareDatasets } = await import('./verify-postgres-migration.mjs');
    const result = compareDatasets([{ id: '1', a: 1 }, { id: '2', a: 2 }], [{ id: '1', a: 1 }]);
    expect(result.countMatch).toBe(false);
  });

  it('detecta divergência de CONTEÚDO mesmo com a mesma contagem', async () => {
    const { compareDatasets } = await import('./verify-postgres-migration.mjs');
    const result = compareDatasets([{ id: '1', current_stop: 100 }], [{ id: '1', current_stop: 99 }]);
    expect(result.countMatch).toBe(true);
    expect(result.checksumMatch).toBe(false);
  });
});

describe('compareTradeOpDuplicates', () => {
  it('nenhum lado tem duplicata -> match true, 0/0', async () => {
    const { compareTradeOpDuplicates } = await import('./verify-postgres-migration.mjs');
    const ops = [
      { id: 'op1', asset_id: 'BTCUSDT', status: 'RUNNER_ACTIVE' },
      { id: 'op2', asset_id: 'ETHUSDT', status: 'SIGNAL_CONFIRMED' },
    ];
    const result = compareTradeOpDuplicates(ops, [...ops]);
    expect(result.match).toBe(true);
    expect(result.firestoreDuplicateGroups).toBe(0);
    expect(result.postgresDuplicateGroups).toBe(0);
  });

  it('a ORIGEM já tinha duplicata (2 ops ativas no mesmo ativo) e a migração preserva -> match true, 1/1', async () => {
    const { compareTradeOpDuplicates } = await import('./verify-postgres-migration.mjs');
    const dup = [
      { id: 'op1', asset_id: 'BTCUSDT', status: 'RUNNER_ACTIVE' },
      { id: 'op2', asset_id: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' },
    ];
    const result = compareTradeOpDuplicates(dup, [...dup]);
    expect(result.match).toBe(true);
    expect(result.firestoreDuplicateGroups).toBe(1);
    expect(result.postgresDuplicateGroups).toBe(1);
  });

  it('a migração INTRODUZ uma duplicata que não existia na origem -> match false', async () => {
    const { compareTradeOpDuplicates } = await import('./verify-postgres-migration.mjs');
    const clean = [{ id: 'op1', asset_id: 'BTCUSDT', status: 'RUNNER_ACTIVE' }];
    const corrupted = [
      { id: 'op1', asset_id: 'BTCUSDT', status: 'RUNNER_ACTIVE' },
      { id: 'op2', asset_id: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' },
    ];
    const result = compareTradeOpDuplicates(clean, corrupted);
    expect(result.match).toBe(false);
    expect(result.firestoreDuplicateGroups).toBe(0);
    expect(result.postgresDuplicateGroups).toBe(1);
  });
});

describe('readFirestoreCollection', () => {
  it('pagina até esvaziar (mesmo cursor de migrateCollection) e converte Timestamp', async () => {
    const seconds = 1_725_000_000;
    const timestamp = { seconds, nanoseconds: 0, toDate: () => new Date(seconds * 1000) };
    const docs = Array.from({ length: 600 }, (_, i) => ({ id: `sig_${i}`, data: { symbol: 'BTCUSDT', created_date: timestamp } }));
    Object.assign(dbMock, makeFakeDb({ signalEvents: docs }));
    const { readFirestoreCollection } = await import('./verify-postgres-migration.mjs');

    const items = await readFirestoreCollection('signalEvents');

    expect(items).toHaveLength(600);
    expect(items[0].created_date).toBe(new Date(seconds * 1000).toISOString());
  });

  it('coleção vazia devolve array vazio', async () => {
    Object.assign(dbMock, makeFakeDb({ priceAlerts: [] }));
    const { readFirestoreCollection } = await import('./verify-postgres-migration.mjs');
    expect(await readFirestoreCollection('priceAlerts')).toEqual([]);
  });
});

describe('readFirestoreSingleton', () => {
  it('documento existente vem com o id', async () => {
    Object.assign(dbMock, makeFakeDb({ strategyConfig: [{ id: 'current', data: { rf_period: 20 } }] }));
    const { readFirestoreSingleton } = await import('./verify-postgres-migration.mjs');
    expect(await readFirestoreSingleton('strategyConfig', 'current')).toEqual([{ id: 'current', rf_period: 20 }]);
  });

  it('documento inexistente devolve array vazio', async () => {
    Object.assign(dbMock, makeFakeDb({ telegramFilters: [] }));
    const { readFirestoreSingleton } = await import('./verify-postgres-migration.mjs');
    expect(await readFirestoreSingleton('telegramFilters', 'current')).toEqual([]);
  });
});
