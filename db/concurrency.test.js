// Prova, contra Postgres REAL com 2 conexões de cliente DISTINTAS (não um
// fake/mock, não a mesma conexão), que o índice único parcial
// `trade_operations_active_anchor_uq` fecha a lacuna que o
// sentinel-council-review identificou no redesenho do CAS: um
// `SELECT ... FOR UPDATE` sozinho não trava linhas que ainda não existem,
// então duas transações concorrentes criando a PRIMEIRA operação de um
// ativo poderiam ambas decidir `create` e ambas commitar — 2 operações
// ativas para o mesmo ativo. Este arquivo testa só o mecanismo do BANCO
// (o índice); a decisão pura (`planTradeOpCreationSql`,
// src/lib/opTransition.js) já tem sua própria cobertura em
// opTransition.test.js — não duplicada aqui.
//
// Gated por TEST_DATABASE_URL, mesmo padrão de schema.test.js.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { applySchema } from './migrate.mjs';
import { buildActiveOpsAnchorId } from '../src/lib/opTransition.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Mimics the create-if-none-active shape a future db/pgEntitiesCore.cjs
// would use: SELECT...FOR UPDATE (real in a live adapter, kept here for
// realism even though this test's whole point is that it does NOT protect
// an as-yet-nonexistent row) then an INSERT that either succeeds or hits
// the unique constraint.
async function attemptCreate(client, { id, assetId, cascade, hierarchicalCascade }) {
  const anchor = buildActiveOpsAnchorId(assetId, cascade);
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT id FROM trade_operations WHERE asset_id = $1 AND status NOT IN ('STOP_HIT','TP2_HIT','INVALIDATED','CLOSED') FOR UPDATE`,
      [assetId]
    );
    await client.query(
      `INSERT INTO trade_operations (id, asset_id, status, cascade, hierarchical_cascade, active_ops_anchor, created_date)
       VALUES ($1, $2, 'SIGNAL_CONFIRMED', $3, $4, $5, now())`,
      [id, assetId, cascade ?? null, hierarchicalCascade ?? null, anchor]
    );
    await client.query('COMMIT');
    return { created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') { // unique_violation
      return { created: false, code: err.code };
    }
    throw err;
  }
}

describe.skipIf(!TEST_DATABASE_URL)('trade_operations_active_anchor_uq (real concurrency)', () => {
  let clientA;
  let clientB;

  beforeAll(async () => {
    await applySchema(TEST_DATABASE_URL);
    clientA = new pg.Client({ connectionString: TEST_DATABASE_URL });
    clientB = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await clientA.connect();
    await clientB.connect();
  });

  afterAll(async () => {
    await clientA.end();
    await clientB.end();
  });

  beforeEach(async () => {
    await clientA.query('DELETE FROM trade_operations');
  });

  // The council's exact scenario: two DISTINCT connections, same asset_id,
  // zero existing rows (nothing for FOR UPDATE to lock), racing to create
  // the FIRST op — repeated in a loop because network/scheduling races are
  // non-deterministic and a single green run proves nothing (council's
  // testing-role recommendation).
  it('exactly one of two concurrent connections creates the first op for a brand-new asset (repeated 25x)', async () => {
    for (let i = 0; i < 25; i++) {
      const assetId = `race-asset-${i}`;
      const [resultA, resultB] = await Promise.all([
        attemptCreate(clientA, { id: `op-${i}-a`, assetId }),
        attemptCreate(clientB, { id: `op-${i}-b`, assetId }),
      ]);
      const outcomes = [resultA.created, resultB.created];
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(outcomes.filter((c) => c === false)).toHaveLength(1);

      const { rows } = await clientA.query(
        `SELECT id FROM trade_operations WHERE asset_id = $1 AND status NOT IN ('STOP_HIT','TP2_HIT','INVALIDATED','CLOSED')`,
        [assetId]
      );
      expect(rows).toHaveLength(1); // never both, never zero
    }
  });

  it('two DIFFERENT hierarchical cascades on the same asset both commit (granularity is (asset,cascade), not just asset)', async () => {
    const assetId = 'hier-asset-1';
    const [resultA, resultB] = await Promise.all([
      attemptCreate(clientA, { id: 'op-hier-a', assetId, cascade: '4h_15m', hierarchicalCascade: true }),
      attemptCreate(clientB, { id: 'op-hier-b', assetId, cascade: '1h_5m', hierarchicalCascade: true }),
    ]);
    expect(resultA.created).toBe(true);
    expect(resultB.created).toBe(true);

    const { rows } = await clientA.query(
      `SELECT id FROM trade_operations WHERE asset_id = $1 AND status NOT IN ('STOP_HIT','TP2_HIT','INVALIDATED','CLOSED')`,
      [assetId]
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['op-hier-a', 'op-hier-b']);
  });

  it('a terminal status clears the anchor, letting a brand-new op reuse the same (asset,cascade) slot', async () => {
    const assetId = 'terminal-asset-1';
    await attemptCreate(clientA, { id: 'op-old', assetId });
    await clientA.query(
      `UPDATE trade_operations SET status = 'STOP_HIT', active_ops_anchor = NULL WHERE id = 'op-old'`
    );
    const result = await attemptCreate(clientA, { id: 'op-new', assetId });
    expect(result.created).toBe(true);
  });
});
