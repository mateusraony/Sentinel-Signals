/**
 * Range Filter - B&S Signals
 * 
 * Portado fielmente do Pine Script v4 "Range Filter - B&S Signals"
 * 
 * Lógica original:
 * 1. Calcula range size usando EMA do absolute change * multiplier
 * 2. Calcula filtro com bandas alta e baixa  
 * 3. Determina direção do filtro
 * 4. Gera sinais BUY/SELL nas mudanças de condição
 * 
 * Diferenças conhecidas vs Pine Script:
 * - Pine usa dados intrabar em tempo real; aqui usamos apenas candles fechados
 * - Possível micro-diferença de arredondamento em EMA recursiva
 * - Timezone: dados Binance em UTC, Pine depende do chart timezone
 * 
 * @param {Array} candles - Array de candles normalizados [{open, high, low, close, ...}]
 * @param {number} period - Swing Period (default: 20)
 * @param {number} multiplier - Swing Multiplier (default: 3.5)
 * @returns {Object} Range Filter result
 */
export function calculateRangeFilter(candles, period = 20, multiplier = 3.5) {
  if (!candles || candles.length < period + 10) {
    throw new Error(`Candles insuficientes: ${candles?.length || 0}, mínimo: ${period + 10}`);
  }

  const closes = candles.map(c => c.close);
  const n = closes.length;

  // Step 1: Calculate range size for each bar
  // rng_size = EMA(EMA(|close - close[1]|, period), wper) * multiplier
  // wper = (period * 2) - 1
  const wper = (period * 2) - 1;
  
  // Absolute changes
  const absChanges = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    absChanges[i] = Math.abs(closes[i] - closes[i - 1]);
  }

  // First EMA of absolute changes
  const avrng = ema(absChanges, period);
  
  // Second EMA (smoothing)
  const smoothedRange = ema(avrng, wper);
  
  // Apply multiplier = range size
  const rangeSize = smoothedRange.map(v => v * multiplier);

  // Step 2: Calculate Range Filter
  const filterValues = new Array(n).fill(0);
  const hBand = new Array(n).fill(0);
  const lBand = new Array(n).fill(0);

  // Initialize filter with first valid close
  filterValues[0] = closes[0];

  for (let i = 1; i < n; i++) {
    const r = rangeSize[i];
    const prevFilter = filterValues[i - 1];
    const src = closes[i];

    // Pine logic: if x - r > rfilt[1] then rfilt = x - r
    //             if x + r < rfilt[1] then rfilt = x + r
    //             else rfilt = rfilt[1]
    if (src - r > prevFilter) {
      filterValues[i] = src - r;
    } else if (src + r < prevFilter) {
      filterValues[i] = src + r;
    } else {
      filterValues[i] = prevFilter;
    }

    hBand[i] = filterValues[i] + r;
    lBand[i] = filterValues[i] - r;
  }

  // Step 3: Direction
  const direction = new Array(n).fill(0);
  direction[0] = 0;
  for (let i = 1; i < n; i++) {
    if (filterValues[i] > filterValues[i - 1]) {
      direction[i] = 1;
    } else if (filterValues[i] < filterValues[i - 1]) {
      direction[i] = -1;
    } else {
      direction[i] = direction[i - 1];
    }
  }

  // Step 4: Trading conditions and signals
  // longCond = (src > filt && src > src[1] && upward) || (src > filt && src < src[1] && upward)
  // Simplificado: longCond = src > filt && upward
  // shortCond = src < filt && downward
  const condIni = new Array(n).fill(0);
  const signals = new Array(n).fill('NONE');

  for (let i = 1; i < n; i++) {
    const src = closes[i];
    const filt = filterValues[i];
    const upward = direction[i] === 1;
    const downward = direction[i] === -1;

    // Exact Pine logic
    const longCond = (src > filt && src > closes[i-1] && upward) || 
                     (src > filt && src < closes[i-1] && upward);
    const shortCond = (src < filt && src < closes[i-1] && downward) || 
                      (src < filt && src > closes[i-1] && downward);

    if (longCond) {
      condIni[i] = 1;
    } else if (shortCond) {
      condIni[i] = -1;
    } else {
      condIni[i] = condIni[i - 1];
    }

    // Signal only on state change
    const longCondition = longCond && condIni[i - 1] === -1;
    const shortCondition = shortCond && condIni[i - 1] === 1;

    if (longCondition) {
      signals[i] = 'BUY';
    } else if (shortCondition) {
      signals[i] = 'SELL';
    }
  }

  // Return the latest state (last candle)
  const last = n - 1;
  return {
    filterValue: filterValues[last],
    highBand: hBand[last],
    lowBand: lBand[last],
    direction: direction[last],
    signal: signals[last],
    condIni: condIni[last],
    // Full series for potential charting
    series: {
      filterValues,
      hBand,
      lBand,
      direction,
      signals,
      condIni,
    }
  };
}

/**
 * EMA calculation
 * Standard Exponential Moving Average
 */
function ema(data, period) {
  const result = new Array(data.length).fill(0);
  const k = 2 / (period + 1);

  // Initialize with first value
  result[0] = data[0];

  for (let i = 1; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}