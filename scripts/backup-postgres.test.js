// buildPgDumpArgs é puro (testável sem pg_dump instalado); o round-trip
// real (pg_dump -> TRUNCATE -> pg_restore) roda contra Postgres REAL,
// gated por TEST_DATABASE_URL — mesma convenção de db/pgEntitiesCore.test.js
// (describe.skipIf), já que este script existe especificamente para provar
// que o binário `pg_dump`/`pg_restore` (não um mock) faz o que o comentário
// do arquivo promete: inclui o que deveria, exclui o que não deveria, e o
// dado volta intacto depois de um restore.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPgDumpArgs, EXCLUDED_TABLES } from './backup-postgres.mjs';

describe('buildPgDumpArgs', () => {
  it('usa --format=custom, --no-owner, --no-privileges e --file com o path pedido', () => {
    const args = buildPgDumpArgs('postgresql://u:p@host/db', '/tmp/out.dump');
    expect(args[0]).toBe('postgresql://u:p@host/db');
    expect(args).toContain('--format=custom');
    expect(args).toContain('--no-owner');
    expect(args).toContain('--no-privileges');
    expect(args).toEqual(expect.arrayContaining(['--file', '/tmp/out.dump']));
  });

  it('exclui users e scanner_locks', () => {
    const args = buildPgDumpArgs('postgresql://u:p@host/db', '/tmp/out.dump');
    expect(args).toContain('--exclude-table=users');
    expect(args).toContain('--exclude-table=scanner_locks');
  });

  it('não exclui tradingview_webhook_events (log de auditoria, fica no backup de propósito)', () => {
    const args = buildPgDumpArgs('postgresql://u:p@host/db', '/tmp/out.dump');
    expect(args).not.toContain('--exclude-table=tradingview_webhook_events');
  });

  it('EXCLUDED_TABLES é exatamente users + scanner_locks (documenta a decisão de escopo)', () => {
    expect(EXCLUDED_TABLES.sort()).toEqual(['scanner_locks', 'users']);
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('backup-postgres.mjs — pg_dump/pg_restore reais', () => {
  let applySchema;
  let backend;
  let getPool;
  let closePool;
  let tmpDir;

  beforeAll(async () => {
    ({ applySchema } = await import('../db/migrate.mjs'));
    ({ backend, getPool, closePool } = await import('../db/pgEntitiesCore.mjs'));
    await applySchema(TEST_DATABASE_URL);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    tmpDir = mkdtempSync(path.join(tmpdir(), 'backup-postgres-test-'));
  });

  afterAll(async () => {
    await closePool();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const pool = getPool(TEST_DATABASE_URL);
    await pool.query('TRUNCATE monitored_assets, users, tradingview_webhook_events');
  });

  it('o dump inclui monitored_assets e tradingview_webhook_events, mas NUNCA users — o restore prova isso', async () => {
    await backend.entities.MonitoredAsset.create({ symbol: 'BTCUSDT', is_active: true });
    await backend.entities.User.create({ role: 'user', email: 'test@example.com' });
    const pool = getPool(TEST_DATABASE_URL);
    await pool.query(
      "INSERT INTO tradingview_webhook_events (id, data) VALUES ('sig-1', '{\"symbol\":\"BTCUSDT\"}'::jsonb)"
    );

    const dumpPath = path.join(tmpDir, 'test.dump');
    const dumpResult = spawnSync('pg_dump', buildPgDumpArgs(TEST_DATABASE_URL, dumpPath));
    expect(dumpResult.status).toBe(0);

    // Apaga tudo — o restore que vem a seguir é o que prova o conteúdo do dump.
    await pool.query('TRUNCATE monitored_assets, users, tradingview_webhook_events');
    expect(await backend.entities.MonitoredAsset.list()).toHaveLength(0);

    const restoreResult = spawnSync('pg_restore', [
      '--clean', '--if-exists', '--no-owner', '--no-privileges',
      '--dbname', TEST_DATABASE_URL, dumpPath,
    ]);
    // pg_restore pode sair com status != 0 por avisos não-fatais (ex.: um
    // DROP de objeto que não existia); o que prova o restore de verdade é o
    // dado de volta no banco — as asserções abaixo — não o código de
    // saída sozinho. Se o restore falhou de verdade, os asserts abaixo
    // pegam isso (a tabela continuaria vazia).
    if (restoreResult.status !== 0) {
      console.warn('[test] pg_restore saiu com status', restoreResult.status, restoreResult.stderr?.toString());
    }

    const assets = await backend.entities.MonitoredAsset.list();
    expect(assets).toHaveLength(1);
    expect(assets[0].symbol).toBe('BTCUSDT');

    const { rows } = await pool.query('SELECT id FROM tradingview_webhook_events');
    expect(rows.map((r) => r.id)).toEqual(['sig-1']);

    // users nunca esteve no dump — TRUNCATE deixou vazio, e o restore não
    // o repovoou (a prova real de que --exclude-table=users funcionou).
    expect(await backend.entities.User.list()).toHaveLength(0);
  });
});
