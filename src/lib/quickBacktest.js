// Simulação rápida, single-asset/single-timeframe, 100% client-side — NÃO é
// o mesmo motor de backtest.yml/backtestEngine.js (que replica a cascata
// multi-timeframe inteira via scanAsset/persistScanResults). Este é um
// sandbox simplificado para "e se eu mudasse este parâmetro?" na hora,
// sem esperar o GitHub Actions. Reaproveita as MESMAS funções puras de
// indicador que o motor real usa (calculateRangeFilter, ATR, RSI, MACD,
// EMA, e o score real de calculateSignalStrength) — não inventa cálculo
// novo — mas simplifica a decisão de entrada para um único timeframe, sem
// alinhamento multi-TF, sem arbitragem entre cascatas, sem SMC. Aproximação
// deliberada, não uma paridade de motor (ver .claude/rules/pine-parity.md).
import { calculateRangeFilter } from './indicators/rangeFilter';
import { calculateATRSeries, calculateTRSeries } from './indicators/atr';
import { calculateADX } from './indicators/adx';
import { classifyTier } from './indicators/tier';
import { calculateRSI } from './indicators/rsi';
import { calculateMACD } from './indicators/macd';
import { calculateEMAs } from './indicators/movingAverages';
import { calculateSignalStrength } from './indicators/confluence';

function simpleMovingAverage(values, i, period) {
  if (i < period - 1) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += values[k];
  return sum / period;
}

// Choppiness por barra — a MESMA fórmula de calculateChoppiness (indicators/choppiness.js), calculada de uma vez para a série inteira.
// Barra i usa só as velas até i (sem olhar o futuro); o teste de paridade compara cada barra com calculateChoppiness(candles.slice(0, i + 1)).
export function chopSeries(candles, length = 14) {
  const tr = calculateTRSeries(candles);
  return candles.map((_, i) => {
    if (i + 1 < length) return 50;
    let trSum = 0; let hi = -Infinity; let lo = Infinity;
    for (let k = i - length + 1; k <= i; k++) { trSum += tr[k]; if (candles[k].high > hi) hi = candles[k].high; if (candles[k].low < lo) lo = candles[k].low; }
    const range = hi - lo;
    return range <= 0 ? 50 : (100 * Math.log10(trSum / range)) / Math.log10(length);
  });
}

// ATR% suavizado por barra (SMA de 20 do ATR/close*100) — a mesma fórmula de calculateAtrPctSmooth (indicators/tier.js) para cada prefixo.
export function atrPctSmoothSeries(candles, atrSeries, atrLen = 14, smoothLen = 20) {
  return candles.map((_, i) => {
    if (i < atrLen - 1) return 0;
    const from = Math.max(atrLen - 1, i - smoothLen + 1);
    let sum = 0;
    for (let k = from; k <= i; k++) sum += (atrSeries[k] / candles[k].close) * 100;
    return sum / (i - from + 1);
  });
}

function closeSimulatedOp(position, exitPrice, exitTime, status, tp1QtyPercent, symbol, timeframe, closedReason = null) {
  const { side, entryPrice, entryTime, initialStop, tp1, tp2, tp1Hit, score } = position;
  const dir = side === 'BUY' ? 1 : -1;
  const riskDist = Math.abs(entryPrice - initialStop);

  // Mesma convenção de peso parcial/runner que tradeMetrics.js usa para
  // TradeOperation reais — permite reaproveitar summarizeOps() sem
  // reimplementar a conta de P&L/R ponderado aqui.
  const pctAt = (price) => ((price - entryPrice) / entryPrice) * 100 * dir;
  const rAt = (price) => (riskDist > 0 ? (dir * (price - entryPrice)) / riskDist : 0);

  return {
    id: `qbt-${entryTime}-${exitTime}`,
    symbol,
    timeframe,
    cascade: 'quick_backtest',
    side,
    entry_price: entryPrice,
    initial_stop: initialStop,
    current_stop: initialStop,
    tp1,
    tp2,
    tp1_hit: tp1Hit,
    tp1_hit_price: tp1Hit ? tp1 : undefined,
    partial_percent: tp1QtyPercent,
    exit_price: exitPrice,
    status,
    ...(closedReason ? { closed_reason: closedReason } : {}),
    created_date: entryTime,
    closed_at: exitTime,
    score,
    // Campos só para exibição — tradeMetrics.js ignora o que não conhece.
    _pctAtTp1: pctAt(tp1),
    _rAtTp1: rAt(tp1),
  };
}

