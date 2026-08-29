import { describe, it, expect } from 'vitest';
import { backfillLookbackWindow, buildBackfillTags, formatBackfillLag, BACKFILL_LOOKBACK_DAYS } from './backfillDetection.js';

describe('backfillLookbackWindow', () => {
  it('spans exactly BACKFILL_LOOKBACK_DAYS ending at nowMs', () => {
    const nowMs = new Date('2026-08-29T12:00:00Z').getTime();
    const { fromMs, toMs } = backfillLookbackWindow(nowMs);
    expect(toMs).toBe(nowMs);
    expect(toMs - fromMs).toBe(BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe('buildBackfillTags', () => {
  it('tags only operations absent from the before-snapshot', () => {
    const before = [{ id: 'op_existing' }];
    const after = [
      { id: 'op_existing' },
      { id: 'op_new', entry_candle_time_15m: '2026-08-20T00:00:00.000Z' },
    ];
    const nowMs = new Date('2026-08-29T12:00:00Z').getTime();
    const tags = buildBackfillTags(before, after, { nowMs });
    expect(tags).toHaveLength(1);
    expect(tags[0].id).toBe('op_new');
    expect(tags[0].patch.source).toBe('backfill');
    expect(tags[0].patch.backfill_detected_at).toBe(new Date(nowMs).toISOString());
  });

  it('returns an empty array when no new operations appeared', () => {
    const before = [{ id: 'op_a' }, { id: 'op_b' }];
    const after = [{ id: 'op_a' }, { id: 'op_b' }];
    expect(buildBackfillTags(before, after)).toEqual([]);
  });

  it('computes backfill_entry_lag_ms from the real entry reference time, prioritizing 15m over 4h', () => {
    const nowMs = new Date('2026-08-29T12:00:00Z').getTime();
    const entryIso = '2026-08-25T12:00:00.000Z'; // exactly 4 days before nowMs
    const after = [{ id: 'op_new', entry_candle_time_15m: entryIso, entry_candle_time_4h: '2026-08-01T00:00:00.000Z' }];
    const [tag] = buildBackfillTags([], after, { nowMs });
    expect(tag.patch.backfill_entry_lag_ms).toBe(4 * 24 * 60 * 60 * 1000);
  });

  it('falls back to candle_close_time when no entry_candle_time_* field is set', () => {
    const nowMs = new Date('2026-08-29T12:00:00Z').getTime();
    const after = [{ id: 'op_new', candle_close_time: '2026-08-28T12:00:00.000Z' }];
    const [tag] = buildBackfillTags([], after, { nowMs });
    expect(tag.patch.backfill_entry_lag_ms).toBe(24 * 60 * 60 * 1000);
  });

  it('yields a null lag when no entry reference time exists at all (legacy op)', () => {
    const after = [{ id: 'op_new' }];
    const [tag] = buildBackfillTags([], after);
    expect(tag.patch.backfill_entry_lag_ms).toBeNull();
  });

  it('never produces an undefined field — matches the Firestore-write safety convention (docs/known-risks.md item 136)', () => {
    const after = [{ id: 'op_new' }];
    const [tag] = buildBackfillTags([], after);
    for (const value of Object.values(tag.patch)) {
      expect(value).not.toBeUndefined();
    }
  });
});

describe('formatBackfillLag', () => {
  it('formats minutes below 1h', () => {
    expect(formatBackfillLag(35 * 60 * 1000)).toBe('35min');
  });

  it('formats hours below 1 day', () => {
    expect(formatBackfillLag(14 * 60 * 60 * 1000)).toBe('14h');
  });

  it('formats days and hours', () => {
    expect(formatBackfillLag((3 * 24 + 14) * 60 * 60 * 1000)).toBe('3d 14h');
  });

  it('returns null for a missing/invalid value', () => {
    expect(formatBackfillLag(null)).toBeNull();
    expect(formatBackfillLag(undefined)).toBeNull();
    expect(formatBackfillLag(-5)).toBeNull();
    expect(formatBackfillLag(NaN)).toBeNull();
  });
});
