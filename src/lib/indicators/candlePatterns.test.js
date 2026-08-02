import { describe, it, expect } from 'vitest';
import { detectEngulfing } from './candlePatterns.js';

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
