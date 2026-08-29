// docs/known-risks.md item 136 (final sweep) — fakeBackend.js is itself the
// safety net that should catch a literal `undefined` field before it ever
// reaches a real Firestore write in production; it had none until the P0-h
// incident, and even after that fix, `StrategyConfig`/`TelegramFilters`
// (written via `set(id, data)`, not `create`/`update`) were missing from
// its COLLECTIONS list entirely — no test could have exercised that write
// path through the fake, the exact blind spot that hid the original bug.
// This file tests the fake's own guard directly, not scanner.js.
import { describe, it, expect } from 'vitest';
import { createFakeBackend } from './fakeBackend.js';

describe('fakeBackend — StrategyConfig/TelegramFilters via set(id, data)', () => {
  it('set() rejects a literal undefined field, same as every other write method', async () => {
    const backend = createFakeBackend();
    await expect(
      backend.entities.StrategyConfig.set('current', { minScore: 75, tp1R: undefined })
    ).rejects.toThrow(/Cannot use "undefined" as a Firestore value.*field "tp1R"/);
  });

  it('set() rejects an undefined field nested inside the payload (recursive guard)', async () => {
    const backend = createFakeBackend();
    await expect(
      backend.entities.TelegramFilters.set('current', { sources: { rf: true, macd: undefined } })
    ).rejects.toThrow(/field "sources\.macd"/);
  });

  it('set() with a clean payload persists and merges over the existing doc (setDoc merge:true semantics)', async () => {
    const backend = createFakeBackend();
    await backend.entities.StrategyConfig.set('current', { minScore: 75, tp1R: 1.5 });
    await backend.entities.StrategyConfig.set('current', { tp1R: 2.0 });

    const [doc] = await backend.entities.StrategyConfig.filter({});
    expect(doc.minScore).toBe(75); // preserved from the first set — merge, not overwrite
    expect(doc.tp1R).toBe(2.0); // updated by the second set
  });
});
