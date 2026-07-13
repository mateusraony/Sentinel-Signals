/**
 * Scanner Engine - Orquestra a análise completa de um ativo
 * 
 * Fluxo:
 * 1. Busca candles de todos os timeframes habilitados
 * 2. Calcula indicadores para cada timeframe
 * 3. Analisa alinhamento multi-timeframe
 * 4. Calcula força e confluência
 * 5. Gera sinais se houver
 * 6. Verifica deduplicação
 * 7. Persiste estado e sinais
 */

import { fetchCandles, fetchCurrentPrice } from './marketDataProvider';
import { calculateRangeFilter } from './indicators/rangeFilter';
import { calculateRSI } from './indicators/rsi';
import { calculateMACD } from './indicators/macd';
import { calculateEMAs } from './indicators/movingAverages';
import { analyzeAlignment, calculateSignalStrength, generateSignalDescription } from './indicators/confluence';
import { calculateATR } from './indicators/atr';
import { calculateAtrPctSmooth, classifyTier } from './indicators/tier';
import { calculateADX } from './indicators/adx';
import { calculateChoppiness } from './indicators/choppiness';
import { calculateStructure, calculateLiquiditySweep, calculatePdZone } from './indicators/smcStructure';
import { getPineConfig } from './pineParser';
import { logInfo, logWarn, logError } from './logger';
import { backend } from '@/api/entities';
import {
  isTelegramConfigured,
  notifyNewSignal,
  notifyTradeCreated,
  notifyTP1Hit,
  notifyTP2Hit,
  notifyStopHit,
} from './telegram';

const TIMEFRAMES = ['1h', '4h', '1d'];
const TF_15M = '15m'; // Used for entry confirmation after 4h signal
const TF_5M = '5m'; // Used for entry confirmation after 1h SMC signal
const ONE_HOUR_MS = 60 * 60 * 1000;
// Fixed constant, deliberately NOT pineConfig.trailAtrMult — that field is
// reserved for the RF cascade's post-TP1 trailing (see buildTradeOpData's
// comment on the same mix-up). The SMC cascade has no tier/regime system to
// derive its own multiplier from yet, so this stays a plain constant.
const SMC_INITIAL_STOP_ATR_MULT = 2.0;

// Lock TTLs: comfortably above the slowest realistic run of each operation
// (the GitHub Actions job has an 8-minute timeout for full scans) so a
// crashed/killed run's lock still expires instead of blocking forever.
const FULL_SCAN_LOCK_TTL_MS = 10 * 60 * 1000;
const PRICE_CHECK_LOCK_TTL_MS = 3 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Bar duration per signal timeframe — used by the Time Stop calculation,
// which counts elapsed time in units of the SIGNAL candle (not the
// entry-confirmation candle). Falls back to 4h for legacy ops that predate
// the `signal_timeframe` field (all of which came from the 4h/15m cascade).
const SIGNAL_TF_MS = { '4h': FOUR_HOURS_MS, '1h': ONE_HOUR_MS };

// Fail-open: if the lock itself can't be acquired/released (permission
// error, network blip), we still let the scan run rather than going
// silently dark — losing the concurrency guard for one run is a much
// smaller risk than the scanner never running signals/price checks again.
// The failure is logged loudly (SystemLog, visible in the app's Debug Log)
// instead of only console.warn, so it doesn't go unnoticed.
async function tryAcquireScanLock(lockName, ttlMs, holder) {
  try {
    return await backend.locks.acquireScanLock(lockName, ttlMs, holder);
  } catch (err) {
    logError('scanner', `Falha ao adquirir lock "${lockName}" — prosseguindo sem lock (risco de execução concorrente)`, { error: err.message });
    return true;
  }
}

async function tryReleaseScanLock(lockName, holder) {
  try {
    await backend.locks.releaseScanLock(lockName, holder);
  } catch (err) {
    logWarn('scanner', `Falha ao liberar lock "${lockName}"`, { error: err.message });
  }
}

/**
 * Regime gate (ADX + Choppiness, tier-based thresholds) — blocks new
 * TradeOperations in choppy/weak-trend conditions, matching the Pine's
 * `regimeOk = adxOk and chopOk`. Only gates entries, never the SignalEvent
 * itself (kept for history/analytics regardless of regime).
 */
function evaluateRegime(tf4hData, pineConfig) {
  const tier = tf4hData.tier;
  if (!tier || !tf4hData.adx) return { ok: true, adxOk: true, chopOk: true };
  const adxOk = pineConfig.useADX === false || tf4hData.adx.adx >= tier.adxMinVal;
  const chopOk = pineConfig.useChop === false || tf4hData.chop <= tier.chopMaxVal;
  return { ok: adxOk && chopOk, adxOk, chopOk };
}

/**
 * Build TradeOperation data from a 4h signal using Pine config parameters.
 * Centralizes entry/stop/TP calculations so Pine Script changes propagate
 * automatically — no manual bot configuration needed.
 */
function buildTradeOpData(sig, tf4hData, pineConfig, confirmation15m) {
  // Stop multiplier is tier-based (volatility-adjusted), not the global
  // trailAtrMult — that field is reserved for the runner's ATR trailing
  // after TP1 (see the post-TP1 update loop), a different parameter with
  // a different purpose that used to be incorrectly reused here.
  const ATR_MULT = tf4hData.tier?.atrStopMult ?? 2.0;
  const tp1R = pineConfig.tp1R ?? 1.5;
  const tp2R = (pineConfig.tp1R ?? 1.5) * 2;
  const partialPct = pineConfig.tp1QtyPercent ?? 50;
  const isBuy = sig.signal_type === 'BUY';
  // Entry must be the real 15m price at confirmation time, not the 4h
  // signal's price — the 4h signal can be hours old by the time 15m
  // confirms (see the up-to-4h retry window above), so using
  // sig.price_at_signal here would record a stale entry price.
  const entry = confirmation15m?.entryPrice ?? sig.price_at_signal;
  const risk = tf4hData.atrValue * ATR_MULT;
  const initialStop = isBuy ? entry - risk : entry + risk;
  const riskR = Math.abs(entry - initialStop);
  const tp1 = isBuy ? entry + riskR * tp1R : entry - riskR * tp1R;
  const tp2 = isBuy ? entry + riskR * tp2R : entry - riskR * tp2R;

  return {
    symbol: sig.symbol,
    asset_id: sig.asset_id,
    timeframe: '15m',
    signal_timeframe: '4h',
    cascade: '4h_15m',
    side: sig.signal_type,
    status: 'SIGNAL_CONFIRMED',
    score: sig.context?.score || 0,
    entry_price: entry,
    atr_value: tf4hData.atrValue,
    initial_stop: initialStop,
    current_stop: initialStop,
    tp1,
    tp2,
    tp1_hit: false,
    tp2_hit: false,
    partial_percent: partialPct,
    runner_percent: 100 - partialPct,
    exit_mode: 'HYBRID_RF_ATR',
    candle_open_time: tf4hData.lastCandleOpenTime,
    candle_close_time: tf4hData.lastCandleTime,
    entry_candle_time_15m: confirmation15m?.entryCandleTime,
    origin_4h_price: sig.price_at_signal,
    tier: tf4hData.tier?.tier,
    adx_at_entry: tf4hData.adx?.adx,
    chop_at_entry: tf4hData.chop,
    tier_time_stop_bars: tf4hData.tier?.timeStopBars,
    source: 'scanner',
    candle_status: 'CLOSED',
    data_status: 'LIVE',
    signal_reasons: sig.context?.reasons || [],
    rf_filter_value: sig.context?.rf_value,
    invalidates_if: isBuy
      ? 'Candle fechar abaixo do Range Filter'
      : 'Candle fechar acima do Range Filter',
  };
}

