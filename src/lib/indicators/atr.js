/**
 * ATR - Average True Range
 * Usa Wilder's Smoothing (RMA) idêntico ao ta.atr do Pine Script
 */
export function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;

  const n = candles.length;
  const tr = new Array(n).fill(0);

  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close)
    );
  }

  // Wilder's RMA: seed = SMA(period), então alpha = 1/period
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }

  return atr;
}