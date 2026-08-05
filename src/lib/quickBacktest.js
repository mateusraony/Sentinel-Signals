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
import { calculateATRSeries } from './indicators/atr';
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

function closeSimulatedOp(position, exitPrice, exitTime, status, tp1QtyPercent, symbol, timeframe) {
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
 * @param {Object} config - { rfPeriod, rfMult, atrMult, tp1R, tp1QtyPercent, minScore, atrLen }
 * @param {{symbol: string, timeframe: string}} meta
 * @returns {{ ops: Array, stillOpen: Object|null }}
 */
export function runQuickBacktest(candles, config, meta) {
  const {
    rfPeriod = 20, rfMult = 3.5, atrMult = 2, tp1R = 1.5,
    tp1QtyPercent = 50, minScore = 75, atrLen = 14,
  } = config;
  const { symbol, timeframe } = meta;

  const minRequired = Math.max(rfPeriod + 10, atrLen + 1, 26 + 9, 21 + 2, 14 + 1) + 20;
  if (!candles || candles.length < minRequired) {
    throw new Error(`Candles insuficientes para simular: ${candles?.length || 0}, mínimo ${minRequired}`);
  }

  const rf = calculateRangeFilter(candles, rfPeriod, rfMult);
  const atrSeries = calculateATRSeries(candles, atrLen);
  const rsi = calculateRSI(candles, 14);
  const macd = calculateMACD(candles, 12, 26, 9);
  const emas = calculateEMAs(candles, 9, 21);
  const volumes = candles.map(c => c.volume || 0);

  const { signals, direction: rfDirection } = rf.series;
  const rsiSeries = rsi.series;
  const { histogram } = macd.series;
  const { shortEMA, longEMA } = emas.series;

  const ops = [];
  let position = null;
  const startIdx = minRequired;

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
      } else if (hitTp1) {
        position.tp1Hit = true;
        position.stop = position.entryPrice; // breakeven pós-TP1, mesma regra do runner real
      }
    }

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

      if (passed) {
        const atr = atrSeries[i];
        const entryPrice = candle.close;
        const stopDist = atr * atrMult;
        const stop = side === 'BUY' ? entryPrice - stopDist : entryPrice + stopDist;
        const tp1 = side === 'BUY' ? entryPrice + stopDist * tp1R : entryPrice - stopDist * tp1R;
        const tp2 = side === 'BUY' ? entryPrice + stopDist * tp1R * 2 : entryPrice - stopDist * tp1R * 2;
        position = {
          side, entryTime: candle.closeTime, entryPrice,
          stop, initialStop: stop, tp1, tp2, tp1Hit: false, score,
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

  return { ops, stillOpen };
}
