// Pure, dependency-free candlestick pattern classifier. Original to this
// project — the reference Pine (docs/reference-pine/) has no candlestick
// pattern logic (grep for "engulf"/"bullish"/"bearish" pattern names comes
// up empty); this is an ADDITIONAL gate on top of the real RF strategy, not
// a port of it. No golden-test obligation (.claude/rules/pine-parity.md) —
// there's no TradingView reference to match against.
//
// Engulfing (bullish/bearish), pin bar (hammer/shooting star) and marubozu —
// three genuinely distinct theories (2-candle reversal, wick-rejection
// reversal, single-candle momentum/conviction), each with real community
// backtest evidence, picked deliberately over exhaustively porting every
// named candlestick pattern that exists (docs/known-risks.md item 58): more
// patterns tested against the same short real history is exactly the
// multiple-comparisons/data-mining trap the community research for this
// item warns about. Inverted Hammer (also ranked highly in that research)
// was deliberately skipped — it's the same wick geometry as a pin bar, just
// read at the opposite market extreme; adding it separately would test the
// same shape twice under a different name, not a genuinely different idea.
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

// Pin bar (hammer for BUY, shooting star for SELL) — a candle rejecting
// price on the side opposite the intended direction: a long wick on that
// side, a small body, and little/no wick on the direction's own side.
// Deliberately does NOT require the body to close in the signal direction
// (unlike engulfing) — the canonical hammer/shooting star definition is
// about the wick rejection, not the close color; many real hammers close
// slightly red and are still valid. `wickToBodyRatio` (default 2, the ratio
// most commonly cited for this pattern) is the only tunable knob.
export function detectPinBar(candle, direction, { wickToBodyRatio = 2 } = {}) {
  const invalid = { isPinBar: false, pattern: null, reason: 'invalid_params' };
  if (!candle || (direction !== 'BUY' && direction !== 'SELL') || wickToBodyRatio <= 0) {
    return invalid;
  }

  const body = Math.abs(candle.close - candle.open);
  if (body === 0) {
    // A doji has no body to anchor a wick ratio against — same "no
    // directional information here" call as engulfing's doji rejection.
    return { isPinBar: false, pattern: null, reason: 'doji' };
  }

  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const dominantWick = direction === 'BUY' ? lowerWick : upperWick;
  const oppositeWick = direction === 'BUY' ? upperWick : lowerWick;

  if (dominantWick < wickToBodyRatio * body) {
    return { isPinBar: false, pattern: null, reason: 'wick_too_short' };
  }
  if (oppositeWick > body) {
    return { isPinBar: false, pattern: null, reason: 'opposite_wick_too_long' };
  }

  return {
    isPinBar: true,
    pattern: direction === 'BUY' ? 'hammer' : 'shooting_star',
    reason: null,
  };
}

// Marubozu — a candle whose body dominates almost the entire high/low range
// (near-zero wicks on both ends), read as strong one-directional conviction.
// Unlike a pin bar, this DOES require the close to align with the signal
// direction — a marubozu is defined by its color (bullish/bearish), not
// just its shape. `minBodyToRangeRatio` (default 0.9) is a conventional
// threshold from the candlestick literature — a real number this project
// has no data of its own to calibrate, same category of judgment call as
// displacement.js's bodyAtrMult.
export function detectMarubozu(candle, direction, { minBodyToRangeRatio = 0.9 } = {}) {
  const invalid = { isMarubozu: false, pattern: null, reason: 'invalid_params' };
  if (!candle || (direction !== 'BUY' && direction !== 'SELL') || minBodyToRangeRatio <= 0) {
    return invalid;
  }

  // Checked before direction: a genuinely zero-range candle (high === low)
  // forces open === close === high === low too, which would always fail the
  // direction check below first and make this branch unreachable — order
  // matters here, not just for defense against a div-by-zero.
  const range = candle.high - candle.low;
  if (range <= 0) {
    return { isMarubozu: false, pattern: null, reason: 'zero_range' };
  }

  const alignedWithDirection = direction === 'BUY' ? candle.close > candle.open : candle.close < candle.open;
  if (!alignedWithDirection) {
    return { isMarubozu: false, pattern: null, reason: 'wrong_direction' };
  }

  const body = Math.abs(candle.close - candle.open);
  const bodyToRangeRatio = body / range;
  if (bodyToRangeRatio < minBodyToRangeRatio) {
    return { isMarubozu: false, pattern: null, reason: 'body_too_small' };
  }

  return {
    isMarubozu: true,
    pattern: direction === 'BUY' ? 'bullish_marubozu' : 'bearish_marubozu',
    reason: null,
  };
}
