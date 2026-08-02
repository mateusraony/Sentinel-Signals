import { describe, it, expect } from 'vitest';
import { detectEngulfing, detectPinBar, detectMarubozu } from './candlePatterns.js';

describe('detectEngulfing', () => {
  it('detects a valid bullish engulfing (bearish candle then a larger bullish candle)', () => {
    const previous = { open: 110, close: 100 };
    const current = { open: 99, close: 112 };
    expect(detectEngulfing(current, previous, 'BUY')).toEqual({
      isEngulfing: true,
      pattern: 'bullish_engulfing',
      reason: null,
    });
  });

  it('detects a valid bearish engulfing (bullish candle then a larger bearish candle)', () => {
    const previous = { open: 100, close: 110 };
    const current = { open: 112, close: 99 };
    expect(detectEngulfing(current, previous, 'SELL')).toEqual({
      isEngulfing: true,
      pattern: 'bearish_engulfing',
      reason: null,
    });
  });

  it('rejects when the current candle does not close in the signal direction', () => {
    const previous = { open: 110, close: 100 };
    const current = { open: 99, close: 95 }; // bearish, but direction asked is BUY
    expect(detectEngulfing(current, previous, 'BUY').reason).toBe('wrong_direction');
  });

  it('rejects a doji current candle on either side (open === close)', () => {
    const previous = { open: 110, close: 100 };
    const current = { open: 105, close: 105 };
    expect(detectEngulfing(current, previous, 'BUY').reason).toBe('wrong_direction');
    expect(detectEngulfing(current, previous, 'SELL').reason).toBe('wrong_direction');
  });

  it('rejects when the previous candle is not the opposite color (no reversal context)', () => {
    const previous = { open: 100, close: 108 }; // also bullish
    const current = { open: 99, close: 112 };
    expect(detectEngulfing(current, previous, 'BUY').reason).toBe('previous_not_opposite');
  });

  it('rejects a same-direction candle that does not fully engulf the previous body', () => {
    const previous = { open: 110, close: 100 };
    const current = { open: 103, close: 106 }; // bullish, but body sits INSIDE the previous body
    expect(detectEngulfing(current, previous, 'BUY').reason).toBe('body_not_engulfing');
  });

  it('returns invalid_params for missing candles or an unrecognized direction', () => {
    const candle = { open: 100, close: 110 };
    expect(detectEngulfing(null, candle, 'BUY').reason).toBe('invalid_params');
    expect(detectEngulfing(candle, null, 'BUY').reason).toBe('invalid_params');
    expect(detectEngulfing(candle, candle, 'LONG').reason).toBe('invalid_params');
  });
});

describe('detectPinBar', () => {
  it('detects a valid hammer (BUY) — long lower wick, small upper wick', () => {
    const candle = { open: 100, close: 102, high: 103, low: 90 }; // body=2, lowerWick=10, upperWick=1
    expect(detectPinBar(candle, 'BUY')).toEqual({ isPinBar: true, pattern: 'hammer', reason: null });
  });

  it('detects a valid shooting star (SELL) — long upper wick, small lower wick', () => {
    const candle = { open: 100, close: 98, high: 110, low: 97 }; // body=2, upperWick=10, lowerWick=1
    expect(detectPinBar(candle, 'SELL')).toEqual({ isPinBar: true, pattern: 'shooting_star', reason: null });
  });

  it('a hammer does not require a bullish close — the wick rejection is what matters', () => {
    const candle = { open: 102, close: 100, high: 103, low: 90 }; // closes red, still a valid hammer shape
    expect(detectPinBar(candle, 'BUY').isPinBar).toBe(true);
  });

  it('rejects a doji (zero body) — no body to anchor a wick ratio against', () => {
    const candle = { open: 100, close: 100, high: 105, low: 95 };
    expect(detectPinBar(candle, 'BUY').reason).toBe('doji');
  });

  it('rejects when the dominant wick is too short relative to the body', () => {
    const candle = { open: 100, close: 102, high: 103, low: 99 }; // lowerWick=1, body=2 -> 1 < 2*2
    expect(detectPinBar(candle, 'BUY').reason).toBe('wick_too_short');
  });

  it('rejects when the opposite-side wick is too long', () => {
    const candle = { open: 100, close: 102, high: 106, low: 90 }; // lowerWick=10 ok, upperWick=4 > body=2
    expect(detectPinBar(candle, 'BUY').reason).toBe('opposite_wick_too_long');
  });

  it('returns invalid_params for a missing candle or an unrecognized direction', () => {
    expect(detectPinBar(null, 'BUY').reason).toBe('invalid_params');
    expect(detectPinBar({ open: 1, close: 2, high: 3, low: 0 }, 'LONG').reason).toBe('invalid_params');
  });
});

describe('detectMarubozu', () => {
  it('detects a valid bullish marubozu — body dominates the range, closes green', () => {
    const candle = { open: 100, close: 110, high: 110.2, low: 99.8 }; // body=10, range=10.4 -> ratio ~0.96
    const result = detectMarubozu(candle, 'BUY');
    expect(result.isMarubozu).toBe(true);
    expect(result.pattern).toBe('bullish_marubozu');
  });

  it('detects a valid bearish marubozu — body dominates the range, closes red', () => {
    const candle = { open: 110, close: 100, high: 110.2, low: 99.8 };
    const result = detectMarubozu(candle, 'SELL');
    expect(result.isMarubozu).toBe(true);
    expect(result.pattern).toBe('bearish_marubozu');
  });

  it('rejects when the close does not align with the signal direction', () => {
    const candle = { open: 110, close: 100, high: 110.2, low: 99.8 }; // bearish candle, direction asked BUY
    expect(detectMarubozu(candle, 'BUY').reason).toBe('wrong_direction');
  });

  it('rejects when the body is too small relative to the range (real wicks present)', () => {
    const candle = { open: 100, close: 105, high: 110, low: 95 }; // body=5, range=15 -> ratio 0.33
    expect(detectMarubozu(candle, 'BUY').reason).toBe('body_too_small');
  });

  it('rejects a degenerate zero-range candle', () => {
    const candle = { open: 100, close: 100, high: 100, low: 100 };
    expect(detectMarubozu(candle, 'BUY').reason).toBe('zero_range');
  });

  it('returns invalid_params for a missing candle or an unrecognized direction', () => {
    expect(detectMarubozu(null, 'BUY').reason).toBe('invalid_params');
    expect(detectMarubozu({ open: 1, close: 2, high: 3, low: 0 }, 'LONG').reason).toBe('invalid_params');
  });
});
