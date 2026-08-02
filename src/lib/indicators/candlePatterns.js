// Pure, dependency-free candlestick pattern classifier. Original to this
// project — the reference Pine (docs/reference-pine/) has no candlestick
// pattern logic (grep for "engulf"/"bullish"/"bearish" pattern names comes
// up empty); this is an ADDITIONAL gate on top of the real RF strategy, not
// a port of it. No golden-test obligation (.claude/rules/pine-parity.md) —
// there's no TradingView reference to match against.
//
// Starts with engulfing only (bullish/bearish) — the pattern with the most
// community-backtested evidence and the one explicitly requested. More
// patterns (pin bar, morning/evening star) can extend this module later
// without changing the shape callers depend on.
//
// Evaluates the two most recent CLOSED candles of the SIGNAL timeframe
// (e.g. 4h for the RF cascade) — current vs. the one immediately before it.
// Deliberately body-only (open/close), the standard definition: wicks don't
// factor into "engulfing" the way they do for a sweep or a pin bar.

export function detectEngulfing(currentCandle, previousCandle, direction) {
  const invalid = { isEngulfing: false, pattern: null, reason: 'invalid_params' };
  if (!currentCandle || !previousCandle || (direction !== 'BUY' && direction !== 'SELL')) {
    return invalid;
  }

  // Current candle must close in the signal's direction — a doji
  // (open === close) fails both sides, same guard displacement.js uses.
  const currentBullish = currentCandle.close > currentCandle.open;
  const currentBearish = currentCandle.close < currentCandle.open;
  const alignedWithDirection = direction === 'BUY' ? currentBullish : currentBearish;
  if (!alignedWithDirection) {
    return { isEngulfing: false, pattern: null, reason: 'wrong_direction' };
  }

  // The prior candle must be the OPPOSITE color — engulfing is a reversal
  // pattern by definition; two same-direction candles in a row isn't one,
  // no matter how large the second candle's body is.
  const previousOpposite = direction === 'BUY'
    ? previousCandle.close < previousCandle.open
    : previousCandle.close > previousCandle.open;
  if (!previousOpposite) {
    return { isEngulfing: false, pattern: null, reason: 'previous_not_opposite' };
  }

  // Body-engulfing check (open/close only, not the full high/low range):
  // the current candle's body must fully contain the previous candle's body.
  const engulfs = direction === 'BUY'
    ? currentCandle.open <= previousCandle.close && currentCandle.close >= previousCandle.open
    : currentCandle.open >= previousCandle.close && currentCandle.close <= previousCandle.open;
  if (!engulfs) {
    return { isEngulfing: false, pattern: null, reason: 'body_not_engulfing' };
  }

  return {
    isEngulfing: true,
    pattern: direction === 'BUY' ? 'bullish_engulfing' : 'bearish_engulfing',
    reason: null,
  };
}
