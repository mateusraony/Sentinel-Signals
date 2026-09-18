// Prova, contra Postgres REAL (não simulado), que uma role com só GRANT
// SELECT bloqueia escrita de verdade — o mecanismo que scripts/health-audit.mjs
// passa a depender de (DATABASE_URL_READONLY, item 179). Não prova nada sobre
// o Neon de produção em si (fora do alcance desta sessão — a criação da role
// lá é um passo manual do usuário, ver docs/known-risks.md item 179), prova
// que o MECANISMO (GRANT do Postgres) funciona, que é o que o código pode
// garantir a partir daqui.
//
// Gated por TEST_DATABASE_URL. Roda num BANCO DE TESTE PRÓPRIO (CREATE
// DATABASE, não a TEST_DATABASE_URL compartilhada) — mesmo padrão de
// db/concurrency.test.js/scripts/backup-postgres.test.js. Achado real (CI,
// 2026-09-18): a suposição original aqui era "sem TRUNCATE em tabela
// nenhuma, então sem risco de corrida com os outros arquivos de db/" — mas
// GRANT/REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public são operações
// de CATÁLOGO (metadados de privilégio de TODAS as tabelas do schema), não
// de linha — quando outro arquivo de db/ roda DDL/escrita concorrente no
// mesmo schema compartilhado (vitest roda arquivos em paralelo por padrão),
// os dois processos colidem na mesma linha de catálogo do Postgres,
// produzindo "tuple concurrently updated" (XX000). Mesma CLASSE de bug que
// já motivou isolar concurrency.test.js/backup-postgres.test.js (lá era
// TRUNCATE vs. INSERT/SELECT; aqui é GRANT/REVOKE vs. qualquer DDL
// concorrente) — mesmo padrão de banco isolado resolve, sem mecanismo novo.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { applySchema } from './migrate.mjs';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function withDbName(baseUrl, dbName) {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function withCredentials(baseUrl, user, password) {
  const url = new URL(baseUrl);
  url.username = user;
  url.password = password;
  return url.toString();
}

describe.skipIf(!TEST_DATABASE_URL)('role Postgres somente-leitura (mecanismo real do GRANT, item 179)', () => {
  const roleName = `health_audit_ro_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const rolePassword = 'ci_test_only_password';
  let clusterAdmin; // conectado à TEST_DATABASE_URL — só p/ CREATE/DROP DATABASE (cluster-wide)
  let adminClient;  // conectado ao banco ISOLADO desta suíte
  let roClient;
  let dbName;

  beforeAll(async () => {
    dbName = `readonly_role_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    clusterAdmin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await clusterAdmin.connect();
    await clusterAdmin.query(`CREATE DATABASE "${dbName}"`);
    const dbUrl = withDbName(TEST_DATABASE_URL, dbName);
    await applySchema(dbUrl);
    adminClient = new pg.Client({ connectionString: dbUrl });
    await adminClient.connect();
    await adminClient.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePassword}'`);
    await adminClient.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${roleName}"`);
    await adminClient.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await adminClient.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
    roClient = new pg.Client({ connectionString: withCredentials(dbUrl, roleName, rolePassword) });
    await roClient.connect();
  });

  afterAll(async () => {
    await roClient?.end();
    await adminClient?.end();
    // DROP DATABASE primeiro: ele já limpa as dependências de privilégio
    // (pg_shdepend) que os GRANTs de tabela/schema/database do beforeAll
    // criaram para a role DENTRO deste banco — não precisa mais de REVOKE
    // manual antes (isso só existia pra permitir o DROP ROLE no banco
    // COMPARTILHADO de antes). CREATE/DROP ROLE são cluster-wide, então só
    // podem ser dropados DEPOIS que o banco que referenciava a role sumiu.
    await clusterAdmin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await clusterAdmin.query(`DROP ROLE IF EXISTS "${roleName}"`);
    await clusterAdmin.end();
  });

  it('SELECT funciona normalmente com a role somente-leitura', async () => {
    const { rows } = await roClient.query('SELECT count(*)::int AS n FROM asset_states');
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it('INSERT é rejeitado com permission denied (42501)', async () => {
    await expect(
      roClient.query(`INSERT INTO asset_states (id, asset_id, timeframe, data) VALUES ('ro-test', 'X', '1h', '{}'::jsonb)`)
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('UPDATE é rejeitado com permission denied', async () => {
    await expect(
      roClient.query(`UPDATE asset_states SET data = '{}'::jsonb WHERE id = 'nonexistent'`)
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('DELETE é rejeitado com permission denied', async () => {
    await expect(
      roClient.query(`DELETE FROM asset_states WHERE id = 'nonexistent'`)
    ).rejects.toMatchObject({ code: '42501' });
  });
});
