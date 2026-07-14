import { describe, it, expect } from 'vitest';
import { calculateADX } from './adx';
import { uptrendCandles, choppyCandles, flatCandles } from './__fixtures__/candles';

describe('calculateADX', () => {
  it('returns the zeroed shape when there is not enough data', () => {
    const result = calculateADX(flatCandles(10), 14, 14);
    expect(result).toEqual({ adx: 0, plusDI: 0, minusDI: 0 });
  });

  it('reads +DI clearly above -DI on a steady uptrend, with non-zero ADX', () => {
    const result = calculateADX(uptrendCandles(60), 14, 14);
    expect(result.plusDI).toBeGreaterThan(result.minusDI);
    expect(result.adx).toBeGreaterThan(0);
  });

  it('reads a lower ADX on a choppy/sideways market than on a steady uptrend', () => {
    const trending = calculateADX(uptrendCandles(60), 14, 14);
    const choppy = calculateADX(choppyCandles(60), 14, 14);
    expect(choppy.adx).toBeLessThan(trending.adx);
  });
});
