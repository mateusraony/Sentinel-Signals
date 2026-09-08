// Extracted from src/lib/__fixtures__/fakeBackend.js (docs/known-risks.md
// item 136) into a shared production module — this file is the direct
// regression test for the guard itself. fakeBackend.test.js keeps covering
// it indirectly through StrategyConfig/TelegramFilters' set(id, data), but
// this is the one that will matter again once a Postgres-backed adapter
// (whose JSONB silently drops `undefined` instead of throwing) needs to
// call the same guard before INSERT/UPDATE.
import { describe, it, expect } from 'vitest';
import { assertNoUndefinedFields } from './assertNoUndefinedFields.js';

describe('assertNoUndefinedFields', () => {
  it('does not throw for a payload with no undefined fields', () => {
    expect(() => assertNoUndefinedFields({ status: 'RUNNER_ACTIVE', current_stop: 100, tags: ['a', 'b'] }, 'TradeOperation')).not.toThrow();
  });

  it('throws with the Firestore-style message for a top-level undefined field', () => {
    expect(() => assertNoUndefinedFields({ tier: undefined }, 'TradeOperation')).toThrow(
      /Cannot use "undefined" as a Firestore value \(found in field "tier"\)/
    );
  });

  it('throws for an undefined value nested inside a plain object', () => {
    expect(() => assertNoUndefinedFields({ details: { reason: undefined } }, 'SystemLog')).toThrow(
      /field "details\.reason"/
    );
  });

  it('throws for an undefined value nested inside an array element', () => {
    expect(() => assertNoUndefinedFields({ items: [{ ok: true }, { ok: undefined }] }, 'SignalEvent')).toThrow(
      /field "items\[1\]\.ok"/
    );
  });

  it('does not treat a Date instance as a plain object to recurse into', () => {
    expect(() => assertNoUndefinedFields({ created_date: new Date('2026-01-01T00:00:00.000Z') }, 'AssetState')).not.toThrow();
  });

  it('does not treat null as a plain object to recurse into', () => {
    expect(() => assertNoUndefinedFields({ pd_zone: null }, 'TradeOperation')).not.toThrow();
  });
});
