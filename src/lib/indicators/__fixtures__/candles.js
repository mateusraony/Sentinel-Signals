// Candle fixtures reused across indicator tests. Kept minimal/synthetic
// (not real market data) so expected values can be reasoned about or
// hand/spreadsheet-verified — the point is testing the math, not replaying
// history.

export function mkCandle(open, high, low, close, i = 0) {
  return {
    open, high, low, close,
    volume: 100,
    openTime: i * 3600000,
    closeTime: (i + 1) * 3600000,
    isClosed: true,
  };
}

/** Flat candles (open=high=low=close) — the all-zero-change edge case. */
export function flatCandles(n, price = 100) {
  return Array.from({ length: n }, (_, i) => mkCandle(price, price, price, price, i));
}

/** Steady uptrend: each candle closes higher than the last, small range. */
export function uptrendCandles(n, start = 100, step = 1) {
  const candles = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + step;
    const high = close + 0.2;
    const low = open - 0.2;
    candles.push(mkCandle(open, high, low, close, i));
    price = close;
  }
  return candles;
}

/** Steady downtrend, mirror of uptrendCandles. */
export function downtrendCandles(n, start = 100, step = 1) {
  const candles = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price - step;
    const high = open + 0.2;
    const low = close - 0.2;
    candles.push(mkCandle(open, high, low, close, i));
    price = close;
  }
  return candles;
}

/**
 * Choppy/sideways: bounces around a center with varying (deterministic
 * pseudo-random) up/down move sizes and no net drift. Varying the move size
 * bar to bar (rather than a perfectly periodic alternation) is deliberate —
 * a clean +N/-N/+N/-N zigzag keeps +DM and -DM both near zero every bar,
 * which saturates ADX's DX ratio to 100 as a numeric artifact (100*|a-b|/
 * (a+b) blows up when a and b are both tiny), giving a falsely HIGH ADX for
 * "choppy" data instead of a low one. Meaningful, uneven move sizes keep
 * +DM/-DM both substantial and roughly balanced, which is what actually
 * produces a low ADX (no direction dominance) as intended.
 */
export function choppyCandles(n, center = 100, amplitude = 3) {
  const candles = [];
  let price = center;
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    const open = price;
    const direction = rand() > 0.5 ? 1 : -1;
    const size = amplitude * (0.5 + rand());
    let close = open + direction * size;
    // Pull back toward center so the range doesn't drift.
    close += (center - close) * 0.3;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    candles.push(mkCandle(open, high, low, close, i));
    price = close;
  }
  return candles;
}

/**
 * A clean zigzag downtrend (strictly lower highs/lows) followed by a strong
 * bullish breakout candle above the most recent swing high — used to test
 * BOS/CHoCH detection in smcStructure.js. Mirrors the manual scenario
 * verified ad hoc during the original SMC cascade implementation.
 */
export function chochBreakoutCandles() {
  const candles = [];
  let idx = 0;
  function addLeg(fromPrice, toPrice, bars) {
    for (let k = 0; k < bars; k++) {
      const t = k / (bars - 1);
      const close = fromPrice + (toPrice - fromPrice) * t;
      const open = idx === 0 ? close : candles[candles.length - 1].close;
      const high = Math.max(open, close) + 0.3;
      const low = Math.min(open, close) - 0.3;
      candles.push(mkCandle(open, high, low, close, idx));
      idx++;
    }
  }
  addLeg(100, 90, 8);
  addLeg(90, 96, 8);
  addLeg(96, 86, 8);
  addLeg(86, 92, 8);
  addLeg(92, 82, 8);
  addLeg(82, 88, 8);

  const lastClose = candles[candles.length - 1].close;
  candles.push(mkCandle(lastClose, 105, lastClose - 1, 104, idx++));
  candles.push(mkCandle(104, 106, 103, 105, idx));
  return candles;
}