/**
 * Check 15m RF direction to confirm a 4h signal before entry.
 * Only requires directional alignment — Range Filter signals fire on state
 * change only, so requiring a fresh signal would block valid entries.
 * Returns { confirmed, entryPrice, entryCandleTime }: entryPrice is the
 * close of the latest closed 15m candle, used as the real entry price
 * instead of the (potentially hours-old) 4h signal price.
 */
async function check15mConfirmation(symbol, direction, asset) {
  try {
    const candles15m = await fetchCandles(symbol, TF_15M, 100);
    const closed = candles15m.filter(c => c.isClosed);
    if (closed.length < 40) {
      // Not enough data — do NOT allow trade without confirmation
      return { confirmed: false, entryPrice: null, entryCandleTime: null };
    }

    const rf = calculateRangeFilter(
      closed,
      asset.rf_period || 20,
      asset.rf_multiplier || 3.5
    );

    // 15m RF must be pointing in the same direction as the 4h signal
    const aligned = direction === 'BUY' ? rf.direction === 1 : rf.direction === -1;
    if (!aligned) {
      return { confirmed: false, entryPrice: null, entryCandleTime: null };
    }

    const lastClosed = closed[closed.length - 1];
    return {
      confirmed: true,
      entryPrice: lastClosed.close,
      entryCandleTime: new Date(lastClosed.closeTime).toISOString(),
    };
  } catch (err) {
    // Data fetch error — do NOT allow trade without confirmation
    console.warn(`[15m confirm] ${symbol} fetch failed:`, err.message);
    return { confirmed: false, entryPrice: null, entryCandleTime: null };
  }
}

/**
 * Check 5m for an SMC entry trigger confirming the 1h structure bias:
 * either a liquidity sweep (SSL/BSL) or a fresh BOS/CHoCH in the same
 * direction. A shorter swing length (10 vs the 1h bias's 50) is used here on
 * purpose — an LTF entry trigger needs to react within a handful of 5m
 * candles, not wait for a 50-bar (~4h) structure break on the 5m chart
 * itself. Returns { confirmed, entryPrice, entryCandleTime, trigger }.
 */
async function check5mSmcConfirmation(symbol, direction) {
  try {
    const candles5m = await fetchCandles(symbol, TF_5M, 150);
    const closed = candles5m.filter(c => c.isClosed);
    if (closed.length < 60) {
      return { confirmed: false, entryPrice: null, entryCandleTime: null, trigger: null };
    }

    const sweep = calculateLiquiditySweep(closed, 20);
    const structure = calculateStructure(closed, { swingLen: 10 });

    const sweepAligned = direction === 'BUY' ? sweep.bullishSweep : sweep.bearishSweep;
    const structureAligned = direction === 'BUY'
      ? (structure.lastBull.bos || structure.lastBull.choch)
      : (structure.lastBear.bos || structure.lastBear.choch);

    if (!sweepAligned && !structureAligned) {
      return { confirmed: false, entryPrice: null, entryCandleTime: null, trigger: null };
    }

    const lastClosed = closed[closed.length - 1];
    return {
      confirmed: true,
      entryPrice: lastClosed.close,
      entryCandleTime: new Date(lastClosed.closeTime).toISOString(),
      trigger: sweepAligned ? 'sweep' : 'structure',
    };
  } catch (err) {
    console.warn(`[5m SMC confirm] ${symbol} fetch failed:`, err.message);
    return { confirmed: false, entryPrice: null, entryCandleTime: null, trigger: null };
  }
}

/**
 * Build TradeOperation data for the SMC 1h→5m cascade — same ATR-based
 * risk/TP model as buildTradeOpData (reusing the same Pine tp1R/tp1QtyPercent
 * params), but stop/entry basis comes from 1h data and there's no
 * tier/regime system here (that's specific to the 4h/15m cascade).
 */
function buildSmcTradeOpData(sig, tf1hData, pineConfig, confirmation5m) {
  const tp1R = pineConfig.tp1R ?? 1.5;
  const tp2R = (pineConfig.tp1R ?? 1.5) * 2;
  const partialPct = pineConfig.tp1QtyPercent ?? 50;
  const isBuy = sig.signal_type === 'BUY';
  const entry = confirmation5m?.entryPrice ?? sig.price_at_signal;
  const risk = tf1hData.atrValue * SMC_INITIAL_STOP_ATR_MULT;
  const initialStop = isBuy ? entry - risk : entry + risk;
  const riskR = Math.abs(entry - initialStop);
  const tp1 = isBuy ? entry + riskR * tp1R : entry - riskR * tp1R;
  const tp2 = isBuy ? entry + riskR * tp2R : entry - riskR * tp2R;

  return {
    symbol: sig.symbol,
    asset_id: sig.asset_id,
    timeframe: TF_5M,
    signal_timeframe: '1h',
    cascade: '1h_5m',
    side: sig.signal_type,
    status: 'SIGNAL_CONFIRMED',
    score: sig.context?.score || 0,
    entry_price: entry,
    atr_value: tf1hData.atrValue,
    initial_stop: initialStop,
    current_stop: initialStop,
    tp1,
    tp2,
    tp1_hit: false,
    tp2_hit: false,
    partial_percent: partialPct,
    runner_percent: 100 - partialPct,
    exit_mode: 'HYBRID_RF_ATR',
    candle_open_time: tf1hData.lastCandleOpenTime,
    candle_close_time: tf1hData.lastCandleTime,
    entry_candle_time_5m: confirmation5m?.entryCandleTime,
    origin_1h_price: sig.price_at_signal,
    tier_time_stop_bars: 96, // ~4 dias em barras de 1h — sem sistema de tier próprio nesta cascata
    bias: sig.signal_type === 'BUY' ? 'bullish' : 'bearish',
    structure_type: sig.context?.structure_type,
    pd_zone: sig.context?.pd_zone,
    sweep_confirmed: confirmation5m?.trigger === 'sweep',
    source: 'scanner_smc',
    candle_status: 'CLOSED',
    data_status: 'LIVE',
    signal_reasons: sig.context?.reasons || [],
    invalidates_if: isBuy
      ? 'Estrutura 1h reverter para baixista (CHoCH bearish)'
      : 'Estrutura 1h reverter para altista (CHoCH bullish)',
  };
}