/**
 * Roda a simulação simplificada sobre uma série de candles JÁ FECHADOS de um
 * único símbolo/timeframe.
 * @param {Array} candles - candles normalizados, ordem ascendente, só fechados
 * @param {Object} config - { rfPeriod, rfMult, atrMult, tp1R, tp1QtyPercent, minScore, atrLen, emaFast, emaSlow,
 *   regimeFilter?: { useADX, useChop, adxLen, adxSmooth, chopLen } | null,   // filtro ADX/Choppiness por tier, SÓ barra entrada (como evaluateRegime do scanner)
 *   timeStop?: { T1, T2, T3 } | null,                                        // fecha ANTES do TP1 após N candles (N por tier), no fechamento da vela
 *   tierThresholds?: { tier2, tier3 } }                                      // limites de ATR% do tier (Pine: 0.8 / 1.5)
 *   Sem regimeFilter/timeStop (o padrão) o comportamento é o de sempre.
 * @param {{symbol: string, timeframe: string}} meta
 * @returns {{ ops: Array, stillOpen: Object|null, stats: { signals: number, taken: number, rejectedByScore: number, rejectedByRegime: number, skippedWhileOpen: number, startIndex: number, candlesTotal: number, firstTradableTime: number|null } }}
 *   `stats` conta o que aconteceu com cada sinal do Range Filter (aditivo: quem só usa ops/stillOpen não muda).
 */
