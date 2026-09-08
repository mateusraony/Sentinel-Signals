// Integration test contra Postgres REAL (não um fake/mock) — gated por
// TEST_DATABASE_URL porque a suíte padrão (`npm test`) não depende de um
// banco disponível. Rodar localmente:
//   TEST_DATABASE_URL=postgresql://user:pass@localhost/dbname npx vitest run db/schema.test.js
// No CI, `services: postgres:` do ci.yml provê essa URL (fase seguinte do
// plano de migração).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { applySchema } from './migrate.mjs';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('db/schema.sql', () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('applies cleanly and is idempotent (rerunning does not error)', async () => {
    await applySchema(TEST_DATABASE_URL);
    await applySchema(TEST_DATABASE_URL);
  });

  it('creates every table the adapter expects', async () => {
    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name;
    `);
    const tableNames = rows.map((r) => r.table_name);
    expect(tableNames).toEqual(expect.arrayContaining([
      'monitored_assets', 'asset_states', 'signal_events', 'trade_operations',
      'price_alerts', 'system_logs', 'users', 'verification_tasks',
      'tradingview_webhook_events', 'strategy_config', 'telegram_filters',
      'scanner_locks',
    ]));
  });

  it('the active-anchor unique index exists and is partial (only non-terminal statuses)', async () => {
    const { rows } = await client.query(`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'trade_operations' AND indexname = 'trade_operations_active_anchor_uq';
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE INDEX/);
    expect(rows[0].indexdef).toMatch(/WHERE/);
  });
});
