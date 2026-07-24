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

import { fetchCandles, fetchCurrentPrice, MARKET_SOURCE, DATA_EXCHANGE, EXECUTOR } from './marketDataProvider';
import { calculateRangeFilter } from './indicators/rangeFilter';
import { calculateConfirmedSignal } from './indicators/rangeFilterConfirmation';
import { calculateRSI } from './indicators/rsi';
import { calculateMACD } from './indicators/macd';
import { calculateEMAs } from './indicators/movingAverages';
import { analyzeAlignment, calculateSignalStrength, generateSignalDescription } from './indicators/confluence';
import { calculateATR } from './indicators/atr';
import { calculateAtrPctSmooth, classifyTier } from './indicators/tier';
import { calculateADX } from './indicators/adx';
import { calculateChoppiness } from './indicators/choppiness';
import { calculateStructure, calculateLiquiditySweep, calculatePdZone, buildOteLeg, classifyZone } from './indicators/smcStructure';
import { calculateSmcSignalStrength, SMC_SCORE_DEFAULTS } from './indicators/smcConfluence';
import { planSignalArbitration, ARBITRATION_VERSION } from './signalArbitration';
import { getPineConfig } from './pineParser';
import { isCandleUsableForExits, getEntryReferenceTime, advanceTrailingStop, nextRfReverseCount, computeStructuralStop, resolveCandleExit, passesRiskReward } from './opExitRules';
import { hasAssetStateChanged } from './assetStateDiff';
import { logInfo, logWarn, logError } from './logger';
import { backend } from '@/api/entities';
import {
  isTelegramConfigured,
  notifyNewSignal,
  notifyTradeCreated,
  notifyTP1Hit,
  notifyTP2Hit,
  notifyStopHit,
  notifyInvalidated,
  notifyTimeStop,
  notifyChopExit,
} from './telegram';

const TIMEFRAMES = ['1h', '4h', '1d'];
const TF_15M = '15m'; // Used for entry confirmation after 4h signal
const TF_5M = '5m'; // Used for entry confirmation after 1h SMC signal
const ONE_HOUR_MS = 60 * 60 * 1000;

// Default fetch is enough for the convergent indicators (RF/RSI/MACD/EMA/
// ATR/ADX/Choppiness — EMA/RMA-based, warm-up of ~6x their period is all
// they ever need, see .claude/rules/pine-parity.md). calculateStructure
// (SMC 1h bias, swingLen=50 default matching the user's real Pine script)
// is path-dependent instead: it recomputes from scratch every scan with no
// state carried over, so it needs enough raw history in the SAME window to
// both confirm a swing pivot (>=swingLen bars) AND still see whatever later
// breaks it — 150 bars leaves so little room for that combination that
// BOS/CHoCH on 1h almost never fires (measured: docs/known-risks.md item 34,
// smcStructure.test.js). Only the 1h fetch (the one feeding the SMC bias)
// gets the larger window; 4h/1d/15m/5m are unaffected.
const DEFAULT_CANDLE_LIMIT = 150;
const SMC_1H_STRUCTURE_CANDLE_LIMIT = 500;
// Fixed constant, deliberately NOT pineConfig.trailAtrMult — that field is
// reserved for the RF cascade's post-TP1 trailing (see buildTradeOpData's
// comment on the same mix-up). The SMC cascade has no tier/regime system to
// derive its own multiplier from yet, so this stays a plain constant.
const SMC_INITIAL_STOP_ATR_MULT = 2.0; // cap do stop estrutural e fallback ATR puro
const SMC_STOP_BUFFER_ATR = 0.1; // folga além do nível estrutural (evita toque exato no pavio)
const SMC_STOP_MIN_ATR = 0.5; // piso — ruído do 5m não pode gerar stop mais apertado que isso

// Honest labeling for passesRiskReward (opExitRules.js): under BOTH cascades'
// current TP model, tp1/tp2 are derived AS `entry ± riskDistance * tp1R/tp2R`
// — i.e. as a configured multiple of the very risk distance the gate divides
// by, not a distance to any real chart level (support/resistance/liquidity/
// swing/FVG/OB). Stamped onto every TradeOperation next to rr_at_entry so the
// panel/audit trail never implies more than this validates today — see
// docs/known-risks.md and opExitRules.js's own comment on passesRiskReward.
const RR_GATE_MODE = 'CONFIGURED_MULTIPLE';
const RR_TARGET_BASIS = 'R_MULTIPLE';

// Review do Codex (PR #58): `??` trata 0/negativo como override "presente",
// mas um período <= 0 passado pra RSI/EMA produz NaN/lixo — e o próprio
// AssetConfigPanel pode gravar 0 se o usuário limpar um campo numérico
// (`Number('') === 0`). firstPositive só aceita candidatos finitos e > 0,
// pulando qualquer 0/negativo/NaN/ausente até achar um válido.
export function firstPositive(...candidates) {
  for (const c of candidates) {
    if (Number.isFinite(c) && c > 0) return c;
  }
  return undefined;
}

// Codex review (PR #61): a period/bar-count field isn't just "any positive
// number" — calculateRSI and calculateATR use `period` directly as an array
// index/loop bound (`avgGain[period]`, `for (let i = period; i < n; i++)`).
// A fractional period like 14.5 never lands on an INTEGER index at or past
// that point, so the whole series silently stays at its `.fill()` default
// (RSI reads 50/'neutral' forever) instead of erroring — wrong signals, not
// a crash. Used for every period field below (rf_period, rsi_period,
// macd_fast/slow/signal, ema_short/long) — MACD/EMA/RangeFilter only use
// period as a smoothing constant (harmless if fractional), but a fractional
// bar-count is meaningless for any of them either way.
export function firstPositiveInteger(...candidates) {
  for (const c of candidates) {
    if (Number.isInteger(c) && c > 0) return c;
  }
  return undefined;
}

// Pine×scanner unification (2026-07-18, ver known-risks.md item 27): antes,
// RSI/EMA usavam SÓ o campo do ativo com fallback hardcoded (9/21/14) —
// divergente do Pine real (20/50/14) — e volume/ATR(stop) eram constantes
// locais surdas ao pineConfig. `emaFastLen`/`emaSlowLen`/`rsiLen`/`volLen`/
// `atrLen` agora fazem parte de SYNCED_STRATEGY_KEYS (pineParser.js +
// adminPineConfig.js), então pineConfig traz o valor real do Pine. O campo
// do ativo continua podendo SOBRESCREVER por-ativo (recurso existente,
// preservado) — só o FALLBACK deixou de ser um literal errado e passou a
// ser o valor real do Pine. Extraído como função pura só para ser testável
// sem precisar mockar fetchCandles.
export function resolveIndicatorParams(asset, pineConfig) {
  let emaFast = firstPositiveInteger(asset.ema_short, pineConfig.emaFastLen, 20);
  let emaSlow = firstPositiveInteger(asset.ema_long, pineConfig.emaSlowLen, 50);
  // known-risks.md item 31: emaFast >= emaSlow doesn't fail calculateEMAs —
  // it still fires a cross, just with an INVERTED label (golden_cross when
  // the fast really crossed below, etc.), which scanner.js turns straight
  // into the wrong BUY/SELL signal_type. Guard the pair the same way
  // resolveRsiZoneThresholds guards overbought/oversold below: an invalid
  // pair falls back to the Pine/literal pair entirely, never a partial mix.
  if (!(emaFast < emaSlow)) {
    emaFast = firstPositiveInteger(pineConfig.emaFastLen, 20);
    emaSlow = firstPositiveInteger(pineConfig.emaSlowLen, 50);
  }
  return {
    rsiPeriod: firstPositiveInteger(asset.rsi_period, pineConfig.rsiLen, 14),
    emaFast,
    emaSlow,
    // Sem campo por-ativo hoje — vêm só do Pine (ou do literal de fallback).
    volPeriod: firstPositiveInteger(pineConfig.volLen, 20),
    atrStopPeriod: firstPositiveInteger(pineConfig.atrLen, 14),
  };
}

