// buildPgDumpArgs é puro (testável sem pg_dump instalado); o round-trip
// real (pg_dump -> TRUNCATE -> pg_restore) roda contra Postgres REAL,
// gated por TEST_DATABASE_URL — mesma convenção de db/pgEntitiesCore.test.js
// (describe.skipIf), já que este script existe especificamente para provar
// que o binário `pg_dump`/`pg_restore` (não um mock) faz o que o comentário
// do arquivo promete: inclui o que deveria, exclui o que não deveria, e o
// dado volta intacto depois de um restore.
//
// Roda num BANCO DE TESTE PRÓPRIO (CREATE DATABASE, não a TEST_DATABASE_URL
// compartilhada) — achado rodando a suíte completa nesta sessão: vitest
// executa arquivos de teste em paralelo por padrão, e os outros arquivos
// gated por TEST_DATABASE_URL (db/schema.test.js, db/concurrency.test.js,
// db/pgEntitiesCore.test.js) TRUNCAM/escrevem nas MESMAS tabelas
// compartilhadas (monitored_assets, users, etc.) — um DROP/CREATE TABLE via
// `pg_restore --clean` deste arquivo rodando ao mesmo tempo que um INSERT de
// outro arquivo produz erros incoerentes ("relation does not exist",
// contagem errada), a assinatura clássica de uma corrida entre arquivos, não
// um bug de lógica. Um banco próprio (criado/apagado neste describe) isola
// esse round-trip destrutivo por completo — nenhuma consulta crua aqui usa
// `backend.entities`/`getPool()` compartilhados de propósito, exatamente
// para nunca mexer no `process.env.DATABASE_URL` global que outros arquivos
// também setam no próprio beforeAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
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

function withDbName(baseUrl, dbName) {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!TEST_DATABASE_URL)('backup-postgres.mjs — pg_dump/pg_restore reais (banco isolado)', () => {
  let applySchema;
  let adminClient;
  let dbName;
  let dbUrl;
  let tmpDir;

  beforeAll(async () => {
    ({ applySchema } = await import('../db/migrate.mjs'));
    dbName = `backup_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    dbUrl = withDbName(TEST_DATABASE_URL, dbName);
    adminClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
    await applySchema(dbUrl);
    tmpDir = mkdtempSync(path.join(tmpdir(), 'backup-postgres-test-'));
  });

  afterAll(async () => {
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminClient.end();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('o dump inclui monitored_assets e tradingview_webhook_events, mas NUNCA users — o restore prova isso', async () => {
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO monitored_assets (id, symbol, is_active, data) VALUES ('asset-1', 'BTCUSDT', true, '{"symbol":"BTCUSDT","is_active":true}'::jsonb)`
      );
      await client.query(
        `INSERT INTO users (id, data) VALUES ('user-1', '{"role":"user","email":"test@example.com"}'::jsonb)`
      );
      await client.query(
        `INSERT INTO tradingview_webhook_events (id, data) VALUES ('sig-1', '{"symbol":"BTCUSDT"}'::jsonb)`
      );

      const dumpPath = path.join(tmpDir, 'test.dump');
      const dumpResult = spawnSync('pg_dump', buildPgDumpArgs(dbUrl, dumpPath));
      expect(dumpResult.status).toBe(0);

      // Apaga tudo — o restore que vem a seguir é o que prova o conteúdo do dump.
      await client.query('TRUNCATE monitored_assets, users, tradingview_webhook_events');

      const restoreResult = spawnSync('pg_restore', [
        '--clean', '--if-exists', '--no-owner', '--no-privileges',
        '--dbname', dbUrl, dumpPath,
      ]);
      // pg_restore pode sair com status != 0 por avisos não-fatais (ex.: um
      // DROP de objeto que não existia); o que prova o restore de verdade é
      // o dado de volta no banco — as asserções abaixo — não o código de
      // saída sozinho. Se o restore falhou de verdade, os asserts abaixo
      // pegam isso (a tabela continuaria vazia).
      if (restoreResult.status !== 0) {
        console.warn('[test] pg_restore saiu com status', restoreResult.status, restoreResult.stderr?.toString());
      }

      const assets = (await client.query('SELECT id, symbol FROM monitored_assets')).rows;
      expect(assets).toHaveLength(1);
      expect(assets[0].symbol).toBe('BTCUSDT');

      const events = (await client.query('SELECT id FROM tradingview_webhook_events')).rows;
      expect(events.map((r) => r.id)).toEqual(['sig-1']);

      // users nunca esteve no dump — TRUNCATE deixou vazio, e o restore não
      // o repovoou (a prova real de que --exclude-table=users funcionou).
      const users = (await client.query('SELECT id FROM users')).rows;
      expect(users).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
