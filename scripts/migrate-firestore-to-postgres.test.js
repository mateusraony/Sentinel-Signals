// Cobre a paginação/cursor real (chunking, término de página, singleton) de
// scripts/migrate-firestore-to-postgres.mjs — mesma convenção de
// backfill-rtdb.test.js: mockar adminEntities.js/db-pgEntitiesCore.mjs e
// testar os wrappers exportados, não main() (forceExit não é testado
// diretamente neste repo).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { bulkImportEntityMock, closePoolMock } = vi.hoisted(() => ({
  bulkImportEntityMock: vi.fn().mockResolvedValue({ upserted: 0 }),
  closePoolMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../db/pgEntitiesCore.mjs', () => ({
  bulkImportEntity: bulkImportEntityMock,
  closePool: closePoolMock,
}));
vi.mock('firebase-admin/firestore', () => ({ FieldPath: { documentId: () => 'id-marker' } }));

function makeDocSnap(id, data) {
  return { id, data: () => data };
}

// db.collection(name) precisa devolver os MESMOS objetos de snapshot em
// chamadas repetidas (uma por página) para que startAfter(cursorSnap)
// consiga localizar o cursor por identidade — daí os snapshots serem
// pré-computados uma vez, fora do builder.
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
vi.mock('./adminEntities.js', () => ({ db: dbMock }));

beforeEach(() => {
  bulkImportEntityMock.mockReset().mockResolvedValue({ upserted: 0 });
  closePoolMock.mockReset().mockResolvedValue(undefined);
});

describe('migrateCollection', () => {
  it('lê tudo numa página só quando cabe abaixo do PAGE_SIZE e upserta uma vez', async () => {
    const docs = [
      { id: 'BTCUSDT', data: { symbol: 'BTCUSDT', is_active: true } },
      { id: 'ETHUSDT', data: { symbol: 'ETHUSDT', is_active: true } },
    ];
    Object.assign(dbMock, makeFakeDb({ monitoredAssets: docs }));
    const { migrateCollection } = await import('./migrate-firestore-to-postgres.mjs');

    const total = await migrateCollection('monitoredAssets', 'MonitoredAsset');

    expect(total).toBe(2);
    expect(bulkImportEntityMock).toHaveBeenCalledTimes(1);
    const [entityName, items] = bulkImportEntityMock.mock.calls[0];
    expect(entityName).toBe('MonitoredAsset');
    expect(items).toEqual([
      { id: 'BTCUSDT', symbol: 'BTCUSDT', is_active: true },
      { id: 'ETHUSDT', symbol: 'ETHUSDT', is_active: true },
    ]);
  });

  it('mais de 500 docs pagina em múltiplas chamadas (cursor por documento, nunca um único request gigante)', async () => {
    const docs = Array.from({ length: 1200 }, (_, i) => ({
      id: `log_${String(i).padStart(4, '0')}`,
      data: { level: 'info', created_date: '2026-09-01T00:00:00.000Z' },
    }));
    Object.assign(dbMock, makeFakeDb({ systemLogs: docs }));
    const { migrateCollection } = await import('./migrate-firestore-to-postgres.mjs');

    const total = await migrateCollection('systemLogs', 'SystemLog');

    expect(total).toBe(1200);
    expect(bulkImportEntityMock).toHaveBeenCalledTimes(3); // 500 + 500 + 200
    const pageSizes = bulkImportEntityMock.mock.calls.map(([, items]) => items.length);
    expect(pageSizes).toEqual([500, 500, 200]);
    // Cada página upserta ids DIFERENTES — nenhum documento repetido/pulado.
    const allIds = bulkImportEntityMock.mock.calls.flatMap(([, items]) => items.map((it) => it.id));
    expect(new Set(allIds).size).toBe(1200);
  });

  it('coleção vazia não chama bulkImportEntity nenhuma vez', async () => {
    Object.assign(dbMock, makeFakeDb({ priceAlerts: [] }));
    const { migrateCollection } = await import('./migrate-firestore-to-postgres.mjs');

    const total = await migrateCollection('priceAlerts', 'PriceAlert');

    expect(total).toBe(0);
    expect(bulkImportEntityMock).not.toHaveBeenCalled();
  });

  it('converte um Firestore Timestamp (duck-typed) para ISO antes de upsertar', async () => {
    const seconds = 1_725_000_000;
    const timestamp = { seconds, nanoseconds: 0, toDate: () => new Date(seconds * 1000) };
    Object.assign(dbMock, makeFakeDb({ users: [{ id: 'uid-1', data: { role: 'user', created_at: timestamp } }] }));
    const { migrateCollection } = await import('./migrate-firestore-to-postgres.mjs');

    await migrateCollection('users', 'User');

    const [, items] = bulkImportEntityMock.mock.calls[0];
    expect(items[0].created_at).toBe(new Date(seconds * 1000).toISOString());
  });
});

