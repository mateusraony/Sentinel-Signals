import { describe, it, expect } from 'vitest';
import { calculateConfirmedSignal } from './rangeFilterConfirmation.js';
import { calculateRangeFilter } from './rangeFilter.js';
import { goldenCandles } from './__fixtures__/candles.js';

// docs/known-risks.md item 27 / .claude/rules/pine-parity.md: confirmBars is
// a real Pine parameter (src/pages/PineScript.jsx ~251-329/397-398), synced
// to Firestore but never read by scanner.js until this feature. Proved (not
// just asserted) here: at confirmBars=1 — the default synced today —
// calculateConfirmedSignal is mathematically identical to the raw
// rangeFilter.js flip signal for EVERY bar of a realistic 500-candle series,
// because longCond (rangeFilter.js) requires `src > filt && upward` in BOTH
// of its OR branches — so whenever signals[i]==='BUY' fires, close[i]>filt[i]
// && direction[i]===1 already holds by construction. This means enabling
// this feature changes nothing until a user actually raises confirmBars
// above 1 in the Pine editor.
describe('calculateConfirmedSignal — equivalence at confirmBars=1 (default)', () => {
  it('matches the raw rangeFilter.js signal on every bar of a realistic series', () => {
    const candles = goldenCandles(500);
    const { series } = calculateRangeFilter(candles);
    let sawAtLeastOneSignal = false;
    for (let i = 60; i < series.signals.length; i++) {
      const { confirmedSignal } = calculateConfirmedSignal(series, 1, i);
      expect(confirmedSignal).toBe(series.signals[i]);
      if (series.signals[i] !== 'NONE') sawAtLeastOneSignal = true;
    }
    // Sanity: this fixture must actually contain real BUY/SELL flips,
    // otherwise the loop above would trivially pass by comparing 'NONE' to
    // 'NONE' the whole way through and prove nothing.
    expect(sawAtLeastOneSignal).toBe(true);
  });
});

// Hand-built minimal series (same shape calculateRangeFilter's `series`
// returns) isolating the confirmBars>1 behavior — no real candle data
// needed, since calculateConfirmedSignal only reads filterValues/direction/
// signals/closes.
function makeSeries({ closesAt5 }) {
  return {
    signals:      ['NONE', 'NONE', 'NONE', 'BUY', 'NONE', 'NONE'],
    filterValues: [100, 100, 100, 100, 100, 100],
    direction:    [0, 0, 0, 1, 1, 1],
    closes:       [100, 100, 100, 105, 105, closesAt5],
  };
}

describe('calculateConfirmedSignal — confirmBars > 1 (backward-looking follow-through window)', () => {
  it('a whipsaw before the window closes cancels confirmation — opportunity lost, not delayed', () => {
    // Flip BUY at index 3, holds clean at 4, but violates (close < filt) at 5.
    const series = makeSeries({ closesAt5: 95 });
    expect(calculateConfirmedSignal(series, 3, 5).confirmedSignal).toBe('NONE');
    // freshBuy alone (ignoring follow-through) WOULD have been true here —
    // proves the whipsaw, not just timing, is what blocks it.
    expect(calculateConfirmedSignal(series, 3, 5).freshBuy).toBe(true);
    expect(calculateConfirmedSignal(series, 3, 5).buyFollowThrough).toBe(false);
  });

  it('a clean hold confirms exactly on the confirmBars-th bar, not earlier', () => {
    const series = makeSeries({ closesAt5: 105 }); // no whipsaw this time
    // Flip bar itself (index 3): not yet confirmed.
    expect(calculateConfirmedSignal(series, 3, 3).confirmedSignal).toBe('NONE');
    // One bar later (index 4): still not confirmed.
    expect(calculateConfirmedSignal(series, 3, 4).confirmedSignal).toBe('NONE');
    // Exactly confirmBars-1 (=2) bars after the flip (index 5): confirmed.
    expect(calculateConfirmedSignal(series, 3, 5).confirmedSignal).toBe('BUY');
  });

  it('never confirms a signal that never happened (no SELL anywhere in this fixture)', () => {
    const series = makeSeries({ closesAt5: 105 });
    expect(calculateConfirmedSignal(series, 3, 5).confirmedSignal).not.toBe('SELL');
  });

  it('insufficient history (fewer than confirmBars candles available) never confirms — mirrors Pine na()', () => {
    const series = makeSeries({ closesAt5: 105 });
    // At index 1, only indices 0-1 exist — confirmBars=3 needs indices back
    // to (index-2), which goes negative.
    expect(calculateConfirmedSignal(series, 3, 1).confirmedSignal).toBe('NONE');
    expect(calculateConfirmedSignal(series, 3, 1).buyFollowThrough).toBe(false);
  });
});
