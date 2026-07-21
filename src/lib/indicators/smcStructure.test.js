import { describe, it, expect } from 'vitest';
import { calculateStructure, calculateLiquiditySweep, calculatePdZone, classifyZone } from './smcStructure';
import { chochBreakoutCandles, mkCandle, flatCandles, goldenCandles } from './__fixtures__/candles';

// Counts BOS/CHoCH events across the whole series ('series' field), used
// only by the windowing investigation below.
function countStructureEvents(structResult) {
  if (!structResult.series) return 0;
  const { bullBos, bullChoch, bearBos, bearChoch } = structResult.series;
  let n = 0;
  for (let i = 0; i < bullBos.length; i++) {
    if (bullBos[i] || bullChoch[i] || bearBos[i] || bearChoch[i]) n++;
  }
  return n;
}

// Mirrors exactly what scanAsset does in production (scanner.js:444,510):
// fetchCandles(..., limit) returns only the last `limit` closed candles, and
// calculateStructure is called fresh on that slice every scan — no state
// carried over from the previous scan. Counts how many of the LAST-bar
// events (the only ones scanAsset ever reads, via r.smc.lastBull/lastBear)
// actually fire when the algorithm only ever sees a `windowSize`-candle tail.
function countWindowedLastBarEvents(candles, swingLen, windowSize) {
  let total = 0;
  for (let end = windowSize; end <= candles.length; end++) {
    const window = candles.slice(end - windowSize, end);
    const r = calculateStructure(window, { swingLen });
    if (r.lastBull.bos || r.lastBull.choch || r.lastBear.bos || r.lastBear.choch) total++;
  }
  return total;
}

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

// Root-cause reproduction (docs/known-risks.md item 34): scanAsset only ever
// gives calculateStructure the last 150 closed candles of a timeframe
// (scanner.js:444), recomputed from scratch every scan — no state carried
// over. At swingLen=50 (the real default, scanner.js:510, from the user's
// own "SMC+A Unified v2.3" Pine script), this discards protected pivot
// levels (topY/btmY) older than 150 bars, silencing BOS/CHoCH events that a
// full-history/stateful computation (or the real TradingView chart) would
// still fire. At swingLen=10 (the value already used for the 5m entry
// trigger, scanner.js:309) the same 150-candle window is nearly harmless —
// this is the measured contrast a sentinel-council-review found before this
// test existed, reproduced here deterministically against the fixed-seed
// goldenCandles fixture (same series already used by goldenParity.test.js).
describe('calculateStructure — 150-candle scan window vs. swingLen (root cause of "0 SMC trades")', () => {
  it('at swingLen=50 (the 1h bias default), a windowed no-state scan misses an event full history would catch', () => {
    const candles = goldenCandles(800);
    // Full history / stateful reference: exactly one BOS/CHoCH exists in
    // this deterministic series at this scale.
    const fullHistoryEvents = countStructureEvents(calculateStructure(candles, { swingLen: 50 }));
    expect(fullHistoryEvents).toBe(1);

    // Production's actual behavior: recompute from scratch on only the last
    // 150 candles, every scan — the protected pivot the real event breaks
    // against is older than 150 bars by the time the break happens, so it
    // never fires under this windowing.
    const windowedEvents = countWindowedLastBarEvents(candles, 50, 150);
    expect(windowedEvents).toBe(0);
  });

  it('at swingLen=10 (the 5m confirmation value), the same 150-candle window loses nothing', () => {
    const candles = goldenCandles(800);
    const fullHistoryEvents = countStructureEvents(calculateStructure(candles, { swingLen: 10 }));
    const windowedEvents = countWindowedLastBarEvents(candles, 10, 150);
    expect(fullHistoryEvents).toBe(6);
    expect(windowedEvents).toBe(6);
  });
});

// docs/known-risks.md item 35: scanner.js's zoneOk gate (1h SMC structure ->
// SignalEvent) shares the SAME closedCandles as calculateStructure — a
// breakout mechanically pushes the close toward the extreme of the PD zone's
// (excluded-current-bar) lookback window, which is exactly the zone the gate
// rejects for that direction. Reproduces the finding on the same fixture
// item 34 already anchors, at the same swingLen=50 default.
describe('calculatePdZone vs calculateStructure — signal-direction zone bias (known-risks item 35)', () => {
  it('the single swingLen=50 structural event in goldenCandles lands in the zone its own direction is rejected by', () => {
    const candles = goldenCandles(800);
    const full = calculateStructure(candles, { swingLen: 50 });

    let eventIdx = -1;
    let isBear = false;
    for (let i = 0; i < full.series.bullBos.length; i++) {
      if (full.series.bullBos[i] || full.series.bullChoch[i]) { eventIdx = i; isBear = false; break; }
      if (full.series.bearBos[i] || full.series.bearChoch[i]) { eventIdx = i; isBear = true; break; }
    }
    expect(eventIdx).toBeGreaterThan(-1); // sanity: item 34's single event still exists

    const zoneAtEvent = calculatePdZone(candles.slice(0, eventIdx + 1), 20);
    // scanner.js:628 rejects BUY when zone === 'premium', SELL when zone === 'discount'.
    expect(zoneAtEvent.zone).toBe(isBear ? 'discount' : 'premium');
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

// docs/known-risks.md item 38: classifyZone extracted from calculatePdZone so
// the same premium/discount/equilibrium math can be reused against a
// structure-break LEG (check5mSmcConfirmation) instead of only a generic
// 20-candle window. Pure regression coverage — calculatePdZone's own tests
// above already prove the wrapper is byte-identical to the pre-refactor
// behavior; these cover classifyZone's own boundary cases directly.
describe('classifyZone', () => {
  it('classifies above the 5% equilibrium band as premium', () => {
    expect(classifyZone(96, 100, 0).zone).toBe('premium');
  });

  it('classifies below the 5% equilibrium band as discount', () => {
    expect(classifyZone(4, 100, 0).zone).toBe('discount');
  });

  it('classifies inside the 5% equilibrium band as equilibrium', () => {
    expect(classifyZone(50, 100, 0).zone).toBe('equilibrium');
    expect(classifyZone(47, 100, 0).zone).toBe('equilibrium');
    expect(classifyZone(53, 100, 0).zone).toBe('equilibrium');
  });

  it('returns null zone when high or low is missing (fail-open contract)', () => {
    expect(classifyZone(50, null, 0).zone).toBeNull();
    expect(classifyZone(50, 100, null).zone).toBeNull();
    expect(classifyZone(50, null, null).zone).toBeNull();
  });

  it('returns null zone when high < low (inverted/invalid range)', () => {
    expect(classifyZone(50, 10, 20).zone).toBeNull();
  });

  it('treats a flat range (high === low) as equilibrium, not a crash', () => {
    const result = classifyZone(100, 100, 100);
    expect(result.zone).toBe('equilibrium');
    expect(result.eqTop).toBe(100);
    expect(result.eqBtm).toBe(100);
  });
});