describe('migrateRecentCollection', () => {
  it('lê no máximo `limit` documentos (mesmo com mais disponível) e upserta uma vez', async () => {
    const docs = Array.from({ length: 5000 }, (_, i) => ({
      id: `log_${String(i).padStart(4, '0')}`,
      data: { level: 'info', created_date: '2026-09-01T00:00:00.000Z' },
    }));
    Object.assign(dbMock, makeFakeDb({ systemLogs: docs }));
    const { migrateRecentCollection } = await import('./migrate-firestore-to-postgres.mjs');

    const total = await migrateRecentCollection('systemLogs', 'SystemLog', 2000);

    expect(total).toBe(2000);
    expect(bulkImportEntityMock).toHaveBeenCalledTimes(1);
    const [entityName, items] = bulkImportEntityMock.mock.calls[0];
    expect(entityName).toBe('SystemLog');
    expect(items).toHaveLength(2000);
  });

  it('coleção vazia não chama bulkImportEntity', async () => {
    Object.assign(dbMock, makeFakeDb({ systemLogs: [] }));
    const { migrateRecentCollection } = await import('./migrate-firestore-to-postgres.mjs');

    const total = await migrateRecentCollection('systemLogs', 'SystemLog', 2000);

    expect(total).toBe(0);
    expect(bulkImportEntityMock).not.toHaveBeenCalled();
  });

  it('coleção com menos documentos que o limite migra todos, sem sobrar/faltar', async () => {
    const docs = Array.from({ length: 3 }, (_, i) => ({ id: `log_${i}`, data: { level: 'info' } }));
    Object.assign(dbMock, makeFakeDb({ systemLogs: docs }));
    const { migrateRecentCollection } = await import('./migrate-firestore-to-postgres.mjs');

    const total = await migrateRecentCollection('systemLogs', 'SystemLog', 2000);

    expect(total).toBe(3);
  });
});

describe('LIST_LIMIT_OVERRIDES', () => {
  it('só systemLogs tem limite — as outras 7 coleções continuam migração exaustiva', async () => {
    const { LIST_LIMIT_OVERRIDES, COLLECTION_ENTITIES } = await import('./migrate-firestore-to-postgres.mjs');
    expect(Object.keys(LIST_LIMIT_OVERRIDES)).toEqual(['systemLogs']);
    expect(Object.keys(COLLECTION_ENTITIES)).toContain('systemLogs');
  });
});

describe('migrateSingleton', () => {
  it('documento existente é upsertado com o id fixo', async () => {
    Object.assign(dbMock, makeFakeDb({ strategyConfig: [{ id: 'current', data: { rf_period: 20 } }] }));
    const { migrateSingleton } = await import('./migrate-firestore-to-postgres.mjs');

    const total = await migrateSingleton('strategyConfig', 'current', 'StrategyConfig');

    expect(total).toBe(1);
    expect(bulkImportEntityMock).toHaveBeenCalledWith('StrategyConfig', [{ id: 'current', rf_period: 20 }]);
  });

  it('documento inexistente é pulado, sem chamar bulkImportEntity', async () => {
    Object.assign(dbMock, makeFakeDb({ telegramFilters: [] }));
    const { migrateSingleton } = await import('./migrate-firestore-to-postgres.mjs');

    const total = await migrateSingleton('telegramFilters', 'current', 'TelegramFilters');

    expect(total).toBe(0);
    expect(bulkImportEntityMock).not.toHaveBeenCalled();
  });
});
