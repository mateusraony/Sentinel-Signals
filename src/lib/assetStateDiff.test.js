import { describe, it, expect } from 'vitest';
import { hasAssetStateChanged } from './assetStateDiff.js';

const BASE = {
  last_close: 100,
  last_candle_time: '2026-07-16T12:00:00.000Z',
  rf_filter_value: 99.5,
  rf_direction: 1,
  rf_high_band: 101,
  rf_low_band: 98,
  rf_signal: 'none',
  rf_cond_ini: false,
  rsi_value: 55,
  rsi_zone: 'neutral',
  macd_line: 0.1,
  macd_signal_line: 0.05,
  macd_histogram: 0.05,
  macd_cross: 'none',
  ema_short_value: 100.2,
  ema_long_value: 99.8,
  ema_cross: 'none',
  trend_ema: 'bullish',
  processed_at: '2026-07-16T12:00:01.000Z',
};

describe('hasAssetStateChanged', () => {
  it('reports a change when there is no existing state (first write for this timeframe)', () => {
    expect(hasAssetStateChanged(null, BASE)).toBe(true);
  });

  it('reports no change when every comparable field is identical, even if processed_at differs', () => {
    const next = { ...BASE, processed_at: '2026-07-16T12:05:00.000Z' };
    expect(hasAssetStateChanged(BASE, next)).toBe(false);
  });

  it('reports a change when the candle advanced (new closed candle)', () => {
    const next = { ...BASE, last_candle_time: '2026-07-16T12:15:00.000Z', last_close: 101 };
    expect(hasAssetStateChanged(BASE, next)).toBe(true);
  });

  it('reports a change when an indicator value differs but the candle timestamp did not (e.g. config change)', () => {
    const next = { ...BASE, rsi_value: 60 };
    expect(hasAssetStateChanged(BASE, next)).toBe(true);
  });

  it('reports a change when a signal fires (rf_signal flips from none)', () => {
    const next = { ...BASE, rf_signal: 'BUY' };
    expect(hasAssetStateChanged(BASE, next)).toBe(true);
  });
});
