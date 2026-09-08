// Extracted from src/lib/__fixtures__/fakeBackend.js (docs/known-risks.md
// item 136, Codex review PR #267) into a shared production module — direct
// regression test for the merge semantics. fakeBackend.test.js keeps
// covering it indirectly through StrategyConfig/TelegramFilters' `set`, but
// this is the one that will matter again once a Postgres-backed adapter's
// JSONB `set` needs the SAME recursive-merge semantics as Firestore's
// `setDoc(ref, data, {merge:true})` (the `||` JSONB operator is shallow).
import { describe, it, expect } from 'vitest';
import { deepMergeFirestore } from './deepMergeFirestore.js';

describe('deepMergeFirestore', () => {
  it('merges nested plain objects, preserving sibling keys not mentioned in the incoming patch', () => {
    const existing = { sources: { rf: true, macd: true, rsi: false } };
    const incoming = { sources: { macd: false } };
    expect(deepMergeFirestore(existing, incoming)).toEqual({ sources: { rf: true, macd: false, rsi: false } });
  });

  it('replaces (never merges) an array field, matching Firestore semantics', () => {
    const existing = { eventIds: ['a', 'b', 'c'] };
    const incoming = { eventIds: ['x'] };
    expect(deepMergeFirestore(existing, incoming)).toEqual({ eventIds: ['x'] });
  });

  it('overwrites a top-level scalar field', () => {
    expect(deepMergeFirestore({ minScore: 75, tp1R: 1.5 }, { tp1R: 2.0 })).toEqual({ minScore: 75, tp1R: 2.0 });
  });

  it('does not merge a Date instance as if it were a plain object', () => {
    const oldDate = new Date('2026-01-01T00:00:00.000Z');
    const newDate = new Date('2026-02-01T00:00:00.000Z');
    expect(deepMergeFirestore({ updated_at: oldDate }, { updated_at: newDate }).updated_at).toBe(newDate);
  });

  it('replaces a nested object with a new nested object when the existing value was not an object', () => {
    expect(deepMergeFirestore({ sources: null }, { sources: { rf: true } })).toEqual({ sources: { rf: true } });
  });

  it('merges recursively at more than one level of nesting', () => {
    const existing = { a: { b: { c: 1, d: 2 } } };
    const incoming = { a: { b: { c: 99 } } };
    expect(deepMergeFirestore(existing, incoming)).toEqual({ a: { b: { c: 99, d: 2 } } });
  });
});
