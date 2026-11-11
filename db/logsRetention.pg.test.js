// Retenção do system_logs contra Postgres REAL (item 298): prova o SQL (corte estrito, linha sem data intocada, lotes, trava de "sem logs recentes").
// Gated por TEST_DATABASE_URL, igual a schema.test.js. Roda num BANCO PRÓPRIO (CREATE DATABASE descartável): `db/pgEntitiesCore.test.js` faz
// `TRUNCATE ... system_logs` no beforeEach e o vitest roda arquivos em paralelo — no mesmo banco, o TRUNCATE de lá apagaria as linhas daqui
// no meio do teste (mesma razão e mesmo padrão de `db/concurrency.test.js`).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { applySchema } from './migrate.mjs';
import { runLogsRetention } from './logsRetention.mjs';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DAY = 86400000;
const MIN = 60000;
const NOW = Date.parse('2026-11-11T12:00:00Z');

function withDbName(baseUrl, dbName) {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!TEST_DATABASE_URL)('retenção do system_logs (Postgres real)', () => {
  let admin;
  let dbName;
  let pool;

  beforeAll(async () => {
    dbName = `logs_retention_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const dbUrl = withDbName(TEST_DATABASE_URL, dbName);
    admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await applySchema(dbUrl);
    pool = new pg.Pool({ connectionString: dbUrl });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE system_logs');
  });

  /** id, nível e "idade" em ms (null = linha sem data). O conteúdo (data) é um JSON qualquer, que a rotina nunca lê. */
  async function seed(rows) {
    for (const [id, level, ageMs] of rows) {
      await pool.query(
        'INSERT INTO system_logs (id, level, created_date, data) VALUES ($1, $2, $3, $4)',
        [id, level, ageMs === null ? null : new Date(NOW - ageMs).toISOString(), JSON.stringify({ message: `log ${id}` })]
      );
    }
  }
  const ids = async () => (await pool.query('SELECT id FROM system_logs ORDER BY id')).rows.map((r) => r.id);

  const MIXED = [
    ['a-45d', 'info', 45 * DAY],
    ['b-31d', 'error', 31 * DAY],
    ['c-30d-e-1min', 'warn', 30 * DAY + MIN], // 1 min mais velho que o corte: apaga
    ['d-30d-exato', 'info', 30 * DAY],         // EXATAMENTE no corte: fica (comparação estrita)
    ['e-29d', 'info', 29 * DAY],
    ['f-1h', 'error', 60 * MIN],
    ['g-sem-data', 'info', null],              // sem data: nunca apaga
  ];

  it('aplicar: apaga só o que é MAIS VELHO que o corte; no corte exato, recente e sem data ficam', async () => {
    await seed(MIXED);
    const r = await runLogsRetention({ db: pool, mode: 'aplicar', days: '30', nowMs: NOW });
    expect(await ids()).toEqual(['d-30d-exato', 'e-29d', 'f-1h', 'g-sem-data']);
    expect(r).toMatchObject({ apagados: 3, aApagar: 3, total: 7, semData: 1, totalDepois: 4, pulado: null, restante: false });
  });

  it('simular: conta certo, por nível, e não apaga NADA', async () => {
    await seed(MIXED);
    const r = await runLogsRetention({ db: pool, mode: 'simular', days: '30', nowMs: NOW });
    expect((await ids()).length).toBe(7);
    expect(r).toMatchObject({ mode: 'simular', apagados: 0, aApagar: 3, total: 7, semData: 1 });
    expect(r.porNivel).toEqual({ error: 1, info: 1, warn: 1 });
    expect(r.maisAntigo).toBe(new Date(NOW - 45 * DAY).toISOString());
    expect(r.maisRecente).toBe(new Date(NOW - 60 * MIN).toISOString());
  });

  it('lotes: 12 antigos com lote de 5 saem em 3 lotes (5, 5, 2) e o recente fica', async () => {
    await seed([
      ...Array.from({ length: 12 }, (_, i) => [`old-${String(i).padStart(2, '0')}`, 'info', (40 + i) * DAY]),
      ['novo', 'info', MIN],
    ]);
    const r = await runLogsRetention({ db: pool, mode: 'aplicar', days: '30', nowMs: NOW, batchSize: 5 });
    expect(r).toMatchObject({ apagados: 12, lotes: 3, restante: false });
    expect(await ids()).toEqual(['novo']);
  });

  it('teto de lotes: apaga só o que cabe, marca "restante" e a execução seguinte termina o serviço', async () => {
    await seed([
      ...Array.from({ length: 12 }, (_, i) => [`old-${String(i).padStart(2, '0')}`, 'info', (40 + i) * DAY]),
      ['novo', 'info', MIN],
    ]);
    const primeira = await runLogsRetention({ db: pool, mode: 'aplicar', days: '30', nowMs: NOW, batchSize: 5, maxBatches: 1 });
    expect(primeira).toMatchObject({ apagados: 5, lotes: 1, restante: true });
    expect((await ids()).length).toBe(8);
    const segunda = await runLogsRetention({ db: pool, mode: 'aplicar', days: '30', nowMs: NOW, batchSize: 5, maxBatches: 10 });
    expect(segunda).toMatchObject({ apagados: 7, restante: false });
    expect(await ids()).toEqual(['novo']);
  });

  it('apaga primeiro os MAIS ANTIGOS (a fila é por data)', async () => {
    // Inseridos DE PROPÓSITO fora da ordem de idade: sem `ORDER BY created_date`, o Postgres devolveria a 1ª linha física ("quase"), não a mais velha.
    await seed([
      ['quase', 'info', 31 * DAY],
      ['novo', 'info', MIN],
      ['meio', 'info', 60 * DAY],
      ['mais-velho', 'info', 90 * DAY],
    ]);
    await runLogsRetention({ db: pool, mode: 'aplicar', days: '30', nowMs: NOW, batchSize: 1, maxBatches: 1 });
    expect(await ids()).toEqual(['meio', 'novo', 'quase']);
  });

  it('trava: sem NENHUM log recente (todos mais velhos que o corte) não apaga nada', async () => {
    await seed([
      ['a', 'error', 50 * DAY],
      ['b', 'error', 45 * DAY],
      ['c', 'warn', 40 * DAY],
    ]);
    const r = await runLogsRetention({ db: pool, mode: 'aplicar', days: '30', nowMs: NOW });
    expect(r).toMatchObject({ pulado: 'sem_logs_recentes', apagados: 0, aApagar: 3 });
    expect(await ids()).toEqual(['a', 'b', 'c']);
  });

  it('tabela vazia: nada a fazer', async () => {
    const r = await runLogsRetention({ db: pool, mode: 'aplicar', days: '30', nowMs: NOW });
    expect(r).toMatchObject({ pulado: 'tabela_vazia', total: 0, apagados: 0 });
  });

  it('o corte respeita os dias pedidos (7 dias apaga mais que 30)', async () => {
    await seed(MIXED);
    await runLogsRetention({ db: pool, mode: 'aplicar', days: '7', nowMs: NOW });
    expect(await ids()).toEqual(['f-1h', 'g-sem-data']);
  });

  it('só mexe em system_logs: as outras tabelas continuam intactas', async () => {
    await seed(MIXED);
    // Uma linha ANTIGA em outra tabela: se a rotina apagasse fora de system_logs, seria a primeira a sumir.
    await pool.query(
      `INSERT INTO monitored_assets (id, symbol, created_date, data) VALUES ('ativo-1', 'BTCUSDT', $1, '{}'::jsonb)`,
      [new Date(NOW - 90 * DAY).toISOString()]
    );
    const contar = async () => (await pool.query('SELECT count(*)::int AS n FROM monitored_assets')).rows[0].n;
    expect(await contar()).toBe(1);
    await runLogsRetention({ db: pool, mode: 'aplicar', days: '30', nowMs: NOW });
    expect(await contar()).toBe(1);
  });
});
