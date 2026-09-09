// Cobre a composição de scripts/migrate-and-verify-postgres.mjs — mockando
// as peças já testadas em outros lugares (readFirestoreCollection* /
// compareDatasets/compareTradeOpDuplicates de verify-postgres-
// migration.mjs; bulkImportEntity/backend de db/pgEntitiesCore.mjs), pra
// provar só a composição nova: lê o Firestore UMA vez, escreve, e compara
// contra o MESMO array em memória — nunca lê o Firestore de novo. Mesma
// convenção de migrate-firestore-to-postgres.test.js/verify-postgres-
// migration.test.js: mockar dependências externas, testar os wrappers
// exportados; main() (forceExit) não é testado diretamente.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  bulkImportEntityMock,
  closePoolMock,
  backendMock,
  readFirestoreCollectionMock,
  readFirestoreCollectionRecentMock,
  readFirestoreSingletonMock,
} = vi.hoisted(() => ({
  bulkImportEntityMock: vi.fn().mockResolvedValue({ upserted: 0 }),
  closePoolMock: vi.fn().mockResolvedValue(undefined),
  backendMock: { entities: {} },
  readFirestoreCollectionMock: vi.fn(),
  readFirestoreCollectionRecentMock: vi.fn(),
  readFirestoreSingletonMock: vi.fn(),
}));

vi.mock('../db/pgEntitiesCore.mjs', () => ({
  bulkImportEntity: bulkImportEntityMock,
  closePool: closePoolMock,
  backend: backendMock,
}));

// verify-postgres-migration.mjs importa `db` de ./adminEntities.js, que
// chama firebase-admin's initializeApp() NO CARREGAMENTO (sem credencial
// real, lançaria aqui) — mockado antes do importOriginal() abaixo pra
// nenhum dos dois módulos tentar inicializar o Firebase de verdade (mesma
// lição do item 158/166: módulo que faz trabalho no carregamento é
// intestável sem isto).
vi.mock('./adminEntities.js', () => ({ db: {} }));

// Reimporta as funções REAIS de compareDatasets/compareTradeOpDuplicates
// (puras, já testadas em verify-postgres-migration.test.js) mas troca as
// funções de LEITURA do Firestore por mocks — é exatamente o ponto que este
// arquivo precisa provar: nenhuma segunda leitura acontece.
vi.mock('./verify-postgres-migration.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFirestoreCollection: readFirestoreCollectionMock,
    readFirestoreCollectionRecent: readFirestoreCollectionRecentMock,
    readFirestoreSingleton: readFirestoreSingletonMock,
  };
});

beforeEach(() => {
  bulkImportEntityMock.mockReset().mockResolvedValue({ upserted: 0 });
  closePoolMock.mockReset().mockResolvedValue(undefined);
  readFirestoreCollectionMock.mockReset();
  readFirestoreCollectionRecentMock.mockReset();
  readFirestoreSingletonMock.mockReset();
  backendMock.entities = {};
});

describe('migrateAndVerifyCollection', () => {
  it('lê o Firestore 1 VEZ SÓ, escreve no Postgres, e compara contra o array já em memória (nunca relê o Firestore)', async () => {
    const items = [{ id: 'BTCUSDT', symbol: 'BTCUSDT' }, { id: 'ETHUSDT', symbol: 'ETHUSDT' }];
    readFirestoreCollectionMock.mockResolvedValue(items);
    backendMock.entities.MonitoredAsset = { list: vi.fn().mockResolvedValue(items) };
    const { migrateAndVerifyCollection } = await import('./migrate-and-verify-postgres.mjs');

    const result = await migrateAndVerifyCollection('monitoredAssets', 'MonitoredAsset');

    expect(readFirestoreCollectionMock).toHaveBeenCalledTimes(1);
    expect(readFirestoreCollectionMock).toHaveBeenCalledWith('monitoredAssets');
    expect(bulkImportEntityMock).toHaveBeenCalledWith('MonitoredAsset', items);
    expect(result.ok).toBe(true);
    expect(result.firestoreItems).toBe(items); // MESMO array, não uma releitura
  });

  it('coleção com LIST_LIMIT_OVERRIDES (systemLogs) usa a variante limitada, dos dois lados', async () => {
    const items = [{ id: 'log-1', level: 'info' }];
    readFirestoreCollectionRecentMock.mockResolvedValue(items);
    const listMock = vi.fn().mockResolvedValue(items);
    backendMock.entities.SystemLog = { list: listMock };
    const { migrateAndVerifyCollection } = await import('./migrate-and-verify-postgres.mjs');

    await migrateAndVerifyCollection('systemLogs', 'SystemLog');

    expect(readFirestoreCollectionRecentMock).toHaveBeenCalledWith('systemLogs', 2000);
    expect(readFirestoreCollectionMock).not.toHaveBeenCalled();
    expect(listMock).toHaveBeenCalledWith('-created_date', 2000);
  });

  it('coleção vazia não chama bulkImportEntity', async () => {
    readFirestoreCollectionMock.mockResolvedValue([]);
    backendMock.entities.PriceAlert = { list: vi.fn().mockResolvedValue([]) };
    const { migrateAndVerifyCollection } = await import('./migrate-and-verify-postgres.mjs');

    const result = await migrateAndVerifyCollection('priceAlerts', 'PriceAlert');

    expect(bulkImportEntityMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('detecta divergência real (Postgres não bate com o que acabou de ser escrito) — sinaliza ok:false', async () => {
    readFirestoreCollectionMock.mockResolvedValue([{ id: 'op-1', status: 'RUNNER_ACTIVE' }]);
    backendMock.entities.TradeOperation = { list: vi.fn().mockResolvedValue([{ id: 'op-1', status: 'STOP_HIT' }]) };
    const { migrateAndVerifyCollection } = await import('./migrate-and-verify-postgres.mjs');

    const result = await migrateAndVerifyCollection('tradeOperations', 'TradeOperation');

    expect(result.ok).toBe(false);
    expect(result.checksumMatch).toBe(false);
  });
});

describe('migrateAndVerifySingleton', () => {
  it('documento existente é migrado e comparado contra o get() do Postgres', async () => {
    readFirestoreSingletonMock.mockResolvedValue([{ id: 'current', rf_period: 20 }]);
    backendMock.entities.StrategyConfig = { get: vi.fn().mockResolvedValue({ id: 'current', rf_period: 20 }) };
    const { migrateAndVerifySingleton } = await import('./migrate-and-verify-postgres.mjs');

    const result = await migrateAndVerifySingleton('strategyConfig', 'current', 'StrategyConfig');

    expect(bulkImportEntityMock).toHaveBeenCalledWith('StrategyConfig', [{ id: 'current', rf_period: 20 }]);
    expect(result.ok).toBe(true);
  });

  it('documento inexistente no Firestore não migra nem falsamente diverge (Postgres também vazio)', async () => {
    readFirestoreSingletonMock.mockResolvedValue([]);
    backendMock.entities.TelegramFilters = { get: vi.fn().mockResolvedValue(null) };
    const { migrateAndVerifySingleton } = await import('./migrate-and-verify-postgres.mjs');

    const result = await migrateAndVerifySingleton('telegramFilters', 'current', 'TelegramFilters');

    expect(bulkImportEntityMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