// known-risks.md item 30: rsi_overbought/rsi_oversold do ativo eram salvos
// pelo AssetConfigPanel mas NUNCA lidos por calculateRSI (que hardcodava
// 70/30) — configurá-los não tinha efeito real algum na geração de sinal.
// Função irmã de resolveIndicatorParams (não dentro dela): estes campos não
// têm equivalente sincronizado do Pine (SYNCED_STRATEGY_KEYS não inclui
// overbought/oversold), então não pertencem ao contrato Pine×scanner daquela
// função — e misturar aqui mudaria o shape exato que
// scannerStateMachine.test.js já fixa via toEqual(). Guarda o PAR
// atomicamente: um par inválido (invertido, fora de 0-100, ou um lado
// ausente) cai inteiro pro default 70/30 — nunca uma mistura de um lado
// válido com o outro default.
export function resolveRsiZoneThresholds(asset) {
  const ob = asset.rsi_overbought;
  const os = asset.rsi_oversold;
  const valid = Number.isFinite(ob) && Number.isFinite(os)
    && ob > 0 && ob < 100 && os > 0 && os < 100 && ob > os;
  return valid ? { overbought: ob, oversold: os } : { overbought: 70, oversold: 30 };
}

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
export function buildTradeOpData(sig, tf4hData, pineConfig, confirmation15m) {
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

  const entryScore = sig.context?.score || 0;

  return {
    symbol: sig.symbol,
    asset_id: sig.asset_id,
    timeframe: '15m',
    signal_timeframe: '4h',
    cascade: '4h_15m',
    origin_cascade: '4h_15m',
    side: sig.signal_type,
    status: 'SIGNAL_CONFIRMED',
    // score kept for backward compat (existing UI/backtest readers) —
    // entry_score is the same value under its unambiguous name, immutable
    // for audit; current_confidence_score is the ONLY field cross-cascade
    // arbitration (reduce_confidence) is allowed to move. See
    // docs/known-risks.md and handleActiveOpArbitration below.
    score: entryScore,
    entry_score: entryScore,
    current_confidence_score: entryScore,
    confidence_penalty_total: 0,
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
    market_source: MARKET_SOURCE,
    data_exchange: DATA_EXCHANGE,
    executor: EXECUTOR,
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
 * itself.
 *
 * docs/known-risks.md item 38: the Premium/Discount zone gate now lives
 * HERE, not on the 1h bias candle — evaluated against `legBounds` (the leg
 * of THIS specific 1h break, from SignalEvent.context.ote_leg_high/low),
 * never against a fresh window measured off `closed`. Reusing `closed` for
 * the zone (the same candles the `structure` trigger is computed from) would
 * reproduce the exact self-referential paradox this item removed at the 1h
 * stage — see buildOteLeg. `legBounds` missing/null on either side means
 * "not evaluable" and fails OPEN (never blocks) — only an explicit
 * unfavorable zone rejects.
 *
 * Returns { confirmed, entryPrice, entryCandleTime, trigger, oteZone,
 * rejectReason }. `rejectReason` is null when confirmed, `'no_trigger'` when
 * neither sweep nor structure fired (or data was unavailable), or
 * `'ote_zone_unfavorable'` when a trigger fired but the zone check rejected
 * it.
 */
async function check5mSmcConfirmation(symbol, direction, legBounds) {
  const noTrigger = { confirmed: false, entryPrice: null, entryCandleTime: null, trigger: null, oteZone: null, rejectReason: 'no_trigger' };
  try {
    const candles5m = await fetchCandles(symbol, TF_5M, 150);
    const closed = candles5m.filter(c => c.isClosed);
    if (closed.length < 60) {
      return noTrigger;
    }

    const sweep = calculateLiquiditySweep(closed, 20);
    const structure = calculateStructure(closed, { swingLen: 10 });

    const sweepAligned = direction === 'BUY' ? sweep.bullishSweep : sweep.bearishSweep;
    const structureAligned = direction === 'BUY'
      ? (structure.lastBull.bos || structure.lastBull.choch)
      : (structure.lastBear.bos || structure.lastBear.choch);

    if (!sweepAligned && !structureAligned) {
      return noTrigger;
    }

    const lastClosed = closed[closed.length - 1];

    // Same favorable-zone convention the old 1h gate used (only the range it
    // measures against changed): BUY rejects only 'premium' (still fully
    // extended, no pullback yet), SELL rejects only 'discount'. A null zone
    // (leg not evaluable) is treated as favorable — fail-open, not a verdict.
    const { zone: oteZone } = classifyZone(lastClosed.close, legBounds?.legHigh, legBounds?.legLow);
    // Codex review (PR #77): classifyZone has no upper/lower bound — a close
    // below legLow (or above legHigh) still reads as 'discount' ('premium')
    // unboundedly, which is exactly the zone BUY (SELL) favors. That would
    // confirm an entry after price broke past the PROTECTED pivot side of
    // the leg (legLow for BUY = lastSwingLow, legHigh for SELL =
    // lastSwingHigh) — not a pullback into a better price anymore, the
    // structure itself is invalidated there. Reject explicitly, regardless
    // of what classifyZone's label says.
    const brokeProtectedPivot = direction === 'BUY'
      ? (legBounds?.legLow != null && lastClosed.close < legBounds.legLow)
      : (legBounds?.legHigh != null && lastClosed.close > legBounds.legHigh);
    const zoneFavorable = !brokeProtectedPivot
      && (oteZone == null || (direction === 'BUY' ? oteZone !== 'premium' : oteZone !== 'discount'));
    if (!zoneFavorable) {
      return { confirmed: false, entryPrice: null, entryCandleTime: null, trigger: null, oteZone, rejectReason: 'ote_zone_unfavorable' };
    }

    // Structural invalidation level of the trigger, consumed by
    // computeStructuralStop in buildSmcTradeOpData:
    // - sweep: the sweep candle's own wick (the extreme that took liquidity —
    //   by construction it is beyond the 20-bar swing it swept);
    // - structure (BOS/CHoCH): the OPPOSING protected pivot carried by the
    //   structure calc itself (lastSwingLow/High = btmY/topY, confirmed with
    //   swingLen lag) — NOT a fixed recent-candle window, whose extreme can
    //   sit inside the true invalidation when the protected pivot is older
    //   (Codex review, PR #55). Missing pivot → null → ATR fallback.
    const structuralLevel = sweepAligned
      ? (direction === 'BUY' ? lastClosed.low : lastClosed.high)
      : (direction === 'BUY'
        ? (structure.lastSwingLow ?? null)
        : (structure.lastSwingHigh ?? null));

    return {
      confirmed: true,
      entryPrice: lastClosed.close,
      entryCandleTime: new Date(lastClosed.closeTime).toISOString(),
      trigger: sweepAligned ? 'sweep' : 'structure',
      structuralLevel,
      oteZone,
      rejectReason: null,
    };
  } catch (err) {
    console.warn(`[5m SMC confirm] ${symbol} fetch failed:`, err.message);
    return noTrigger;
  }
}

/**
 * Build TradeOperation data for the SMC 1h→5m cascade — same TP model as
 * buildTradeOpData (reusing the same Pine tp1R/tp1QtyPercent params), but
 * the initial stop is STRUCTURAL: beyond the 5m trigger's invalidation
 * level (sweep wick / protective swing) with an ATR(1h) buffer, floored at
 * SMC_STOP_MIN_ATR and capped at SMC_INITIAL_STOP_ATR_MULT — the old fixed
 * 2×ATR stop remains as cap and as fallback for a missing/invalid level
 * (see computeStructuralStop and known-risks item 11/24). No tier/regime
 * system here (that's specific to the 4h/15m cascade).
 */
export function buildSmcTradeOpData(sig, tf1hData, pineConfig, confirmation5m) {
  const tp1R = pineConfig.tp1R ?? 1.5;
  const tp2R = (pineConfig.tp1R ?? 1.5) * 2;
  const partialPct = pineConfig.tp1QtyPercent ?? 50;
  const isBuy = sig.signal_type === 'BUY';
  const entry = confirmation5m?.entryPrice ?? sig.price_at_signal;
  const { stop: initialStop, basis: stopBasis } = computeStructuralStop({
    isBuy,
    entry,
    structuralLevel: confirmation5m?.structuralLevel,
    atrValue: tf1hData.atrValue,
    bufferAtrMult: SMC_STOP_BUFFER_ATR,
    minAtrMult: SMC_STOP_MIN_ATR,
    maxAtrMult: SMC_INITIAL_STOP_ATR_MULT,
  });
  const riskR = Math.abs(entry - initialStop);
  const tp1 = isBuy ? entry + riskR * tp1R : entry - riskR * tp1R;
  const tp2 = isBuy ? entry + riskR * tp2R : entry - riskR * tp2R;
  // Base score already reflects 1h structure/EMA/RF/volume/alignment
  // (calculateSmcSignalStrength at signal emission, above); the 5m sweep
  // trigger is only known now, so its weight is added here instead of
  // recomputing the whole score from scratch — reuses the same weight
  // config used at emission.
  const entryScore = Math.min(100, (sig.context?.score || 0)
    + (confirmation5m?.trigger === 'sweep' ? (pineConfig.smcScoreSweepWeight ?? SMC_SCORE_DEFAULTS.sweepWeight) : 0));

  return {
    symbol: sig.symbol,
    asset_id: sig.asset_id,
    timeframe: TF_5M,
    signal_timeframe: '1h',
    cascade: '1h_5m',
    origin_cascade: '1h_5m',
    side: sig.signal_type,
    status: 'SIGNAL_CONFIRMED',
    // score kept for backward compat; entry_score/current_confidence_score
    // split per docs/known-risks.md — see buildTradeOpData's comment.
    score: entryScore,
    entry_score: entryScore,
    current_confidence_score: entryScore,
    confidence_penalty_total: 0,
    // Promotion state machine (1h_5m cascade only — the RF/4h_15m cascade is
    // already the largest timeframe, nothing "promotes" it). TACTICAL_1H/1h
    // until a same-direction 4h candidate scores high enough to start
    // PENDING_15M, and the SAME 15m confirmation the native 4h_15m cascade
    // requires actually confirms it (scanner.js's promotion-confirmation
    // retry) — see signalArbitration.js's two-stage promotion doc comment.
    trade_mode: 'TACTICAL_1H',
    management_timeframe: '1h',
    promotion_status: 'NONE',
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
    // Observability only (item 38) — the leg the 1h break anchored, and the
    // zone the 5m entry candle was actually classified into against it.
    // Never consumed by stop/TP math (that stays computeStructuralStop's
    // structuralLevel, unrelated field).
    ote_leg_high: sig.context?.ote_leg_high ?? null,
    ote_leg_low: sig.context?.ote_leg_low ?? null,
    ote_zone_at_entry: confirmation5m?.oteZone ?? null,
    sweep_confirmed: confirmation5m?.trigger === 'sweep',
    stop_basis: stopBasis,
    structural_level: confirmation5m?.structuralLevel ?? null,
    source: 'scanner_smc',
    candle_status: 'CLOSED',
    data_status: 'LIVE',
    signal_reasons: sig.context?.reasons || [],
    invalidates_if: isBuy
      ? 'Estrutura 1h reverter para baixista (CHoCH bearish)'
      : 'Estrutura 1h reverter para altista (CHoCH bullish)',
    market_source: MARKET_SOURCE,
    data_exchange: DATA_EXCHANGE,
    executor: EXECUTOR,
  };
}

/**
 * Central cross-cascade arbitration — the ONLY place scanner.js reacts to a
 * new candidate signal arriving while the asset already has an active
 * TradeOperation (from either cascade). Replaces the old pure-block-and-log
 * behavior (docs/known-risks.md item 23) with the decision matrix in
 * src/lib/signalArbitration.js. Never creates a second TradeOperation or a
 * second assetActiveOps pointer — every op-touching action here goes through
 * transitionTradeOp (a same-status CAS patch, or a terminal one for
 * 'invalidate'), which also structurally guarantees the stop never regresses
 * (clampMonotonicStop, src/api/entities.js).
 *
 * "promote" is Stage A only (external audit of PR #78): a qualifying 4h
 * candidate starts PENDING_15M — it does NOT confirm the promotion, since
 * this function deliberately never fetches the 15m candle (the active op
 * blocks the whole retry window anyway, and skipping that candle fetch is
 * the point of the hasActiveOp early-exit). Stage B (CONFIRMED/EXPIRED) is
 * resolved separately by the promotion-confirmation retry step in
 * persistScanResults, which reuses check15mConfirmation — the SAME function
 * the native 4h_15m cascade requires for a real entry. See
 * signalArbitration.js's module doc comment for the full two-stage design.
 *
 * Write economy: SignalEvent.createUnique's dedup (in the caller, before this
 * runs) means a given signal reaches here at most ONCE — repeated scan passes
 * over an already-persisted signal never get this far again (dedupResult.created
 * is false, the caller `continue`s earlier). So a 'none'-action outcome
 * (reinforcement_accepted/rejected, continuation_confirmation, no_change,
 * candidate_below_arbitration_threshold) is logged to SystemLog for the audit
 * trail but does NOT write to the TradeOperation itself — nothing there
 * actually changed, and the decision is already recoverable from the log;
 * every real management change (start_promotion_pending, reduce_confidence,
 * invalidate, reject_pending_promotion) does write, exactly once.
 *
 * Logs via a direct backend.entities.SystemLog.create — not logInfo/logWarn
 * (src/lib/logger.js) — deliberately: that logger batches/dedups/delays up to
 * 3s before flushing, which risks losing the entry entirely if the short-lived
 * cron process (scripts/run-scan.mjs) exits first. This matches the existing
 * local convention in this same function (the "aguardando confirmação"/R:R
 * block messages a few lines up all use direct SystemLog.create too) and
 * keeps `reason: 'active_op_exists'` for continuity with the field the panel
 * and prior audits already query on, extended with the richer arbitration_*
 * fields.
 */
async function handleActiveOpArbitration({ signal, candidateCascade, activeOp, results, pineConfig }) {
  const candidateScore = signal.context?.score ?? 0;
  const decision = planSignalArbitration({
    candidateCascade,
    candidateSide: signal.signal_type,
    candidateScore,
    activeOp,
    pineConfig,
  });

  // Built BEFORE the CAS write, and reused (not redeclared) if that write is
  // rejected below — the exact bug an external audit of PR #78 caught: the
  // CAS-rejection log used to reference a `logPayload` variable that was
  // never declared in this function's scope, so the ONE path meant to record
  // "arbitration lost the race, here's why" instead threw a ReferenceError.
  const entryScore = activeOp?.entry_score ?? activeOp?.score ?? null;
  const currentConfidence = activeOp?.current_confidence_score ?? activeOp?.score ?? null;
  const logPayload = {
    reason: 'active_op_exists',
    arbitration_version: ARBITRATION_VERSION,
    arbitration_event_id: `${signal.dedup_key}::${activeOp?.id ?? 'none'}`,
    candidate_signal: signal.dedup_key,
    candidate_cascade: candidateCascade,
    candidate_side: signal.signal_type,
    candidate_score: candidateScore,
    confirmation_checked: false,
    active_op_id: activeOp?.id ?? null,
    active_op_cascade: activeOp?.cascade ?? null,
    active_op_side: activeOp?.side ?? null,
    active_op_status: activeOp?.status ?? null,
    active_op_score: activeOp?.score ?? null,
    active_op_entry_score: entryScore,
    active_op_current_confidence: currentConfidence,
    relation_direction: decision.direction,
    relation_tf: decision.tfRelation,
    arbitration_outcome: decision.outcome,
    arbitration_reason: decision.reason,
  };

  await backend.entities.SystemLog.create({
    level: decision.logLevel === 'warn' ? 'warn' : 'info',
    module: 'scanner',
    message: `${signal.symbol} ${candidateCascade} ${signal.signal_type} (score ${candidateScore}) vs. operação ativa ${activeOp?.cascade ?? '?'} ${activeOp?.side ?? '?'} (score ${activeOp?.score ?? 0}) — ${decision.outcome} (${decision.reason})`,
    symbol: signal.symbol,
    timeframe: candidateCascade === '4h_15m' ? '4h' : '1h',
    details: logPayload,
  });

  if (decision.action === 'none' || !activeOp) {
    return { dedup_key: signal.dedup_key, cascade: candidateCascade, outcome: decision.outcome };
  }

  const now = new Date().toISOString();
  const patch = {
    arbitration_outcome: decision.outcome,
    arbitration_reason: decision.reason,
    arbitration_at: now,
  };

  if (decision.action === 'start_promotion_pending') {
    // Stage A only — records that the 4h context qualified, WITHOUT
    // lengthening the time stop or touching trade_mode/management_timeframe
    // yet. Those only change once Stage B (the retry step below, in
    // persistScanResults) actually confirms the 15m entry.
    patch.promotion_status = 'PENDING_15M';
    patch.promotion_candidate_at = now;
    patch.promotion_candidate_score_4h = candidateScore;
    patch.promotion_candidate_signal_id = signal.dedup_key;
  } else if (decision.action === 'reduce_confidence') {
    // Only current_confidence_score moves — entry_score (and the legacy
    // `score` alias) stay exactly what they were at entry, forever, for
    // audit. See docs/known-risks.md and buildTradeOpData's comment.
    const base = activeOp.current_confidence_score ?? activeOp.entry_score ?? activeOp.score ?? 0;
    patch.current_confidence_score = Math.min(100, Math.max(0, base - decision.scorePenalty));
    patch.confidence_penalty_total = (activeOp.confidence_penalty_total ?? 0) + decision.scorePenalty;
    patch.last_opposing_signal_at = now;
  } else if (decision.action === 'invalidate') {
    patch.status = 'INVALIDATED';
    patch.closed_reason = 'INVALIDATION';
    patch.closed_at = now;
    patch.exit_price = signal.price_at_signal ?? activeOp.entry_price;
  } else if (decision.action === 'reject_pending_promotion') {
    // The larger-timeframe context that would have confirmed a pending
    // promotion just reversed — cancel the pending stage. The operation
    // itself (status, stop, targets) is untouched; only the promotion state
    // machine moves, matching the "não invalidar automaticamente" carve-out
    // for a candidate that isn't opted into arbInvalidateOnOppositeMajor.
    patch.promotion_status = 'REJECTED';
  }

  const { applied, currentStatus } = await backend.tradeOps.transitionTradeOp(activeOp.id, activeOp.status, patch, { assetId: activeOp.asset_id });
  if (!applied) {
    await backend.entities.SystemLog.create({
      level: 'warn',
      module: 'scanner',
      message: `Arbitragem (${decision.outcome}) descartada pelo CAS: op ${activeOp.id} (${signal.symbol}) já mudou de ${activeOp.status} para ${currentStatus}`,
      symbol: signal.symbol,
      details: { ...logPayload, reason: 'arbitration_cas_rejected', current_status: currentStatus },
    });
  }

  // Codex review (PR #79): returning the applied patch lets the caller
  // refresh its local `activeOp` snapshot. Without this, two opposing
  // candidates landing in the SAME pass (e.g. a 4h_15m one and a 1h_5m one,
  // both targeting the same active op) would both compute reduce_confidence's
  // `base`/`confidence_penalty_total` from the same stale pre-pass values —
  // the second write would overwrite the first's penalty instead of
  // compounding it, understating how many opposing signals actually fired.
  return { dedup_key: signal.dedup_key, cascade: candidateCascade, outcome: decision.outcome, applied, patch: applied ? patch : null };
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
  const indicatorParams = resolveIndicatorParams(asset, pineConfig);
  const rsiZoneThresholds = resolveRsiZoneThresholds(asset);

  const enabledTimeframes = TIMEFRAMES.filter(tf => {
    const tfConfig = asset.timeframes_enabled;
    return tfConfig ? tfConfig[tf] !== false : true;
  });

  // Fetch and analyze each timeframe
  for (const tf of enabledTimeframes) {
    try {
      const candleLimit = tf === '1h' ? SMC_1H_STRUCTURE_CANDLE_LIMIT : DEFAULT_CANDLE_LIMIT;
      const candles = await fetchCandles(asset.symbol, tf, candleLimit);
      
      // Only use closed candles for signal calculation
      const closedCandles = candles.filter(c => c.isClosed);
      
      if (closedCandles.length < 50) {
        errors.push({ timeframe: tf, error: `Apenas ${closedCandles.length} candles fechados disponíveis` });
        continue;
      }

      // Calculate all indicators
      const rfResult = calculateRangeFilter(
        closedCandles,
        firstPositiveInteger(asset.rf_period, 20),
        firstPositive(asset.rf_multiplier, 3.5)
      );

      // confirmBars — global Pine parameter (docs/known-risks.md item 27:
      // deliberately no per-asset override, unlike rf_period/rf_multiplier),
      // so no resolveIndicatorParams entry. Retroactive gate: at the
      // default (1) this is mathematically identical to rfResult.signal —
      // see rangeFilterConfirmation.js's header comment and its equivalence
      // test — so this only changes behavior once confirmBars is raised in
      // the Pine editor and synced.
      const confirmed = calculateConfirmedSignal(rfResult.series, firstPositiveInteger(pineConfig.confirmBars, 1) ?? 1);

      const rsiResult = calculateRSI(closedCandles, indicatorParams.rsiPeriod, rsiZoneThresholds.overbought, rsiZoneThresholds.oversold);

      const macdResult = calculateMACD(
        closedCandles,
        firstPositiveInteger(asset.macd_fast, 12),
        firstPositiveInteger(asset.macd_slow, 26),
        firstPositiveInteger(asset.macd_signal, 9)
      );

      const emaResult = calculateEMAs(
        closedCandles,
        indicatorParams.emaFast,
        indicatorParams.emaSlow
      );

      // Volume SMA para confirmação Pine v2 — período vem do Pine (volLen),
      // não mais uma constante local surda ao pineConfig.
      const volumes = closedCandles.map(c => c.volume || 0);
      const volSlice = volumes.slice(-indicatorParams.volPeriod);
      const volMa = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
      const volCurrent = volumes[volumes.length - 1];
      const volumeData = { current: volCurrent, ma: volMa };

      const atrValue = calculateATR(closedCandles, indicatorParams.atrStopPeriod);
      const lastCandle = closedCandles[closedCandles.length - 1];

      // Tier/regime filters (ADX, Choppiness) are only meaningful on the
      // 4h timeframe — that's where entries/risk are decided (the 4h
      // signal + 15m confirmation cascade, kept as-is by design).
      let tier = null, adx = null, chop = null;
      if (tf === '4h') {
        const atrPctSmooth = calculateAtrPctSmooth(closedCandles, indicatorParams.atrStopPeriod, 20);
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
        smc = {
          trend: structure.trend,
          lastBull: structure.lastBull,
          lastBear: structure.lastBear,
          pdZone: pdZone.zone,
          // Protected pivots carried by the structure calc (docs/known-risks.md
          // item 38) — the origin of the impulse leg a fresh 1h BOS/CHoCH just
          // confirmed. Consumed below to anchor the OTE leg passed to the 5m
          // entry trigger; already reused by the SMC structural stop (item 24).
          lastSwingHigh: structure.lastSwingHigh,
          lastSwingLow: structure.lastSwingLow,
        };
      }

      results[tf] = {
        rf: rfResult,
        confirmed,
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
    
    // Calculate strength and priority (score from Pine config). r.confirmed
    // (confirmBars-aware) drives isBuy/isSell/followThrough here — see
    // rangeFilterConfirmation.js.
    const MIN_SCORE = pineConfig.minScore ?? 75;
    const strengthResult = calculateSignalStrength(
      r.rf, r.rsi, r.macd, r.ema, alignmentResult, tf, r.volumeData, MIN_SCORE, r.confirmed
    );

    // Check for Range Filter BUY/SELL signal — only emit if score passes.
    // Uses the CONFIRMED signal (confirmBars), not the raw flip — at the
    // default confirmBars=1 these are identical (see rangeFilterConfirmation.js).
    // Every other reader of r.rf.signal/.direction (AssetState diagnostics,
    // regime checks, check15mConfirmation, retry loop) is intentionally
    // untouched — this block only.
    if ((r.confirmed.confirmedSignal === 'BUY' || r.confirmed.confirmedSignal === 'SELL') && strengthResult.passed) {
      const reason = generateSignalDescription(
        asset.symbol, tf, r.confirmed.confirmedSignal,
        strengthResult.strength, strengthResult.alignment, strengthResult.reasons
      );

      newSignals.push({
        asset_id: asset.id,
        symbol: asset.symbol,
        timeframe: tf,
        signal_type: r.confirmed.confirmedSignal,
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
        dedup_key: `${asset.symbol}_${tf}_${r.confirmed.confirmedSignal}_range_filter_${r.lastCandleTime}`,
      });
    }

    // Check for SMC/ICT structure signal (1h bias for the 1h→5m cascade) —
    // fires on any fresh BOS/CHoCH. docs/known-risks.md item 38: the
    // Premium/Discount zone is NO LONGER a reject gate here — pd_zone stays
    // as observable metadata only (reason string, context.pd_zone). Gating
    // on it at this exact candle was self-contradictory by construction: a
    // structure break's close is, by definition, near the extreme of the
    // very window pdZone measures over the same closedCandles, so the old
    // gate rejected almost exactly the event type it was meant to filter
    // (measured: 74/74 real 1h breaks rejected in an 18.5-month BTCUSDT
    // backtest — see docs/known-risks.md item 35). Zone-awareness moves to
    // the 5m entry trigger instead (check5mSmcConfirmation), evaluated
    // against the LEG of this specific break rather than a disconnected
    // window — see buildSmcTradeOpData/ote_leg_high/ote_leg_low.
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
        // Fixed once, here, at the instant of the 1h signal — never
        // recomputed on retry (item 38). Null legLow/legHigh (missing
        // protected pivot) is a valid, expected fail-open case.
        const { legHigh: oteLegHigh, legLow: oteLegLow } = buildOteLeg(signalType, r.lastClose, r.smc);

        // Score is advisory (see smcConfluence.js header) — feeds
        // cross-cascade arbitration/audit, never gates emission. sweepConfirmed
        // is unknown at this stage (resolved later, at op-creation, once
        // check5mSmcConfirmation runs) — see buildSmcTradeOpData.
        const smcScore = calculateSmcSignalStrength({
          structureType,
          signalType,
          rf1hDirection: r.rf.direction,
          emaTrend: r.ema.trend,
          volumeData: r.volumeData,
          alignmentResult,
          pdZone: r.smc.pdZone,
          weights: {
            structureWeight: pineConfig.smcScoreStructureWeight,
            chochBonus: pineConfig.smcScoreChochBonus,
            emaWeight: pineConfig.smcScoreEmaWeight,
            rfWeight: pineConfig.smcScoreRfWeight,
            volumeWeight: pineConfig.smcScoreVolumeWeight,
            alignmentWeight: pineConfig.smcScoreAlignmentWeight,
            sweepWeight: pineConfig.smcScoreSweepWeight,
          },
        });

        newSignals.push({
          asset_id: asset.id,
          symbol: asset.symbol,
          timeframe: tf,
          signal_type: signalType,
          source: 'smc_structure',
          strength: smcScore.strength,
          alignment: strengthResult.alignment,
          priority: smcScore.priority,
          price_at_signal: r.lastClose,
          candle_time: r.lastCandleTime,
          reason: `${asset.symbol} 1H ${structureType} ${signalType === 'BUY' ? 'altista' : 'baixista'} — zona ${r.smc.pdZone} (score ${smcScore.score})`,
          context: {
            structure_type: structureType,
            pd_zone: r.smc.pdZone,
            ote_leg_high: oteLegHigh,
            ote_leg_low: oteLegLow,
            score: smcScore.score,
            reasons: smcScore.reasons,
          },
          dedup_key: `${asset.symbol}_1h_${signalType}_smc_structure_${r.lastCandleTime}`,
        });
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
    pineConfig,
  };
}

/**
 * Persist scan results - states and deduplicated signals
 */
export async function persistScanResults(scanResult) {
  // pineConfig is reused from scanAsset's read instead of fetched again here
  // — this function is always called immediately after scanAsset with its
  // result, so a second read of the same strategyConfig doc is pure waste
  // (Firestore quota is billed per read, and this runs for every asset on
  // every 5-minute pass — see docs/known-risks.md item 13).
  const { asset, results, newSignals, errors, duration, pineConfig } = scanResult;

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
      // Skip the write entirely when nothing about the state actually
      // changed (candle hasn't closed yet, no new indicator values) — this
      // block otherwise ran unconditionally on every 5-min pass for every
      // timeframe, most of which are no-ops for slower timeframes like 4h/1d
      // (see docs/known-risks.md item 17). processed_at is excluded from the
      // comparison, so it's only refreshed when there's a real change to
      // persist alongside it.
      if (hasAssetStateChanged(existing[0], stateData)) {
        await backend.entities.AssetState.update(existing[0].id, stateData);
      }
    } else {
      await backend.entities.AssetState.create(stateData);
    }
  }

  // Whether this asset already has a non-terminal TradeOperation — fetched
  // ONCE per pass and reused everywhere it's needed below (both cascades'
  // entry blocks and retry loops), instead of the same TradeOperation
  // query being re-run up to 4x per asset per pass. This is only ever a
  // cheap early-exit optimization (skips an unnecessary candle fetch) —
  // the real duplicate-prevention guarantee is createTradeOpIfNoneActive's
  // transaction further down, so a value that goes stale mid-function (if
  // an op is created by an earlier block in this same pass) is harmless;
  // it's kept fresh anyway by flipping to true right after each successful
  // creation below.
  const activeOpsAtStart = await backend.entities.TradeOperation.filter({
    symbol: asset.symbol,
    asset_id: asset.id,
    status: ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'],
  });
  let hasActiveOp = activeOpsAtStart.length > 0;
  // Kept only to enrich the discard log below (which op blocked the entry) —
  // hasActiveOp remains the actual gate.
  let activeOp = activeOpsAtStart[0] || null;

  // Invariant guard (external audit of PR #78): the whole system is built
  // around exactly ONE active op per asset (assetActiveOps' single-doc CAS
  // anchor, src/api/entities.js), so this should be structurally impossible
  // in normal operation — but a pre-CAS historical record, manual Firestore
  // edit, or an as-yet-unknown bug could still produce it. Silently picking
  // activeOpsAtStart[0] in that case would let arbitration/promotion act on
  // an arbitrary one of several operations nobody chose. Instead: suspend
  // BOTH arbitration and new-entry creation for this asset (hasActiveOp
  // already blocks new entries below since it's true whenever length > 0)
  // and surface it loudly — resolving which op is "real" is a policy
  // decision for a human, not something this loop should guess at.
  const duplicateActiveOps = activeOpsAtStart.length > 1;
  if (duplicateActiveOps) {
    await backend.entities.SystemLog.create({
      level: 'error',
      module: 'scanner',
      message: `${asset.symbol}: ${activeOpsAtStart.length} operações ativas simultâneas detectadas — invariante de 1 operação por ativo violada. Arbitragem e novas entradas suspensas até resolução manual.`,
      symbol: asset.symbol,
      details: {
        reason: 'duplicate_active_ops_detected',
        op_ids: activeOpsAtStart.map(o => o.id),
        op_statuses: activeOpsAtStart.map(o => o.status),
        op_cascades: activeOpsAtStart.map(o => o.cascade),
        op_created_dates: activeOpsAtStart.map(o => o.created_date),
      },
    });
  }

  // Deduplicate and persist signals
  let persistedSignals = 0;
  // docs/known-risks.md item 38: sampled, not exhaustive — only the entry
  // motor's FIRST evaluation of a fresh 1h SMC signal pushes here, never the
  // 5m-retry loop (which stays silent on every rejected tick by the same
  // deliberate design as the 4h/15m retry loop, to avoid a Firestore write
  // per pending signal every ~5 minutes over its whole retry window). Real
  // rejection volume across the full retry window is therefore higher than
  // this array reports — it answers "did the very first 5m check reject the
  // candidate", not "was it ever rejected". Good enough to distinguish
  // item 34 (no structure event) from item 35/38 (event happened, gate
  // rejected the entry) without adding new write volume.
  const smc5mZoneRejections = [];
  // Collected from handleActiveOpArbitration below — surfaced in the return
  // value (used by the backtest report, buildReport's `arbitration` section)
  // and left otherwise unused by the live scanner itself (audit trail is
  // SystemLog, this array is just for a single-pass summary).
  const arbitrationOutcomes = [];
  for (const signal of newSignals) {
    // Cooldown check — a best-effort query, not atomic on its own, but the
    // scan lock (acquireScanLock in scanAllAssets/priceCheckActiveOps) means
    // only one executor (browser or cron) is ever inside this loop at a
    // time, so the residual race window here is negligible (see
    // docs/known-risks.md). Computed BEFORE persisting this signal so
    // `recentNotified` naturally excludes it. Gates ONLY the Telegram
    // notification below (the UI already labels this field "minutos entre
    // ALERTAS iguais" — alertas means Telegram in this app's vocabulary) —
    // it must NEVER gate persistence or the entry motor (see known-risks.md
    // item 28: raising this to reduce notification spam used to silently
    // drop the SignalEvent and every entry that depended on it existing,
    // including the retry loop's ability to re-check it later).
    const cooldownMinutes = asset.alert_cooldown_minutes || 60;
    const cooldownTime = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();

    // Anchored on `notified: true` only (Codex review, PR #59): every signal
    // persists now regardless of cooldown, so a query without this filter
    // would find the most recently PERSISTED same-type signal — which could
    // itself be one whose notification was suppressed, letting a streak of
    // frequent signals stretch the "quiet window" indefinitely even though
    // the last actual alert was long ago. Anchoring on the last NOTIFIED one
    // makes "N minutes between alerts" mean what it says.
    const recentNotified = await backend.entities.SignalEvent.filter({
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      signal_type: signal.signal_type,
      source: signal.source,
      notified: true,
    }, '-created_date', 1);

    const notificationOnCooldown = recentNotified.some(s =>
      s.created_date > cooldownTime
    );
    // Whether THIS signal would actually alert anyone — used both to gate
    // the Telegram call below and to persist `notified` on the record
    // itself, so every user-facing alert channel (Telegram, in-app toast/
    // banner, browser Notification API — see Dashboard.jsx consumers) can
    // filter on the SAME flag instead of re-deriving cooldown state
    // independently (Codex review, PR #59).
    const willNotify = !notificationOnCooldown && isTelegramConfigured();

    // Atomic dedup: dedup_key is used as the Firestore document id itself,
    // so createUnique is a single transaction that can never let two
    // concurrent callers both persist the same signal (unlike the previous
    // filter()-then-create() pattern, which had a race window between the
    // two calls). Runs regardless of cooldown — the signal is real and
    // must be recorded/evaluated for entry even while notifications are
    // suppressed.
    const dedupResult = await backend.entities.SignalEvent.createUnique(signal.dedup_key, {
      ...signal,
      notified: willNotify,
      market_source: MARKET_SOURCE,
      data_exchange: DATA_EXCHANGE,
      executor: EXECUTOR,
    });
    if (!dedupResult.created) continue;

    persistedSignals++;
    if (willNotify) notifyNewSignal(signal).catch(() => {});

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

            if (!hasActiveOp) {
              // 15m confirmation required — no entry without it
              const confirmed15m = await check15mConfirmation(asset.symbol, signal.signal_type, asset);

              if (confirmed15m.confirmed) {
                const opData = buildTradeOpData(signal, tf4hData, pineConfig, confirmed15m);
                const minRR = pineConfig.minRR ?? 1.2;
                const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
                if (!rr.pass) {
                  await backend.entities.SystemLog.create({
                    level: 'info',
                    module: 'scanner',
                    message: `${asset.symbol} 4h ${signal.signal_type} — entrada bloqueada: R:R ${rr.rr1?.toFixed(2) ?? 'n/d'} abaixo do mínimo ${minRR} (${rr.reason})`,
                    symbol: asset.symbol,
                    timeframe: '15m',
                    details: { reason: rr.reason, rr1: rr.rr1, rr2: rr.rr2, min_rr: minRR },
                  });
                } else {
                  opData.rr_at_entry = rr.rr1;
                  opData.rr_gate_mode = RR_GATE_MODE;
                  opData.rr_target_basis = RR_TARGET_BASIS;
                  const tradeOpId = `trade_${signal.dedup_key}`;
                  const created = await backend.tradeOps.createTradeOpIfNoneActive(signal.asset_id, tradeOpId, opData);
                  if (created.created) {
                    hasActiveOp = true;
                    activeOp = created.doc;
                    if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});
                    logInfo('scanner', `${signal.symbol} entrada criada — Pine sync ativo`, {
                      score: signal.context?.score, atr_mult: pineConfig.trailAtrMult, tp1R: pineConfig.tp1R, rr: rr.rr1,
                    }, { symbol: signal.symbol, timeframe: '15m' });
                  }
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
            } else if (!duplicateActiveOps) {
              // Candidate passed every 4H gate but the asset already holds an
              // op (possibly from the OTHER cascade — the two share the
              // one-op-per-asset anchor). The 15m confirmation is deliberately
              // NOT fetched here (the active op blocks the whole retry window
              // anyway, and skipping the candle fetch is the point of the
              // hasActiveOp early-exit) — arbitration reacts to the candidate
              // signal itself, never to a hypothetical confirmed entry.
              const outcome = await handleActiveOpArbitration({
                signal, candidateCascade: '4h_15m', activeOp, results, pineConfig,
              });
              arbitrationOutcomes.push(outcome);
              // Keep the local snapshot fresh for any FURTHER signal this
              // same pass (see handleActiveOpArbitration's return comment).
              if (outcome.applied && outcome.patch) activeOp = { ...activeOp, ...outcome.patch };
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
        if (!hasActiveOp) {
          const legBounds = { legHigh: signal.context?.ote_leg_high, legLow: signal.context?.ote_leg_low };
          const confirmed5m = await check5mSmcConfirmation(asset.symbol, signal.signal_type, legBounds);

          if (confirmed5m.confirmed) {
            const opData = buildSmcTradeOpData(signal, tf1hData, pineConfig, confirmed5m);
            const minRR = pineConfig.minRR ?? 1.2;
            const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
            if (!rr.pass) {
              await backend.entities.SystemLog.create({
                level: 'info',
                module: 'scanner',
                message: `${asset.symbol} 1H SMC ${signal.signal_type} — entrada bloqueada: R:R ${rr.rr1?.toFixed(2) ?? 'n/d'} abaixo do mínimo ${minRR} (${rr.reason})`,
                symbol: asset.symbol,
                timeframe: '5m',
                details: { reason: rr.reason, rr1: rr.rr1, rr2: rr.rr2, min_rr: minRR },
              });
            } else {
              opData.rr_at_entry = rr.rr1;
              opData.rr_gate_mode = RR_GATE_MODE;
              opData.rr_target_basis = RR_TARGET_BASIS;
              const tradeOpId = `trade_smc_${signal.dedup_key}`;
              const created = await backend.tradeOps.createTradeOpIfNoneActive(signal.asset_id, tradeOpId, opData);
              if (created.created) {
                hasActiveOp = true;
                activeOp = created.doc;
                if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});
                logInfo('scanner', `${signal.symbol} entrada SMC criada (1h→5m)`, {
                  score: signal.context?.score, structure_type: signal.context?.structure_type, trigger: confirmed5m.trigger, rr: rr.rr1,
                }, { symbol: signal.symbol, timeframe: '5m' });
              }
            }
          } else {
            // item 38: rejectReason distinguishes "no 5m trigger yet" from
            // "trigger fired but the OTE leg zone rejected it" — the latter
            // is the new gate's own rejection, worth telling apart from mere
            // waiting when reading SystemLog later.
            await backend.entities.SystemLog.create({
              level: 'info',
              module: 'scanner',
              message: `${asset.symbol} 1H SMC ${signal.signal_type} — aguardando confirmação no 5m`,
              symbol: asset.symbol,
              timeframe: '5m',
              details: {
                signal_tf: '1h',
                direction: signal.signal_type,
                structure_type: signal.context?.structure_type,
                reason: confirmed5m.rejectReason,
                ote_zone: confirmed5m.oteZone,
              },
            });
            if (confirmed5m.rejectReason === 'ote_zone_unfavorable') {
              smc5mZoneRejections.push({ dedup_key: signal.dedup_key, symbol: signal.symbol, signal_type: signal.signal_type, ote_zone: confirmed5m.oteZone });
            }
          }
        } else if (!duplicateActiveOps) {
          // Same cross-cascade arbitration as the RF block above — 5m
          // confirmation not fetched (see the RF branch for why).
          const outcome = await handleActiveOpArbitration({
            signal, candidateCascade: '1h_5m', activeOp, results, pineConfig,
          });
          arbitrationOutcomes.push(outcome);
          if (outcome.applied && outcome.patch) activeOp = { ...activeOp, ...outcome.patch };
        }
      }
    }
  }

  // ─── Retry: resolve a pending 4h→1h promotion (Stage B) ───
  // `activeOp` is kept fresh across this pass — the two arbitration call
  // sites above merge their applied patch back into it (Codex review,
  // PR #79) — so a promotion that just went PENDING_15M earlier in THIS
  // same pass is visible here immediately, not deferred to the next pass.
  //
  // rejectedPendingThisPass stays as a defensive fallback for the one case
  // the merge can't cover: a critical_opposite write that itself got
  // rejected by the CAS (activeOp.promotion_status would still legitimately
  // read PENDING_15M then, since the REJECTED patch never actually landed).
  const rejectedPendingThisPass = arbitrationOutcomes.some(o => o.outcome === 'critical_opposite');
  if (!duplicateActiveOps && !rejectedPendingThisPass && activeOp?.promotion_status === 'PENDING_15M') {
    const candidateAtMs = activeOp.promotion_candidate_at ? new Date(activeOp.promotion_candidate_at).getTime() : null;
    const expired = candidateAtMs == null || (Date.now() - candidateAtMs) > 4 * ONE_HOUR_MS;

    if (expired) {
      await backend.tradeOps.transitionTradeOp(activeOp.id, activeOp.status, {
        promotion_status: 'EXPIRED',
      }, { assetId: activeOp.asset_id });
      await backend.entities.SystemLog.create({
        level: 'info',
        module: 'scanner',
        message: `${activeOp.symbol} promoção 4H pendente expirou sem confirmação 15m — operação segue TACTICAL_1H`,
        symbol: activeOp.symbol,
        timeframe: '15m',
        details: {
          reason: 'promotion_expired',
          arbitration_version: ARBITRATION_VERSION,
          op_id: activeOp.id,
          promotion_candidate_signal_id: activeOp.promotion_candidate_signal_id ?? null,
          promotion_candidate_at: activeOp.promotion_candidate_at ?? null,
        },
      });
    } else {
      // Codex review (PR #79): re-validate the 4h context ITSELF before
      // confirming, the same way the sibling "pending 4h signal" retry loop
      // below does (tf4hDir match + regime gate) — this block used to check
      // ONLY 15m alignment. A genuine directional flip normally also fires a
      // fresh opposing 4h SignalEvent, already caught above by
      // critical_opposite/reject_pending_promotion — but a regime-only
      // failure (ADX weak / Choppiness high) never does, since Range Filter
      // only emits a signal on a direction CHANGE, not on "conditions
      // stopped supporting a confident entry". Without this, a stale
      // qualifying context from hours ago could still confirm a promotion
      // off a coincidental later 15m bounce, even though the NATIVE
      // 4h_15m cascade's own gates would reject a fresh entry right now.
      const tf4h = results['4h'];
      const sigDir = activeOp.side === 'BUY' ? 1 : -1;
      const tf4hStillAligned = Boolean(tf4h?.atrValue) && tf4h.rf?.direction === sigDir;
      const regimeStillOk = tf4hStillAligned && evaluateRegime(tf4h, pineConfig).ok;

      if (tf4hStillAligned && regimeStillOk) {
        const confirmed15m = await check15mConfirmation(activeOp.symbol, activeOp.side, asset);
        if (confirmed15m.confirmed) {
          const now = new Date().toISOString();
          // Only NOW — Stage B, real 4h context AND 15m confirmation both in
          // hand — does the promotion actually take effect:
          // trade_mode/management_timeframe flip, and the time stop
          // lengthens (never shortens, see the Math.max below).
          // signal_timeframe is deliberately left untouched (still '1h') —
          // the update loop uses it to locate results[...] for this op's own
          // entry/stop/tp math, which stays 5m/1h-derived.
          const { applied } = await backend.tradeOps.transitionTradeOp(activeOp.id, activeOp.status, {
            promotion_status: 'CONFIRMED',
            trade_mode: 'PROMOTED_4H',
            management_timeframe: '4h',
            arbitration_outcome: 'promoted',
            promoted_at: now,
            promoted_from_cascade: activeOp.cascade,
            score_at_promotion_1h: activeOp.entry_score ?? activeOp.score ?? 0,
            score_at_promotion_4h: activeOp.promotion_candidate_score_4h ?? null,
            promotion_confirmed_at: now,
            promotion_confirm_candle_time: confirmed15m.entryCandleTime,
            tier_time_stop_bars: tf4h?.tier?.timeStopBars != null
              ? Math.max(activeOp.tier_time_stop_bars ?? 96, tf4h.tier.timeStopBars * 4)
              : activeOp.tier_time_stop_bars,
          }, { assetId: activeOp.asset_id });
          if (applied) {
            await backend.entities.SystemLog.create({
              level: 'info',
              module: 'scanner',
              message: `${activeOp.symbol} promoção 4H confirmada no 15m — gestão passa a ser PROMOTED_4H`,
              symbol: activeOp.symbol,
              timeframe: '15m',
              details: {
                reason: 'promotion_confirmed',
                arbitration_version: ARBITRATION_VERSION,
                op_id: activeOp.id,
                promotion_candidate_signal_id: activeOp.promotion_candidate_signal_id ?? null,
                confirm_candle_time: confirmed15m.entryCandleTime,
              },
            });
          }
        }
        // Not confirmed yet and still within the window: silent retry, same
        // write economy as the RF/SMC signal-confirmation retry loops below.
      }
      // 4h context no longer aligned/regime-valid: treated exactly like "not
      // confirmed yet" — stays PENDING_15M, re-evaluated next pass. Never
      // confirms on stale context, but doesn't reject on a single regime
      // blip either (ADX/Chop can flicker pass to pass).
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
  }, '-created_date', 10);

  for (const sig of recent4hSignals) {
    if (sig.created_date < fourHoursAgo) continue; // stale, skip
    if (sig.is_dismissed) continue;

    if (hasActiveOp) continue;

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
    const minRR = pineConfig.minRR ?? 1.2;
    const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
    if (!rr.pass) {
      await backend.entities.SystemLog.create({
        level: 'info',
        module: 'scanner',
        message: `${sig.symbol} 4h ${sig.signal_type} — entrada bloqueada (retry): R:R ${rr.rr1?.toFixed(2) ?? 'n/d'} abaixo do mínimo ${minRR} (${rr.reason})`,
        symbol: sig.symbol,
        timeframe: '15m',
        details: { reason: rr.reason, rr1: rr.rr1, rr2: rr.rr2, min_rr: minRR, retry: true },
      });
      continue;
    }
    opData.rr_at_entry = rr.rr1;
    opData.rr_gate_mode = RR_GATE_MODE;
    opData.rr_target_basis = RR_TARGET_BASIS;

    const tradeOpId = `trade_${sig.dedup_key || sig.id}`;
    const created = await backend.tradeOps.createTradeOpIfNoneActive(sig.asset_id, tradeOpId, opData);
    if (!created.created) continue;
    hasActiveOp = true;

    if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});

    await backend.entities.SystemLog.create({
      level: 'info',
      module: 'scanner',
      message: `${sig.symbol} 4h ${sig.signal_type} — confirmação 15m OK, entrada criada`,
      symbol: sig.symbol,
      timeframe: '15m',
      details: { signal_tf: '4h', direction: sig.signal_type, score: sig.context?.score, rr: rr.rr1, retry: true },
    });
  }

  // ─── Retry: re-check 5m SMC confirmation for pending 1h signals ───
  if (asset.smc_enabled) {
    const oneHourAgo4x = new Date(Date.now() - 4 * ONE_HOUR_MS).toISOString();
    const recentSmcSignals = await backend.entities.SignalEvent.filter({
      asset_id: asset.id,
      source: 'smc_structure',
      timeframe: '1h',
    }, '-created_date', 10);

    for (const sig of recentSmcSignals) {
      if (sig.created_date < oneHourAgo4x) continue; // stale, skip
      if (sig.is_dismissed) continue;

      if (hasActiveOp) continue;

      // Verify 1h structure bias still aligned (may have reversed since signal fired)
      const tfData1h = results['1h'];
      if (!tfData1h || !tfData1h.atrValue || !tfData1h.smc) continue;
      const sigDir = sig.signal_type === 'BUY' ? 1 : -1;
      if (tfData1h.smc.trend !== sigDir) continue;

      // Legacy SignalEvents predating item 38 have no ote_leg_high/low —
      // legBounds resolves to {legHigh: undefined, legLow: undefined},
      // which classifyZone (via check5mSmcConfirmation) already treats as
      // not-evaluable and fails OPEN, same as a freshly-created signal whose
      // protected pivot wasn't confirmed yet.
      const legBounds = { legHigh: sig.context?.ote_leg_high, legLow: sig.context?.ote_leg_low };
      const confirmed = await check5mSmcConfirmation(sig.symbol, sig.signal_type, legBounds);
      if (!confirmed.confirmed) continue;

      const opData = buildSmcTradeOpData(sig, tfData1h, pineConfig, confirmed);
      const minRR = pineConfig.minRR ?? 1.2;
      const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
      if (!rr.pass) {
        await backend.entities.SystemLog.create({
          level: 'info',
          module: 'scanner',
          message: `${sig.symbol} 1h SMC ${sig.signal_type} — entrada bloqueada (retry): R:R ${rr.rr1?.toFixed(2) ?? 'n/d'} abaixo do mínimo ${minRR} (${rr.reason})`,
          symbol: sig.symbol,
          timeframe: '5m',
          details: { reason: rr.reason, rr1: rr.rr1, rr2: rr.rr2, min_rr: minRR, retry: true },
        });
        continue;
      }
      opData.rr_at_entry = rr.rr1;
      opData.rr_gate_mode = RR_GATE_MODE;
      opData.rr_target_basis = RR_TARGET_BASIS;

      const tradeOpId = `trade_smc_${sig.dedup_key || sig.id}`;
      const created = await backend.tradeOps.createTradeOpIfNoneActive(sig.asset_id, tradeOpId, opData);
      if (!created.created) continue;
      hasActiveOp = true;

      if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});

      await backend.entities.SystemLog.create({
        level: 'info',
        module: 'scanner',
        message: `${sig.symbol} 1h SMC ${sig.signal_type} — confirmação 5m OK, entrada criada`,
        symbol: sig.symbol,
        timeframe: '5m',
        details: { signal_tf: '1h', direction: sig.signal_type, trigger: confirmed.trigger, rr: rr.rr1, retry: true },
      });
    }
  }

  // Update status of existing active TradeOperations. Skipped entirely when
  // duplicateActiveOps is true — "não alterar nenhuma das operações" applies
  // here too, not just to entry creation/arbitration above: with more than
  // one active op for this asset, this loop can't tell which one is real
  // either, so touching stop/TP on any of them would be guessing.
  const allActiveOps = duplicateActiveOps ? [] : await backend.entities.TradeOperation.filter({
    asset_id: asset.id,
    status: ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'],
  });
  for (const op of allActiveOps) {
    // Defense-in-depth: the status filter above already excludes terminal
    // ops server-side, but this guard stays in case a concurrent transaction
    // terminated the op between the query above and this iteration.
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
    // P0-c/P0-g: a candle whose OPEN predates the real entry (the confirming
    // 15m/5m candle, not the signal candle) contains price movement from
    // BEFORE the entry existed — its high/low must not trigger stop/TP
    // retroactively. See getEntryReferenceTime/isCandleUsableForExits in
    // opExitRules.js for why signal-candle-close was not a safe reference on
    // its own. Time Stop / Chop / RF state checks are not intra-candle price
    // action and stay unaffected; live price coverage continues via
    // priceCheckActiveOps meanwhile.
    const entryRef = getEntryReferenceTime(op);
    const candleUsable = isCandleUsableForExits(tfData.lastCandleOpenTime, entryRef);
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
      const stopHit = candleUsable
        && (isBuy ? stopCheckPrice <= op.current_stop : stopCheckPrice >= op.current_stop);
      // Computed here (not just inline in the tp1 else-if below) so
      // resolveCandleExit can flag when BOTH levels were touched in this
      // same candle — the stop still wins either way (policy unchanged),
      // but now the record can distinguish a clean stop from a conservative
      // call made under real ambiguity. See opExitRules.js.
      const tp1Touched = candleUsable
        && ((isBuy && tpCheckPrice >= op.tp1) || (!isBuy && tpCheckPrice <= op.tp1));
      const { ambiguous: stopTp1Ambiguous } = resolveCandleExit({ stopTouched: stopHit, targetTouched: tp1Touched });

      // Time Stop: close if TP1 hasn't hit within tier.timeStopBars candles
      // of the SIGNAL timeframe since entry — counted by elapsed time rather
      // than a scan-incremented counter, so it stays correct across cron
      // gaps. Bar duration depends on the cascade (4h for the RF cascade,
      // 1h for the SMC cascade). Aged from the REAL entry (entryRef, P0-g) —
      // the signal candle's close used to make a retry-confirmed operation
      // start "aging" hours before it actually existed.
      const barMs = SIGNAL_TF_MS[op.signal_timeframe] || FOUR_HOURS_MS;
      const barsOpen = entryRef
        ? Math.floor((Date.now() - new Date(entryRef).getTime()) / barMs)
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
      // P0-e: count CANDLES, not scanner passes — the 5-minute cron would
      // otherwise increment the same 4h/1h candle dozens of times.
      const rfCounter = nextRfReverseCount({
        rfReversedAgainst: isBuy ? rfDir === -1 : rfDir === 1,
        prevCount: op.rf_reverse_bars_count || 0,
        prevCandleTime: op.rf_reverse_last_candle || null,
        candleTime: tfData.lastCandleTime || null,
      });
      const reverseBars = rfCounter.count;
      updatePayload.rf_reverse_bars_count = reverseBars;
      updatePayload.rf_reverse_last_candle = rfCounter.lastCandle;
      const invalidationTriggered = pineConfig.useInvalidation === true
        && reverseBars >= (pineConfig.invalidRFBars ?? 2);

      if (stopHit) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_price = op.current_stop;
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
        if (stopTp1Ambiguous) updatePayload.exit_ambiguous = true;
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
      } else if (tp1Touched) {
        tp1Hit = true;
        newStatus = 'RUNNER_ACTIVE';
        newCurrentStop = op.entry_price;
        updatePayload.tp1_hit_at = nowIso;
        updatePayload.tp1_hit_price = op.tp1;
      }
    } else {
      // rf_reverse_bars_count only matters pre-TP1 (Chop Exit/Invalidation
      // gates) — keep it (and its candle marker) stable post-TP1 so the
      // update-guard below doesn't trigger a write every pass just because
      // updatePayload didn't set it.
      updatePayload.rf_reverse_bars_count = op.rf_reverse_bars_count || 0;
      updatePayload.rf_reverse_last_candle = op.rf_reverse_last_candle || null;

      // P0-d: exits are evaluated against the STORED stop — a trailing stop
      // derived from this candle's close only protects from the NEXT candle
      // on; testing it against the same candle's low/high is look-ahead. The
      // trail advance happens after the exit checks, at the end of this block.
      const runnerStopHit = candleUsable
        && (isBuy ? stopCheckPrice <= op.current_stop : stopCheckPrice >= op.current_stop);
      // See the pre-TP1 branch above for why this is computed alongside
      // runnerStopHit instead of only inline in the tp2 else-if.
      const tp2Touched = candleUsable
        && ((isBuy && tpCheckPrice >= op.tp2) || (!isBuy && tpCheckPrice <= op.tp2));
      const { ambiguous: stopTp2Ambiguous } = resolveCandleExit({ stopTouched: runnerStopHit, targetTouched: tp2Touched });
      if (runnerStopHit) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_price = op.current_stop;
        // Runner stopped at BE (entry) or current stop
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
        if (stopTp2Ambiguous) updatePayload.exit_ambiguous = true;
      } else if (tp2Touched) {
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
          // Aligned with the pre-TP1 RF-invalidation branch above, which
          // already set this — was missing here, leaving closed_reason
          // undefined on a real fraction of INVALIDATED ops (Telegram
          // notification below and any consumer of closed_reason need it).
          updatePayload.closed_reason = 'INVALIDATION';
          updatePayload.exit_price = closePrice;
          updatePayload.closed_at = nowIso;
        }
      } else if (rfFilt && op.exit_mode !== 'ATR_TRAILING') {
        const rfInval = isBuy ? (rfDir === -1 && closePrice < rfFilt) : (rfDir === 1 && closePrice > rfFilt);
        if (rfInval) {
          newStatus = 'INVALIDATED';
          updatePayload.closed_reason = 'INVALIDATION';
          updatePayload.exit_price = closePrice;
          updatePayload.closed_at = nowIso;
        }
      }

      // P0-d: only after no exit fired on this candle, advance the ATR trail
      // from its close — the new stop starts protecting on the next candle.
      // Gated by candleUsable so a stale (pre-entry/replay) close can never
      // move the stop.
      if (newStatus === 'RUNNER_ACTIVE' && candleUsable
          && (op.exit_mode === 'HYBRID_RF_ATR' || op.exit_mode === 'ATR_TRAILING') && tfData.atrValue) {
        newCurrentStop = advanceTrailingStop({
          isBuy,
          currentStop: newCurrentStop,
          closePrice,
          atrValue: tfData.atrValue,
          trailMult: pineConfig.trailAtrMult ?? 2.0,
        });
      }
    }
    if (newStatus !== op.status || tp1Hit !== op.tp1_hit || tp2Hit !== op.tp2_hit || newCurrentStop !== op.current_stop
        || updatePayload.rf_reverse_bars_count !== (op.rf_reverse_bars_count || 0)) {
      // Compare-and-set against the op's current status in Firestore: the
      // browser scan and the cron run under separate locks, so a plain update
      // could clobber a newer state or resurrect a terminal op. transitionTradeOp
      // also folds clearActiveOp into the same transaction on terminal states.
      const { applied, currentStatus } = await backend.tradeOps.transitionTradeOp(op.id, op.status, {
        status: newStatus,
        tp1_hit: tp1Hit,
        tp2_hit: tp2Hit,
        current_stop: newCurrentStop,
        ...updatePayload,
      }, { assetId: op.asset_id });
      // Observability for the cross-loop precedence residual (see
      // .claude/rules/trading-engine.md): a dropped transition means the other
      // loop won the race — measure how often before designing a hard rule.
      if (!applied) {
        logWarn('scanner', `Transição descartada pelo CAS: op ${op.id} (${op.symbol}) ${op.status}→${newStatus}; status atual ${currentStatus}`, { op_id: op.id, from: op.status, attempted: newStatus, current: currentStatus }, { symbol: op.symbol });
      }
      // Only notify when THIS pass actually applied the transition — prevents
      // duplicate Telegram messages when both loops race the same op.
      if (applied && isTelegramConfigured()) {
        if (newStatus === 'STOP_HIT' && op.status !== 'STOP_HIT') notifyStopHit(op, closePrice).catch(() => {});
        else if (newStatus === 'TP2_HIT') notifyTP2Hit(op, closePrice).catch(() => {});
        else if (newStatus === 'INVALIDATED') notifyInvalidated(op, closePrice).catch(() => {});
        else if (newStatus === 'CLOSED' && updatePayload.closed_reason === 'TIME_STOP') notifyTimeStop(op, closePrice).catch(() => {});
        else if (newStatus === 'CLOSED' && updatePayload.closed_reason === 'CHOP_EXIT') notifyChopExit(op, closePrice).catch(() => {});
        else if (tp1Hit && !op.tp1_hit) notifyTP1Hit(op, closePrice).catch(() => {});
      }
    }
    } catch (err) {
      logError('scanner', `Falha ao atualizar status da operação ${op.id} (${op.symbol})`, { error: err.message });
    }
  }

  // Update asset scan status. scan_error_since tracks how long this asset has
  // been failing CONTINUOUSLY — last_scan_at alone can't detect that, since
  // it's refreshed on both success and error (a per-asset healthcheck reading
  // only last_scan_at would never notice an asset failing every single pass;
  // see docs/known-risks.md item 12 and scripts/run-scan.mjs's per-asset
  // healthcheck, which alerts when this has been set for too long).
  await backend.entities.MonitoredAsset.update(asset.id, {
    last_scan_at: new Date().toISOString(),
    scan_status: errors.length > 0 ? 'error' : 'success',
    scan_error: errors.length > 0 ? errors.map(e => `${e.timeframe}: ${e.error}`).join('; ') : '',
    scan_error_since: errors.length > 0
      ? (asset.scan_status === 'error' ? (asset.scan_error_since || new Date().toISOString()) : new Date().toISOString())
      : null,
  });

  // Log scan — only when something actually happened (new signal or error).
  // A routine "nothing changed" pass used to write this unconditionally for
  // every asset on every 5-minute cron run — pure Firestore write-quota
  // waste on the free Spark plan (see docs/known-risks.md item 13). Skipped
  // passes are still fully covered by MonitoredAsset.last_scan_at above and
  // the watchdog ping in scripts/run-scan.mjs, so nothing goes unobserved.
  if (persistedSignals > 0 || errors.length > 0) {
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
  }

  return { persistedSignals, errors, smc5mZoneRejections, arbitrationOutcomes };
}

