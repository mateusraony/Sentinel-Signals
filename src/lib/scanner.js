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
import { getPineConfig } from './pineParser';
import { logInfo, logWarn } from './logger';
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

/**
 * Build TradeOperation data from a 4h signal using Pine config parameters.
 * Centralizes entry/stop/TP calculations so Pine Script changes propagate
 * automatically — no manual bot configuration needed.
 */
function buildTradeOpData(sig, tf4hData, pineConfig) {
  const ATR_MULT = pineConfig.trailAtrMult ?? 2.0;
  const tp1R = pineConfig.tp1R ?? 1.5;
  const tp2R = (pineConfig.tp1R ?? 1.5) * 2;
  const partialPct = pineConfig.tp1QtyPercent ?? 50;
  const isBuy = sig.signal_type === 'BUY';
  const entry = sig.price_at_signal;
  const risk = tf4hData.atrValue * ATR_MULT;
  const initialStop = isBuy ? entry - risk : entry + risk;
  const riskR = Math.abs(entry - initialStop);
  const tp1 = isBuy ? entry + riskR * tp1R : entry - riskR * tp1R;
  const tp2 = isBuy ? entry + riskR * tp2R : entry - riskR * tp2R;

  return {
    symbol: sig.symbol,
    asset_id: sig.asset_id,
    timeframe: '15m',
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
 * Returns true if 15m RF direction matches the 4h signal direction.
 */
async function check15mConfirmation(symbol, direction, asset) {
  try {
    const candles15m = await fetchCandles(symbol, TF_15M, 100);
    const closed = candles15m.filter(c => c.isClosed);
    if (closed.length < 40) {
      // Not enough data — do NOT allow trade without confirmation
      return false;
    }

    const rf = calculateRangeFilter(
      closed,
      asset.rf_period || 20,
      asset.rf_multiplier || 3.5
    );

    // 15m RF must be pointing in the same direction as the 4h signal
    const aligned = direction === 'BUY' ? rf.direction === 1 : rf.direction === -1;
    return aligned;
  } catch (err) {
    // Data fetch error — do NOT allow trade without confirmation
    console.warn(`[15m confirm] ${symbol} fetch failed:`, err.message);
    return false;
  }
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
  const pineConfig = getPineConfig();

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

      results[tf] = {
        rf: rfResult,
        rsi: rsiResult,
        macd: macdResult,
        ema: emaResult,
        volumeData,
        atrValue,
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
  const pineConfig = getPineConfig();

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
    // Check dedup_key
    const existingSignals = await backend.entities.SignalEvent.filter({ 
      dedup_key: signal.dedup_key 
    });

    if (existingSignals.length === 0) {
      // Check cooldown
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

      if (!hasCooldownConflict) {
        await backend.entities.SignalEvent.create(signal);
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
                // 4H aligned — check for existing active ops
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

                  if (confirmed15m) {
                    const opData = buildTradeOpData(signal, tf4hData, pineConfig);
                    const newOp = await backend.entities.TradeOperation.create(opData);
                    if (isTelegramConfigured() && newOp) notifyTradeCreated(newOp).catch(() => {});
                    logInfo('scanner', `${signal.symbol} entrada criada — Pine sync ativo`, {
                      score: signal.context?.score, atr_mult: pineConfig.trailAtrMult, tp1R: pineConfig.tp1R,
                    }, { symbol: signal.symbol, timeframe: '15m' });
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

    // Check if a trade op already exists for this signal
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

    // Re-run 15m confirmation
    const confirmed = await check15mConfirmation(sig.symbol, sig.signal_type, asset);
    if (!confirmed) continue;

    const opData = buildTradeOpData(sig, tfData4h, pineConfig);
    const newOp = await backend.entities.TradeOperation.create(opData);

    if (isTelegramConfigured() && newOp) notifyTradeCreated(newOp).catch(() => {});

    await backend.entities.SystemLog.create({
      level: 'info',
      module: 'scanner',
      message: `${sig.symbol} 4h ${sig.signal_type} — confirmação 15m OK, entrada criada`,
      symbol: sig.symbol,
      timeframe: '15m',
      details: { signal_tf: '4h', direction: sig.signal_type, score: sig.context?.score, retry: true },
    });
  }

  // Update status of existing active TradeOperations
  const allActiveOps = await backend.entities.TradeOperation.filter({ asset_id: asset.id });
  for (const op of allActiveOps) {
    if (['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'].includes(op.status)) continue;
    const tfData = results[op.timeframe];
    if (!tfData) continue;
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
      if (stopHit) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_price = op.current_stop;
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
      } else if ((isBuy && tpCheckPrice >= op.tp1) || (!isBuy && tpCheckPrice <= op.tp1)) {
        tp1Hit = true;
        newStatus = 'RUNNER_ACTIVE';
        newCurrentStop = op.entry_price;
        updatePayload.tp1_hit_at = nowIso;
        updatePayload.tp1_hit_price = op.tp1;
      }
    } else {
      const runnerStopHit = isBuy ? stopCheckPrice <= op.current_stop : stopCheckPrice >= op.current_stop;
      if (runnerStopHit) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_price = op.current_stop;
        // Runner stopped at BE (entry) or current stop
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
      } else if ((isBuy && tpCheckPrice >= op.tp2) || (!isBuy && tpCheckPrice <= op.tp2)) {
        tp2Hit = true;
        newStatus = 'TP2_HIT';
        updatePayload.tp2_hit_at = nowIso;
        updatePayload.tp2_hit_price = op.tp2;
        updatePayload.exit_price = op.tp2;
        updatePayload.closed_at = nowIso;
      } else if (rfFilt && op.exit_mode !== 'ATR_TRAILING') {
        const rfInval = isBuy ? (rfDir === -1 && closePrice < rfFilt) : (rfDir === 1 && closePrice > rfFilt);
        if (rfInval) {
          newStatus = 'INVALIDATED';
          updatePayload.exit_price = closePrice;
          updatePayload.closed_at = nowIso;
        }
      }
    }
    if (newStatus !== op.status || tp1Hit !== op.tp1_hit || tp2Hit !== op.tp2_hit || newCurrentStop !== op.current_stop) {
      await backend.entities.TradeOperation.update(op.id, {
        status: newStatus,
        tp1_hit: tp1Hit,
        tp2_hit: tp2Hit,
        current_stop: newCurrentStop,
        ...updatePayload,
      });
      if (isTelegramConfigured()) {
        if (newStatus === 'STOP_HIT' && op.status !== 'STOP_HIT') notifyStopHit(op, closePrice).catch(() => {});
        else if (newStatus === 'TP2_HIT') notifyTP2Hit(op, closePrice).catch(() => {});
        else if (tp1Hit && !op.tp1_hit) notifyTP1Hit(op, closePrice).catch(() => {});
      }
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
      if (isTelegramConfigured()) {
        if (newStatus === 'STOP_HIT') notifyStopHit(op, price).catch(() => {});
        else if (newStatus === 'TP2_HIT') notifyTP2Hit(op, price).catch(() => {});
        else if (tp1Hit && !op.tp1_hit) notifyTP1Hit(op, price).catch(() => {});
      }
    }
  }
}

/**
 * Scan all active assets
 */
export async function scanAllAssets(onProgress) {
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