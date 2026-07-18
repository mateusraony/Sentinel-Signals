// getTelegramFilters merges new default event IDs into filters saved BEFORE
// those events existed (Codex review, PR #60, known-risks.md item 29) — a
// saved `events` array missing invalidated/time_stop/chop_exit must not
// silently suppress those notifications forever.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { getTelegramFilters } from './telegram.js';

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  globalThis.localStorage = makeLocalStorage();
});

describe('getTelegramFilters', () => {
  it('returns DEFAULT_FILTERS (including the new events) when nothing is saved', () => {
    const filters = getTelegramFilters();
    expect(filters.events).toEqual(
      expect.arrayContaining(['invalidated', 'time_stop', 'chop_exit'])
    );
  });

  it('merges the new default events into a pre-existing saved filter set that predates them, and persists the migration', () => {
    localStorage.setItem('tg_filters', JSON.stringify({
      timeframes: ['1h', '4h', '1d'],
      min_priority: 'low',
      signal_types: ['BUY', 'SELL'],
      events: ['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit'], // pre-2026-07-18 shape
      min_score: 0,
    }));

    const filters = getTelegramFilters();
    expect(filters.events).toEqual(
      expect.arrayContaining(['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit', 'invalidated', 'time_stop', 'chop_exit'])
    );
    expect(filters.events).toHaveLength(8);

    // Migration must be written back — otherwise every future read would
    // treat the (still absent, by construction) new events as "old data"
    // again, forever re-adding them even after the user turns one off.
    const persisted = JSON.parse(localStorage.getItem('tg_filters'));
    expect(persisted._migratedEvents20260718).toBe(true);
  });

  it('does not re-add an event the user explicitly removed after the one-time migration ran', () => {
    localStorage.setItem('tg_filters', JSON.stringify({
      timeframes: ['1h', '4h', '1d'],
      min_priority: 'low',
      signal_types: ['BUY', 'SELL'],
      // Already migrated once; user has since deliberately turned time_stop off.
      events: ['signal_detected', 'entry_confirmed', 'tp1_hit', 'tp2_hit', 'stop_hit', 'invalidated', 'chop_exit'],
      min_score: 0,
      _migratedEvents20260718: true,
    }));

    const filters = getTelegramFilters();
    expect(filters.events).not.toContain('time_stop');
  });

  it('leaves non-array/malformed events untouched (falls through to the corrupted-JSON path is separate)', () => {
    localStorage.setItem('tg_filters', JSON.stringify({ min_priority: 'high' })); // no events key at all
    const filters = getTelegramFilters();
    expect(filters.events).toBeUndefined();
    expect(filters.min_priority).toBe('high');
  });
});
