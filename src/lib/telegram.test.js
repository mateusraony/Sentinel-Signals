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

import { getTelegramFilters, notifyNewSignal } from './telegram.js';

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

// Codex review (PR #65): notifyNewSignal used to hardcode "Novo Sinal RF
// Detectado" and `context.score || 0` for EVERY signal source. Harmless
// while smc_structure signals almost never reached here (smc_enabled
// defaulted to false) — but PR #65 turns that cascade on by default for
// new assets, making this a real, frequent mislabeling: an smc_structure
// signal (which never carries a score) would show "Score: 0/100" under a
// header claiming it's an RF signal, reading as "bad signal" when it's
// really just a different, unscored signal type.
describe('notifyNewSignal — source-aware label and score (Codex review, PR #65)', () => {
  beforeEach(() => {
    // isTelegramConfigured()/send() need a configured bot to actually call
    // fetch — otherwise send() returns before ever building the message.
    localStorage.setItem('cryptoradar_telegram_cfg', JSON.stringify({ botToken: 'x', chatId: 'y' }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
  });

  function baseSignal(overrides = {}) {
    return {
      symbol: 'BTCUSDT', timeframe: '1h', signal_type: 'BUY',
      price_at_signal: 100, reason: 'test reason', context: {},
      ...overrides,
    };
  }

  async function sentText(signal) {
    const before = global.fetch.mock.calls.length;
    await notifyNewSignal(signal);
    expect(global.fetch.mock.calls.length).toBe(before + 1);
    return JSON.parse(global.fetch.mock.calls[before][1].body).text;
  }

  it('labels a range_filter signal as RF and shows its real score', async () => {
    const text = await sentText(baseSignal({ source: 'range_filter', strength: 'strong', context: { score: 82 } }));
    expect(text).toContain('Novo Sinal RF Detectado');
    expect(text).toContain('Score: 82/100');
  });

  it('labels an smc_structure signal as SMC and never shows a fake 0/100 score', async () => {
    const text = await sentText(baseSignal({ source: 'smc_structure', strength: 'medium', context: { structure_type: 'BOS', pd_zone: 'discount' } }));
    expect(text).toContain('Novo Sinal SMC Detectado');
    expect(text).not.toContain('RF Detectado');
    expect(text).not.toContain('Score: 0/100');
  });

  it('labels macd/ema_cross/rsi signals with their own source instead of RF', async () => {
    expect(await sentText(baseSignal({ source: 'macd' }))).toContain('Novo Sinal MACD Detectado');
    expect(await sentText(baseSignal({ source: 'ema_cross' }))).toContain('Novo Sinal EMA Detectado');
    expect(await sentText(baseSignal({ source: 'rsi' }))).toContain('Novo Sinal RSI Detectado');
  });

  it('falls back to RF for an unrecognized/legacy source instead of throwing', async () => {
    const text = await sentText(baseSignal({ source: 'something_new' }));
    expect(text).toContain('Novo Sinal RF Detectado');
  });
});
