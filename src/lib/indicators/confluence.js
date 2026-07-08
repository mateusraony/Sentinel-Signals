/**
 * Confluence Engine - NEW ERA Range Filter Strategy v2
 *
 * Score 0-100 (igual ao Pine Script v2):
 *   followThrough  25pts
 *   macdHist dir   20pts
 *   emaTrend       20pts
 *   rsi zone       15pts
 *   volume > ma    10pts
 *   close vs filt  10pts
 *
 * Gate: score >= minScore (padrão 75, alinhado com Pine v12) para emitir sinal.
 */

/**
 * Analyze multi-timeframe alignment
 * @param {Object} states - { '1h': state, '4h': state, '1d': state }
 * @returns {Object} Alignment analysis
 */
export function analyzeAlignment(states) {
  const tf1d = states['1d'];
  const tf4h = states['4h'];
  const tf1h = states['1h'];

  if (!tf1d || !tf4h || !tf1h) {
    return {
      alignment: 'unknown',
      macro_direction: tf1d?.rf_direction || 0,
      description: 'Dados insuficientes para análise de alinhamento',
    };
  }

  const dir1d = tf1d.rf_direction;
  const dir4h = tf4h.rf_direction;
  const dir1h = tf1h.rf_direction;

  // Full alignment
  if (dir1d === dir4h && dir4h === dir1h && dir1d !== 0) {
    return {
      alignment: 'aligned',
      direction: dir1d === 1 ? 'bullish' : 'bearish',
      macro_direction: dir1d,
      description: dir1d === 1
        ? 'Alinhamento bullish completo (1D + 4H + 1H)'
        : 'Alinhamento bearish completo (1D + 4H + 1H)',
    };
  }

  // 1D + 4H aligned, 1H different
  if (dir1d === dir4h && dir1d !== 0) {
    return {
      alignment: 'partially_aligned',
      direction: dir1d === 1 ? 'bullish' : 'bearish',
      macro_direction: dir1d,
      description: dir1d === 1
        ? 'Macro bullish (1D + 4H alinhados), 1H divergente'
        : 'Macro bearish (1D + 4H alinhados), 1H divergente',
    };
  }

  // 4H + 1H aligned, against 1D
  if (dir4h === dir1h && dir4h !== 0 && dir4h !== dir1d) {
    return {
      alignment: 'against_trend',
      direction: dir4h === 1 ? 'bullish' : 'bearish',
      macro_direction: dir1d,
      description: `4H + 1H ${dir4h === 1 ? 'bullish' : 'bearish'} contra direção macro do 1D`,
    };
  }

  // Mixed
  return {
    alignment: 'partially_aligned',
    direction: dir1d === 1 ? 'bullish' : dir1d === -1 ? 'bearish' : 'neutral',
    macro_direction: dir1d,
    description: 'Timeframes com sinais mistos',
  };
}

/**
 * Calculate signal strength based on confluence of indicators (Pine v2 score 0-100)
 * @param {Object} rfResult - Range Filter result
 * @param {Object} rsiResult - RSI result
 * @param {Object} macdResult - MACD result
 * @param {Object} emaResult - EMA result
 * @param {Object} alignmentResult - Multi-TF alignment result
 * @param {string} timeframe - Current timeframe
 * @param {Object} volumeData - { current, ma } volume data
 * @param {number} minScore - Minimum score threshold (default 75)
 * @returns {Object} Signal strength, priority, score, reasons
 */
export function calculateSignalStrength(rfResult, rsiResult, macdResult, emaResult, alignmentResult, timeframe, volumeData = null, minScore = 75) {
  const isBuy  = rfResult.signal === 'BUY';
  const isSell = rfResult.signal === 'SELL';
  const reasons = [];

  // followThrough: price on correct side of filter with correct direction (25pts)
  // By definition, when RF emits a signal the condition is met
  const followThrough = isBuy
    ? (rfResult.direction === 1)
    : (rfResult.direction === -1);
  let score = followThrough ? 25 : 0;
  if (followThrough) reasons.push('Follow-through confirmado (+25)');

  // MACD histogram direction (20pts)
  if (isBuy  && macdResult.histogram > 0) { score += 20; reasons.push('MACD hist positivo (+20)'); }
  if (isSell && macdResult.histogram < 0) { score += 20; reasons.push('MACD hist negativo (+20)'); }

  // EMA trend (20pts)
  const emaBull = emaResult.trend === 'bullish';
  const emaBear = emaResult.trend === 'bearish';
  if (isBuy  && emaBull) { score += 20; reasons.push('EMA tendência bullish (+20)'); }
  if (isSell && emaBear) { score += 20; reasons.push('EMA tendência bearish (+20)'); }

  // RSI zone (15pts)
  const rsi = rsiResult.value;
  if (isBuy  && rsi > 50 && rsi < 70) { score += 15; reasons.push(`RSI ${rsi.toFixed(1)} em zona favorável compra (+15)`); }
  if (isSell && rsi < 50 && rsi > 30) { score += 15; reasons.push(`RSI ${rsi.toFixed(1)} em zona favorável venda (+15)`); }

  // Volume > MA (10pts)
  if (volumeData && volumeData.current > volumeData.ma) {
    score += 10;
    reasons.push('Volume acima da média (+10)');
  }

  // Close vs filter (10pts)
  if (isBuy  && rfResult.direction === 1)  { score += 10; reasons.push('Preço acima do filtro (+10)'); }
  if (isSell && rfResult.direction === -1) { score += 10; reasons.push('Preço abaixo do filtro (+10)'); }

  // Classify
  const passed = score >= minScore;
  let strength, priority;
  if (score >= 85) {
    strength = 'strong'; priority = 'high';
  } else if (score >= minScore) {
    strength = 'moderate'; priority = 'medium';
  } else {
    strength = 'weak'; priority = 'low';
  }

  // Signal alignment from multi-TF
  let signalAlignment = 'aligned';
  if (alignmentResult.alignment === 'against_trend') signalAlignment = 'against_trend';
  else if (alignmentResult.alignment === 'partially_aligned') signalAlignment = 'partially_aligned';

  return { score, strength, priority, alignment: signalAlignment, reasons, passed };
}

/**
 * Generate human-readable signal description
 */
export function generateSignalDescription(symbol, timeframe, signal, strength, alignment, reasons) {
  const tfLabel = { '1h': '1H', '4h': '4H', '1d': '1D' }[timeframe] || timeframe;
  const strengthLabel = { strong: 'Forte', moderate: 'Moderado', weak: 'Fraco' }[strength] || strength;
  const alignLabel = { 
    aligned: 'Alinhado com TF maior',
    partially_aligned: 'Parcialmente alinhado',
    against_trend: 'Contra tendência maior'
  }[alignment] || alignment;

  return `${symbol} — ${signal} ${tfLabel} [${strengthLabel}] — ${alignLabel}. ${reasons.slice(0, 3).join('; ')}`;
}