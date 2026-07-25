import { describe, it, expect } from 'vitest';
import { detectDisplacement } from './displacement';

function mkCandle(open, close, volume = 100) {
  return { open, high: Math.max(open, close), low: Math.min(open, close), close, volume };
}

describe('detectDisplacement', () => {
  it('rejects a candle whose body is below the ATR multiple, no volume requirement', () => {
    const candle = mkCandle(100, 101); // body 1
    const result = detectDisplacement(candle, { atrValue: 2, bodyAtrMult: 1.5 }); // needs body >= 3
    expect(result.isDisplacement).toBe(false);
    expect(result.reason).toBe('body_too_small');
    expect(result.bodyRatio).toBeCloseTo(0.5, 5);
  });

  it('confirms a candle whose body meets the ATR multiple when volume is not required', () => {
    const candle = mkCandle(100, 104); // body 4
    const result = detectDisplacement(candle, { atrValue: 2, bodyAtrMult: 1.5 }); // needs body >= 3
    expect(result.isDisplacement).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.bodyRatio).toBeCloseTo(2, 5);
    expect(result.volumeRatio).toBeNull(); // never computed — volume wasn't required
  });

  it('treats the body/ATR boundary as inclusive', () => {
    const candle = mkCandle(100, 103); // body exactly 3
    const result = detectDisplacement(candle, { atrValue: 2, bodyAtrMult: 1.5 }); // threshold exactly 3
    expect(result.isDisplacement).toBe(true);
  });

  it('rejects on volume when minVolumeRatio is set and the candle volume is below it', () => {
    const candle = mkCandle(100, 104, 50); // body ok, volume 50
    const result = detectDisplacement(candle, { atrValue: 2, bodyAtrMult: 1.5, minVolumeRatio: 1.5, volumeMa: 100 });
    expect(result.isDisplacement).toBe(false);
    expect(result.reason).toBe('volume_too_low');
    expect(result.volumeRatio).toBeCloseTo(0.5, 5);
  });

  it('confirms when both body and volume requirements are met', () => {
    const candle = mkCandle(100, 104, 200); // body ok, volume 200
    const result = detectDisplacement(candle, { atrValue: 2, bodyAtrMult: 1.5, minVolumeRatio: 1.5, volumeMa: 100 });
    expect(result.isDisplacement).toBe(true);
    expect(result.volumeRatio).toBeCloseTo(2, 5);
  });

  it('treats the volume-ratio boundary as inclusive', () => {
    const candle = mkCandle(100, 104, 150); // volume ratio exactly 1.5
    const result = detectDisplacement(candle, { atrValue: 2, bodyAtrMult: 1.5, minVolumeRatio: 1.5, volumeMa: 100 });
    expect(result.isDisplacement).toBe(true);
  });

  it('returns insufficient_volume_data when volume is required but no volumeMa baseline is available', () => {
    const candle = mkCandle(100, 104, 200);
    const result = detectDisplacement(candle, { atrValue: 2, bodyAtrMult: 1.5, minVolumeRatio: 1.5, volumeMa: null });
    expect(result.isDisplacement).toBe(false);
    expect(result.reason).toBe('insufficient_volume_data');
  });

  it('returns invalid_params without throwing for a missing/zero ATR', () => {
    const candle = mkCandle(100, 104);
    expect(detectDisplacement(candle, { atrValue: 0, bodyAtrMult: 1.5 }).reason).toBe('invalid_params');
    expect(detectDisplacement(candle, { atrValue: null, bodyAtrMult: 1.5 }).reason).toBe('invalid_params');
  });

  it('returns invalid_params without throwing for a missing candle or bodyAtrMult', () => {
    expect(detectDisplacement(null, { atrValue: 2, bodyAtrMult: 1.5 }).reason).toBe('invalid_params');
    expect(detectDisplacement(mkCandle(100, 104), { atrValue: 2, bodyAtrMult: null }).reason).toBe('invalid_params');
  });
});