/**
 * Scan a single asset across all enabled timeframes
 * @param {Object} asset - MonitoredAsset entity record
 * @returns {Object} Scan result with states and signals
 */
export async function scanAsset(asset) {
  const startTime = Date.now();
  const results = {};
  const newSignals = [];
  const errors = [];

  // Read Pine config — parameters auto-synced from Pine Script editor
  const pineConfig = await getPineConfig();

  const enabledTimeframes = TIMEFRAMES.filter(tf => {
    const tfConfig = asset.timeframes_enabled;
    return tfConfig ? tfConfig[tf] !== false : true;
  });

  // Fetch and analyze each timeframe
  for (const tf of enabledTimeframes) {
    try {
      const candles = await fetchCandles(asset.symbol, tf, 150);
      
      // Only use closed candles for signal calculation
      const closedCandles = candles.filter(c => c.isClosed);
      
      if (closedCandles.length < 50) {
        errors.push({ timeframe: tf, error: `Apenas ${closedCandles.length} candles fechados disponíveis` });
        continue;
      }

      // Calculate all indicators
      const rfResult = calculateRangeFilter(
        closedCandles, 
        asset.rf_period || 20, 
        asset.rf_multiplier || 3.5
      );

      const rsiResult = calculateRSI(closedCandles, asset.rsi_period || 14);
      
      const macdResult = calculateMACD(
        closedCandles,
        asset.macd_fast || 12,
        asset.macd_slow || 26,
        asset.macd_signal || 9
      );

      const emaResult = calculateEMAs(
        closedCandles,
        asset.ema_short || 9,
        asset.ema_long || 21
      );

      // Volume SMA(20) para confirmação Pine v2
      const VOL_PERIOD = 20;
      const volumes = closedCandles.map(c => c.volume || 0);
      const volSlice = volumes.slice(-VOL_PERIOD);
      const volMa = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
      const volCurrent = volumes[volumes.length - 1];
      const volumeData = { current: volCurrent, ma: volMa };

      const atrValue = calculateATR(closedCandles, 14);
      const lastCandle = closedCandles[closedCandles.length - 1];

      // Tier/regime filters (ADX, Choppiness) are only meaningful on the
      // 4h timeframe — that's where entries/risk are decided (the 4h
      // signal + 15m confirmation cascade, kept as-is by design).
      let tier = null, adx = null, chop = null;
      if (tf === '4h') {
        const atrPctSmooth = calculateAtrPctSmooth(closedCandles, pineConfig.atrLen ?? 14, 20);
        tier = classifyTier(atrPctSmooth, {
          tier2: pineConfig.tier2Threshold ?? 0.8,
          tier3: pineConfig.tier3Threshold ?? 1.5,
        }, {
          T1: pineConfig.timeStopT1,
          T2: pineConfig.timeStopT2,
          T3: pineConfig.timeStopT3,
        });
        adx = calculateADX(closedCandles, pineConfig.adxLen ?? 14, pineConfig.adxSmooth ?? 14);
        chop = calculateChoppiness(closedCandles, pineConfig.chopLen ?? 14);
      }

      // SMC/ICT structure (BOS/CHoCH + Premium/Discount zone) — used both as
      // the bias for the new 1h→5m cascade and, optionally, as an extra
      // confirmation gate on the existing 4h→15m cascade (asset.smc_confirm_4h15m).
      let smc = null;
      if (tf === '4h' || tf === '1h') {
        const structure = calculateStructure(closedCandles);
        const pdZone = calculatePdZone(closedCandles);
        smc = { trend: structure.trend, lastBull: structure.lastBull, lastBear: structure.lastBear, pdZone: pdZone.zone };
      }

      results[tf] = {
        rf: rfResult,
        rsi: rsiResult,
        macd: macdResult,
        ema: emaResult,
        volumeData,
        atrValue,
        tier,
        adx,
        chop,
        smc,
        lastClose: lastCandle.close,
        lastCandleHigh: lastCandle.high,
        lastCandleLow: lastCandle.low,
        lastCandleTime: new Date(lastCandle.closeTime).toISOString(),
        lastCandleOpenTime: new Date(lastCandle.openTime).toISOString(),
        candleCount: closedCandles.length,
      };

    } catch (err) {
      errors.push({ timeframe: tf, error: err.message });
    }
  }

  // Build states map for alignment analysis
  const statesForAlignment = {};
  for (const tf of enabledTimeframes) {
    if (results[tf]) {
      statesForAlignment[tf] = {
        rf_direction: results[tf].rf.direction,
      };
    }
  }

  const alignmentResult = analyzeAlignment(statesForAlignment);

  // Generate signals for each timeframe
  for (const tf of enabledTimeframes) {
    if (!results[tf]) continue;

    const r = results[tf];
    
    // Calculate strength and priority (score from Pine config)
    const MIN_SCORE = pineConfig.minScore ?? 75;
    const strengthResult = calculateSignalStrength(
      r.rf, r.rsi, r.macd, r.ema, alignmentResult, tf, r.volumeData, MIN_SCORE
    );

    // Check for Range Filter BUY/SELL signal — only emit if score passes
    if ((r.rf.signal === 'BUY' || r.rf.signal === 'SELL') && strengthResult.passed) {
      const reason = generateSignalDescription(
        asset.symbol, tf, r.rf.signal,
        strengthResult.strength, strengthResult.alignment, strengthResult.reasons
      );

      newSignals.push({
        asset_id: asset.id,
        symbol: asset.symbol,
        timeframe: tf,
        signal_type: r.rf.signal,
        source: 'range_filter',
        strength: strengthResult.strength,
        alignment: strengthResult.alignment,
        priority: strengthResult.priority,
        price_at_signal: r.lastClose,
        candle_time: r.lastCandleTime,
        reason,
        context: {
          rf_value: r.rf.filterValue,
          rf_direction: r.rf.direction,
          rsi: r.rsi.value,
          macd_histogram: r.macd.histogram,
          ema_short: r.ema.shortValue,
          ema_long: r.ema.longValue,
          tf_1d_direction: statesForAlignment['1d']?.rf_direction || 0,
          tf_4h_direction: statesForAlignment['4h']?.rf_direction || 0,
          tf_1h_direction: statesForAlignment['1h']?.rf_direction || 0,
          score: strengthResult.score,
          reasons: strengthResult.reasons,
        },
        dedup_key: `${asset.symbol}_${tf}_${r.rf.signal}_range_filter_${r.lastCandleTime}`,
      });
    }

    // Check for SMC/ICT structure signal (1h bias for the 1h→5m cascade) —
    // fires on a fresh BOS/CHoCH, gated by the Premium/Discount zone rule
    // (only buy from discount/equilibrium, only sell from premium/equilibrium).
    // Gated by asset.smc_enabled up front — assets that never opted into
    // this cascade shouldn't get SMC SignalEvents/alerts at all, not just
    // have the TradeOperation blocked later.
    if (tf === '1h' && r.smc && asset.smc_enabled) {
      const bullFired = r.smc.lastBull.bos || r.smc.lastBull.choch;
      const bearFired = r.smc.lastBear.bos || r.smc.lastBear.choch;
      if (bullFired || bearFired) {
        const signalType = bullFired ? 'BUY' : 'SELL';
        const structureType = bullFired
          ? (r.smc.lastBull.choch ? 'CHoCH' : 'BOS')
          : (r.smc.lastBear.choch ? 'CHoCH' : 'BOS');
        const zoneOk = signalType === 'BUY' ? r.smc.pdZone !== 'premium' : r.smc.pdZone !== 'discount';

        if (zoneOk) {
          newSignals.push({
            asset_id: asset.id,
            symbol: asset.symbol,
            timeframe: tf,
            signal_type: signalType,
            source: 'smc_structure',
            strength: structureType === 'CHoCH' ? 'strong' : 'medium',
            alignment: strengthResult.alignment,
            priority: structureType === 'CHoCH' ? 'high' : 'medium',
            price_at_signal: r.lastClose,
            candle_time: r.lastCandleTime,
            reason: `${asset.symbol} 1H ${structureType} ${signalType === 'BUY' ? 'altista' : 'baixista'} — zona ${r.smc.pdZone}`,
            context: {
              structure_type: structureType,
              pd_zone: r.smc.pdZone,
              reasons: [`Estrutura 1H: ${structureType} ${signalType}`, `Zona: ${r.smc.pdZone}`],
            },
            dedup_key: `${asset.symbol}_1h_${signalType}_smc_structure_${r.lastCandleTime}`,
          });
        }
      }
    }

    // Check for MACD cross signal
    if (r.macd.cross !== 'none') {
      const signalType = r.macd.cross === 'bullish_cross' ? 'BUY' : 'SELL';
      newSignals.push({
        asset_id: asset.id,
        symbol: asset.symbol,
        timeframe: tf,
        signal_type: signalType,
        source: 'macd',
        strength: strengthResult.strength,
        alignment: strengthResult.alignment,
        priority: strengthResult.priority === 'high' ? 'medium' : 'low',
        price_at_signal: r.lastClose,
        candle_time: r.lastCandleTime,
        reason: `MACD ${r.macd.cross === 'bullish_cross' ? 'cruzamento bullish' : 'cruzamento bearish'} no ${tf.toUpperCase()}`,
        context: {
          rf_value: r.rf.filterValue,
          rf_direction: r.rf.direction,
          rsi: r.rsi.value,
          macd_histogram: r.macd.histogram,
          ema_short: r.ema.shortValue,
          ema_long: r.ema.longValue,
        },
        dedup_key: `${asset.symbol}_${tf}_${signalType}_macd_${r.lastCandleTime}`,
      });
    }

    // Check for EMA cross signal
    if (r.ema.cross !== 'none') {
      const signalType = r.ema.cross === 'golden_cross' ? 'BUY' : 'SELL';
      newSignals.push({
        asset_id: asset.id,
        symbol: asset.symbol,
        timeframe: tf,
        signal_type: signalType,
        source: 'ema_cross',
        strength: strengthResult.strength,
        alignment: strengthResult.alignment,
        priority: strengthResult.priority === 'high' ? 'medium' : 'low',
        price_at_signal: r.lastClose,
        candle_time: r.lastCandleTime,
        reason: `${r.ema.cross === 'golden_cross' ? 'Golden Cross' : 'Death Cross'} (EMA) no ${tf.toUpperCase()}`,
        context: {
          ema_short: r.ema.shortValue,
          ema_long: r.ema.longValue,
        },
        dedup_key: `${asset.symbol}_${tf}_${signalType}_ema_cross_${r.lastCandleTime}`,
      });
    }

    // RSI extreme zone signal
    if (r.rsi.zone !== 'neutral') {
      const signalType = r.rsi.zone === 'oversold' ? 'BUY' : 'SELL';
      newSignals.push({
        asset_id: asset.id,
        symbol: asset.symbol,
        timeframe: tf,
        signal_type: signalType,
        source: 'rsi',
        strength: 'weak',
        alignment: strengthResult.alignment,
        priority: 'low',
        price_at_signal: r.lastClose,
        candle_time: r.lastCandleTime,
        reason: `RSI ${r.rsi.zone === 'oversold' ? 'em sobrevenda' : 'em sobrecompra'} (${r.rsi.value.toFixed(1)}) no ${tf.toUpperCase()}`,
        context: { rsi: r.rsi.value },
        dedup_key: `${asset.symbol}_${tf}_${signalType}_rsi_${r.rsi.zone}_${r.lastCandleTime}`,
      });
    }
  }

  const duration = Date.now() - startTime;

  return {
    asset,
    results,
    alignment: alignmentResult,
    newSignals,
    errors,
    duration,
  };
}

