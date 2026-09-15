// Prova, contra Postgres REAL, que db/schema.sql aplica limpo mesmo quando
// o banco já tem duplicatas herdadas do find-then-write não atômico
// anterior ao índice único de asset_states (item 179 — ver o comentário no
// próprio schema.sql). Cenário real de produção: o adaptador criava via ID
// auto-gerado e localizava um estado existente por
// filter({asset_id,timeframe}) antes de update() — check-then-write, não
// atômico — então é plausível que produção acumule mais de uma linha por
// par antes desta migração rodar lá.
//
// Roda num BANCO DE TESTE PRÓPRIO (mesmo padrão de db/concurrency.test.js):
// precisa criar `asset_states` manualmente SEM o índice único, para semear
// duplicatas cruas simulando o "antes" — no TEST_DATABASE_URL compartilhado
// o índice já existe (aplicado por outro arquivo de teste em paralelo), não
// dá pra semear duplicata nenhuma ali.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { applySchema } from './migrate.mjs';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function withDbName(baseUrl, dbName) {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!TEST_DATABASE_URL)('dedup de asset_states antes do índice único (upgrade de produção)', () => {
  let adminClient;
  let client;
  let dbName;
  let dbUrl;

  beforeAll(async () => {
    dbName = `assetstates_dedup_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    dbUrl = withDbName(TEST_DATABASE_URL, dbName);
    adminClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${dbName}"`);

    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    // Shape "antigo" — sem o índice único, igual à produção antes desta
    // mudança.
    await client.query(`
      CREATE TABLE asset_states (
        id TEXT PRIMARY KEY, asset_id TEXT, timeframe TEXT,
        created_date TIMESTAMPTZ, data JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    await client.query(`
      INSERT INTO asset_states (id, asset_id, timeframe, created_date, data) VALUES
        ('old-1', 'BTCUSDT', '1h', now(), '{"processed_at":"2026-09-01T00:00:00.000Z"}'),
        ('old-2', 'BTCUSDT', '1h', now(), '{"processed_at":"2026-09-10T00:00:00.000Z"}'),
        ('old-3', 'BTCUSDT', '4h', now(), '{"processed_at":"2026-09-05T00:00:00.000Z"}'),
        ('legacy-null-1', NULL, NULL, now(), '{}'),
        ('legacy-null-2', NULL, NULL, now(), '{}');
    `);
  });

  afterAll(async () => {
    await client.end();
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminClient.end();
  });

  it('applySchema roda limpo e colapsa duplicatas mantendo o processed_at mais recente', async () => {
    await applySchema(dbUrl);

    const { rows } = await client.query(
      `SELECT id FROM asset_states WHERE asset_id = 'BTCUSDT' AND timeframe = '1h'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('old-2'); // processed_at mais recente

    const { rows: tf4h } = await client.query(
      `SELECT id FROM asset_states WHERE asset_id = 'BTCUSDT' AND timeframe = '4h'`
    );
    expect(tf4h).toHaveLength(1); // não tinha duplicata, não deveria ter sido tocado
    expect(tf4h[0].id).toBe('old-3');
  });

  it('linhas com asset_id/timeframe NULL não são tocadas pela dedup', async () => {
    const { rows } = await client.query(`SELECT id FROM asset_states WHERE asset_id IS NULL ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['legacy-null-1', 'legacy-null-2']);
  });

  it('o índice único agora existe e bloqueia uma nova duplicata', async () => {
    await expect(
      client.query(
        `INSERT INTO asset_states (id, asset_id, timeframe, created_date, data) VALUES ('new-dup', 'BTCUSDT', '1h', now(), '{}')`
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('reaplicar applySchema é idempotente (2ª rodada não encontra nada pra deduplicar)', async () => {
    await applySchema(dbUrl);
    const { rows } = await client.query(
      `SELECT id FROM asset_states WHERE asset_id = 'BTCUSDT' AND timeframe = '1h'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('old-2');
  });
});
