/**
 * Moving Averages - EMA calculations and crossover detection
 * 
 * @param {Array} candles - Array de candles normalizados
 * @param {number} shortPeriod - Short EMA period (default: 9)
 * @param {number} longPeriod - Long EMA period (default: 21)
 * @returns {Object} Moving average result
 */
export function calculateEMAs(candles, shortPeriod = 9, longPeriod = 21) {
  if (!candles || candles.length < longPeriod + 2) {
    throw new Error(`Candles insuficientes para EMA: ${candles?.length || 0}, mínimo: ${longPeriod + 2}`);
  }

  const closes = candles.map(c => c.close);
  const n = closes.length;

  const shortEMA = ema(closes, shortPeriod);
  const longEMA = ema(closes, longPeriod);

  const last = n - 1;
  const prev = n >= 2 ? n - 2 : 0;

  // Detect crossover
  let cross = 'none';
  if (last >= 1) {
    const prevShortAbove = shortEMA[prev] > longEMA[prev];
    const currShortAbove = shortEMA[last] > longEMA[last];
    if (!prevShortAbove && currShortAbove) cross = 'golden_cross';
    if (prevShortAbove && !currShortAbove) cross = 'death_cross';
  }

  // Trend: short above long = bullish
  const trend = shortEMA[last] > longEMA[last] ? 'bullish' : 
                shortEMA[last] < longEMA[last] ? 'bearish' : 'neutral';

  // Price position relative to EMAs
  const price = closes[last];
  const aboveBoth = price > shortEMA[last] && price > longEMA[last];
  const belowBoth = price < shortEMA[last] && price < longEMA[last];

  return {
    shortValue: shortEMA[last],
    longValue: longEMA[last],
    cross,
    trend,
    priceAboveBoth: aboveBoth,
    priceBelowBoth: belowBoth,
    spread: ((shortEMA[last] - longEMA[last]) / longEMA[last]) * 100,
    series: { shortEMA, longEMA },
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