/**
 * Persist scan results - states and deduplicated signals
 */
export async function persistScanResults(scanResult) {
  const { asset, results, newSignals, errors, duration } = scanResult;
  const pineConfig = await getPineConfig();

  // Update or create asset states
  for (const [tf, data] of Object.entries(results)) {
    const stateData = {
      asset_id: asset.id,
      symbol: asset.symbol,
      timeframe: tf,
      last_close: data.lastClose,
      last_candle_time: data.lastCandleTime,
      rf_filter_value: data.rf.filterValue,
      rf_direction: data.rf.direction,
      rf_high_band: data.rf.highBand,
      rf_low_band: data.rf.lowBand,
      rf_signal: data.rf.signal,
      rf_cond_ini: data.rf.condIni,
      rsi_value: data.rsi.value,
      rsi_zone: data.rsi.zone,
      macd_line: data.macd.macdLine,
      macd_signal_line: data.macd.signalLine,
      macd_histogram: data.macd.histogram,
      macd_cross: data.macd.cross,
      ema_short_value: data.ema.shortValue,
      ema_long_value: data.ema.longValue,
      ema_cross: data.ema.cross,
      trend_ema: data.ema.trend,
      processed_at: new Date().toISOString(),
    };

    // Check if state exists
    const existing = await backend.entities.AssetState.filter({ 
      asset_id: asset.id, 
      timeframe: tf 
    });

    if (existing.length > 0) {
      await backend.entities.AssetState.update(existing[0].id, stateData);
    } else {
      await backend.entities.AssetState.create(stateData);
    }
  }

  // Deduplicate and persist signals
  let persistedSignals = 0;
  for (const signal of newSignals) {
    // Cooldown check — a best-effort query, not atomic on its own, but the
    // scan lock (acquireScanLock in scanAllAssets/priceCheckActiveOps) means
    // only one executor (browser or cron) is ever inside this loop at a
    // time, so the residual race window here is negligible (see
    // docs/known-risks.md).
    const cooldownMinutes = asset.alert_cooldown_minutes || 60;
    const cooldownTime = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();

    const recentSame = await backend.entities.SignalEvent.filter({
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      signal_type: signal.signal_type,
      source: signal.source,
    });

    const hasCooldownConflict = recentSame.some(s =>
      s.created_date > cooldownTime
    );

    if (hasCooldownConflict) continue;

    // Atomic dedup: dedup_key is used as the Firestore document id itself,
    // so createUnique is a single transaction that can never let two
    // concurrent callers both persist the same signal (unlike the previous
    // filter()-then-create() pattern, which had a race window between the
    // two calls).
    const dedupResult = await backend.entities.SignalEvent.createUnique(signal.dedup_key, signal);
    if (!dedupResult.created) continue;

    persistedSignals++;
    if (isTelegramConfigured()) notifyNewSignal(signal).catch(() => {});

    // ═══ Entry Motor: 4H trend → 15m confirmation only ═══
    // No operation opens on 15m without prior 4H trend confirmation.
    // Non-4H RF signals are persisted as alerts but do NOT trigger entries.
    if (signal.source === 'range_filter') {
      if (signal.timeframe !== '4h') {
        // Non-4H signal — block entry, log as ignored
        await backend.entities.SystemLog.create({
          level: 'debug',
          module: 'scanner',
          message: `${asset.symbol} ${signal.timeframe.toUpperCase()} ${signal.signal_type} — entrada bloqueada (requer tendência 4H confirmada)`,
          symbol: asset.symbol,
          timeframe: signal.timeframe,
          details: { direction: signal.signal_type, score: signal.context?.score, reason: 'requires_4h_trend' },
        });
      } else {
        // 4H signal — verify 4H trend alignment explicitly before any entry
        const tf4hData = results['4h'];
        if (tf4hData && tf4hData.atrValue) {
          const tf4hDir = tf4hData.rf.direction;
          const sigDir = signal.signal_type === 'BUY' ? 1 : -1;

          if (tf4hDir !== sigDir) {
            // 4H trend not aligned with signal direction — block entry
            await backend.entities.SystemLog.create({
              level: 'warn',
              module: 'scanner',
              message: `${asset.symbol} 4H ${signal.signal_type} — tendência 4H desalinhada (dir=${tf4hDir}), entrada bloqueada`,
              symbol: asset.symbol,
              timeframe: '4h',
              details: { signal_dir: sigDir, tf4h_dir: tf4hDir, score: signal.context?.score },
            });
          } else {
            const regime = evaluateRegime(tf4hData, pineConfig);
            if (!regime.ok) {
              await backend.entities.SystemLog.create({
                level: 'info',
                module: 'scanner',
                message: `${asset.symbol} 4H ${signal.signal_type} — regime bloqueado (${!regime.adxOk ? 'ADX fraco' : ''}${!regime.adxOk && !regime.chopOk ? ' + ' : ''}${!regime.chopOk ? 'mercado lateralizado' : ''})`,
                symbol: asset.symbol,
                timeframe: '4h',
                details: { adx: tf4hData.adx?.adx, chop: tf4hData.chop, tier: tf4hData.tier?.tier, adxOk: regime.adxOk, chopOk: regime.chopOk },
              });
              continue;
            }

            // Optional extra confirmation: SMC 4h structure trend + PD zone
            // must agree with the RF signal direction. Off by default
            // (asset.smc_confirm_4h15m) — purely additive, never required
            // unless the user explicitly opts an asset into it.
            if (asset.smc_confirm_4h15m && tf4hData.smc) {
              const trendAligned = sigDir === 1 ? tf4hData.smc.trend === 1 : tf4hData.smc.trend === -1;
              const zoneOk = sigDir === 1 ? tf4hData.smc.pdZone !== 'premium' : tf4hData.smc.pdZone !== 'discount';
              if (!trendAligned || !zoneOk) {
                await backend.entities.SystemLog.create({
                  level: 'info',
                  module: 'scanner',
                  message: `${asset.symbol} 4H ${signal.signal_type} — bloqueado pela confirmação SMC (trend=${tf4hData.smc.trend}, zona=${tf4hData.smc.pdZone})`,
                  symbol: asset.symbol,
                  timeframe: '4h',
                  details: { smc_trend: tf4hData.smc.trend, pd_zone: tf4hData.smc.pdZone, trendAligned, zoneOk },
                });
                continue;
              }
            }

            // Cheap early-exit query (still racy, just an optimization to
            // skip the 15m candle fetch below) — the real guarantee against
            // duplicate/overlapping operations for this asset comes from
            // createTradeOpIfNoneActive's transaction further down.
            const existingOps = await backend.entities.TradeOperation.filter({
              symbol: signal.symbol,
              asset_id: signal.asset_id,
            });
            const hasActive = existingOps.some(op =>
              !['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'].includes(op.status)
            );

            if (!hasActive) {
              // 15m confirmation required — no entry without it
              const confirmed15m = await check15mConfirmation(asset.symbol, signal.signal_type, asset);

              if (confirmed15m.confirmed) {
                const opData = buildTradeOpData(signal, tf4hData, pineConfig, confirmed15m);
                const tradeOpId = `trade_${signal.dedup_key}`;
                const created = await backend.tradeOps.createTradeOpIfNoneActive(signal.asset_id, tradeOpId, opData);
                if (created.created) {
                  if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});
                  logInfo('scanner', `${signal.symbol} entrada criada — Pine sync ativo`, {
                    score: signal.context?.score, atr_mult: pineConfig.trailAtrMult, tp1R: pineConfig.tp1R,
                  }, { symbol: signal.symbol, timeframe: '15m' });
                }
              } else {
                // 15m not aligned — log and wait for retry on next scan
                await backend.entities.SystemLog.create({
                  level: 'info',
                  module: 'scanner',
                  message: `${asset.symbol} 4h ${signal.signal_type} — aguardando confirmação no 15m`,
                  symbol: asset.symbol,
                  timeframe: '15m',
                  details: { signal_tf: '4h', direction: signal.signal_type, score: signal.context?.score },
                });
              }
            }
          }
        }
      }
    }

    // ═══ Entry Motor (SMC): 1H structure bias → 5m confirmation ═══
    // Independent cascade, parallel to the 4H/15M one above — never touches
    // its signals/trade ops. Off by default per asset (asset.smc_enabled).
    if (signal.source === 'smc_structure' && asset.smc_enabled) {
      const tf1hData = results['1h'];
      if (tf1hData && tf1hData.atrValue) {
        const existingOps = await backend.entities.TradeOperation.filter({
          symbol: signal.symbol,
          asset_id: signal.asset_id,
        });
        const hasActive = existingOps.some(op =>
          !['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'].includes(op.status)
        );

        if (!hasActive) {
          const confirmed5m = await check5mSmcConfirmation(asset.symbol, signal.signal_type);

          if (confirmed5m.confirmed) {
            const opData = buildSmcTradeOpData(signal, tf1hData, pineConfig, confirmed5m);
            const tradeOpId = `trade_smc_${signal.dedup_key}`;
            const created = await backend.tradeOps.createTradeOpIfNoneActive(signal.asset_id, tradeOpId, opData);
            if (created.created) {
              if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});
              logInfo('scanner', `${signal.symbol} entrada SMC criada (1h→5m)`, {
                score: signal.context?.score, structure_type: signal.context?.structure_type, trigger: confirmed5m.trigger,
              }, { symbol: signal.symbol, timeframe: '5m' });
            }
          } else {
            await backend.entities.SystemLog.create({
              level: 'info',
              module: 'scanner',
              message: `${asset.symbol} 1H SMC ${signal.signal_type} — aguardando confirmação no 5m`,
              symbol: asset.symbol,
              timeframe: '5m',
              details: { signal_tf: '1h', direction: signal.signal_type, structure_type: signal.context?.structure_type },
            });
          }
        }
      }
    }
  }

  // ─── Retry: re-check 15m confirmation for pending 4h signals ───
  // Signals that were saved but didn't create a trade op (15m wasn't aligned)
  // get re-checked on every scan. If 15m aligns now, the trade op is created.
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const recent4hSignals = await backend.entities.SignalEvent.filter({
    asset_id: asset.id,
    source: 'range_filter',
    timeframe: '4h',
  });

  for (const sig of recent4hSignals) {
    if (sig.created_date < fourHoursAgo) continue; // stale, skip
    if (sig.is_dismissed) continue;

    // Cheap early-exit query (see comment above) — createTradeOpIfNoneActive
    // below is what actually guarantees no duplicate/overlapping operation.
    const existingOps = await backend.entities.TradeOperation.filter({
      symbol: sig.symbol,
      asset_id: sig.asset_id,
    });
    const hasActive = existingOps.some(op =>
      !['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'].includes(op.status)
    );
    if (hasActive) continue;

    // Verify 4H trend still aligned with signal direction (may have reversed)
    const tfData4h = results['4h'];
    if (!tfData4h || !tfData4h.atrValue) continue;
    const tf4hDir = tfData4h.rf.direction;
    const sigDir = sig.signal_type === 'BUY' ? 1 : -1;
    if (tf4hDir !== sigDir) continue;

    // Regime gate (ADX + Choppiness) — re-evaluated every retry pass since
    // conditions may have changed since the signal first fired.
    const regime = evaluateRegime(tfData4h, pineConfig);
    if (!regime.ok) continue;

    // Same optional SMC confirmation gate as the initial entry check —
    // re-evaluated every retry pass since trend/zone may have changed
    // since the signal first fired.
    if (asset.smc_confirm_4h15m && tfData4h.smc) {
      const trendAligned = sigDir === 1 ? tfData4h.smc.trend === 1 : tfData4h.smc.trend === -1;
      const zoneOk = sigDir === 1 ? tfData4h.smc.pdZone !== 'premium' : tfData4h.smc.pdZone !== 'discount';
      if (!trendAligned || !zoneOk) continue;
    }

    // Re-run 15m confirmation
    const confirmed = await check15mConfirmation(sig.symbol, sig.signal_type, asset);
    if (!confirmed.confirmed) continue;

    const opData = buildTradeOpData(sig, tfData4h, pineConfig, confirmed);
    const tradeOpId = `trade_${sig.dedup_key || sig.id}`;
    const created = await backend.tradeOps.createTradeOpIfNoneActive(sig.asset_id, tradeOpId, opData);
    if (!created.created) continue;

    if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});

    await backend.entities.SystemLog.create({
      level: 'info',
      module: 'scanner',
      message: `${sig.symbol} 4h ${sig.signal_type} — confirmação 15m OK, entrada criada`,
      symbol: sig.symbol,
      timeframe: '15m',
      details: { signal_tf: '4h', direction: sig.signal_type, score: sig.context?.score, retry: true },
    });
  }

  // ─── Retry: re-check 5m SMC confirmation for pending 1h signals ───
  if (asset.smc_enabled) {
    const oneHourAgo4x = new Date(Date.now() - 4 * ONE_HOUR_MS).toISOString();
    const recentSmcSignals = await backend.entities.SignalEvent.filter({
      asset_id: asset.id,
      source: 'smc_structure',
      timeframe: '1h',
    });

    for (const sig of recentSmcSignals) {
      if (sig.created_date < oneHourAgo4x) continue; // stale, skip
      if (sig.is_dismissed) continue;

      const existingOps = await backend.entities.TradeOperation.filter({
        symbol: sig.symbol,
        asset_id: sig.asset_id,
      });
      const hasActive = existingOps.some(op =>
        !['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'].includes(op.status)
      );
      if (hasActive) continue;

      // Verify 1h structure bias still aligned (may have reversed since signal fired)
      const tfData1h = results['1h'];
      if (!tfData1h || !tfData1h.atrValue || !tfData1h.smc) continue;
      const sigDir = sig.signal_type === 'BUY' ? 1 : -1;
      if (tfData1h.smc.trend !== sigDir) continue;

      const confirmed = await check5mSmcConfirmation(sig.symbol, sig.signal_type);
      if (!confirmed.confirmed) continue;

      const opData = buildSmcTradeOpData(sig, tfData1h, pineConfig, confirmed);
      const tradeOpId = `trade_smc_${sig.dedup_key || sig.id}`;
      const created = await backend.tradeOps.createTradeOpIfNoneActive(sig.asset_id, tradeOpId, opData);
      if (!created.created) continue;

      if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});

      await backend.entities.SystemLog.create({
        level: 'info',
        module: 'scanner',
        message: `${sig.symbol} 1h SMC ${sig.signal_type} — confirmação 5m OK, entrada criada`,
        symbol: sig.symbol,
        timeframe: '5m',
        details: { signal_tf: '1h', direction: sig.signal_type, trigger: confirmed.trigger, retry: true },
      });
    }
  }

  // Update status of existing active TradeOperations
  const allActiveOps = await backend.entities.TradeOperation.filter({ asset_id: asset.id });
  for (const op of allActiveOps) {
    if (['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'].includes(op.status)) continue;
    // op.timeframe is the ENTRY-confirmation candle (15m/5m), which never
    // appears in `results` (only 1h/4h/1d are fetched here) — the indicators
    // this loop needs (RF, ATR, tier) live on the SIGNAL timeframe instead.
    // signal_timeframe is set on every op created from this point forward;
    // legacy ops (pre-dating the field) all came from the 4h/15m cascade.
    const tfData = results[op.signal_timeframe || '4h'];
    if (!tfData) continue;
    // Isolated per-operation: a failure updating one op's stop/TP status
    // (e.g. a transient Firestore error) must not stop the remaining active
    // operations for this asset from being checked in the same pass.
    try {
    const isBuy = op.side === 'BUY';
    // Use candle high/low for TP/stop checks (more accurate than just close)
    const closePrice = tfData.lastClose;
    const candleHigh = tfData.lastCandleHigh ?? closePrice;
    const candleLow = tfData.lastCandleLow ?? closePrice;
    // For BUY: stop checked against low, TPs against high
    // For SELL: stop checked against high, TPs against low
    const stopCheckPrice = isBuy ? candleLow : candleHigh;
    const tpCheckPrice = isBuy ? candleHigh : candleLow;
    const rfFilt = tfData.rf?.filterValue;
    const rfDir = tfData.rf?.direction;
    const nowIso = new Date().toISOString();
    let newStatus = op.status;
    let tp1Hit = op.tp1_hit || false;
    let tp2Hit = op.tp2_hit || false;
    let newCurrentStop = op.current_stop;
    const updatePayload = {};

    if (!tp1Hit) {
      // Check stop first (stop has priority over TP on same candle for safety)
      const stopHit = isBuy ? stopCheckPrice <= op.current_stop : stopCheckPrice >= op.current_stop;

      // Time Stop: close if TP1 hasn't hit within tier.timeStopBars candles
      // of the SIGNAL timeframe since entry — counted by elapsed time rather
      // than a scan-incremented counter, so it stays correct across cron
      // gaps. Bar duration depends on the cascade (4h for the RF cascade,
      // 1h for the SMC cascade).
      const barMs = SIGNAL_TF_MS[op.signal_timeframe] || FOUR_HOURS_MS;
      const barsOpen = op.candle_close_time
        ? Math.floor((Date.now() - new Date(op.candle_close_time).getTime()) / barMs)
        : 0;
      const timeStopBars = op.tier_time_stop_bars ?? 48;
      const timeStopTriggered = pineConfig.useTimeStop !== false && barsOpen >= timeStopBars;

      // Chop Exit — OFF by default (useChopExit), matches the Pine toggle.
      const chopExitTriggered = pineConfig.useChopExit === true
        && tfData.chop != null && tfData.tier && tfData.chop > tfData.tier.chopMaxVal;

      // RF invalidation — OFF by default (useInvalidation). Counts
      // consecutive 4h candles with RF reversed against the position;
      // the Pine's alternate trigger ("score contrário >= invalidScoreMin")
      // is intentionally not replicated here — it needs a freshly computed
      // opposite-direction score not otherwise available in this loop, and
      // this toggle is off by default in the reference strategy.
      const reverseBars = (isBuy ? rfDir === -1 : rfDir === 1)
        ? (op.rf_reverse_bars_count || 0) + 1
        : 0;
      updatePayload.rf_reverse_bars_count = reverseBars;
      const invalidationTriggered = pineConfig.useInvalidation === true
        && reverseBars >= (pineConfig.invalidRFBars ?? 2);

      if (stopHit) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_price = op.current_stop;
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
      } else if (invalidationTriggered) {
        newStatus = 'INVALIDATED';
        updatePayload.closed_reason = 'INVALIDATION';
        updatePayload.exit_price = closePrice;
        updatePayload.closed_at = nowIso;
      } else if (chopExitTriggered) {
        newStatus = 'CLOSED';
        updatePayload.closed_reason = 'CHOP_EXIT';
        updatePayload.exit_price = closePrice;
        updatePayload.closed_at = nowIso;
      } else if (timeStopTriggered) {
        newStatus = 'CLOSED';
        updatePayload.closed_reason = 'TIME_STOP';
        updatePayload.exit_price = closePrice;
        updatePayload.closed_at = nowIso;
      } else if ((isBuy && tpCheckPrice >= op.tp1) || (!isBuy && tpCheckPrice <= op.tp1)) {
        tp1Hit = true;
        newStatus = 'RUNNER_ACTIVE';
        newCurrentStop = op.entry_price;
        updatePayload.tp1_hit_at = nowIso;
        updatePayload.tp1_hit_price = op.tp1;
      }
    } else {
      // rf_reverse_bars_count only matters pre-TP1 (Chop Exit/Invalidation
      // gates) — keep it stable post-TP1 so the update-guard below doesn't
      // trigger a write every pass just because updatePayload didn't set it.
      updatePayload.rf_reverse_bars_count = op.rf_reverse_bars_count || 0;

      // Advance the runner's stop via ATR trailing (never retreats) before
      // evaluating exits — mirrors the Pine's same-bar order (runner
      // conduction happens before the exit checks that use it).
      if ((op.exit_mode === 'HYBRID_RF_ATR' || op.exit_mode === 'ATR_TRAILING') && tfData.atrValue) {
        const trailMult = pineConfig.trailAtrMult ?? 2.0;
        const atrTrailStop = isBuy
          ? closePrice - tfData.atrValue * trailMult
          : closePrice + tfData.atrValue * trailMult;
        newCurrentStop = isBuy ? Math.max(newCurrentStop, atrTrailStop) : Math.min(newCurrentStop, atrTrailStop);
      }

      const runnerStopHit = isBuy ? stopCheckPrice <= newCurrentStop : stopCheckPrice >= newCurrentStop;
      if (runnerStopHit) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_price = newCurrentStop;
        // Runner stopped at BE (entry) or current stop
        updatePayload.exit_price = newCurrentStop;
        updatePayload.closed_at = nowIso;
      } else if ((isBuy && tpCheckPrice >= op.tp2) || (!isBuy && tpCheckPrice <= op.tp2)) {
        tp2Hit = true;
        newStatus = 'TP2_HIT';
        updatePayload.tp2_hit_at = nowIso;
        updatePayload.tp2_hit_price = op.tp2;
        updatePayload.exit_price = op.tp2;
        updatePayload.closed_at = nowIso;
      } else if (op.cascade === '1h_5m') {
        // SMC cascade: the runner's invalidation must come from the same
        // structure that opened the trade (CHoCH against the position), not
        // the RF filter — RF has no bearing on this cascade's thesis, and
        // using it here (as this branch used to, unconditionally) silently
        // coupled two cascades documented as independent.
        const structureReversed = tfData.smc && (isBuy ? tfData.smc.trend === -1 : tfData.smc.trend === 1);
        if (structureReversed) {
          newStatus = 'INVALIDATED';
          updatePayload.exit_price = closePrice;
          updatePayload.closed_at = nowIso;
        }
      } else if (rfFilt && op.exit_mode !== 'ATR_TRAILING') {
        const rfInval = isBuy ? (rfDir === -1 && closePrice < rfFilt) : (rfDir === 1 && closePrice > rfFilt);
        if (rfInval) {
          newStatus = 'INVALIDATED';
          updatePayload.exit_price = closePrice;
          updatePayload.closed_at = nowIso;
        }
      }
    }
    if (newStatus !== op.status || tp1Hit !== op.tp1_hit || tp2Hit !== op.tp2_hit || newCurrentStop !== op.current_stop
        || updatePayload.rf_reverse_bars_count !== (op.rf_reverse_bars_count || 0)) {
      await backend.entities.TradeOperation.update(op.id, {
        status: newStatus,
        tp1_hit: tp1Hit,
        tp2_hit: tp2Hit,
        current_stop: newCurrentStop,
        ...updatePayload,
      });
      // Frees the asset up for a new entry (see createTradeOpIfNoneActive).
      if (['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'].includes(newStatus)) {
        await backend.tradeOps.clearActiveOp(op.asset_id, op.id);
      }
      if (isTelegramConfigured()) {
        if (newStatus === 'STOP_HIT' && op.status !== 'STOP_HIT') notifyStopHit(op, closePrice).catch(() => {});
        else if (newStatus === 'TP2_HIT') notifyTP2Hit(op, closePrice).catch(() => {});
        else if (tp1Hit && !op.tp1_hit) notifyTP1Hit(op, closePrice).catch(() => {});
      }
    }
    } catch (err) {
      logError('scanner', `Falha ao atualizar status da operação ${op.id} (${op.symbol})`, { error: err.message });
    }
  }

  // Update asset scan status
  await backend.entities.MonitoredAsset.update(asset.id, {
    last_scan_at: new Date().toISOString(),
    scan_status: errors.length > 0 ? 'error' : 'success',
    scan_error: errors.length > 0 ? errors.map(e => `${e.timeframe}: ${e.error}`).join('; ') : '',
  });

  // Log scan
  await backend.entities.SystemLog.create({
    level: errors.length > 0 ? 'warn' : 'info',
    module: 'scanner',
    message: `Scan completo: ${asset.symbol} — ${persistedSignals} novos sinais, ${errors.length} erros`,
    symbol: asset.symbol,
    duration_ms: duration,
    details: {
      timeframes_scanned: Object.keys(results),
      signals_found: newSignals.length,
      signals_persisted: persistedSignals,
      errors: errors,
    },
  });

  return { persistedSignals, errors };
}

