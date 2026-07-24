import { describe, it, expect } from 'vitest';
import { detectRetest } from './retest';
import { mkCandle } from './__fixtures__/candles';

describe('detectRetest', () => {
  it('reports not_yet when price never comes back near the level', () => {
    const candles = [
      mkCandle(110, 112, 109, 111, 0),
      mkCandle(111, 113, 110, 112, 1),
      mkCandle(112, 114, 111, 113, 2),
    ];
    const result = detectRetest(candles, { direction: 'BUY', level: 100, signalCandleTime: 0, tolerancePrice: 1 });
    expect(result.retested).toBe(false);
    expect(result.reason).toBe('not_yet');
    expect(result.retestPrice).toBeNull();
  });

  it('confirms a BUY retest by close within tolerance and resumption above the level', () => {
    const candles = [
      mkCandle(110, 111, 108, 109, 0), // still away from level
      mkCandle(105, 106, 99.8, 100.3, 1), // pulls back, closes within [99.7, 100.3]
      mkCandle(101, 103, 100, 102, 2),
    ];
    const result = detectRetest(candles, { direction: 'BUY', level: 100, signalCandleTime: -1, tolerancePrice: 0.3 });
    expect(result.retested).toBe(true);
    expect(result.retestPrice).toBe(100.3);
    expect(result.retestCandleTime).toBe(candles[1].closeTime);
    expect(result.barsToConfirm).toBe(2);
  });

  it('confirms a SELL retest symmetrically', () => {
    const candles = [
      mkCandle(95, 96, 93, 94, 0),
      mkCandle(98, 100.2, 97, 99.8, 1), // pulls back up, closes within [99.7, 100.3]
    ];
    const result = detectRetest(candles, { direction: 'SELL', level: 100, signalCandleTime: -1, tolerancePrice: 0.3 });
    expect(result.retested).toBe(true);
    expect(result.retestPrice).toBe(99.8);
  });

  it('touchMode "wick": confirms when the correct-side wick touches the band and the close resumes favorably', () => {
    const candles = [
      // BUY: low dips into [99.7, 100.3], close resumes well above the band.
      mkCandle(103, 104, 99.9, 103.5, 0),
    ];
    const result = detectRetest(candles, {
      direction: 'BUY', level: 100, signalCandleTime: -1, tolerancePrice: 0.3, touchMode: 'wick',
    });
    expect(result.retested).toBe(true);
    expect(result.retestPrice).toBe(103.5);
  });

  it('touchMode "wick": the WRONG-side wick touching the band does not confirm a BUY retest', () => {
    const candles = [
      // BUY checks candle.low, not candle.high — high dips into band, low never does.
      mkCandle(103, 100.1, 102, 103.2, 0),
    ];
    const result = detectRetest(candles, {
      direction: 'BUY', level: 100, signalCandleTime: -1, tolerancePrice: 0.3, touchMode: 'wick',
    });
    expect(result.retested).toBe(false);
  });

  it('excludes the signal candle itself from counting as its own retest', () => {
    const signalCandle = mkCandle(105, 106, 100, 100, 0); // close lands exactly on the level
    const candles = [signalCandle];
    const result = detectRetest(candles, {
      direction: 'BUY', level: 100, signalCandleTime: signalCandle.closeTime, tolerancePrice: 0.5,
    });
    expect(result.retested).toBe(false);
    expect(result.reason).toBe('not_yet');
  });

  it('treats the tolerance boundary as inclusive', () => {
    const candles = [mkCandle(101, 102, 99.5, 100.5, 0)]; // close exactly at upperBound
    const result = detectRetest(candles, { direction: 'BUY', level: 100, signalCandleTime: -1, tolerancePrice: 0.5 });
    expect(result.retested).toBe(true);
  });

  it('returns invalid_params without throwing for a missing level', () => {
    const result = detectRetest([mkCandle(100, 101, 99, 100, 0)], {
      direction: 'BUY', level: null, signalCandleTime: -1, tolerancePrice: 0.3,
    });
    expect(result.retested).toBe(false);
    expect(result.reason).toBe('invalid_params');
  });

  it('returns invalid_params without throwing for a negative tolerance', () => {
    const result = detectRetest([mkCandle(100, 101, 99, 100, 0)], {
      direction: 'BUY', level: 100, signalCandleTime: -1, tolerancePrice: -1,
    });
    expect(result.reason).toBe('invalid_params');
  });

  it('returns no_candles for an empty series', () => {
    const result = detectRetest([], { direction: 'BUY', level: 100, signalCandleTime: -1, tolerancePrice: 0.3 });
    expect(result.reason).toBe('no_candles');
  });

  it('returns the FIRST chronologically qualifying candle, not a later one', () => {
    const candles = [
      mkCandle(105, 106, 99.9, 100.1, 0), // qualifies first
      mkCandle(105, 106, 99.9, 100.1, 1), // would also qualify
    ];
    const result = detectRetest(candles, { direction: 'BUY', level: 100, signalCandleTime: -1, tolerancePrice: 0.3 });
    expect(result.retestCandleTime).toBe(candles[0].closeTime);
    expect(result.barsToConfirm).toBe(1);
  });
});
