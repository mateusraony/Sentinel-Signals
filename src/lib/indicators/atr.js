/**
 * True Range por candle — reaproveitado por ATR, ADX e Choppiness Index,
 * que precisam todos da mesma série de TR bar-a-bar (ta.tr do Pine).
 */
export function calculateTRSeries(candles) {
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
  return tr;
}

/**
 * Série completa de ATR (Wilder RMA) — usada por Tier (ATR% suavizado) e
 * disponível para qualquer outro indicador que precise do valor por candle,
 * não só o último.
 */
export function calculateATRSeries(candles, period = 14) {
  if (!candles || candles.length < period + 1) return [];

  const n = candles.length;
  const tr = calculateTRSeries(candles);
  const atr = new Array(n).fill(0);

  // Wilder's RMA: seed = SMA(period), então alpha = 1/period
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atr[period - 1] = value;
  for (let i = period; i < n; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    atr[i] = value;
  }
  return atr;
}

/**
 * ATR - Average True Range
 * Usa Wilder's Smoothing (RMA) idêntico ao ta.atr do Pine Script
 */
export function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  const series = calculateATRSeries(candles, period);
  return series[series.length - 1];
}