/**
 * Lightweight price check for active TradeOperations only
 * Fetches current price per symbol and updates trade op status
 */
export async function priceCheckActiveOps() {
  const holder = `price-check_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const acquired = await tryAcquireScanLock('price-check', PRICE_CHECK_LOCK_TTL_MS, holder);
  if (!acquired) {
    logInfo('scanner', 'Price check ignorado — outra execução já está em andamento (lock ocupado)');
    return;
  }

  try {
    await priceCheckActiveOpsInner();
  } finally {
    await tryReleaseScanLock('price-check', holder);
  }
}

async function priceCheckActiveOpsInner() {
  const ops = await backend.entities.TradeOperation.filter({});
  const activeOps = ops.filter(op => ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'].includes(op.status));
  if (activeOps.length === 0) return;

  const symbols = [...new Set(activeOps.map(op => op.symbol))];
  const prices = {};
  await Promise.all(symbols.map(async sym => {
    try { prices[sym] = await fetchCurrentPrice(sym); }
    catch (e) { logWarn('scanner', `Falha ao buscar preço de ${sym}`, { error: e.message }, { symbol: sym }); }
  }));

  for (const op of activeOps) {
    const price = prices[op.symbol];
    if (!price) continue;
    // Isolated per-operation — see the same comment in persistScanResults.
    try {
    const isBuy = op.side === 'BUY';
    let newStatus = op.status;
    let tp1Hit = op.tp1_hit || false;
    let tp2Hit = op.tp2_hit || false;
    let newCurrentStop = op.current_stop;
    const nowIso = new Date().toISOString();
    const updatePayload = {};

    if (!tp1Hit) {
      if (isBuy ? price <= op.current_stop : price >= op.current_stop) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_price = price;
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
      } else if ((isBuy && price >= op.tp1) || (!isBuy && price <= op.tp1)) {
        tp1Hit = true; newStatus = 'RUNNER_ACTIVE'; newCurrentStop = op.entry_price;
        updatePayload.tp1_hit_at = nowIso;
        updatePayload.tp1_hit_price = op.tp1;
      }
    } else {
      if (isBuy ? price <= op.current_stop : price >= op.current_stop) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_price = price;
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
      } else if ((isBuy && price >= op.tp2) || (!isBuy && price <= op.tp2)) {
        tp2Hit = true; newStatus = 'TP2_HIT';
        updatePayload.tp2_hit_at = nowIso;
        updatePayload.tp2_hit_price = price;
        updatePayload.exit_price = op.tp2;
        updatePayload.closed_at = nowIso;
      }
    }

    if (newStatus !== op.status || tp1Hit !== op.tp1_hit || tp2Hit !== op.tp2_hit || newCurrentStop !== op.current_stop) {
      await backend.entities.TradeOperation.update(op.id, { status: newStatus, tp1_hit: tp1Hit, tp2_hit: tp2Hit, current_stop: newCurrentStop, ...updatePayload });
      if (['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'].includes(newStatus)) {
        await backend.tradeOps.clearActiveOp(op.asset_id, op.id);
      }
      if (isTelegramConfigured()) {
        if (newStatus === 'STOP_HIT') notifyStopHit(op, price).catch(() => {});
        else if (newStatus === 'TP2_HIT') notifyTP2Hit(op, price).catch(() => {});
        else if (tp1Hit && !op.tp1_hit) notifyTP1Hit(op, price).catch(() => {});
      }
    }
    } catch (err) {
      logError('scanner', `Falha ao atualizar status da operação ${op.id} (${op.symbol}) no price check`, { error: err.message });
    }
  }
}

/**
 * Scan all active assets
 */
export async function scanAllAssets(onProgress) {
  const holder = `full-scan_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const acquired = await tryAcquireScanLock('full-scan', FULL_SCAN_LOCK_TTL_MS, holder);
  if (!acquired) {
    logInfo('scanner', 'Scan completo ignorado — outra execução já está em andamento (lock ocupado)');
    return { total: 0, results: [], skipped: true };
  }

  try {
    return await scanAllAssetsInner(onProgress);
  } finally {
    await tryReleaseScanLock('full-scan', holder);
  }
}

async function scanAllAssetsInner(onProgress) {
  const assets = await backend.entities.MonitoredAsset.filter({ is_active: true });

  if (assets.length === 0) {
    return { total: 0, results: [] };
  }

  const allResults = [];

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    if (onProgress) onProgress(i + 1, assets.length, asset.symbol);

    try {
      // Update status to scanning
      await backend.entities.MonitoredAsset.update(asset.id, { scan_status: 'scanning' });
      
      const result = await scanAsset(asset);
      const persisted = await persistScanResults(result);
      
      allResults.push({
        symbol: asset.symbol,
        success: true,
        ...result,
        persisted,
      });

      // Small delay between assets to respect rate limits
      if (i < assets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (err) {
      allResults.push({
        symbol: asset.symbol,
        success: false,
        error: err.message,
      });

      await backend.entities.MonitoredAsset.update(asset.id, {
        scan_status: 'error',
        scan_error: err.message,
        last_scan_at: new Date().toISOString(),
      });

      await backend.entities.SystemLog.create({
        level: 'error',
        module: 'scanner',
        message: `Erro no scan de ${asset.symbol}: ${err.message}`,
        symbol: asset.symbol,
      });
    }
  }

  return { total: assets.length, results: allResults };
}