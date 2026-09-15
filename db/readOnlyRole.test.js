// Prova, contra Postgres REAL (não simulado), que uma role com só GRANT
// SELECT bloqueia escrita de verdade — o mecanismo que scripts/health-audit.mjs
// passa a depender de (DATABASE_URL_READONLY, item 179). Não prova nada sobre
// o Neon de produção em si (fora do alcance desta sessão — a criação da role
// lá é um passo manual do usuário, ver docs/known-risks.md item 179), prova
// que o MECANISMO (GRANT do Postgres) funciona, que é o que o código pode
// garantir a partir daqui.
//
// Gated por TEST_DATABASE_URL, banco COMPARTILHADO (mesmo padrão de
// schema.test.js) — cria/derruba uma role de CLUSTER com nome sufixado por
// timestamp+random (roles não são escopadas a um banco, então nunca colide
// com outra execução em paralelo), sem TRUNCATE em tabela nenhuma, então sem
// risco de corrida com os outros arquivos de db/ (ver db/CLAUDE.md).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { applySchema } from './migrate.mjs';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function withCredentials(baseUrl, user, password) {
  const url = new URL(baseUrl);
  url.username = user;
  url.password = password;
  return url.toString();
}

describe.skipIf(!TEST_DATABASE_URL)('role Postgres somente-leitura (mecanismo real do GRANT, item 179)', () => {
  const roleName = `health_audit_ro_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const rolePassword = 'ci_test_only_password';
  let adminClient;
  let roClient;
  let dbName;

  beforeAll(async () => {
    adminClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await adminClient.connect();
    await applySchema(TEST_DATABASE_URL);
    dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
    await adminClient.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePassword}'`);
    await adminClient.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${roleName}"`);
    await adminClient.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await adminClient.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
    roClient = new pg.Client({ connectionString: withCredentials(TEST_DATABASE_URL, roleName, rolePassword) });
    await roClient.connect();
  });

  afterAll(async () => {
    await roClient?.end();
    // Precisa revogar TUDO que foi concedido no beforeAll (tabelas, schema,
    // database) antes do DROP ROLE — sobrar qualquer privilégio faz o
    // Postgres recusar o DROP com "cannot be dropped because some objects
    // depend on it".
    await adminClient.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "${roleName}"`);
    await adminClient.query(`REVOKE USAGE ON SCHEMA public FROM "${roleName}"`);
    await adminClient.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM "${roleName}"`);
    await adminClient.query(`DROP ROLE IF EXISTS "${roleName}"`);
    await adminClient.end();
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
