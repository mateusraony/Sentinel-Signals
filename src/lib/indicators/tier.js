/**
 * Auto-Tier — classificação de volatilidade por ativo (igual ao Pine v13.2,
 * Grupo 03 "Auto-Ajuste por Tipo de Ativo").
 *
 * T1 Blue chip (ATR% baixo): stop 2.0x ATR, ADX mín 25, Chop máx 55, Time Stop 48 candles
 * T2 Mid cap:                 stop 2.5x ATR, ADX mín 22, Chop máx 58, Time Stop 64 candles
 * T3 Altcoin (ATR% alto):     stop 3.0x ATR, ADX mín 18, Chop máx 62, Time Stop 96 candles
 */

import { calculateATRSeries } from './atr';

const TIER_PARAMS = {
  T1: { atrStopMult: 2.0, adxMinVal: 25, chopMaxVal: 55, timeStopBars: 48 },
  T2: { atrStopMult: 2.5, adxMinVal: 22, chopMaxVal: 58, timeStopBars: 64 },
  T3: { atrStopMult: 3.0, adxMinVal: 18, chopMaxVal: 62, timeStopBars: 96 },
};

/**
 * ATR% suavizado: SMA(20) de (ATR(atrPeriod)/close*100) — mesma fórmula do
 * `atrPctSmooth` do Pine.
 */
export function calculateAtrPctSmooth(candles, atrPeriod = 14, smoothLen = 20) {
  const atrSeries = calculateATRSeries(candles, atrPeriod);
  if (atrSeries.length === 0) return 0;

  const atrPctSeries = atrSeries.map((atr, i) => (atr / candles[i].close) * 100);
  const slice = atrPctSeries.slice(-smoothLen).filter((v) => v > 0 || v === 0);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Classifica o tier a partir do ATR% suavizado.
 * @param {number} atrPctSmooth
 * @param {{tier2: number, tier3: number}} thresholds - default 0.8/1.5 (Pine)
 * @param {{T1: number, T2: number, T3: number}} [timeStopBarsOverride] - vem
 *   de strategyConfig (timeStopT1/T2/T3), sobrescreve os defaults do Pine.
 */
export function classifyTier(atrPctSmooth, thresholds = { tier2: 0.8, tier3: 1.5 }, timeStopBarsOverride) {
  const tier = atrPctSmooth >= thresholds.tier3 ? 'T3'
             : atrPctSmooth >= thresholds.tier2 ? 'T2' : 'T1';
  const params = { ...TIER_PARAMS[tier] };
  if (timeStopBarsOverride?.[tier] != null) params.timeStopBars = timeStopBarsOverride[tier];
  return { tier, atrPctSmooth, ...params };
}
