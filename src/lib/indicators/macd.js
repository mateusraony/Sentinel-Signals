/**
 * MACD - Moving Average Convergence Divergence
 * 
 * @param {Array} candles - Array de candles normalizados
 * @param {number} fastPeriod - Fast EMA period (default: 12)
 * @param {number} slowPeriod - Slow EMA period (default: 26)
 * @param {number} signalPeriod - Signal line period (default: 9)
 * @returns {Object} MACD result
 */
export function calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!candles || candles.length < slowPeriod + signalPeriod) {
    throw new Error(`Candles insuficientes para MACD: ${candles?.length || 0}, mínimo: ${slowPeriod + signalPeriod}`);
  }

  const closes = candles.map(c => c.close);
  const n = closes.length;

  // Calculate fast and slow EMAs
  const fastEMA = ema(closes, fastPeriod);
  const slowEMA = ema(closes, slowPeriod);

  // MACD line = fast EMA - slow EMA
  const macdLine = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    macdLine[i] = fastEMA[i] - slowEMA[i];
  }

  // Signal line = EMA of MACD line
  const signalLine = ema(macdLine, signalPeriod);

  // Histogram = MACD line - Signal line
  const histogram = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    histogram[i] = macdLine[i] - signalLine[i];
  }

  const last = n - 1;
  const prev = n >= 2 ? n - 2 : 0;

  // Detect crossovers
  let cross = 'none';
  if (last >= 1) {
    const prevMACDAbove = macdLine[prev] > signalLine[prev];
    const currMACDAbove = macdLine[last] > signalLine[last];
    if (!prevMACDAbove && currMACDAbove) cross = 'bullish_cross';
    if (prevMACDAbove && !currMACDAbove) cross = 'bearish_cross';
  }

  return {
    macdLine: macdLine[last],
    signalLine: signalLine[last],
    histogram: histogram[last],
    previousHistogram: histogram[prev],
    cross,
    // Trend assessment
    trend: macdLine[last] > signalLine[last] ? 'bullish' : 'bearish',
    momentum: histogram[last] > histogram[prev] ? 'increasing' : 'decreasing',
    series: { macdLine, signalLine, histogram },
  };
}

function ema(data, period) {
  const result = new Array(data.length).fill(0);
  const k = 2 / (period + 1);
  result[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}