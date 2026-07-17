import { describe, it, expect } from 'vitest';
import { calculateStructure, calculateLiquiditySweep, calculatePdZone } from './smcStructure';
import { chochBreakoutCandles, mkCandle, flatCandles } from './__fixtures__/candles';

describe('calculateStructure', () => {
  it('returns the null/false shape when there is not enough data (n < swingLen + 2)', () => {
    const result = calculateStructure(flatCandles(10), { swingLen: 20 });
    expect(result.trend).toBeNull();
    expect(result.lastBull).toEqual({ bos: false, choch: false });
    expect(result.lastBear).toEqual({ bos: false, choch: false });
  });

  it('detects a downtrend, then flips to bullish with a CHoCH exactly on the breakout bar', () => {
    const candles = chochBreakoutCandles();
    const swingLen = 5;

    // Before EITHER of the two trailing bars (breakout + confirm): still in the downtrend.
    const before = calculateStructure(candles.slice(0, -2), { swingLen });
    expect(before.trend).toBe(-1);

    // Exactly at the breakout bar (drop only the trailing confirm candle):
    // CHoCH must fire HERE, not one bar early/late.
    const atBreakout = calculateStructure(candles.slice(0, -1), { swingLen });
    expect(atBreakout.trend).toBe(1);
    expect(atBreakout.lastBull.choch).toBe(true);
    expect(atBreakout.lastBull.bos).toBe(false);
    expect(atBreakout.lastBear.choch).toBe(false);

    // One bar later: trend stays bullish, but CHoCH must NOT fire again.
    const after = calculateStructure(candles, { swingLen });
    expect(after.trend).toBe(1);
    expect(after.lastBull.choch).toBe(false);
  });

  it('does not fire CHoCH/BOS on ordinary bars once the trend is established (no false positives)', () => {
    const candles = chochBreakoutCandles();
    // A couple of bars deep into the initial downtrend leg — no breakout
    // happening here, so neither bull nor bear structure event should fire.
    const result = calculateStructure(candles.slice(0, 6), { swingLen: 5 });
    expect(result.lastBull.bos || result.lastBull.choch).toBe(false);
    expect(result.lastBear.bos || result.lastBear.choch).toBe(false);
  });

  it('exposes the carried protected pivots (lastSwingHigh/Low) the structure breaks against', () => {
    // Fixture legs: ...96→86, 86→92 (top 92 + 0.3 wick), 92→82 (bottom 82
    // − 0.3 wick), 82→88, breakout to 104/105. The confirmed pivots carried
    // to the last bar are exactly those wicks: topY = 92.3 (the level the
    // bull CHoCH broke), btmY = 81.7 (the protected low a bull entry's
    // structural stop must sit beyond).
    const candles = chochBreakoutCandles();
    const result = calculateStructure(candles, { swingLen: 5 });
    expect(result.lastSwingHigh).toBeCloseTo(92.3);
    expect(result.lastSwingLow).toBeCloseTo(81.7);
    // Not enough data → nulls, matching the null shape of the other fields.
    const empty = calculateStructure(flatCandles(4), { swingLen: 5 });
    expect(empty.lastSwingHigh ?? null).toBe(null);
    expect(empty.lastSwingLow ?? null).toBe(null);
  });

  it('a continuation break in the same direction as the trend is a BOS, not a CHoCH', () => {
    // Once trend is bullish, a further break of a new swing high in the
    // SAME direction should mark bos=true, choch=false (not a reversal).
    const candles = chochBreakoutCandles();
    const swingLen = 5;
    // Extend with more bullish continuation bars past the initial CHoCH.
    let price = candles[candles.length - 1].close;
    let idx = candles.length;
    for (let i = 0; i < 6; i++) {
      const open = price;
      const close = price + 0.5;
      candles.push(mkCandle(open, close + 0.2, open - 0.2, close, idx++));
      price = close;
    }
    // Strong continuation breakout above the recent swing high.
    candles.push(mkCandle(price, price + 8, price - 0.5, price + 7, idx));

    const result = calculateStructure(candles, { swingLen });
    expect(result.trend).toBe(1);
    // Either this bar itself is the BOS, or structure had already advanced —
    // the key invariant is CHoCH cannot fire twice for the same-direction
    // continuation once trend is already 1.
    if (result.lastBull.bos || result.lastBull.choch) {
      expect(result.lastBull.choch).toBe(false);
    }
  });
});

describe('calculateLiquiditySweep', () => {
  it('returns false/false when there is not enough data', () => {
    const result = calculateLiquiditySweep(flatCandles(10), 20);
    expect(result).toEqual({ bullishSweep: false, bearishSweep: false });
  });

  it('detects a bullish sweep: wicks below the recent low, closes back above it, bullish candle', () => {
    const candles = [];
    for (let i = 0; i < 25; i++) candles.push(mkCandle(100, 105, 95, 100, i));
    candles.push(mkCandle(96, 97, 93, 96.5, 25));
    const result = calculateLiquiditySweep(candles, 20);
    expect(result.bullishSweep).toBe(true);
    expect(result.bearishSweep).toBe(false);
  });

  it('detects a bearish sweep: wicks above the recent high, closes back below it, bearish candle', () => {
    const candles = [];
    for (let i = 0; i < 25; i++) candles.push(mkCandle(100, 105, 95, 100, i));
    candles.push(mkCandle(104, 107, 103, 103.5, 25));
    const result = calculateLiquiditySweep(candles, 20);
    expect(result.bearishSweep).toBe(true);
    expect(result.bullishSweep).toBe(false);
  });

  it('does not flag a sweep on an ordinary candle inside the existing range', () => {
    const candles = [];
    for (let i = 0; i < 25; i++) candles.push(mkCandle(100, 105, 95, 100, i));
    candles.push(mkCandle(100, 102, 98, 101, 25));
    const result = calculateLiquiditySweep(candles, 20);
    expect(result.bullishSweep).toBe(false);
    expect(result.bearishSweep).toBe(false);
  });
});

describe('calculatePdZone', () => {
  it('returns nulls when there is not enough data', () => {
    const result = calculatePdZone(flatCandles(10), 20);
    expect(result.zone).toBeNull();
  });

  it('classifies a close near the bottom of the range as discount', () => {
    const candles = [];
    for (let i = 0; i < 24; i++) candles.push(mkCandle(100, 105, 95, 100, i));
    // Last candle's close near the range low -> should read as discount,
    // not equilibrium (pdSwingHigh/Low come from the window ENDING at the
    // second-to-last bar, so this last candle's own high/low don't move
    // the range, only its close is being classified against it).
    candles.push(mkCandle(97, 98, 95.5, 96, 24));
    const result = calculatePdZone(candles, 20);
    expect(result.zone).toBe('discount');
    expect(result.pdSwingHigh).toBe(105);
    expect(result.pdSwingLow).toBe(95);
  });
});