// known-risks.md item 32: useAutoScan.js used to gate priceCheckActiveOps()
// on whether any of the 50 MOST RECENTLY CREATED TradeOperations (any
// status) happened to be active — a genuinely active op older (by creation
// time) than 50 others created since (plausible with several assets, ops
// opening/closing while one RUNNER_ACTIVE waits days for TP2) fell outside
// that window and silently disabled the live price check for it in the
// browser. This does the correct server-side status-filtered existence
// check instead — same filter priceCheckActiveOpsInner already uses below,
// just capped to 1 doc since existence is all that's needed (cheaper than
// the 50-doc read it replaces, not just more correct).
export async function hasActiveTradeOps() {
  const ops = await backend.entities.TradeOperation.filter({ status: ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'] }, undefined, 1);
  return ops.length > 0;
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
  // Filtered server-side by status instead of fetching every TradeOperation
  // ever created and discarding most of it client-side — that unfiltered
  // read grows with trade history forever and was a real, documented
  // Firestore-quota risk (see docs/known-risks.md item 13).
  const activeOps = await backend.entities.TradeOperation.filter({ status: ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'] });
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
      // Same compare-and-set as persistScanResults — this price-check loop uses
      // a different lock ('price-check'), so it can race the full scan on the
      // same op; the transaction serialises the write and folds clearActiveOp.
      const { applied, currentStatus } = await backend.tradeOps.transitionTradeOp(op.id, op.status, { status: newStatus, tp1_hit: tp1Hit, tp2_hit: tp2Hit, current_stop: newCurrentStop, ...updatePayload }, { assetId: op.asset_id });
      // Same cross-loop race observability as persistScanResults.
      if (!applied) {
        logWarn('scanner', `Transição descartada pelo CAS (price check): op ${op.id} (${op.symbol}) ${op.status}→${newStatus}; status atual ${currentStatus}`, { op_id: op.id, from: op.status, attempted: newStatus, current: currentStatus }, { symbol: op.symbol });
      }
      if (applied && isTelegramConfigured()) {
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
      // No transient 'scanning' status write here: nothing in the UI ever
      // read it (progress feedback comes from the onProgress callback), and
      // it cost one MonitoredAsset write per asset on EVERY pass — ~2.3k
      // wasted writes/day on the free Spark quota with 8 assets at the
      // cron's 5-minute cadence. persistScanResults writes the real
      // success/error status at the end of the pass.
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
        scan_error_since: asset.scan_status === 'error' ? (asset.scan_error_since || new Date().toISOString()) : new Date().toISOString(),
      });

      await backend.entities.SystemLog.create({
        level: 'error',
        module: 'scanner',
        message: `Erro no scan de ${asset.symbol}: ${err.message}`,
        symbol: asset.symbol,
      });
    }
  }

  // Rough Firestore quota check — extrapolates this pass's read/write count
  // to a full day assuming the cron's real cadence (the dominant driver of
  // Firestore usage; the browser's own auto-scan runs full scans far less
  // often, so this is a conservative/pessimistic estimate there, never an
  // under-count). Warns via the normal Debug Log (no Firebase Console
  // literacy needed) if projected usage crosses 80% of the free Spark
  // plan's daily limits (50k reads / 20k writes) — see known-risks.md #13.
  // 312 = 288 (external dispatch every 5min, the primary trigger — see
  // docs/claude/external-cron-setup.md) + 24 (GitHub's own schedule:, kept
  // as an hourly fallback in scan.yml so it never doubles the 5-min cadence
  // — doubling it would silently push real usage past this estimate).
  const { reads, writes } = backend.quota.getAndResetOpCounts();
  const PASSES_PER_DAY = 312;
  const projectedReads = reads * PASSES_PER_DAY;
  const projectedWrites = writes * PASSES_PER_DAY;
  const READ_LIMIT = 50000;
  const WRITE_LIMIT = 20000;
  if (projectedReads > READ_LIMIT * 0.8 || projectedWrites > WRITE_LIMIT * 0.8) {
    logWarn('scanner', 'Uso do Firestore projetado perto do limite diário gratuito', {
      reads_this_pass: reads,
      writes_this_pass: writes,
      projected_daily_reads: projectedReads,
      projected_daily_writes: projectedWrites,
      read_limit: READ_LIMIT,
      write_limit: WRITE_LIMIT,
    });
  }

  return { total: assets.length, results: allResults };
}