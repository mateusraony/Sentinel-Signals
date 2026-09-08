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
});