export function runQuickBacktest(candles, config, meta) {
  const {
    rfPeriod = 20, rfMult = 3.5, atrMult = 2, tp1R = 1.5,
    tp1QtyPercent = 50, minScore = 75, atrLen = 14,
  } = config;
  // Médias do score: as MESMAS que o scanner usa (Pine: 20/50 — resolveIndicatorParams, known-risks item 27). Até 22/11/2026 este
  // simulador usava 9/21 fixas, o que muda a tendência EMA (20 pts do score) em ~15% das barras. Par inválido (rápida >= lenta) cai
  // inteiro nos valores do Pine, como no scanner (item 31).
  const { regimeFilter = null, timeStop = null, tierThresholds = { tier2: 0.8, tier3: 1.5 } } = config;
  let { emaFast = 20, emaSlow = 50 } = config;
  if (!(Number.isInteger(emaFast) && Number.isInteger(emaSlow) && emaFast > 0 && emaFast < emaSlow)) { emaFast = 20; emaSlow = 50; }
  const { symbol, timeframe } = meta;

  const minRequired = Math.max(rfPeriod + 10, atrLen + 1, 26 + 9, emaSlow + 2, 14 + 1) + 20;
  if (!candles || candles.length < minRequired) {
    throw new Error(`Candles insuficientes para simular: ${candles?.length || 0}, mínimo ${minRequired}`);
  }

  const rf = calculateRangeFilter(candles, rfPeriod, rfMult);
  const atrSeries = calculateATRSeries(candles, atrLen);
  const rsi = calculateRSI(candles, 14);
  const macd = calculateMACD(candles, 12, 26, 9);
  const emas = calculateEMAs(candles, emaFast, emaSlow);
  const volumes = candles.map(c => c.volume || 0);

  const { signals, direction: rfDirection } = rf.series;
  const rsiSeries = rsi.series;
  const { histogram } = macd.series;
  const { shortEMA, longEMA } = emas.series;

  // Regime e time stop precisam do TIER (ATR% suavizado por barra, como o scanner) e, o regime, do ADX/Choppiness por barra.
  const needTier = Boolean(regimeFilter || timeStop);
  const atrPctSmooth = needTier ? atrPctSmoothSeries(candles, atrSeries, atrLen, 20) : null;
  const tierAt = (i) => classifyTier(atrPctSmooth[i], tierThresholds, timeStop ? { T1: timeStop.T1, T2: timeStop.T2, T3: timeStop.T3 } : undefined);
  // ADX por barra, como o scanner o vê: calculateADX devolve `adx: 0` (e NENHUMA série) quando o prefixo tem menos de adxLen + adxSmooth + 1 velas, e a
  // produção então REJEITA a entrada (0 < mínimo do tier). Tratar "sem série" como "sem filtro" liberava entradas e fazia as primeiras operações
  // dependerem do tamanho TOTAL da série (achado do Codex, PR #618): a regra é por barra, nunca pela série inteira.
  const adxLen = regimeFilter?.adxLen ?? 14;
  const adxSm = regimeFilter?.adxSmooth ?? 14;
  const adxFull = regimeFilter ? calculateADX(candles, adxLen, adxSm).series?.adx ?? null : null;
  const adxAt = (i) => (adxFull && i + 1 >= adxLen + adxSm + 1 ? adxFull[i] : 0);
  const chopS = regimeFilter && regimeFilter.useChop !== false ? chopSeries(candles, regimeFilter.chopLen ?? 14) : null;

  const ops = [];
  let position = null;
  const startIdx = minRequired;
  // O que aconteceu com cada sinal do Range Filter a partir do início da simulação (para explicar "por que só N operações").
  const stats = { signals: 0, taken: 0, rejectedByScore: 0, rejectedByRegime: 0, skippedWhileOpen: 0, startIndex: startIdx, candlesTotal: candles.length, firstTradableTime: candles[startIdx]?.closeTime ?? null };

  for (let i = startIdx; i < candles.length; i++) {
    const candle = candles[i];

    if (position) {
      const { side, stop, tp1, tp2, tp1Hit } = position;
      const hitStop = side === 'BUY' ? candle.low <= stop : candle.high >= stop;
      const hitTp1 = !tp1Hit && (side === 'BUY' ? candle.high >= tp1 : candle.low <= tp1);
      const hitTp2 = side === 'BUY' ? candle.high >= tp2 : candle.low <= tp2;

      // Mesma política "stop vence" em caso de ambiguidade no mesmo candle
      // que o motor real usa (opExitRules.resolveCandleExit).
      if (hitStop) {
        ops.push(closeSimulatedOp(position, stop, candle.closeTime, 'STOP_HIT', tp1QtyPercent, symbol, timeframe));
        position = null;
      } else if (position.tp1Hit && hitTp2) {
        ops.push(closeSimulatedOp(position, tp2, candle.closeTime, 'TP2_HIT', tp1QtyPercent, symbol, timeframe));
        position = null;
      } else if (!position.tp1Hit && position.timeStopBars != null && i - position.entryIndex >= position.timeStopBars) {
        // Time stop (como o scanner, que só o aplica ANTES do TP1): fecha no FECHAMENTO da vela, depois de o stop ter sido checado e ANTES de contar um TP1 desta vela.
        ops.push(closeSimulatedOp(position, candle.close, candle.closeTime, 'CLOSED', tp1QtyPercent, symbol, timeframe, 'TIME_STOP'));
        position = null;
      } else if (hitTp1) {
        position.tp1Hit = true;
        position.stop = position.entryPrice; // breakeven pós-TP1, mesma regra do runner real
      }
    }

    if (signals[i] !== 'NONE') stats.signals += 1;
    if (position && signals[i] !== 'NONE') stats.skippedWhileOpen += 1;

    if (!position && signals[i] !== 'NONE') {
      const side = signals[i];
      const rfResult = { signal: side, direction: rfDirection[i] };
      const prevRsi = i >= 1 ? rsiSeries[i - 1] : rsiSeries[i];
      const prev2Rsi = i >= 2 ? rsiSeries[i - 2] : prevRsi;
      const rsiResult = {
        crossedBull50: (prevRsi <= 50 && rsiSeries[i] > 50) || (rsiSeries[i] > 50 && prevRsi > 50 && prev2Rsi < 50),
        crossedBear50: (prevRsi >= 50 && rsiSeries[i] < 50) || (rsiSeries[i] < 50 && prevRsi < 50 && prev2Rsi > 50),
      };
      const macdResult = { histogram: histogram[i] };
      const emaResult = { trend: shortEMA[i] > longEMA[i] ? 'bullish' : 'bearish' };
      const volMa = simpleMovingAverage(volumes, i, 20);
      const volumeData = volMa != null ? { current: volumes[i], ma: volMa } : null;

      // Mesma fórmula de score 0-100 do motor real (confluence.js) — não é
      // um score inventado pra este sandbox.
      const { score, passed } = calculateSignalStrength(
        rfResult, rsiResult, macdResult, emaResult, { alignment: 'aligned' },
        timeframe, volumeData, minScore, null,
      );

      if (!passed) stats.rejectedByScore += 1;

      // Filtro de regime (evaluateRegime do scanner): só barra ENTRADA; ADX >= mínimo do tier e Choppiness <= máximo do tier (cada um liga/desliga).
      let tierHere = null;
      let regimeOk = true;
      if (passed && needTier) tierHere = tierAt(i);
      if (passed && regimeFilter) {
        const adxOk = regimeFilter.useADX === false || adxAt(i) >= tierHere.adxMinVal;
        const chopOk = chopS === null || chopS[i] <= tierHere.chopMaxVal;
        regimeOk = adxOk && chopOk;
        if (!regimeOk) stats.rejectedByRegime += 1;
      }

      if (passed && regimeOk) {
        stats.taken += 1;
        const atr = atrSeries[i];
        const entryPrice = candle.close;
        const stopDist = atr * atrMult;
        const stop = side === 'BUY' ? entryPrice - stopDist : entryPrice + stopDist;
        const tp1 = side === 'BUY' ? entryPrice + stopDist * tp1R : entryPrice - stopDist * tp1R;
        const tp2 = side === 'BUY' ? entryPrice + stopDist * tp1R * 2 : entryPrice - stopDist * tp1R * 2;
        position = {
          side, entryTime: candle.closeTime, entryPrice,
          stop, initialStop: stop, tp1, tp2, tp1Hit: false, score,
          entryIndex: i, timeStopBars: timeStop ? tierHere.timeStopBars : null,
        };
      }
    }
  }

  const stillOpen = position
    ? {
      symbol, timeframe, side: position.side, entry_price: position.entryPrice,
      initial_stop: position.initialStop, tp1: position.tp1, tp2: position.tp2,
      created_date: position.entryTime, tp1_hit: position.tp1Hit, score: position.score,
    }
    : null;

  return { ops, stillOpen, stats };
}
