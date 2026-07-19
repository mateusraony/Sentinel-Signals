/**
 * RSI - Relative Strength Index
 * 
 * Implementação padrão Wilder's RSI
 * 
 * @param {Array} candles - Array de candles normalizados
 * @param {number} period - RSI period (default: 14)
 * @returns {Object} RSI result
 */
export function calculateRSI(candles, period = 14, overbought = 70, oversold = 30) {
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
  const prev2RSI = n >= 3 ? rsi[n - 3] : prevRSI;

  // Same crossover-of-50 condition the Pine script uses to score entries
  // (ta.crossover(rsi,50) or a same-side 2-bar-old cross): a static
  // "50 < rsi < 70" band check (the previous JS logic) is a different,
  // looser condition than what the reference strategy actually scores on.
  const crossedBull50 = (prevRSI <= 50 && lastRSI > 50) || (lastRSI > 50 && prevRSI > 50 && prev2RSI < 50);
  const crossedBear50 = (prevRSI >= 50 && lastRSI < 50) || (lastRSI < 50 && prevRSI < 50 && prev2RSI > 50);

  return {
    value: lastRSI,
    previousValue: prevRSI,
    zone: getRSIZone(lastRSI, overbought, oversold),
    crossedBull50,
    crossedBear50,
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