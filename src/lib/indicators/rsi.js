/**
 * RSI - Relative Strength Index
 * 
 * Implementação padrão Wilder's RSI
 * 
 * @param {Array} candles - Array de candles normalizados
 * @param {number} period - RSI period (default: 14)
 * @returns {Object} RSI result
 */
export function calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    throw new Error(`Candles insuficientes para RSI: ${candles?.length || 0}, mínimo: ${period + 1}`);
  }

  const closes = candles.map(c => c.close);
  const n = closes.length;
  
  // Calculate price changes
  const changes = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    changes[i] = closes[i] - closes[i - 1];
  }

  // Separate gains and losses
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);

  // Wilder's smoothing (same as RMA/SMMA)
  const avgGain = new Array(n).fill(0);
  const avgLoss = new Array(n).fill(0);
  const rsi = new Array(n).fill(50);

  // Initial average (SMA of first period)
  let sumGain = 0, sumLoss = 0;
  for (let i = 1; i <= period; i++) {
    sumGain += gains[i];
    sumLoss += losses[i];
  }
  avgGain[period] = sumGain / period;
  avgLoss[period] = sumLoss / period;

  // Calculate RSI for each bar using Wilder's smoothing
  for (let i = period; i < n; i++) {
    if (i > period) {
      avgGain[i] = (avgGain[i - 1] * (period - 1) + gains[i]) / period;
      avgLoss[i] = (avgLoss[i - 1] * (period - 1) + losses[i]) / period;
    }

    if (avgLoss[i] === 0) {
      rsi[i] = 100;
    } else {
      const rs = avgGain[i] / avgLoss[i];
      rsi[i] = 100 - (100 / (1 + rs));
    }
  }

  const lastRSI = rsi[n - 1];
  const prevRSI = n >= 2 ? rsi[n - 2] : lastRSI;

  return {
    value: lastRSI,
    previousValue: prevRSI,
    zone: lastRSI >= 70 ? 'overbought' : lastRSI <= 30 ? 'oversold' : 'neutral',
    series: rsi,
  };
}

/**
 * Get RSI zone with custom thresholds
 */
export function getRSIZone(value, overbought = 70, oversold = 30) {
  if (value >= overbought) return 'overbought';
  if (value <= oversold) return 'oversold';
  return 'neutral';
}