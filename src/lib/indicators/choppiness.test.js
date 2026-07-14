import { describe, it, expect } from 'vitest';
import { calculateChoppiness } from './choppiness';
import { uptrendCandles, choppyCandles, flatCandles } from './__fixtures__/candles';

describe('calculateChoppiness', () => {
  it('returns 50 when there is not enough data (n < length)', () => {
    expect(calculateChoppiness(flatCandles(5), 14)).toBe(50);
  });

  it('returns 50 (not -Infinity/NaN) when the range is flat (high === low all through)', () => {
    // range = highest-lowest = 0 -> would be log10(x/0) without the guard
    const result = calculateChoppiness(flatCandles(20), 14);
    expect(result).toBe(50);
    expect(Number.isFinite(result)).toBe(true);
  });

  it('reads lower on a steady trend than on a choppy/sideways market', () => {
    const trending = calculateChoppiness(uptrendCandles(30), 14);
    const choppy = calculateChoppiness(choppyCandles(30), 14);
    expect(trending).toBeLessThan(choppy);
  });
});
