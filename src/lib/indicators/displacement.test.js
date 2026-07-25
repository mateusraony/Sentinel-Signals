import { describe, it, expect } from 'vitest';
import { detectDisplacement } from './displacement';

function mkCandle(open, close, volume = 100) {
  return { open, high: Math.max(open, close), low: Math.min(open, close), close, volume };
}

describe('detectDisplacement', () => {
  it('rejects a candle whose body is below the ATR multiple, no volume requirement', () => {
    const candle = mkCandle(100, 101); // body 1
    const result = detectDisplacement(candle, { direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5 }); // needs body >= 3
    expect(result.isDisplacement).toBe(false);
    expect(result.reason).toBe('body_too_small');
    expect(result.bodyRatio).toBeCloseTo(0.5, 5);
  });

  it('confirms a candle whose body meets the ATR multiple when volume is not required', () => {
    const candle = mkCandle(100, 104); // body 4
    const result = detectDisplacement(candle, { direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5 }); // needs body >= 3
    expect(result.isDisplacement).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.bodyRatio).toBeCloseTo(2, 5);
    expect(result.volumeRatio).toBeNull(); // never computed — volume wasn't required
  });

  it('treats the body/ATR boundary as inclusive', () => {
    const candle = mkCandle(100, 103); // body exactly 3
    const result = detectDisplacement(candle, { direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5 }); // threshold exactly 3
    expect(result.isDisplacement).toBe(true);
  });

  it('rejects on volume when minVolumeRatio is set and the candle volume is below it', () => {
    const candle = mkCandle(100, 104, 50); // body ok, volume 50
    const result = detectDisplacement(candle, {
      direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5, minVolumeRatio: 1.5, volumeMa: 100,
    });
    expect(result.isDisplacement).toBe(false);
    expect(result.reason).toBe('volume_too_low');
    expect(result.volumeRatio).toBeCloseTo(0.5, 5);
  });

  it('confirms when both body and volume requirements are met', () => {
    const candle = mkCandle(100, 104, 200); // body ok, volume 200
    const result = detectDisplacement(candle, {
      direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5, minVolumeRatio: 1.5, volumeMa: 100,
    });
    expect(result.isDisplacement).toBe(true);
    expect(result.volumeRatio).toBeCloseTo(2, 5);
  });

  it('treats the volume-ratio boundary as inclusive', () => {
    const candle = mkCandle(100, 104, 150); // volume ratio exactly 1.5
    const result = detectDisplacement(candle, {
      direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5, minVolumeRatio: 1.5, volumeMa: 100,
    });
    expect(result.isDisplacement).toBe(true);
  });

  it('returns insufficient_volume_data when volume is required but no volumeMa baseline is available', () => {
    const candle = mkCandle(100, 104, 200);
    const result = detectDisplacement(candle, {
      direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5, minVolumeRatio: 1.5, volumeMa: null,
    });
    expect(result.isDisplacement).toBe(false);
    expect(result.reason).toBe('insufficient_volume_data');
  });

  it('returns invalid_params without throwing for a missing/zero ATR', () => {
    const candle = mkCandle(100, 104);
    expect(detectDisplacement(candle, { direction: 'BUY', atrValue: 0, bodyAtrMult: 1.5 }).reason).toBe('invalid_params');
    expect(detectDisplacement(candle, { direction: 'BUY', atrValue: null, bodyAtrMult: 1.5 }).reason).toBe('invalid_params');
  });

  it('returns invalid_params without throwing for a missing candle, bodyAtrMult, or direction', () => {
    expect(detectDisplacement(null, { direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5 }).reason).toBe('invalid_params');
    expect(detectDisplacement(mkCandle(100, 104), { direction: 'BUY', atrValue: 2, bodyAtrMult: null }).reason).toBe('invalid_params');
    expect(detectDisplacement(mkCandle(100, 104), { atrValue: 2, bodyAtrMult: 1.5 }).reason).toBe('invalid_params');
    expect(detectDisplacement(mkCandle(100, 104), { direction: 'UP', atrValue: 2, bodyAtrMult: 1.5 }).reason).toBe('invalid_params');
  });

  it('returns invalid_params for a zero bodyAtrMult (a doji would otherwise always pass)', () => {
    const candle = mkCandle(100, 104);
    expect(detectDisplacement(candle, { direction: 'BUY', atrValue: 2, bodyAtrMult: 0 }).reason).toBe('invalid_params');
  });

  it('rejects a bullish-close candle that is net bearish in body for a BUY direction', () => {
    // A structure break only needs close to cross a pivot — the candle itself
    // can still be net bearish (opened high, sold off, closed below open but
    // above the pivot). Body/ATR alone would have scored this as displacement.
    const candle = { open: 110, high: 112, low: 99, close: 104, volume: 100 }; // close < open
    const result = detectDisplacement(candle, { direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5 });
    expect(result.isDisplacement).toBe(false);
    expect(result.reason).toBe('wrong_direction');
    expect(result.bodyRatio).toBeNull();
  });

  it('rejects a bearish-close candle that is net bullish in body for a SELL direction', () => {
    const candle = { open: 90, high: 101, low: 88, close: 96, volume: 100 }; // close > open
    const result = detectDisplacement(candle, { direction: 'SELL', atrValue: 2, bodyAtrMult: 1.5 });
    expect(result.isDisplacement).toBe(false);
    expect(result.reason).toBe('wrong_direction');
  });

  it('rejects a doji (open === close) for either direction', () => {
    const candle = mkCandle(100, 100);
    expect(detectDisplacement(candle, { direction: 'BUY', atrValue: 2, bodyAtrMult: 1.5 }).reason).toBe('wrong_direction');
    expect(detectDisplacement(candle, { direction: 'SELL', atrValue: 2, bodyAtrMult: 1.5 }).reason).toBe('wrong_direction');
  });
});
