import { describe, it, expect } from 'vitest';
import { calculateRSI, getRSIZone } from './rsi';
import { flatCandles, mkCandle } from './__fixtures__/candles';

describe('calculateRSI', () => {
  it('throws when there are fewer candles than period + 1', () => {
    expect(() => calculateRSI(flatCandles(10), 14)).toThrow();
  });

  it('reads 100 (not NaN) when there are no losses at all', () => {
    // Strictly increasing closes: avgLoss stays 0 the whole way.
    const candles = [];
    for (let i = 0; i < 20; i++) candles.push(mkCandle(100 + i, 100 + i + 1, 100 + i - 1, 100 + i + 1, i));
    const result = calculateRSI(candles, 14);
    expect(result.value).toBe(100);
    expect(Number.isNaN(result.value)).toBe(false);
  });

  it('matches a hand-computed RSI value on a known gain/loss sequence', () => {
    // 15 closes with a fixed, hand-summable pattern of changes so avgGain/
    // avgLoss (Wilder SMA seed) are exactly known: +1 six times, -1 six
    // times, alternating, period=14 (uses all 14 changes as the seed).
    const closes = [100];
    for (let i = 0; i < 14; i++) closes.push(closes[closes.length - 1] + (i % 2 === 0 ? 1 : -1));
    const candles = closes.map((c, i) => mkCandle(c, c + 0.5, c - 0.5, c, i));
    const result = calculateRSI(candles, 14);
    // 7 up-moves of 1, 7 down-moves of 1 -> avgGain = avgLoss -> RS = 1 -> RSI = 50
    expect(result.value).toBeCloseTo(50, 5);
  });

  it('crossedBull50 fires exactly on the bar RSI crosses above 50, not before/after', () => {
    // Build a downtrend (RSI well below 50) then a sharp reversal that
    // should cross RSI above 50 on the last bar.
    const candles = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      candles.push(mkCandle(price, price + 0.3, price - 0.3, price - 1, i));
      price -= 1;
    }
    // One bar before the crossing candle
    const beforeCross = calculateRSI(candles, 14);
    expect(beforeCross.crossedBull50).toBe(false);

    // Sharp bullish reversal candle
    candles.push(mkCandle(price, price + 15, price - 0.5, price + 14, candles.length));
    const atCross = calculateRSI(candles, 14);
    expect(atCross.value).toBeGreaterThan(50);
    expect(atCross.crossedBull50).toBe(true);
    expect(atCross.crossedBear50).toBe(false);
  });

  it('crossedBear50 fires exactly on the bar RSI crosses below 50', () => {
    const candles = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      candles.push(mkCandle(price, price + 0.3, price - 0.3, price + 1, i));
      price += 1;
    }
    const beforeCross = calculateRSI(candles, 14);
    expect(beforeCross.crossedBear50).toBe(false);

    candles.push(mkCandle(price, price + 0.5, price - 15, price - 14, candles.length));
    const atCross = calculateRSI(candles, 14);
    expect(atCross.value).toBeLessThan(50);
    expect(atCross.crossedBear50).toBe(true);
    expect(atCross.crossedBull50).toBe(false);
  });

  it('also fires crossedBull50 on the "2-bar-old same-side cross" branch', () => {
    // lastRSI>50 && prevRSI>50 && prev2RSI<50: RSI crossed above 50 one bar
    // ago (that's "prev") and has stayed above 50 into the current bar
    // ("last") — the subtler branch that caused the original
    // static-band-vs-crossover parity bug. Needs exactly one more bar after
    // the reversal candle so the FRESH-cross clause (prevRSI<=50) is no
    // longer true, forcing the 2-bar-old clause to be the one that fires.
    const candles = [];
    let price = 100;
    for (let i = 0; i < 15; i++) {
      candles.push(mkCandle(price, price + 0.3, price - 0.3, price - 1, i));
      price -= 1;
    }
    // Reversal bar that crosses RSI above 50 (becomes "prev" after the next bar)
    candles.push(mkCandle(price, price + 15, price - 0.5, price + 14, candles.length));
    price += 14;
    // One more bar, still above 50 -> should hit the 2-bar-old branch, not the fresh-cross branch
    candles.push(mkCandle(price, price + 1, price - 0.5, price + 0.5, candles.length));

    const result = calculateRSI(candles, 14);
    expect(result.value).toBeGreaterThan(50);
    expect(result.previousValue).toBeGreaterThan(50);
    expect(result.crossedBull50).toBe(true);
  });
});

// known-risks.md item 30: calculateRSI used to hardcode the zone at 70/30 and
// ignore any custom threshold — a per-asset rsi_overbought/rsi_oversold saved
// via the UI had zero effect on which zone (and therefore which 'rsi'-source
// signal) actually fired. These prove the optional 3rd/4th args are honored.
describe('calculateRSI zone thresholds (known-risks item 30)', () => {
  function rsi50Candles() {
    // Same fixture as "matches a hand-computed RSI value" above: alternating
    // +1/-1 changes make avgGain === avgLoss, so RSI lands exactly on 50 —
    // 'neutral' under the default 70/30, letting custom thresholds move it.
    const closes = [100];
    for (let i = 0; i < 14; i++) closes.push(closes[closes.length - 1] + (i % 2 === 0 ? 1 : -1));
    return closes.map((c, i) => mkCandle(c, c + 0.5, c - 0.5, c, i));
  }

  it('defaults to 70/30 when no thresholds are passed', () => {
    const result = calculateRSI(rsi50Candles(), 14);
    expect(result.value).toBeCloseTo(50, 5);
    expect(result.zone).toBe('neutral');
  });

  it('classifies overbought at a custom threshold the default 70/30 would call neutral', () => {
    const result = calculateRSI(rsi50Candles(), 14, 40, 20);
    expect(result.zone).toBe('overbought');
  });

  it('classifies oversold at a custom threshold the default 70/30 would call neutral', () => {
    const result = calculateRSI(rsi50Candles(), 14, 80, 60);
    expect(result.zone).toBe('oversold');
  });

  it('delegates to getRSIZone instead of duplicating the boundary logic', () => {
    expect(getRSIZone(70, 70, 30)).toBe('overbought');
    expect(getRSIZone(69.999, 70, 30)).toBe('neutral');
    expect(getRSIZone(30, 70, 30)).toBe('oversold');
    expect(getRSIZone(30.001, 70, 30)).toBe('neutral');
  });
});
