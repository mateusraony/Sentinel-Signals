import { describe, it, expect } from 'vitest';
import { checkCollectionAccess } from './entityCollectionGuard.js';

const ENTITY_TABLES = {
  MonitoredAsset: {}, AssetState: {}, TradeOperation: {}, User: {},
};

describe('checkCollectionAccess', () => {
  it('allows a normal business collection', () => {
    expect(checkCollectionAccess(ENTITY_TABLES, 'TradeOperation')).toEqual({ allowed: true });
  });

  it('404s a collection outside ENTITY_TABLES — never queries a free-form table', () => {
    const result = checkCollectionAccess(ENTITY_TABLES, 'NotARealCollection');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe(404);
  });

  // Regression: the first version of this route only blocked changing
  // `role` in a PATCH — GET/PATCH/DELETE of ANY uid's profile (and a
  // list/filter dumping the WHOLE users table, email+role included) went
  // straight through. `User` is "dono only" in firestore.rules today; the
  // generic route has no owner-scoping concept, so it's blocked entirely
  // instead of trying to bolt one on just for this collection.
  it('blocks the User collection entirely, regardless of which uid is targeted', () => {
    const result = checkCollectionAccess(ENTITY_TABLES, 'User');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/api\/me/);
  });

  // Achado P0 (sentinel-security-review, 2026-09-14): TradeOperation tinha
  // rota CAS dedicada (server/routes/tradeOps.js) E a rota CRUD genérica —
  // um PATCH direto por aqui contornava a máquina de estados inteira.
  it('allows GET on TradeOperation (read-only)', () => {
    expect(checkCollectionAccess(ENTITY_TABLES, 'TradeOperation', 'GET')).toEqual({ allowed: true });
  });

  it('blocks every write verb on TradeOperation, pointing to /api/trade-ops', () => {
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      const result = checkCollectionAccess(ENTITY_TABLES, 'TradeOperation', method);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/api\/trade-ops/);
    }
  });

  it('does not block writes on other business collections', () => {
    expect(checkCollectionAccess(ENTITY_TABLES, 'MonitoredAsset', 'PATCH')).toEqual({ allowed: true });
    expect(checkCollectionAccess(ENTITY_TABLES, 'AssetState', 'DELETE')).toEqual({ allowed: true });
  });

  it('defaults the method to GET when the caller omits it (backward compatible)', () => {
    expect(checkCollectionAccess(ENTITY_TABLES, 'TradeOperation')).toEqual({ allowed: true });
  });
});
