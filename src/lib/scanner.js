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
import { calculateATR, calculateATRSeries } from './indicators/atr';
import { calculateAtrPctSmooth, classifyTier } from './indicators/tier';
import { calculateADX } from './indicators/adx';
import { calculateChoppiness } from './indicators/choppiness';
import { calculateStructure, calculateLiquiditySweep, calculatePdZone, buildOteLeg, classifyZone } from './indicators/smcStructure';
import { calculateSmcSignalStrength, SMC_SCORE_DEFAULTS } from './indicators/smcConfluence';
import { detectRetest } from './indicators/retest';
import { detectDisplacement } from './indicators/displacement';
import { detectFvg } from './indicators/fvg';
import { detectOrderBlock } from './indicators/orderBlock';
import { detectEngulfing, detectPinBar, detectMarubozu } from './indicators/candlePatterns';
import { planSignalArbitration, ARBITRATION_VERSION } from './signalArbitration';
import { getPineConfig } from './pineParser';
import { isCandleUsableForExits, getEntryReferenceTime, advanceTrailingStop, advancePreTp1StopProtection, advancePreTp1Trailing, favorableExtremeFromMfe, advanceToBreakevenOnSiblingOpen, nextRfReverseCount, computeStructuralStop, resolveCandleExit, passesRiskReward, closesFullyAtTp1 } from './opExitRules';
import { groupActiveOpsByAsset, isTerminalStatus } from './opTransition';
import { hasAssetStateChanged } from './assetStateDiff';
import { logInfo, logWarn, logError } from './logger';
import { backend } from '@/api/entities';
import {
  isTelegramConfigured,
  notifyNewSignal,
  notifyVerificationTask,
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

// Fator entre a janela da QUERY dos loops de retry e a janela de EXPIRAÇÃO
// do sinal. Precisa ser > 1, e o motivo é uma armadilha real (known-risks
// item 133, achado do review Codex no PR #259):
//
// As duas queries de retry (RF 4h→15m e SMC 1h→5m) alimentam TAMBÉM o ramo
// que registra a expiração do sinal (`expired_logged` + `SystemLog`, item
// 47.2, que existe justamente para a expiração não ser muda). Um filtro
// exatamente na janela de expiração faria o sinal desaparecer da query no
// mesmo instante em que expira — o log nunca seria escrito.
//
// Com fator 2 o sinal expira na metade da janela e continua visível pela
// outra metade; como o scan roda a cada ~5min e `expired_logged` é
// idempotente, na operação normal ele é sempre capturado. Modo de falha
// residual e limitado: se o scan ficar fora do ar por mais que a janela de
// expiração inteira (estouro de cota do item 106, instabilidade do GitHub
// Actions), o sinal atravessa sem log — custa uma linha de log, nunca uma
// operação. Aumentar o fator amplia essa folga e o custo de leitura junto.
const RETRY_QUERY_WINDOW_FACTOR = 2;
// Fase 1 (docs/known-risks.md item 56 "Fase 1") — RF 1h condicionado ao 4h.
// pineConfig.rf1hCondEnabled (backtest-only, ver scripts/backtestPineConfig.js)
// deixa um sinal RF 1h virar candidato de entrada quando o RF 4h JÁ estiver
// na mesma direção — reusa o gate de regime já avaliado em tf4hData (nunca
// recalcula regime em dado de 1h) e a MESMA check15mConfirmation da cascata
// nativa. Rótulo distinto: nunca '1h_5m' (cascata SMC, lógica de invalidação
// diferente, scanner.js ~L2720) nem '4h_15m' (cascata RF nativa).
const RF_1H_COND_CASCADE = 'rf1h_cond4h_15m';
// docs/known-risks.md item 68 — RF 1h TOTALMENTE independente do 4h.
// pineConfig.rf1hUncondEnabled (backtest-only, ver scripts/backtestPineConfig.js)
// é a mesma mecânica do RF_1H_COND_CASCADE acima (mesmo regime via tf4hData,
// mesma check15mConfirmation, mesmo ATR/tier pra risk sizing) com a ÚNICA
// diferença: NÃO exige que o RF do 4h concorde com a direção do sinal de 1h
// (o gate `tf4hDir !== sigDir` do _COND simplesmente não existe aqui). Nunca
// ligar rf1hCondEnabled e rf1hUncondEnabled juntos no mesmo run — convenção,
// não validado em runtime (mesmo padrão dos demais flags opt-in do projeto).
const RF_1H_UNCOND_CASCADE = 'rf1h_uncond_15m';
// docs/known-risks.md item 78 — pineConfig.rf1hExclusiveEnabled
// (backtest-only, ver scripts/backtestPineConfig.js). Motivado por dado real:
// um run com rf1hUncondEnabled ligado mediu a cascata 4h_15m e a
// RF_1H_UNCOND_CASCADE competindo pela MESMA vaga por ativo — 67% das
// rejeições do 1h eram "vaga ocupada", e a amostra do 4h nativo caiu pela
// metade (109->59) só por causa da disputa, contaminando os dois números
// (mesma classe de erro de sub-bucket já corrigida nos itens 51/68, agora
// prevenida por desenho em vez de corrigida depois). Quando ligado, a
// cascata NATIVA (4h_15m) simplesmente não cria operação nenhuma — nem na
// 1ª passada nem no retry — dando a vaga inteira pra RF_1H_COND_CASCADE/
// RF_1H_UNCOND_CASCADE (o que estiver ligado) medir sozinha, sem
// competição. Sinais RF de 4h continuam sendo emitidos normalmente (só a
// CRIAÇÃO de operação é suprimida) — o funil/expiração desses sinais segue
// visível no relatório, só nunca vira TradeOperation.

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
// docs/known-risks.md item 102 — mesma janela ampliada do
// SMC_1H_STRUCTURE_CANDLE_LIMIT acima, mesmo motivo (item 34:
// calculateStructure é stateless, swingLen=50 quase silencia BOS/CHoCH com
// só 150 candles de histórico), aplicada ao 4h SÓ quando
// pineConfig.rfStructuralStopEnabled está ligado — sem isso o stop
// estrutural do RF nativo dependeria de um swing quase sempre ausente,
// caindo no fallback ATR quase toda vez e tornando o experimento
// inconclusivo por falta de dado, não por o mecanismo não ajudar.
const RF_4H_STRUCTURAL_STOP_CANDLE_LIMIT = 500;
// Fixed constant, deliberately NOT pineConfig.trailAtrMult — that field is
// reserved for the RF cascade's post-TP1 trailing (see buildTradeOpData's
// comment on the same mix-up). Fase 3 (known-risks item 42) gave the SMC
// cascade a tier/regime system too, but deliberately did NOT wire
// tier.atrStopMult in here — SMC's stop stays structural, tier only feeds
// entry-gating and tier_time_stop_bars (buildSmcTradeOpData). Stays a plain
// constant on purpose, not an oversight.
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

// docs/known-risks.md item 6 (2026-08-03): o cálculo RF principal (scanAsset)
// e a confirmação 15m (check15mConfirmation) resolviam rf_period/rf_multiplier
// por caminhos diferentes — o principal já usava firstPositiveInteger/
// firstPositive (defensivo contra negativo/fracionário/NaN), a confirmação
// usava um `asset.rf_period || 20` simples (só bloqueia falsy — aceita
// -10, 14.5). Um resolvedor único, chamado dos dois lugares com o MESMO
// asset, garante que os dois caminhos nunca divirjam sobre o que é um
// parâmetro válido — mesma disciplina de firstPositive/firstPositiveInteger
// acima, sem introduzir uma fonte de verdade nova (ainda lê só
// asset.rf_period/rf_multiplier, os campos já sincronizados por
// syncPineToAssets — ver .claude/rules/pine-parity.md).
export function resolveRangeFilterParams(asset) {
  return {
    period: firstPositiveInteger(asset?.rf_period, 20),
    multiplier: firstPositive(asset?.rf_multiplier, 3.5),
  };
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
 * Candlestick pattern gate — additional confirmation ON TOP OF the RF
 * signal, opt-in (pineConfig.candlePatternEnabled), RF 4h_15m cascade only.
 * Requires the signal candle (the latest closed 4h candle) to show ANY ONE
 * of three genuinely distinct patterns (checked in this priority order —
 * first match wins, since a candle could technically satisfy more than one):
 * engulfing (2-candle reversal) -> pin bar (wick-rejection reversal) ->
 * marubozu (single-candle momentum). See docs/known-risks.md item 58 for
 * why these three and not an exhaustive port of every named pattern.
 * Returns null when the flag is off — same convention as retestGate, so
 * callers skip pushing an outcome (candlePatternOutcomes) for the common
 * passthrough case. When none match, `reason` reports engulfing's specific
 * rejection (the most information-dense of the three); `allReasons` carries
 * all three for SystemLog debugging, never persisted to TradeOperation.
 */
function evaluateCandlePatternGate(tf4hData, direction, pineConfig) {
  if (pineConfig.candlePatternEnabled !== true) return null;
  const candles = tf4hData?.last2Candles;
  if (!candles || candles.length < 2) return { ok: false, pattern: null, reason: 'insufficient_data' };
  const [previous, current] = candles;

  const engulfing = detectEngulfing(current, previous, direction);
  if (engulfing.isEngulfing) return { ok: true, pattern: engulfing.pattern, reason: null };
  const pinBar = detectPinBar(current, direction);
  if (pinBar.isPinBar) return { ok: true, pattern: pinBar.pattern, reason: null };
  const marubozu = detectMarubozu(current, direction);
  if (marubozu.isMarubozu) return { ok: true, pattern: marubozu.pattern, reason: null };

  return {
    ok: false,
    pattern: null,
    reason: engulfing.reason,
    allReasons: { engulfing: engulfing.reason, pinBar: pinBar.reason, marubozu: marubozu.reason },
  };
}

/**
 * Build TradeOperation data from a 4h signal using Pine config parameters.
 * Centralizes entry/stop/TP calculations so Pine Script changes propagate
 * automatically — no manual bot configuration needed.
 *
 * cascadeInfo (opcional, default null): usado SÓ pela cascata experimental
 * RF 1h condicionado ao 4h (Fase 1, docs/known-risks.md item 56 "Fase 1",
 * backtest-only via pineConfig.rf1hCondEnabled). Quando ausente (todos os
 * call sites de produção hoje), o comportamento é byte-idêntico ao anterior
 * — signal_timeframe/cascade/origin_cascade seguem '4h'/'4h_15m'/'4h_15m'.
 */
export function buildTradeOpData(sig, tf4hData, pineConfig, confirmation15m, cascadeInfo = null) {
  const cascade = cascadeInfo?.cascade ?? '4h_15m';
  const signalTimeframe = cascadeInfo?.signalTimeframe ?? '4h';
  // Stop multiplier is tier-based (volatility-adjusted), not the global
  // trailAtrMult — that field is reserved for the runner's ATR trailing
  // after TP1 (see the post-TP1 update loop), a different parameter with
  // a different purpose that used to be incorrectly reused here.
  const ATR_MULT = tf4hData.tier?.atrStopMult ?? 2.0;
  const tp1R = pineConfig.tp1R ?? 1.5;
  const tp2R = (pineConfig.tp1R ?? 1.5) * 2;
  // runnerEnabled: false congela a gestão como "100% no TP1" NA CRIAÇÃO, em vez
  // de consultar o flag no momento da saída. Assim o flag governa a próxima
  // operação e nunca abandona um runner já vivo, e os dois loops de saída
  // decidem lendo só a op (closesFullyAtTp1). Ver known-risks item 46.
  const partialPct = pineConfig.runnerEnabled === false ? 100 : (pineConfig.tp1QtyPercent ?? 50);
  const isBuy = sig.signal_type === 'BUY';
  // Entry must be the real 15m price at confirmation time, not the 4h
  // signal's price — the 4h signal can be hours old by the time 15m
  // confirms (see the up-to-4h retry window above), so using
  // sig.price_at_signal here would record a stale entry price.
  const entry = confirmation15m?.entryPrice ?? sig.price_at_signal;
  // docs/known-risks.md item 102 — pineConfig.rfStructuralStopEnabled
  // (opt-in, backtest-only, default false). Reusa computeStructuralStop
  // (já testado/em produção na cascata SMC) alimentado pelo swing de 4h
  // que o RF nativo já calcula pra todo sinal (tf4hData.smc.lastSwingLow/
  // lastSwingHigh, scanAsset) — até hoje só consumido como gate
  // informativo, nunca como stop. Cai pro fallback ATR sozinho
  // (computeStructuralStop) quando o nível estrutural está ausente/
  // inválido/do lado errado. `basis` é gravado na operação
  // (initial_stop_basis) pra auditoria — sem isso, "sem diferença" seria
  // ambíguo entre "estrutural não ajuda" e "estrutural quase nunca foi
  // usado de verdade" (ver RF_4H_STRUCTURAL_STOP_CANDLE_LIMIT acima).
  // Correção (2026-08-18, review externa Codex, PR #209, docs/known-risks.md
  // item 104): `maxAtrMult` PRECISA ser o `ATR_MULT` por-tier (o mesmo do
  // ramo desligado abaixo), não o default 2.0 fixo de computeStructuralStop
  // — sem isso, `structural_capped`/`atr_fallback` (a maioria dos casos)
  // não reproduzem o stop antigo pra tier T2/T3 (2.5×/3.0×ATR), viram um
  // aperto sistemático não intencional pro flag. O piso (minAtrMult, sem
  // equivalente por-tier no ramo desligado) continua fixo de propósito.
  let initialStop;
  let stopBasis = 'tier_atr';
  if (pineConfig.rfStructuralStopEnabled) {
    const structuralLevel = isBuy ? tf4hData.smc?.lastSwingLow : tf4hData.smc?.lastSwingHigh;
    const structural = computeStructuralStop({
      isBuy, entry, structuralLevel, atrValue: tf4hData.atrValue, maxAtrMult: ATR_MULT,
    });
    initialStop = structural.stop;
    stopBasis = structural.basis;
  } else {
    const risk = tf4hData.atrValue * ATR_MULT;
    initialStop = isBuy ? entry - risk : entry + risk;
  }
  const riskR = Math.abs(entry - initialStop);
  const tp1 = isBuy ? entry + riskR * tp1R : entry - riskR * tp1R;
  const tp2 = isBuy ? entry + riskR * tp2R : entry - riskR * tp2R;

  const entryScore = sig.context?.score || 0;

  // Recomputed here (cheap, pure candle comparison, no I/O) rather than
  // threading the gate's result through every caller just for this one
  // audit field — returns null when the gate is off, matching the other
  // opt-in audit fields below (pre_tp1_stop_*).
  const candlePattern = evaluateCandlePatternGate(tf4hData, sig.signal_type, pineConfig);

  return {
    symbol: sig.symbol,
    asset_id: sig.asset_id,
    timeframe: '15m',
    signal_timeframe: signalTimeframe,
    cascade,
    origin_cascade: cascade,
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
    // 'tier_atr' (default) | 'structural' | 'structural_floored' |
    // 'structural_capped' | 'atr_fallback' (rfStructuralStopEnabled ligado,
    // mas sem swing válido) — ver comentário acima. docs/known-risks.md
    // item 102.
    initial_stop_basis: stopBasis,
    tp1,
    tp2,
    tp1_hit: false,
    tp2_hit: false,
    // docs/known-risks.md item 114 — congelado na CRIAÇÃO, mesmo contrato de
    // runnerEnabled/preTp1StopProtectionEnabled. `tp2` continua gravado
    // (auditoria/exibição) mesmo com o flag ligado; só os loops de saída
    // param de checar contra ele.
    tp2_cap_disabled: !!pineConfig.disableTp2CapEnabled,
    partial_percent: partialPct,
    runner_percent: 100 - partialPct,
    exit_mode: 'HYBRID_RF_ATR',
    candle_open_time: tf4hData.lastCandleOpenTime,
    candle_close_time: tf4hData.lastCandleTime,
    // skip15mConfirmationEnabled (known-risks.md item 67): the confirmation
    // is synthetic (bypassed15m), not a real 15m confirming candle — record
    // it under its own field so getEntryReferenceTime's callers (P0-g guard,
    // Time Stop) and any future reader can tell "confirmed by a dedicated
    // 15m candle" apart from "confirmed by skipping that step entirely".
    // `null`, never `undefined`, for the "not applicable" branch — Firestore
    // rejects any field with a literal `undefined` value on write (client
    // AND admin SDK, neither has ignoreUndefinedProperties set), so an
    // `undefined` here crashed EVERY normal (non-bypassed) op creation in
    // production — docs/known-risks.md item 136.
    entry_candle_time_15m: confirmation15m?.bypassed15m ? null : (confirmation15m?.entryCandleTime ?? null),
    entry_candle_time_4h: confirmation15m?.bypassed15m ? (confirmation15m?.entryCandleTime ?? null) : null,
    skip_15m_confirmation: confirmation15m?.bypassed15m === true,
    origin_4h_price: sig.price_at_signal ?? null,
    tier: tf4hData.tier?.tier ?? null,
    adx_at_entry: tf4hData.adx?.adx ?? null,
    chop_at_entry: tf4hData.chop,
    // tf4hData.tier.timeStopBars is always calibrated in 4h bars (tier.js).
    // The native path stamps signal_timeframe:'4h', so the exit loop's
    // SIGNAL_TF_MS[op.signal_timeframe] lookup (scanner.js ~2663) already
    // reads it as 4h bars — no conversion needed there. The 1h-conditional
    // cascade (Fase 1) stamps signal_timeframe:'1h' instead, which would
    // make that SAME lookup treat this 4h-calibrated count as 1h bars —
    // firing the Time Stop 4x too early (48/64/96h instead of the intended
    // 192/256/384h). Convert by 4 here, same precedent as the existing
    // SMC->4h promotion (scanner.js ~2192-2194: tf4h.tier.timeStopBars * 4).
    // docs/known-risks.md item 109 — pineConfig.timeStopBarsOverride
    // (backtest-only, `null` = tier decide, byte-idêntico ao de sempre)
    // substitui o valor do tier ANTES da conversão *4 acima, para que o
    // prazo em RELÓGIO continue consistente entre as cascatas exatamente
    // como o tier já garantia. Congelado aqui na criação de propósito —
    // mesmo contrato de runnerEnabled/preTp1StopProtectionEnabled.
    tier_time_stop_bars: (() => {
      const base = pineConfig?.timeStopBarsOverride ?? tf4hData.tier?.timeStopBars;
      return signalTimeframe === '1h' && base != null ? base * 4 : base;
    })(),
    // Padrão de vela que confirmou a entrada (opt-in, pineConfig.
    // candlePatternEnabled) — null quando o gate está desligado.
    entry_candle_pattern: candlePattern?.pattern ?? null,
    // Observability only — o alinhamento macro que o sinal já calculou
    // (analyzeAlignment) nunca era copiado pra cá; TradeCard.jsx sempre lia
    // null numa operação ativa apesar de exibir esses campos. Ver
    // docs/known-risks.md item 47.2.
    tf_1d_direction: sig.context?.tf_1d_direction ?? null,
    tf_4h_direction: sig.context?.tf_4h_direction ?? null,
    tf_1h_direction: sig.context?.tf_1h_direction ?? null,
    source: 'scanner',
    candle_status: 'CLOSED',
    data_status: 'LIVE',
    signal_reasons: sig.context?.reasons || [],
    rf_filter_value: sig.context?.rf_value ?? null,
    invalidates_if: isBuy
      ? 'Candle fechar abaixo do Range Filter'
      : 'Candle fechar acima do Range Filter',
    market_source: MARKET_SOURCE,
    data_exchange: DATA_EXCHANGE,
    executor: EXECUTOR,
    // Proteção de stop pré-TP1 (opt-in, known-risks.md item 53/54) — frozen
    // at creation like partial_percent/runnerEnabled above: whether the
    // mechanism CAN apply to this op is decided once, so a later pineConfig
    // flip governs only the NEXT operation. pre_tp1_stop_advanced_at stays
    // absent until (if ever) the gate actually fires — stamped by
    // persistScanResults, not here.
    pre_tp1_stop_protection_enabled: pineConfig.preTp1StopProtectionEnabled === true,
    pre_tp1_stop_advance_trigger_atr_mult: pineConfig.preTp1StopProtectionAtrMult ?? 1.0,
    // docs/known-risks.md item 132 — QUAL mecanismo pré-TP1 governa esta
    // operação, congelado aqui pelo mesmo motivo dos campos acima. Ausente/
    // 'breakeven' = comportamento de sempre; 'trailing' = trail contínuo
    // ancorado no extremo favorável. Os dois multiplicadores só têm
    // significado no modo 'trailing'.
    pre_tp1_stop_mode: pineConfig.preTp1TrailEnabled === true ? 'trailing' : 'breakeven',
    pre_tp1_trail_start_atr_mult: pineConfig.preTp1TrailStartAtrMult ?? 1.0,
    pre_tp1_trail_atr_mult: pineConfig.preTp1TrailAtrMult ?? 2.5,
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
  // docs/known-risks.md item 6 (2026-08-03): mesmo resolvedor do cálculo RF
  // principal (scanAsset) — antes esta função usava `asset.rf_period || 20`,
  // que aceita valores que firstPositiveInteger/firstPositive rejeitariam
  // (ex. -10, 14.5). calculateRangeFilter também exige
  // `candles.length >= period + 10` (rangeFilter.js) e lança exceção se não
  // tiver — o limite de busca fixo de 100 e o piso de 40 abaixo eram cegos
  // ao período real, então qualquer rf_period acima de ~90 fazia a
  // confirmação falhar sempre, silenciosamente (exceção capturada no catch),
  // indistinguível de "ainda não confirmou".
  const rfParams = resolveRangeFilterParams(asset);
  try {
    const candleLimit = Math.max(100, rfParams.period + 10);
    const candles15m = await fetchCandles(symbol, TF_15M, candleLimit);
    const closed = candles15m.filter(c => c.isClosed);
    if (closed.length < rfParams.period + 10) {
      // Not enough data — do NOT allow trade without confirmation
      return { confirmed: false, entryPrice: null, entryCandleTime: null };
    }

    const rf = calculateRangeFilter(
      closed,
      rfParams.period,
      rfParams.multiplier
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
 * pineConfig.skip15mConfirmationEnabled (docs/known-risks.md item 67) —
 * bypasses check15mConfirmation entirely, replicating the user's real Pine
 * strategy: strategy.entry runs inside `if finalBuy`, which is only true
 * once candleConfirmed (the SIGNAL candle itself closed) — there is no
 * smaller-timeframe confirmation anywhere in the real Pine. Off by default
 * (today's behaviour, unchanged; zero extra fetch either way).
 *
 * When bypassed, the synthetic confirmation is built entirely from the
 * caller-supplied entryPrice/entryCandleTime — this function never fetches
 * anything itself, so the caller decides the source:
 * - 1st-pass call sites use sig.price_at_signal/sig.candle_time — entry
 *   happens in the SAME pass the signal was born, so the signal candle IS
 *   the current candle, no staleness.
 * - Retry call sites use the CURRENT pass's tfData4h.lastClose/lastCandleTime
 *   instead (Codex review, PR #147, P1) — a retry can fire hours after the
 *   signal was born (that's the whole reason the retry loop exists: a gate
 *   blocked entry earlier and conditions may since have changed), so reusing
 *   the original signal price would open a position at a price that's no
 *   longer executable, mixing an hours-old entry with the current pass's
 *   ATR/stop/tp math. Each retry call site already re-validates tfData4h is
 *   still same-direction as the signal (trend_reversed guard) before calling
 *   this, so it's a safe, causal substitute.
 */
function resolveEntryConfirmation15m({ symbol, direction, asset, pineConfig, entryPrice, entryCandleTime }) {
  if (pineConfig.skip15mConfirmationEnabled === true) {
    return Promise.resolve({ confirmed: true, entryPrice, entryCandleTime, bypassed15m: true });
  }
  return check15mConfirmation(symbol, direction, asset);
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
 * rejectReason }. `rejectReason` is null when confirmed, or one of three
 * distinct causes previously collapsed into a single `'no_trigger'` (known-
 * risks item 45.3/49 — indistinguishable causes made "gatilho nunca dispara"
 * and "sem dado" impossible to tell apart in the funnel): `'no_trigger'`
 * (neither sweep nor structure fired, real data available), `'insufficient_data'`
 * (fewer than 60 closed 5m candles), `'fetch_error'` (candle fetch threw).
 * `'ote_zone_unfavorable'` when a trigger fired but the zone check rejected it.
 */
async function check5mSmcConfirmation(symbol, direction, legBounds) {
  const noTriggerBase = { confirmed: false, entryPrice: null, entryCandleTime: null, trigger: null, oteZone: null, sweepAligned: null, structureAligned: null };
  try {
    const candles5m = await fetchCandles(symbol, TF_5M, 150);
    const closed = candles5m.filter(c => c.isClosed);
    if (closed.length < 60) {
      return { ...noTriggerBase, rejectReason: 'insufficient_data' };
    }

    const sweep = calculateLiquiditySweep(closed, 20);
    const structure = calculateStructure(closed, { swingLen: 10 });

    const sweepAligned = direction === 'BUY' ? sweep.bullishSweep : sweep.bearishSweep;
    const structureAligned = direction === 'BUY'
      ? (structure.lastBull.bos || structure.lastBull.choch)
      : (structure.lastBear.bos || structure.lastBear.choch);

    if (!sweepAligned && !structureAligned) {
      // Round 3 (docs/known-risks.md item 50): sweep/structure already
      // compute BOTH sides (bullish/bearish) — only the requested direction
      // was ever read above. entryFunnel's 70.3% 'no_trigger' rate was
      // indistinguishable between "genuinely no event happened" and "an
      // event fired, just on the OPPOSITE side" until now. Zero extra fetch.
      const sweepOpposite = direction === 'BUY' ? sweep.bearishSweep : sweep.bullishSweep;
      const structureOpposite = direction === 'BUY'
        ? (structure.lastBear.bos || structure.lastBear.choch)
        : (structure.lastBull.bos || structure.lastBull.choch);
      const reason = (sweepOpposite || structureOpposite) ? 'wrong_direction_trigger' : 'no_trigger';
      // docs/known-risks.md item 52 (atualização 2026-08-02): expõe os 2
      // booleanos brutos já computados acima, não só o rótulo de
      // precedência — aqui os dois valem false para a direção pedida (é
      // por isso que caiu neste branch), mas o registro fica consistente
      // com os outros retornos que também os expõem.
      return { ...noTriggerBase, rejectReason: reason, sweepAligned, structureAligned };
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
      return { confirmed: false, entryPrice: null, entryCandleTime: null, trigger: null, oteZone, rejectReason: 'ote_zone_unfavorable', sweepAligned, structureAligned };
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
      // docs/known-risks.md item 52 (atualização 2026-08-02): booleanos
      // brutos, além do rótulo de precedência acima — responde se
      // structureAligned também era true quando sweep levou o rótulo
      // (sombreamento) ou se confirmou sozinho (independência real).
      sweepAligned,
      structureAligned,
      // Fase 2 rodada 2 (docs/known-risks.md item 41): the closed 5m series
      // already fetched above, exposed so the opt-in displacement gate
      // (evaluateDisplacementGate) can evaluate the SAME trigger candle
      // without a redundant fetchCandles call — additive only, no existing
      // decision above is affected by this field's presence.
      closedCandles: closed,
    };
  } catch (err) {
    console.warn(`[5m SMC confirm] ${symbol} fetch failed:`, err.message);
    return { ...noTriggerBase, rejectReason: 'fetch_error' };
  }
}

// ─── Fase 2 rodada 1: retest confirmation gate (opt-in, off by default) ───
// docs/known-risks.md item 40. Called from the 4 entry points below (RF 1st
// pass + retry, SMC 1st pass + retry) ONLY when pineConfig.retestEnabled is
// true — the caller is responsible for that check, so the flag stays a true
// passthrough (zero extra fetchCandles) at every call site when off. Own
// fetch, independent of check15mConfirmation/check5mSmcConfirmation (same
// pattern those two already use) — the gate must resolve BEFORE those run,
// and skips them entirely on this pass when it hasn't confirmed yet, so a
// pending signal never pays for two fetches on a tick that's going to bail
// anyway. tolerancePrice is measured in ATR of the CONFIRMATION timeframe
// (15m/5m), not the signal timeframe (4h/1h) — using the coarser TF's ATR
// here would produce a disproportionately wide band relative to the candles
// detectRetest actually scans.
async function evaluateRetestGate({ symbol, direction, level, signalCandleTime, timeframe, pineConfig }) {
  const touchMode = pineConfig.retestTouchMode ?? 'close';
  const notRetested = {
    retested: false, retestPrice: null, retestCandleTime: null, barsToConfirm: null,
    reason: 'invalid_params', anchorLevel: level, touchMode,
  };
  if (level == null) return notRetested;
  try {
    const tfConst = timeframe === '15m' ? TF_15M : TF_5M;
    const candles = await fetchCandles(symbol, tfConst, 100);
    const closed = candles.filter(c => c.isClosed);
    if (closed.length < 15) return { ...notRetested, reason: 'insufficient_data' };
    const atrValue = calculateATR(closed, pineConfig.atrLen ?? 14);
    if (!atrValue) return { ...notRetested, reason: 'insufficient_data' };
    const tolerancePrice = (pineConfig.retestToleranceAtrMult ?? 0.3) * atrValue;
    const result = detectRetest(closed, { direction, level, signalCandleTime, tolerancePrice, touchMode });
    return { ...result, anchorLevel: level, touchMode };
  } catch (err) {
    console.warn(`[retest gate] ${symbol} fetch failed:`, err.message);
    return { ...notRetested, reason: 'fetch_error' };
  }
}

// Stamps the 6 audit fields onto an already-built opData object (never
// consumed by stop/TP math — see docs/schema-reference/TradeOperation.jsonc)
// right before createTradeOpIfNoneActive. Only called on the path where the
// retest gate actually participated in this entry.
function stampRetestFields(opData, gate) {
  opData.retest_gate_enabled = true;
  opData.retest_anchor_level = gate.anchorLevel ?? null;
  opData.retest_price = gate.retestPrice ?? null;
  opData.retest_candle_time = gate.retestCandleTime ?? null;
  opData.retest_bars_to_confirm = gate.barsToConfirm ?? null;
  opData.retest_touch_mode = gate.touchMode ?? null;
}

// ─── Fase 2 rodada 2: displacement candle gate (opt-in, off by default,
// SMC 1h→5m only) — docs/known-risks.md item 41. Unlike the retest gate,
// this evaluates a SINGLE known candle (the entry trigger check5mSmcConfirmation
// already found), not a window search — so it runs AFTER confirmation
// succeeds, reusing the closedCandles that call already fetched (see the
// additive field added to its return value above) instead of a redundant
// fetchCandles. Caller passes confirmation.closedCandles/confirmation.entryCandleTime
// straight through; the ATR/volume-MA baseline is computed here with the
// same pineConfig.atrLen/volLen defaults the rest of the scanner already
// uses (no new period knobs invented for this round).
function evaluateDisplacementGate({ closedCandles, entryCandleTime, direction, pineConfig }) {
  const bodyAtrMult = pineConfig.displacementBodyAtrMult ?? 1.5;
  const minVolumeRatio = pineConfig.displacementMinVolumeRatio ?? null;
  const triggerIndex = closedCandles?.findIndex(c => c.closeTime === new Date(entryCandleTime).getTime()) ?? -1;
  if (triggerIndex === -1) {
    return {
      isDisplacement: false, bodyRatio: null, volumeRatio: null, reason: 'trigger_candle_not_found', bodyAtrMult, minVolumeRatio,
    };
  }
  const triggerCandle = closedCandles[triggerIndex];
  // ATR and volume MA are baselines the trigger candle is measured AGAINST —
  // computing them from a series that ends WITH the trigger candle lets a
  // large candle inflate its own yardstick (self-normalization), silently
  // pulling its bodyRatio/volumeRatio down. Slice the history to everything
  // strictly BEFORE the trigger candle, same principle as isCandleUsableForExits
  // (.claude/rules/trading-engine.md, P0-g) — never let the candle being
  // judged contaminate its own baseline.
  const history = closedCandles.slice(0, triggerIndex);
  // Clamp to what history actually holds: check5mSmcConfirmation fetches a
  // fixed ~150-candle window sized for its OWN sweep/structure needs, not
  // for an arbitrary configured ATR period. calculateATR needs period+1
  // candles and silently returns 0 otherwise, which detectDisplacement then
  // reads as invalid_params — rejecting every entry regardless of body size
  // whenever pineConfig.atrLen exceeds what's available (plausible: the
  // project's own Pine reference uses ATR(200) for Order Block confirmation
  // elsewhere). Codex review, PR #82.
  const atrPeriod = Math.min(pineConfig.atrLen ?? 14, Math.max(history.length - 1, 0));
  const atrValue = atrPeriod ? calculateATR(history, atrPeriod) : null;
  let volumeMa = null;
  if (minVolumeRatio != null) {
    const volPeriod = pineConfig.volLen ?? 20;
    const volumes = history.map(c => c.volume || 0).slice(-volPeriod);
    volumeMa = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : null;
  }
  const result = detectDisplacement(triggerCandle, { direction, atrValue, bodyAtrMult, minVolumeRatio, volumeMa });
  return { ...result, bodyAtrMult, minVolumeRatio };
}

function stampDisplacementFields(opData, gate) {
  opData.displacement_gate_enabled = true;
  opData.displacement_body_ratio = gate.bodyRatio;
  opData.displacement_volume_ratio = gate.volumeRatio;
  opData.displacement_min_body_atr_mult = gate.bodyAtrMult;
  opData.displacement_min_volume_ratio = gate.minVolumeRatio;
}

// known-risks item 45.3/49 — "muitos sinais, poucas operações": nenhum gate
// do funil de confirmação registrava, de forma agregável, QUAL motivo
// bloqueou uma tentativa. Usado só nos loops de RETRY (o 1º pass já loga
// verboso pro SystemLog a cada sinal novo, uma vez por sinal — não precisa
// do campo persistido). Write-on-change: um sinal preso no MESMO gate por
// muitas passadas de retry custa zero escrita extra; só uma mudança de
// motivo grava. `entryFunnelOutcomes` é sempre empurrado (em memória, sem
// custo) — é o que alimenta a seção `entryFunnel` do relatório de backtest.
async function recordRejection(sig, cascade, reason, entryFunnelOutcomes) {
  entryFunnelOutcomes.push({ dedup_key: sig.dedup_key, cascade, reason });
  if (sig.last_rejection_reason !== reason) {
    await backend.entities.SignalEvent.update(sig.id, { last_rejection_reason: reason });
    sig.last_rejection_reason = reason;
  }
}

// docs/known-risks.md item 77 — observational-only counterpart to the
// existing GATE `asset.smc_confirm_4h15m` (scanner.js, both call sites just
// below): that gate gets it right in spirit (SMC structure should inform the
// RF native cascade) but wrong in mechanics for two reasons — (1) it BLOCKS
// the entry outright instead of just scoring it, and (2) it classifies the
// zone against the SAME generic 20-candle window `calculateStructure` reads,
// which item 35/38 already proved is tautological for a candle that just
// broke structure (close lands near the window's own edge almost by
// construction). This function fixes (2) by classifying against SMC's own
// most recent swing range (`smc.lastSwingHigh`/`lastSwingLow` — the
// confirmed protected pivots `calculateStructure` already tracks, textbook
// ICT/SMC Premium/Discount definition) instead of the generic window — but
// deliberately does NOT fix (1): it never blocks anything, only stamps a
// classification for later analysis, per the user's explicit request to
// validate before deciding whether SMC helps or is "just more filter in the
// way". Never called when the flag is off; caller owns that gate.
//
// `legHigh`/`legLow` come from `SignalEvent.context.smc_align_leg_high/low`
// — built ONCE at the instant the 4h signal was born, never rebuilt here
// from whatever the CURRENT scan pass's live smc happens to be. Codex
// review (PR #173, post-merge): a retry can land after a NEWER 4h candle
// has closed without RF reversing, so the live smc can silently describe a
// different candle than the one that fired the signal — rebuilding the leg
// from it would contaminate the aligned/against groups despite this
// function's contract.
//
// The leg is deliberately NOT anchored to the RF signal candle's own close
// (unlike `buildOteLeg`'s other caller, the SMC 1h->5m cascade, where the
// break candle IS the SMC event). First live A/B (docs/known-risks.md item
// 77, "Achado do primeiro A/B real") measured 0 'aligned' in 104 real
// operations: a confirmed 15m entry almost always continues past the RF
// signal candle's own close (that's what "confirmed" means), so anchoring
// the leg to that close made the zone come out "premium"/"discount"
// (against) in ~91-94% of trades by construction, regardless of real SMC
// structure. Using SMC's own swing range fixes that — `entryPrice` (the
// REAL 15m confirmation price) is classified against a leg that has no
// structural relationship to the RF cascade's own timing at all.
// `smc.trend` is read LIVE at the call site on purpose — only the leg's
// identity was ever promised to be frozen; trend re-evaluation every retry
// matches the sibling gate `asset.smc_confirm_4h15m` (item 45.5)'s existing
// behavior.
function computeSmcAlignmentAtEntry(signalType, smc, legHigh, legLow, entryPrice) {
  if (!smc) return 'unavailable';
  const trendAligned = signalType === 'BUY' ? smc.trend === 1 : smc.trend === -1;
  if (legHigh == null || legLow == null) return 'unavailable';
  const { zone } = classifyZone(entryPrice, legHigh, legLow);
  if (zone == null) return 'unavailable';
  const zoneOk = signalType === 'BUY' ? zone !== 'premium' : zone !== 'discount';
  return trendAligned && zoneOk ? 'aligned' : 'against';
}

// docs/known-risks.md item 37 (Bloco 4 Fase 1) — called right after a
// hierarchical leg (4h_15m or 1h_5m) successfully opens, when the SIBLING
// cascade already holds its own active leg on the same asset: moves the
// sibling's stop to breakeven (never past it — advanceToBreakevenOnSiblingOpen
// + the transactional clampMonotonicStop inside transitionTradeOp both
// guard against regressing an already-better stop), so opening a 2nd leg
// never raises the worst-case COMBINED loss beyond what the 1st leg alone
// already risked (community pyramiding precedent — see item 37). A 2nd,
// SEQUENTIAL transitionTradeOp call, not a multi-doc transaction with the
// creation above — deliberately: this project's rule against a 3rd op-
// mutation path (`.claude/rules/trading-engine.md`) is about not inventing
// a NEW way to write `status`/`current_stop`; this reuses the exact same
// transitionTradeOp everything else already goes through, just called
// twice. If it fails to apply (a concurrent worker already moved the
// sibling's status), that's logged and non-blocking — the leg that just
// opened is unaffected either way.
async function coupleSiblingRiskOnOpen(siblingOp, siblingCascade) {
  if (!siblingOp || isTerminalStatus(siblingOp.status)) return siblingOp;
  const candidateStop = advanceToBreakevenOnSiblingOpen({
    isBuy: siblingOp.side === 'BUY',
    currentStop: siblingOp.current_stop,
    entry: siblingOp.entry_price,
  });
  if (candidateStop === siblingOp.current_stop) return siblingOp;
  const result = await backend.tradeOps.transitionTradeOp(
    siblingOp.id, siblingOp.status, { current_stop: candidateStop },
    { assetId: siblingOp.asset_id, cascade: siblingCascade },
  );
  if (!result.applied) {
    await backend.entities.SystemLog.create({
      level: 'warn',
      module: 'scanner',
      message: `${siblingOp.symbol}: não foi possível avançar o stop da perna ${siblingCascade} para breakeven ao abrir a cascata irmã — transição descartada pelo CAS (concorrência).`,
      symbol: siblingOp.symbol,
      details: { reason: 'sibling_breakeven_cas_rejected', op_id: siblingOp.id, cascade: siblingCascade, attempted_stop: candidateStop },
    });
    return siblingOp;
  }
  return { ...siblingOp, current_stop: candidateStop };
}

/**
 * Build TradeOperation data for the SMC 1h→5m cascade — same TP model as
 * buildTradeOpData (reusing the same Pine tp1R/tp1QtyPercent params), but
 * the initial stop is STRUCTURAL: beyond the 5m trigger's invalidation
 * level (sweep wick / protective swing) with an ATR(1h) buffer, floored at
 * SMC_STOP_MIN_ATR and capped at SMC_INITIAL_STOP_ATR_MULT — the old fixed
 * 2×ATR stop remains as cap and as fallback for a missing/invalid level
 * (see computeStructuralStop and known-risks item 11/24). Tier/regime
 * (Fase 3, pineConfig.smcTierEnabled, off by default — known-risks item 42)
 * feeds ONLY entry-gating and tier_time_stop_bars here — deliberately NOT
 * this stop calculation, which stays structural regardless of tier.
 */
export function buildSmcTradeOpData(sig, tf1hData, pineConfig, confirmation5m) {
  const tp1R = pineConfig.tp1R ?? 1.5;
  const tp2R = (pineConfig.tp1R ?? 1.5) * 2;
  // runnerEnabled: false congela a gestão como "100% no TP1" NA CRIAÇÃO, em vez
  // de consultar o flag no momento da saída. Assim o flag governa a próxima
  // operação e nunca abandona um runner já vivo, e os dois loops de saída
  // decidem lendo só a op (closesFullyAtTp1). Ver known-risks item 46.
  const partialPct = pineConfig.runnerEnabled === false ? 100 : (pineConfig.tp1QtyPercent ?? 50);
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
    // docs/known-risks.md item 114 — mesmo contrato da cascata RF acima.
    tp2_cap_disabled: !!pineConfig.disableTp2CapEnabled,
    partial_percent: partialPct,
    runner_percent: 100 - partialPct,
    exit_mode: 'HYBRID_RF_ATR',
    candle_open_time: tf1hData.lastCandleOpenTime,
    candle_close_time: tf1hData.lastCandleTime,
    entry_candle_time_5m: confirmation5m?.entryCandleTime ?? null,
    origin_1h_price: sig.price_at_signal ?? null,
    // Fase 3 (docs/known-risks.md item 42): tier/adx_at_entry/chop_at_entry
    // are the SAME fields buildTradeOpData (RF) already stamps — not new
    // fields, just also populated here when pineConfig.smcTierEnabled
    // populated tf1hData.tier in scanAsset. `?? null` preserves today's
    // exact behavior when the flag is off or tier is unavailable — a bare
    // `tf1hData.tier?.tier` left this `undefined` whenever smcTierEnabled
    // was off (the default), crashing the Firestore write on every SMC op
    // creation. docs/known-risks.md item 136.
    tier: tf1hData.tier?.tier ?? null,
    adx_at_entry: tf1hData.adx?.adx ?? null,
    chop_at_entry: tf1hData.chop,
    // Mesmo override do item 109 aplicado na cascata SMC — aqui o valor já
    // está em velas de 1h (o timeframe de sinal desta cascata), sem a
    // conversão *4 que a RF precisa.
    tier_time_stop_bars: pineConfig?.timeStopBarsOverride ?? tf1hData.tier?.timeStopBars ?? 96,
    // Observability only — mesmo campo/motivo do buildTradeOpData (RF) acima;
    // o sinal SMC agora também grava tf_1d/4h/1h_direction no context (ver o
    // push do SignalEvent smc_structure em scanAsset). Ver known-risks 47.2.
    tf_1d_direction: sig.context?.tf_1d_direction ?? null,
    tf_4h_direction: sig.context?.tf_4h_direction ?? null,
    tf_1h_direction: sig.context?.tf_1h_direction ?? null,
    bias: sig.signal_type === 'BUY' ? 'bullish' : 'bearish',
    structure_type: sig.context?.structure_type ?? null,
    pd_zone: sig.context?.pd_zone ?? null,
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
    // Proteção de stop pré-TP1 (opt-in, known-risks.md item 53/54) — mesmo
    // motivo do buildTradeOpData (RF) acima.
    pre_tp1_stop_protection_enabled: pineConfig.preTp1StopProtectionEnabled === true,
    pre_tp1_stop_advance_trigger_atr_mult: pineConfig.preTp1StopProtectionAtrMult ?? 1.0,
    // docs/known-risks.md item 132 — QUAL mecanismo pré-TP1 governa esta
    // operação, congelado aqui pelo mesmo motivo dos campos acima. Ausente/
    // 'breakeven' = comportamento de sempre; 'trailing' = trail contínuo
    // ancorado no extremo favorável. Os dois multiplicadores só têm
    // significado no modo 'trailing'.
    pre_tp1_stop_mode: pineConfig.preTp1TrailEnabled === true ? 'trailing' : 'breakeven',
    pre_tp1_trail_start_atr_mult: pineConfig.preTp1TrailStartAtrMult ?? 1.0,
    pre_tp1_trail_atr_mult: pineConfig.preTp1TrailAtrMult ?? 2.5,
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

  const { applied, currentStatus } = await backend.tradeOps.transitionTradeOp(activeOp.id, activeOp.status, patch, {
    assetId: activeOp.asset_id,
    // Item 125 achado 7: este é o branch `invalidate` acima (patch.status =
    // 'INVALIDATED', terminal) — sem `cascade` aqui, uma operação
    // hierárquica invalidada por arbitragem limparia o anchor errado
    // (assetActiveOps/{assetId} em vez de .../{assetId}__{cascade}), mesmo
    // bug que o item 80/B-2 já corrigiu nos outros 2 call sites que fecham
    // operação (scanner.js, mais acima). Hoje inofensivo em produção
    // (hierarchicalCascadesEnabled só existe em backtest), mas deixa a
    // função consistente com as demais que fecham operação.
    cascade: activeOp.hierarchical_cascade === true ? activeOp.cascade : undefined,
  });
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
 * @returns {Promise<Object>} Scan result with states and signals
 */
export async function scanAsset(asset) {
  const startTime = Date.now();
  const results = {};
  const newSignals = [];
  // Todo flip de RF 4h confirmado, ANTES do gate de score (docs/known-risks.md
  // item 69) — captura o estado de CADA indicador separadamente, aprovado ou
  // não pelos filtros de hoje. Aditivo/read-only: nenhum I/O, nenhuma escrita
  // no Firestore a partir daqui, custo desprezível no scan ao vivo (só monta
  // um objeto a mais). Consumido só pelo simulador de operação-fantasma do
  // backtest (src/lib/indicatorAttribution.js) — nenhum caller ao vivo lê
  // este campo hoje.
  const rawSignalSnapshots = [];
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
      const candleLimit = tf === '1h'
        ? SMC_1H_STRUCTURE_CANDLE_LIMIT
        : (tf === '4h' && pineConfig.rfStructuralStopEnabled)
          ? RF_4H_STRUCTURAL_STOP_CANDLE_LIMIT
          : DEFAULT_CANDLE_LIMIT;
      const candles = await fetchCandles(asset.symbol, tf, candleLimit);
      
      // Only use closed candles for signal calculation
      const closedCandles = candles.filter(c => c.isClosed);
      
      if (closedCandles.length < 50) {
        errors.push({ timeframe: tf, error: `Apenas ${closedCandles.length} candles fechados disponíveis` });
        continue;
      }

      // Calculate all indicators
      const rfParams = resolveRangeFilterParams(asset);
      const rfResult = calculateRangeFilter(
        closedCandles,
        rfParams.period,
        rfParams.multiplier
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

      // Tier/regime filters (ADX, Choppiness) are unconditional on 4h (the
      // RF cascade's signal timeframe) and, opt-in via pineConfig.smcTierEnabled
      // (off by default, docs/known-risks.md item 42), on 1h too (the SMC
      // cascade's signal timeframe) — same functions/threshold table reused
      // as-is, no separate calibration invented for 1h. Guarded behind the
      // flag to keep this file's "flag off = zero extra cost" discipline
      // (retest/displacement follow the same rule) even though this is
      // CPU-only — 1h candles are already fetched regardless, for the SMC
      // structure block just below.
      let tier = null, adx = null, chop = null;
      if (tf === '4h' || (tf === '1h' && pineConfig.smcTierEnabled)) {
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

        // Fase 4 (docs/known-risks.md item 43) — Order Block / Fair Value Gap,
        // off by default. Informativos: alimentam o score SMC (como o próprio
        // Pine do usuário faz no seu Confluence Score), nunca bloqueiam nem
        // liberam entrada. Só 1h (a cascata que consome) e só quando a última
        // vela ROMPEU estrutura — que é exatamente quando um sinal SMC
        // dispara, e a âncora que detectOrderBlock assume (candles[n-1]).
        // closedCandles já está em memória: zero fetchCandles extra.
        let obActive = null, fvgActive = null;
        if (tf === '1h' && pineConfig.smcObFvgEnabled) {
          const breakDir = (structure.lastBull.bos || structure.lastBull.choch) ? 'BUY'
            : (structure.lastBear.bos || structure.lastBear.choch) ? 'SELL' : null;
          if (breakDir) {
            const obFvgAtrLen = pineConfig.obFvgAtrLen ?? 50;
            // Order Block: avaliado UMA vez, na barra do rompimento (n-1), então
            // o ATR corrente É o ATR de formação — escalar está correto aqui.
            obActive = detectOrderBlock(closedCandles, {
              direction: breakDir,
              atrValue: calculateATR(closedCandles, obFvgAtrLen),
              minAtrMult: pineConfig.obMinAtrMult ?? 0.5,
              maxAtrMult: pineConfig.obMaxAtrMult ?? 2.5,
            }).active;
            // FVG: varre uma JANELA de candidatos históricos, então cada gap
            // precisa ser julgado pelo limiar da SUA barra de formação — é o
            // que o Pine faz (`sz > size_threshold` no instante da criação, e
            // o objeto vive até ser preenchido; `remove_insignificant` fica
            // desligado porque a chamada real omite `gc_cycle`). Passar um
            // escalar faria um gap antigo aparecer/sumir conforme o ATR de
            // hoje oscila — revisão do Codex, PR #85.
            const fvgMult = pineConfig.fvgMinAtrMult ?? 0.5;
            const fvgThresholds = calculateATRSeries(closedCandles, obFvgAtrLen)
              .map(a => (a > 0 ? a * fvgMult : -1));
            fvgActive = detectFvg(closedCandles, {
              direction: breakDir,
              sizeThreshold: fvgThresholds,
              fillTargetRatio: pineConfig.fvgFillTargetRatio ?? 0.6,
            }).active;
          }
        }

        smc = {
          trend: structure.trend,
          lastBull: structure.lastBull,
          lastBear: structure.lastBear,
          pdZone: pdZone.zone,
          // null = não avaliado (flag off / sem rompimento nesta vela),
          // diferente de false (avaliado, não ativo).
          obActive,
          fvgActive,
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
        // Last 2 closed candles (full OHLC), for the candle-pattern gate
        // (evaluateCandlePatternGate) — bounded slice, not the whole
        // series, since that's all a 2-candle pattern like engulfing needs.
        last2Candles: closedCandles.slice(-2),
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
      r.rf, r.rsi, r.macd, r.ema, alignmentResult, tf, r.volumeData, MIN_SCORE, r.confirmed,
      // docs/known-risks.md item 111 (backtest-only) — RSI sozinho decide o
      // gate em vez do score ponderado, ver confluence.js.
      !!pineConfig?.rsiOnlyGateEnabled
    );

    // docs/known-risks.md item 69 — captura TODO flip de RF em 4h confirmado
    // (aprovado ou não pelo gate de score abaixo), com o estado de CADA
    // indicador em campo SEPARADO — nunca um blob combinado, pra permitir
    // medir a contribuição marginal de cada um depois sem o viés de amostra
    // de "só quem já passou em todos os filtros". Duplica as MESMAS condições
    // que calculateSignalStrength usa internamente (confluence.js) em vez de
    // mudar a assinatura dela — zero risco pro caminho ao vivo, que nunca lê
    // este array. Só timeframe 4h: é a única cascata nativa que abre operação
    // real a partir de RF hoje (ver known-risks item 66/68).
    if (tf === '4h' && (r.confirmed.confirmedSignal === 'BUY' || r.confirmed.confirmedSignal === 'SELL')) {
      const isBuySnap = r.confirmed.confirmedSignal === 'BUY';
      rawSignalSnapshots.push({
        asset_id: asset.id,
        symbol: asset.symbol,
        direction: r.confirmed.confirmedSignal,
        candle_time: r.lastCandleTime,
        entry_price_ref: r.lastClose,
        atr_value: r.atrValue,
        tier: r.tier?.tier ?? null,
        tier_atr_stop_mult: r.tier?.atrStopMult ?? null,
        tier_time_stop_bars: r.tier?.timeStopBars ?? null,
        follow_through: isBuySnap ? r.confirmed.buyFollowThrough : r.confirmed.sellFollowThrough,
        macd_bullish: r.macd.histogram > 0,
        macd_bearish: r.macd.histogram < 0,
        ema_bull: r.ema.trend === 'bullish',
        ema_bear: r.ema.trend === 'bearish',
        rsi_crossed_bull50: r.rsi.crossedBull50,
        rsi_crossed_bear50: r.rsi.crossedBear50,
        volume_above_ma: !!(r.volumeData && r.volumeData.current > r.volumeData.ma),
        adx_value: r.adx?.adx ?? null,
        chop_value: r.chop ?? null,
        rf_direction: r.rf.direction,
        score_real: strengthResult.score,
        passed_real: strengthResult.passed,
        dedup_key: `${asset.symbol}_4h_${r.confirmed.confirmedSignal}_raw_${r.lastCandleTime}`,
      });
    }

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

      // docs/known-risks.md item 77 — frozen at the instant THIS signal is
      // born, same discipline as ote_leg_high/low below for the SMC 1h->5m
      // cascade (item 38). Only tf==='4h' feeds the RF-native (4h_15m)
      // cascade that consumes this; r.smc is only populated for tf 4h/1h,
      // no extra fetch cost.
      //
      // Deliberately NOT buildOteLeg here (unlike the SMC 1h->5m block
      // below) — buildOteLeg anchors one edge to the break candle's OWN
      // close, which is the right call when the "break" IS the SMC event
      // (the 1h->5m case). Here the break is an RF event, not an SMC one:
      // anchoring to r.lastClose (the RF 4h signal candle's close) would
      // measure "did price move past the candle that fired the RF signal"
      // instead of anything about real SMC structure — a real bug, found
      // AFTER running the first live A/B (docs/known-risks.md item 77,
      // "Achado do primeiro A/B real"): a confirmed 15m entry almost always
      // continues past that same close (that's what "confirmed" means),
      // so the zone came out "premium"/"discount" (against) in ~91-94% of
      // trades regardless of real market state — 0 'aligned' in 104 ops.
      // The fix: use SMC's OWN most recent swing range (lastSwingHigh/
      // lastSwingLow, the confirmed protected pivots calculateStructure
      // already tracks independently of any RF candle) as the leg
      // directly — the textbook ICT/SMC Premium/Discount definition
      // (measured over the latest significant swing), genuinely
      // independent of how/when the RF cascade happened to fire.
      const smcAlignLeg = (tf === '4h' && r.smc)
        ? { legHigh: r.smc.lastSwingHigh ?? null, legLow: r.smc.lastSwingLow ?? null }
        : { legHigh: null, legLow: null };

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
          smc_align_leg_high: smcAlignLeg.legHigh,
          smc_align_leg_low: smcAlignLeg.legLow,
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
          // Fase 4 (item 43) — null quando smcObFvgEnabled está desligado.
          // Com os pesos no default (0) não alteram o score; ligar o flag
          // sozinho serve para MEDIR (campos de auditoria + seção do backtest)
          // antes de decidir dar peso.
          obActive: r.smc.obActive,
          fvgActive: r.smc.fvgActive,
          weights: {
            structureWeight: pineConfig.smcScoreStructureWeight,
            chochBonus: pineConfig.smcScoreChochBonus,
            emaWeight: pineConfig.smcScoreEmaWeight,
            rfWeight: pineConfig.smcScoreRfWeight,
            volumeWeight: pineConfig.smcScoreVolumeWeight,
            alignmentWeight: pineConfig.smcScoreAlignmentWeight,
            sweepWeight: pineConfig.smcScoreSweepWeight,
            obWeight: pineConfig.smcScoreObWeight,
            fvgWeight: pineConfig.smcScoreFvgWeight,
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
            // The level THIS break actually crossed — the protected pivot on
            // the SAME side as the move (lastSwingHigh for a bullish
            // BOS/CHoCH, lastSwingLow for bearish). NOT the same value as
            // structuralLevel in check5mSmcConfirmation (that's the OPPOSITE,
            // protected pivot used as the stop) nor buildOteLeg's legHigh/Low
            // (that's the extended breakClose side for the direction that
            // fired). Fixed once, here, at signal time — same "never
            // recompute on retry" rule as oteLegHigh/oteLegLow above, so the
            // Fase 2 rodada 1 retest gate (retest.js) always retests the
            // level THIS candidate broke, not a level that drifted while it
            // waited. Null when the protected pivot on that side isn't
            // confirmed yet (retest gate fails closed on null — see
            // docs/known-risks.md item 40).
            smc_broken_level: signalType === 'BUY' ? (r.smc.lastSwingHigh ?? null) : (r.smc.lastSwingLow ?? null),
            // Fase 4 (item 43) — observacionais, nunca consumidos por
            // stop/TP nem por gate de entrada. null = não avaliado
            // (smcObFvgEnabled desligado), false = avaliado e não ativo.
            ob_active: r.smc.obActive ?? null,
            fvg_active: r.smc.fvgActive ?? null,
            // Mesmo contexto macro que o sinal RF já grava (mesmo
            // statesForAlignment do loop) — sem isso buildSmcTradeOpData não
            // tinha nada pra copiar pra TradeOperation (ver known-risks item 47.2).
            tf_1d_direction: statesForAlignment['1d']?.rf_direction || 0,
            tf_4h_direction: statesForAlignment['4h']?.rf_direction || 0,
            tf_1h_direction: statesForAlignment['1h']?.rf_direction || 0,
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
    rawSignalSnapshots,
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
  // Shared detector (src/lib/opTransition.js) — this query already filters
  // by this asset's symbol+id, so at most one group ever comes back UNLESS
  // both ops carry the hierarchical_cascade stamp (Bloco 4 Fase 1, below) —
  // the helper still runs here (rather than a plain length check) so the
  // duplicate-op RULE lives in exactly one place, shared with
  // priceCheckActiveOpsInner below.
  const { validGroups, duplicateGroups } = groupActiveOpsByAsset(activeOpsAtStart);
  // Kept only to enrich the discard log below (which op blocked the entry) —
  // hasActiveOp remains the actual gate. null whenever duplicated (see guard
  // below) — no branch that runs in that case ever reads it. When BOTH
  // hierarchical legs are active, this arbitrarily picks one of the two —
  // harmless, because every hierarchical-mode branch below reads
  // activeOp4h15m/activeOp1h5m instead, never this shared `activeOp`.
  let activeOp = validGroups.size > 0 ? [...validGroups.values()][0] : null;
  // docs/known-risks.md item 37 (Bloco 4 Fase 1) — per-cascade tracking,
  // used ONLY by the 4h_15m/1h_5m blocks below when
  // pineConfig.hierarchicalCascadesEnabled is on. Independent of
  // hasActiveOp/activeOp above, which keep gating every OTHER cascade
  // (rf1h_cond4h_15m/rf1h_uncond_15m) exactly as before — those never
  // migrate to a per-cascade anchor, so mixing them with a hierarchical run
  // is an unsupported combination (documented limitation, not validated
  // here).
  let hasActiveOp4h15m = activeOpsAtStart.some((op) => op.cascade === '4h_15m');
  let hasActiveOp1h5m = activeOpsAtStart.some((op) => op.cascade === '1h_5m');
  let activeOp4h15m = activeOpsAtStart.find((op) => op.cascade === '4h_15m') ?? null;
  let activeOp1h5m = activeOpsAtStart.find((op) => op.cascade === '1h_5m') ?? null;

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
  const duplicateActiveOps = duplicateGroups.size > 0;
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
        op_created_dates: activeOpsAtStart.map(o => o.created_date ?? null),
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
  // Fase 2 rodada 1 (docs/known-risks.md item 40) — same purpose/shape
  // convention as arbitrationOutcomes above, feeding buildReport's `retest`
  // section (backtestEngine.js). Pushed from BOTH the 1st-pass call sites
  // AND the retry loops (in-memory only, no Firestore write — cheap to push
  // every retry tick) — backtestEngine.js dedupes by dedup_key, last-write-
  // wins, so a later "retested:true" from a retry correctly overwrites the
  // "pending" outcome the 1st pass recorded for the same signal.
  const retestOutcomes = [];
  // Fase 2 rodada 2 (docs/known-risks.md item 41) — same convention, feeding
  // buildReport's `displacement` section. SMC 1h_5m cascade only.
  const displacementOutcomes = [];
  // Fase 3 (docs/known-risks.md item 42) — same convention, feeding
  // buildReport's `smcRegime` section. SMC 1h_5m cascade only.
  const smcRegimeOutcomes = [];
  // Round 3 (docs/known-risks.md item 50) — same convention, mirrors
  // smcRegimeOutcomes for the RF 4h_15m cascade (which never had this
  // granularity: entryFunnelOutcomes only records the string reason
  // 'regime_rejected', never the actual adx/chop/tier that produced it).
  // Feeds buildReport's `rfRegime` section.
  const rfRegimeOutcomes = [];
  // Padrão de vela (engolfo), pedido do usuário 2026-08-02 — mesma
  // convenção de retestOutcomes: só pushed quando pineConfig.
  // candlePatternEnabled === true (evaluateCandlePatternGate devolve null
  // com o flag desligado, mesmo padrão de retestGate). Feeds buildReport's
  // `candlePattern` section. RF 4h_15m cascade only.
  const candlePatternOutcomes = [];
  // Round 3 (docs/known-risks.md item 50) — same convention, pushed on
  // EVERY check5mSmcConfirmation call (confirmed or not — check5mSmcConfirmation
  // is never opt-in, so unlike retest/displacement there's no flag gating
  // this). Turns "sinal esgota a janela de 4h sem disparar" from an
  // aggregate-arithmetic inference into a real per-signal attempt count.
  // Feeds buildReport's `smcTrigger` section.
  const smcTriggerOutcomes = [];
  // Fase 4 (docs/known-risks.md item 43) — same convention, feeding
  // buildReport's `smcObFvg` section. Recorded at SIGNAL EMISSION (not at
  // entry): the question this answers is "quantos sinais SMC tinham OB/FVG a
  // favor no momento em que nasceram", que é o dado necessário pra decidir se
  // vale dar peso a eles no score. Empurrado abaixo, ao percorrer newSignals.
  const smcObFvgOutcomes = [];
  // known-risks item 45.3/49 — "muitos sinais, poucas operações": nenhuma
  // seção existente respondia QUAL gate rejeita mais ao longo de TODO o
  // funil (1ª passada + retry), nas duas cascatas — smc5mZoneRejections
  // acima só amostra a 1ª passada da zona OTE, e cada gate loga pro
  // SystemLog isoladamente sem nenhum agregado. Mesma convenção
  // in-memory/last-write-wins dos arrays acima, mas UM balde por
  // dedup_key+cascade com o motivo do gate que rejeitou — feeding
  // buildReport's `entryFunnel` section.
  const entryFunnelOutcomes = [];

  // ─── Teto de exposição de carteira (backtest-only, known-risks item 133) ───
  // `assetActiveOps` garante 1 operação por ATIVO — e só. Não existe nenhum
  // limite de quantas operações do MESMO LADO podem estar abertas ao mesmo
  // tempo na carteira inteira. Com ativos fortemente correlacionados a BTC,
  // N posições simultâneas do mesmo lado são uma aposta de tamanho N, não N
  // apostas independentes: é exatamente o termo que infla o DEFF e que
  // NENHUMA regra de saída consegue tocar (o item 132 cortou a variância
  // POR operação; esta é a variância ENTRE operações).
  //
  // Custo em produção: ZERO. Com o teto nulo (o default em produção — a
  // chave só existe em scripts/backtestPineConfig.js) nenhuma query extra é
  // emitida. Só o backtest paga, e lá o backend é fake em memória.
  const portfolioSideCap = pineConfig.maxConcurrentSameSideOps ?? null;
  const portfolioCapOutcomes = [];
  const portfolioCapBlockedIds = new Set();
  const openSideCounts = { BUY: 0, SELL: 0 };
  if (portfolioSideCap != null) {
    const portfolioOps = await backend.entities.TradeOperation.filter({
      status: ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'],
    });
    for (const op of portfolioOps) {
      if (op.side === 'BUY' || op.side === 'SELL') openSideCounts[op.side] += 1;
    }
  }

  /**
   * Wrapper com a MESMA assinatura de `backend.tradeOps.createTradeOpIfNoneActive`
   * — trocar a chamada pelo wrapper é a única mudança nos 8 pontos de criação
   * dentro desta função. Com o teto desligado é um passthrough literal.
   *
   * A contagem local é incrementada a cada criação bem-sucedida para o teto
   * valer DENTRO da mesma passada, não só entre passadas (a query acima é
   * lida uma vez por ativo; sem isso, dois ativos na mesma passada poderiam
   * ambos passar por um teto já esgotado).
   *
   * NÃO cobre `createManualTradeOp` de propósito: entrada manual é ação
   * explícita do usuário no painel, não uma decisão do motor.
   */
  const createTradeOpIfNoneActiveCapped = async (assetId, tradeOpId, opData, cascade) => {
    const side = opData?.side;
    if (portfolioSideCap != null && (side === 'BUY' || side === 'SELL')
        && openSideCounts[side] >= portfolioSideCap) {
      // Deduplicado por `tradeOpId`: o MESMO sinal é avaliado na 1ª passada e
      // de novo no loop de retry dentro desta mesma chamada, então contar
      // tentativas infla a métrica. O que interessa medir é quantas ENTRADAS
      // distintas o teto barrou — o `tradeOpId` é determinístico por sinal,
      // então é a chave certa (mesma dedup que `createTradeOpIfNoneActive` já
      // faz do lado do banco).
      if (!portfolioCapBlockedIds.has(tradeOpId)) {
        portfolioCapBlockedIds.add(tradeOpId);
        portfolioCapOutcomes.push({
          trade_op_id: tradeOpId,
          symbol: opData?.symbol ?? asset.symbol,
          side,
          cascade: opData?.cascade ?? cascade ?? null,
          openSameSide: openSideCounts[side],
          cap: portfolioSideCap,
        });
      }
      return { created: false, blockedByPortfolioCap: true };
    }
    const res = await backend.tradeOps.createTradeOpIfNoneActive(assetId, tradeOpId, opData, cascade);
    if (res?.created && (side === 'BUY' || side === 'SELL')) openSideCounts[side] += 1;
    return res;
  };

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
    // `asset` já está em escopo neste loop (usado acima em
    // asset.alert_cooldown_minutes) — passar direto evita qualquer leitura
    // extra no Firestore só para o filtro por-ativo (known-risks item 47).
    if (willNotify) notifyNewSignal(signal, asset).catch(() => {});

    // Tarefa de verificação automática — um lembrete que sobrevive a fechar o
    // navegador para todo sinal de alta prioridade, já que este loop roda
    // idêntico no browser e no cron (scripts/build-scan.mjs).
    // createUnique com o MESMO dedup_key do SignalEvent garante 1 tarefa por
    // sinal mesmo sob múltiplas passadas do cron (~5min) — nenhum lock extra
    // necessário, mesma garantia que já protege o SignalEvent contra
    // duplicata. Independente de `willNotify`/cooldown: a tarefa deve
    // persistir mesmo quando o Telegram do sinal está em cooldown ou não
    // configurado — só o ENVIO da notificação (abaixo) depende de
    // isTelegramConfigured().
    //
    // try/catch dedicado (Codex review, PR #159 follow-up): sem isso, uma
    // falha transitória nesta escrita aditiva propagaria e abortaria TODO o
    // restante de persistScanResults para este ativo nesta passada (o
    // try/catch de scanAllAssetsInner que envolve a chamada é por-ATIVO, não
    // por-sinal) — inclusive o motor de entrada de outros sinais do mesmo
    // ativo. Uma tarefa de verificação perdida é aceitável (lembrete
    // best-effort, mesmo status de risco do notifyNewSignal fire-and-forget
    // logo acima); abortar a avaliação de entrada do ativo por causa dela
    // não é.
    if (signal.priority === 'high') {
      try {
        const verificationCreated = await backend.entities.VerificationTask.createUnique(signal.dedup_key, {
          signal_event_id: signal.dedup_key,
          asset_id: signal.asset_id,
          symbol: signal.symbol,
          signal_type: signal.signal_type,
          timeframe: signal.timeframe,
          source: signal.source,
          priority: signal.priority,
          score: signal.context?.score ?? null,
          signal_context: signal.context,
          reason: signal.reason,
          status: 'pending',
          notes: '',
          telegram_notified: false,
          telegram_notified_at: null,
        });
        if (verificationCreated.created) {
          // Marca qualquer tarefa 'pending' MAIS ANTIGA do mesmo ativo+timeframe
          // como 'superseded' — sem isso, um sinal SELL de 2 dias atrás ficava
          // "Pendente"/"Entrada liberada" na aba Verificação para sempre, mesmo
          // depois do RF já ter flipado pra BUY (achado do usuário, item 76):
          // a aba Trades sempre mostra só o sinal MAIS RECENTE por
          // símbolo+timeframe (Trades.jsx:325-333), mas a Verificação nunca
          // marcava as tarefas antigas como superadas — as duas telas
          // divergiam sem nenhum aviso visual do porquê. Mesma chave
          // (asset_id + timeframe, não por cascata/source) que Trades.jsx já
          // usa para "qual sinal é o atual" deste ativo. Filtro só com `==`
          // (sem orderBy) não precisa de índice composto novo — diferente dos
          // dois casos do item 72 (que combinavam igualdade com orderBy).
          const stalePending = await backend.entities.VerificationTask.filter({
            asset_id: signal.asset_id,
            timeframe: signal.timeframe,
            status: 'pending',
          });
          await Promise.all(
            stalePending
              .filter((t) => t.id !== verificationCreated.doc.id)
              .map((t) => backend.entities.VerificationTask.update(t.id, {
                status: 'superseded',
                reviewed_at: new Date().toISOString(),
              }))
          );

          if (isTelegramConfigured()) {
            // Fire-and-forget, como notifyNewSignal acima — NÃO aguardado,
            // para não atrasar os gates de confirmação de entrada
            // (check15mConfirmation/check5mSmcConfirmation) que rodam logo
            // depois neste mesmo loop com uma chamada de rede ao Telegram.
            // telegram_notified só deve significar "de fato enviado", não
            // "tentaríamos enviar" (Codex review: o valor anterior gravava
            // true mesmo quando o filtro de evento/score/timeframe descartava
            // o envio, ou quando send() engolia uma falha de rede) — por isso
            // o update fica condicionado ao retorno real de notifyVerificationTask,
            // só que de forma assíncrona/eventual em vez de bloquear a passada.
            notifyVerificationTask(signal, asset)
              .then((delivered) => delivered && backend.entities.VerificationTask.update(verificationCreated.doc.id, {
                telegram_notified: true,
                telegram_notified_at: new Date().toISOString(),
              }))
              .catch((e) => logWarn('scanner', `Falha ao notificar/gravar entrega da tarefa de verificação de ${signal.symbol}`, { error: e.message, dedup_key: signal.dedup_key }));
          }
        }
      } catch (e) {
        logWarn('scanner', `Falha ao criar tarefa de verificação para ${signal.symbol}`, { error: e.message, dedup_key: signal.dedup_key });
      }
    }

    // Fase 4 (item 43) — in-memory only, no Firestore write; nada é empurrado
    // enquanto smcObFvgEnabled está desligado (os campos ficam null), que é
    // como o relatório de backtest infere se o flag estava ligado.
    //
    // A POSIÇÃO importa: tem que ser DEPOIS do `if (!dedupResult.created)
    // continue` acima. `scanAsset` é stateless e reemite o MESMO evento de
    // estrutura da última vela 1h fechada a cada tick (~12x/hora na cadência
    // de 5min do replay), então empurrar antes do gate de dedup fazia a
    // contagem de avaliações medir a cadência do replay em vez do que
    // aconteceu com o sinal. Diferente dos gates de reteste/deslocamento/
    // regime, que são reavaliados de verdade pelo loop de retry, OB/FVG é
    // registrado uma vez, no nascimento do sinal — achado de revisão externa
    // (Codex, PR #91). O `total` da seção não muda (o relatório já deduplicava
    // por dedup_key); o que muda é `attempts` deixar de ser ruído.
    if (signal.source === 'smc_structure'
      && (signal.context?.ob_active != null || signal.context?.fvg_active != null)) {
      smcObFvgOutcomes.push({
        dedup_key: signal.dedup_key,
        cascade: '1h_5m',
        obActive: signal.context.ob_active === true,
        fvgActive: signal.context.fvg_active === true,
      });
    }

    // ═══ Entry Motor: 4H trend → 15m confirmation only ═══
    // No operation opens on 15m without prior 4H trend confirmation.
    // Non-4H RF signals are persisted as alerts but do NOT trigger entries.
    if (signal.source === 'range_filter') {
      if (signal.timeframe === '1h' && pineConfig.rf1hCondEnabled === true) {
        // Fase 1 (docs/known-risks.md item 56 "Fase 1") — RF 1h condicionado
        // ao 4h, backtest-only (rf1hCondEnabled só existe em
        // scripts/backtestPineConfig.js, nunca em pineParser.js/
        // adminPineConfig.js — nunca alcança produção). O sinal 1h só vira
        // candidato se o RF 4h JÁ estiver na mesma direção, e reusa o MESMO
        // tf4hData/regime/check15mConfirmation da cascata nativa — nunca
        // recalcula regime em dado de 1h (evita reabrir a calibração
        // ADX/Choppiness não validada nesse timeframe, item 42). Rótulo de
        // cascade distinto (RF_1H_COND_CASCADE) — nunca '1h_5m' (SMC) nem
        // '4h_15m' (RF nativa). Escopo desta 1ª rodada: sem candlePattern/
        // smc_confirm_4h15m/reteste/arbitragem cross-cascade para este
        // caminho experimental — deliberadamente mais simples que a cascata
        // nativa, ver plano (Fase 1) para o que fica pra depois.
        const tf4hData = results['4h'];
        if (tf4hData && tf4hData.atrValue) {
          const tf4hDir = tf4hData.rf.direction;
          const sigDir = signal.signal_type === 'BUY' ? 1 : -1;

          if (tf4hDir !== sigDir) {
            entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: RF_1H_COND_CASCADE, reason: 'trend_reversed' });
          } else {
            const regime = evaluateRegime(tf4hData, pineConfig);
            rfRegimeOutcomes.push({
              dedup_key: signal.dedup_key, cascade: RF_1H_COND_CASCADE,
              ok: regime.ok, adxOk: regime.adxOk, chopOk: regime.chopOk,
              adx: tf4hData.adx?.adx ?? null, chop: tf4hData.chop ?? null, tier: tf4hData.tier?.tier ?? null,
            });
            if (!regime.ok) {
              entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: RF_1H_COND_CASCADE, reason: 'regime_rejected' });
            } else if (hasActiveOp) {
              entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: RF_1H_COND_CASCADE, reason: 'active_op_exists' });
            } else {
              const confirmed15m = await resolveEntryConfirmation15m({
                symbol: asset.symbol, direction: signal.signal_type, asset, pineConfig,
                entryPrice: signal.price_at_signal, entryCandleTime: signal.candle_time,
              });
              if (!confirmed15m.confirmed) {
                entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: RF_1H_COND_CASCADE, reason: 'confirmation_15m_not_aligned' });
              } else {
                const opData = buildTradeOpData(signal, tf4hData, pineConfig, confirmed15m, { cascade: RF_1H_COND_CASCADE, signalTimeframe: '1h' });
                const minRR = pineConfig.minRR ?? 1.2;
                const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
                if (!rr.pass) {
                  entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: RF_1H_COND_CASCADE, reason: rr.reason });
                } else {
                  opData.rr_at_entry = rr.rr1;
                  opData.rr_gate_mode = RR_GATE_MODE;
                  opData.rr_target_basis = RR_TARGET_BASIS;
                  const tradeOpId = `trade_${signal.dedup_key}`;
                  const created = await createTradeOpIfNoneActiveCapped(signal.asset_id, tradeOpId, opData);
                  if (created.created) {
                    hasActiveOp = true;
                    activeOp = created.doc;
                    if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});
                    logInfo('scanner', `${signal.symbol} entrada criada (RF 1h condicionado ao 4h) — experimental`, {
                      score: signal.context?.score ?? null, rr: rr.rr1,
                    }, { symbol: signal.symbol, timeframe: '15m' });
                  }
                }
              }
            }
          }
        }
      } else if (signal.timeframe === '1h' && pineConfig.rf1hUncondEnabled === true) {
        // docs/known-risks.md item 68 — RF 1h TOTALMENTE independente do 4h,
        // backtest-only (rf1hUncondEnabled só existe em
        // scripts/backtestPineConfig.js, nunca em pineParser.js/
        // adminPineConfig.js — nunca alcança produção). Mesma mecânica do
        // ramo rf1hCondEnabled acima (reusa tf4hData pra ATR/tier/regime,
        // nunca recalcula regime em dado de 1h, mesma check15mConfirmation)
        // com a ÚNICA diferença: SEM o gate de concordância direcional com
        // o 4h — um sinal de 1h vira candidato mesmo com o 4h em direção
        // oposta ou neutra. Isola exatamente essa variável em relação ao
        // ramo condicionado (mesma metodologia, resultado comparável).
        // Rótulo de cascade distinto (RF_1H_UNCOND_CASCADE) — nunca '1h_5m'
        // (SMC), '4h_15m' (RF nativa) nem RF_1H_COND_CASCADE.
        const tf4hData = results['4h'];
        if (tf4hData && tf4hData.atrValue) {
          const regime = evaluateRegime(tf4hData, pineConfig);
          rfRegimeOutcomes.push({
            dedup_key: signal.dedup_key, cascade: RF_1H_UNCOND_CASCADE,
            ok: regime.ok, adxOk: regime.adxOk, chopOk: regime.chopOk,
            adx: tf4hData.adx?.adx ?? null, chop: tf4hData.chop ?? null, tier: tf4hData.tier?.tier ?? null,
          });
          if (!regime.ok) {
            entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: RF_1H_UNCOND_CASCADE, reason: 'regime_rejected' });
          } else if (hasActiveOp) {
            entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: RF_1H_UNCOND_CASCADE, reason: 'active_op_exists' });
          } else {
            const confirmed15m = await resolveEntryConfirmation15m({
              symbol: asset.symbol, direction: signal.signal_type, asset, pineConfig,
              entryPrice: signal.price_at_signal, entryCandleTime: signal.candle_time,
            });
            if (!confirmed15m.confirmed) {
              entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: RF_1H_UNCOND_CASCADE, reason: 'confirmation_15m_not_aligned' });
            } else {
              const opData = buildTradeOpData(signal, tf4hData, pineConfig, confirmed15m, { cascade: RF_1H_UNCOND_CASCADE, signalTimeframe: '1h' });
              const minRR = pineConfig.minRR ?? 1.2;
              const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
              if (!rr.pass) {
                entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: RF_1H_UNCOND_CASCADE, reason: rr.reason });
              } else {
                opData.rr_at_entry = rr.rr1;
                opData.rr_gate_mode = RR_GATE_MODE;
                opData.rr_target_basis = RR_TARGET_BASIS;
                const tradeOpId = `trade_${signal.dedup_key}`;
                const created = await createTradeOpIfNoneActiveCapped(signal.asset_id, tradeOpId, opData);
                if (created.created) {
                  hasActiveOp = true;
                  activeOp = created.doc;
                  if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});
                  logInfo('scanner', `${signal.symbol} entrada criada (RF 1h independente do 4h) — experimental`, {
                    score: signal.context?.score ?? null, rr: rr.rr1,
                  }, { symbol: signal.symbol, timeframe: '15m' });
                }
              }
            }
          }
        }
      } else if (signal.timeframe !== '4h') {
        // Non-4H signal — block entry, log as ignored
        await backend.entities.SystemLog.create({
          level: 'debug',
          module: 'scanner',
          message: `${asset.symbol} ${signal.timeframe.toUpperCase()} ${signal.signal_type} — entrada bloqueada (requer tendência 4H confirmada)`,
          symbol: asset.symbol,
          timeframe: signal.timeframe,
          details: { direction: signal.signal_type, score: signal.context?.score ?? null, reason: 'requires_4h_trend' },
        });
      } else if (!pineConfig.rf1hExclusiveEnabled) {
        // 4H signal — verify 4H trend alignment explicitly before any entry.
        // docs/known-risks.md item 78: when rf1hExclusiveEnabled is on, this
        // whole native-cascade branch is skipped — the 4H signal is simply
        // never converted into a TradeOperation, freeing the asset's slot
        // entirely for RF_1H_COND_CASCADE/RF_1H_UNCOND_CASCADE to measure
        // without competing against 4h_15m for it.
        const tf4hData = results['4h'];
        if (tf4hData && tf4hData.atrValue) {
          // docs/known-risks.md item 71 — pineConfig.allowedSide
          // ('SELL'|'BUY'|ausente, backtest-only). Bloqueia o lado NÃO
          // permitido na cascata nativa ANTES de qualquer outro gate — mais
          // barato (sem I/O) e mais fundamental (decisão de lado, não de
          // qualidade do sinal). Um parâmetro só (não 2 flags booleanas
          // separadas) evita o caso os-dois-ligados-ao-mesmo-tempo sem
          // precisar validar mutex — e permite testar SELL-only e BUY-only
          // pela MESMA mecânica, pro contraste pedido pelo usuário. Achado
          // que motivou: nas operações reais já medidas, BUY teve
          // expectância negativa CONCLUSIVA (-0,324R, IC95 não cruza zero)
          // e SELL positiva CONCLUSIVA (+0,271R) — ver item 71.
          if (pineConfig.allowedSide && signal.signal_type !== pineConfig.allowedSide) {
            entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: 'side_filter_blocked' });
            continue;
          }
          // docs/known-risks.md item 100 — pineConfig.buyRegimeFilterEnabled
          // (opt-in, backtest-only, default false). Item 88 registrou BUY
          // como regime-dependente (positivo em alta, negativo/inconclusivo
          // em baixa) e nomeou este filtro — condicionar compra ao
          // alinhamento de tendência 1D — como o único caminho formal de
          // reabrir a pergunta do BUY. Só afeta o lado BUY (SELL já performa
          // bem independente de regime nas medições já feitas, item 88);
          // usa signal.context.tf_1d_direction, já calculado por
          // analyzeAlignment dentro de scanAsset — sem I/O extra. Neutro
          // (0) conta como bloqueado: sem confirmação macro clara, gate
          // conservador por desenho, não só bloqueia 1D baixista.
          if (pineConfig.buyRegimeFilterEnabled && signal.signal_type === 'BUY' && signal.context?.tf_1d_direction !== 1) {
            entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: 'buy_regime_filter_blocked' });
            continue;
          }
          const tf4hDir = tf4hData.rf.direction;
          const sigDir = signal.signal_type === 'BUY' ? 1 : -1;

          if (tf4hDir !== sigDir) {
            // 4H trend not aligned with signal direction — block entry
            entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: 'trend_reversed' });
            await backend.entities.SystemLog.create({
              level: 'warn',
              module: 'scanner',
              message: `${asset.symbol} 4H ${signal.signal_type} — tendência 4H desalinhada (dir=${tf4hDir}), entrada bloqueada`,
              symbol: asset.symbol,
              timeframe: '4h',
              details: { signal_dir: sigDir, tf4h_dir: tf4hDir, score: signal.context?.score ?? null },
            });
          } else {
            const regime = evaluateRegime(tf4hData, pineConfig);
            rfRegimeOutcomes.push({
              dedup_key: signal.dedup_key, cascade: '4h_15m',
              ok: regime.ok, adxOk: regime.adxOk, chopOk: regime.chopOk,
              adx: tf4hData.adx?.adx ?? null, chop: tf4hData.chop ?? null, tier: tf4hData.tier?.tier ?? null,
            });
            if (!regime.ok) {
              entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: 'regime_rejected' });
              await backend.entities.SystemLog.create({
                level: 'info',
                module: 'scanner',
                message: `${asset.symbol} 4H ${signal.signal_type} — regime bloqueado (${!regime.adxOk ? 'ADX fraco' : ''}${!regime.adxOk && !regime.chopOk ? ' + ' : ''}${!regime.chopOk ? 'mercado lateralizado' : ''})`,
                symbol: asset.symbol,
                timeframe: '4h',
                details: { adx: tf4hData.adx?.adx ?? null, chop: tf4hData.chop ?? null, tier: tf4hData.tier?.tier ?? null, adxOk: regime.adxOk, chopOk: regime.chopOk },
              });
              continue;
            }

            const candlePattern = evaluateCandlePatternGate(tf4hData, signal.signal_type, pineConfig);
            if (candlePattern) {
              candlePatternOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', ok: candlePattern.ok, pattern: candlePattern.pattern, reason: candlePattern.reason });
              if (!candlePattern.ok) {
                entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: 'candle_pattern_rejected' });
                await backend.entities.SystemLog.create({
                  level: 'info',
                  module: 'scanner',
                  message: `${asset.symbol} 4H ${signal.signal_type} — padrão de vela não confirmado (${candlePattern.reason})`,
                  symbol: asset.symbol,
                  timeframe: '4h',
                  details: { reason: candlePattern.reason, allReasons: candlePattern.allReasons },
                });
                continue;
              }
            }

            // Optional extra confirmation: SMC 4h structure trend + PD zone
            // must agree with the RF signal direction. Off by default
            // (asset.smc_confirm_4h15m) — purely additive, never required
            // unless the user explicitly opts an asset into it.
            if (asset.smc_confirm_4h15m && tf4hData.smc) {
              const trendAligned = sigDir === 1 ? tf4hData.smc.trend === 1 : tf4hData.smc.trend === -1;
              const zoneOk = sigDir === 1 ? tf4hData.smc.pdZone !== 'premium' : tf4hData.smc.pdZone !== 'discount';
              if (!trendAligned || !zoneOk) {
                entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: 'smc_confirm_zone_rejected' });
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

            // docs/known-risks.md item 37 (Bloco 4 Fase 1) — with the flag
            // on, this cascade's own slot (never the shared one) decides
            // whether it's free.
            if (pineConfig.hierarchicalCascadesEnabled ? !hasActiveOp4h15m : !hasActiveOp) {
              // Fase 2 rodada 1 (docs/known-risks.md item 40): off by
              // default — pineConfig.retestEnabled === false skips this
              // entirely (retestGate stays null, no extra fetchCandles), and
              // the block below is byte-identical to pre-Fase-2 behaviour.
              const retestGate = pineConfig.retestEnabled
                ? await evaluateRetestGate({
                    symbol: asset.symbol,
                    direction: signal.signal_type,
                    level: signal.context?.rf_value,
                    signalCandleTime: signal.candle_time,
                    timeframe: '15m',
                    pineConfig,
                  })
                : null;
              if (retestGate) retestOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', retested: retestGate.retested, barsToConfirm: retestGate.barsToConfirm, reason: retestGate.reason });
              if (retestGate && !retestGate.retested) {
                entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: 'retest_pending' });
                await backend.entities.SystemLog.create({
                  level: 'info',
                  module: 'scanner',
                  message: `${asset.symbol} 4h ${signal.signal_type} — aguardando reteste do nível ${retestGate.anchorLevel ?? 'n/d'} antes de confirmar no 15m`,
                  symbol: asset.symbol,
                  timeframe: '15m',
                  details: { reason: 'awaiting_retest', retest_reason: retestGate.reason, anchor_level: retestGate.anchorLevel ?? null },
                });
              } else {
              // 15m confirmation required — no entry without it (unless
              // pineConfig.skip15mConfirmationEnabled, item 67, bypasses it)
              const confirmed15m = await resolveEntryConfirmation15m({
                symbol: asset.symbol, direction: signal.signal_type, asset, pineConfig,
                entryPrice: signal.price_at_signal, entryCandleTime: signal.candle_time,
              });

              if (confirmed15m.confirmed) {
                const opData = buildTradeOpData(signal, tf4hData, pineConfig, confirmed15m);
                if (pineConfig.smcAlignmentScoreEnabled) {
                  opData.smc_alignment_at_entry = computeSmcAlignmentAtEntry(signal.signal_type, tf4hData.smc, signal.context?.smc_align_leg_high, signal.context?.smc_align_leg_low, opData.entry_price);
                }
                if (retestGate) stampRetestFields(opData, retestGate);
                const minRR = pineConfig.minRR ?? 1.2;
                const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
                if (!rr.pass) {
                  entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: rr.reason });
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
                  // docs/known-risks.md item 37 (Bloco 4 Fase 1) — stamped
                  // on the op itself, read back by groupActiveOpsByAsset.
                  if (pineConfig.hierarchicalCascadesEnabled) opData.hierarchical_cascade = true;
                  const tradeOpId = `trade_${signal.dedup_key}`;
                  const created = await createTradeOpIfNoneActiveCapped(
                    signal.asset_id, tradeOpId, opData,
                    pineConfig.hierarchicalCascadesEnabled ? '4h_15m' : undefined,
                  );
                  if (created.created) {
                    if (pineConfig.hierarchicalCascadesEnabled) {
                      hasActiveOp4h15m = true;
                      activeOp4h15m = created.doc;
                      activeOp1h5m = await coupleSiblingRiskOnOpen(activeOp1h5m, '1h_5m');
                    } else {
                      hasActiveOp = true;
                    }
                    activeOp = created.doc;
                    if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});
                    logInfo('scanner', `${signal.symbol} entrada criada — Pine sync ativo`, {
                      score: signal.context?.score ?? null, atr_mult: pineConfig.trailAtrMult, tp1R: pineConfig.tp1R, rr: rr.rr1,
                    }, { symbol: signal.symbol, timeframe: '15m' });
                  }
                }
              } else {
                // 15m not aligned — log and wait for retry on next scan
                entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: 'confirmation_15m_not_aligned' });
                await backend.entities.SystemLog.create({
                  level: 'info',
                  module: 'scanner',
                  message: `${asset.symbol} 4h ${signal.signal_type} — aguardando confirmação no 15m`,
                  symbol: asset.symbol,
                  timeframe: '15m',
                  details: { signal_tf: '4h', direction: signal.signal_type, score: signal.context?.score ?? null },
                });
              }
              }
            } else if (pineConfig.hierarchicalCascadesEnabled) {
              // docs/known-risks.md item 37 (Bloco 4 Fase 1) — hierarchical
              // mode never arbitrates 4h_15m against 1h_5m (each cascade's
              // slot is independent now); reaching here means the 4h_15m
              // slot ITSELF is already occupied by an earlier 4h_15m op —
              // nothing to arbitrate against.
              if (!duplicateActiveOps) entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '4h_15m', reason: 'active_op_exists' });
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
        // Fase 3 (docs/known-risks.md item 42) — off by default. Reuses the
        // SAME evaluateRegime the RF cascade already gates entries with
        // (scanner.js:207-213), now also reading tf1hData.tier/.adx/.chop
        // (populated in scanAsset only when pineConfig.smcTierEnabled is on —
        // see the guard change there). Positioned BEFORE hasActiveOp, same as
        // the RF block above, so a blocked regime also skips cross-cascade
        // arbitration for this signal — mirrors RF's own behavior exactly.
        const regime = pineConfig.smcTierEnabled ? evaluateRegime(tf1hData, pineConfig) : { ok: true, adxOk: true, chopOk: true };
        if (pineConfig.smcTierEnabled) smcRegimeOutcomes.push({
          dedup_key: signal.dedup_key, cascade: '1h_5m',
          ok: regime.ok, adxOk: regime.adxOk, chopOk: regime.chopOk,
          adx: tf1hData.adx?.adx ?? null, chop: tf1hData.chop ?? null, tier: tf1hData.tier?.tier ?? null,
        });
        if (!regime.ok) {
          entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '1h_5m', reason: 'regime_rejected' });
          await backend.entities.SystemLog.create({
            level: 'info',
            module: 'scanner',
            message: `${asset.symbol} 1H SMC ${signal.signal_type} — regime bloqueado (${!regime.adxOk ? 'ADX fraco' : ''}${!regime.adxOk && !regime.chopOk ? ' + ' : ''}${!regime.chopOk ? 'mercado lateralizado' : ''})`,
            symbol: asset.symbol,
            timeframe: '1h',
            details: { adx: tf1hData.adx?.adx ?? null, chop: tf1hData.chop ?? null, tier: tf1hData.tier?.tier ?? null, adxOk: regime.adxOk, chopOk: regime.chopOk },
          });
          continue;
        }
        // docs/known-risks.md item 37 (Bloco 4 Fase 1) — same per-cascade
        // gate as the RF block above.
        if (pineConfig.hierarchicalCascadesEnabled ? !hasActiveOp1h5m : !hasActiveOp) {
          // Fase 2 rodada 1 (docs/known-risks.md item 40) — same passthrough
          // guarantee as the RF block above: off by default, zero extra
          // fetch, byte-identical behaviour when pineConfig.retestEnabled is
          // false. Anchor is context.smc_broken_level (the swing this
          // specific BOS/CHoCH crossed) — NOT ote_leg_high/low (the leg's
          // extended/protected sides) nor structuralLevel from
          // check5mSmcConfirmation (the OPPOSITE pivot, used as the stop).
          const retestGate = pineConfig.retestEnabled
            ? await evaluateRetestGate({
                symbol: asset.symbol,
                direction: signal.signal_type,
                level: signal.context?.smc_broken_level,
                signalCandleTime: signal.candle_time,
                timeframe: '5m',
                pineConfig,
              })
            : null;
          if (retestGate) retestOutcomes.push({ dedup_key: signal.dedup_key, cascade: '1h_5m', retested: retestGate.retested, barsToConfirm: retestGate.barsToConfirm, reason: retestGate.reason });
          if (retestGate && !retestGate.retested) {
            entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '1h_5m', reason: 'retest_pending' });
            await backend.entities.SystemLog.create({
              level: 'info',
              module: 'scanner',
              message: `${asset.symbol} 1H SMC ${signal.signal_type} — aguardando reteste do nível ${retestGate.anchorLevel ?? 'n/d'} antes de confirmar no 5m`,
              symbol: asset.symbol,
              timeframe: '5m',
              details: { reason: 'awaiting_retest', retest_reason: retestGate.reason, anchor_level: retestGate.anchorLevel ?? null },
            });
          } else {
          const legBounds = { legHigh: signal.context?.ote_leg_high, legLow: signal.context?.ote_leg_low };
          const confirmed5m = await check5mSmcConfirmation(asset.symbol, signal.signal_type, legBounds);
          smcTriggerOutcomes.push({
            dedup_key: signal.dedup_key, cascade: '1h_5m',
            confirmed: confirmed5m.confirmed, trigger: confirmed5m.trigger ?? null,
            rejectReason: confirmed5m.rejectReason ?? null,
            sweepAligned: confirmed5m.sweepAligned ?? null, structureAligned: confirmed5m.structureAligned ?? null,
          });

          if (confirmed5m.confirmed) {
            // Fase 2 rodada 2 (docs/known-risks.md item 41) — off by default,
            // SMC only. Evaluated on the SAME closedCandles/trigger candle
            // check5mSmcConfirmation just found (no extra fetchCandles) —
            // see evaluateDisplacementGate's own comment above.
            const displacementGate = pineConfig.displacementEnabled
              ? evaluateDisplacementGate({
                  closedCandles: confirmed5m.closedCandles,
                  entryCandleTime: confirmed5m.entryCandleTime,
                  direction: signal.signal_type,
                  pineConfig,
                })
              : null;
            if (displacementGate) displacementOutcomes.push({ dedup_key: signal.dedup_key, cascade: '1h_5m', isDisplacement: displacementGate.isDisplacement, bodyRatio: displacementGate.bodyRatio, reason: displacementGate.reason });
            if (displacementGate && !displacementGate.isDisplacement) {
              entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '1h_5m', reason: 'displacement_gate_rejected' });
              await backend.entities.SystemLog.create({
                level: 'info',
                module: 'scanner',
                message: `${asset.symbol} 1H SMC ${signal.signal_type} — candle de entrada não atende ao gatilho de deslocamento (${displacementGate.reason})`,
                symbol: asset.symbol,
                timeframe: '5m',
                details: { reason: 'displacement_gate_rejected', displacement_reason: displacementGate.reason, body_ratio: displacementGate.bodyRatio, volume_ratio: displacementGate.volumeRatio },
              });
            } else {
            const opData = buildSmcTradeOpData(signal, tf1hData, pineConfig, confirmed5m);
            if (retestGate) stampRetestFields(opData, retestGate);
            if (displacementGate) stampDisplacementFields(opData, displacementGate);
            const minRR = pineConfig.minRR ?? 1.2;
            const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
            if (!rr.pass) {
              entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '1h_5m', reason: rr.reason });
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
              // docs/known-risks.md item 37 (Bloco 4 Fase 1) — stamped on
              // the op itself, read back by groupActiveOpsByAsset.
              if (pineConfig.hierarchicalCascadesEnabled) opData.hierarchical_cascade = true;
              const tradeOpId = `trade_smc_${signal.dedup_key}`;
              const created = await createTradeOpIfNoneActiveCapped(
                signal.asset_id, tradeOpId, opData,
                pineConfig.hierarchicalCascadesEnabled ? '1h_5m' : undefined,
              );
              if (created.created) {
                if (pineConfig.hierarchicalCascadesEnabled) {
                  hasActiveOp1h5m = true;
                  activeOp1h5m = created.doc;
                  activeOp4h15m = await coupleSiblingRiskOnOpen(activeOp4h15m, '4h_15m');
                } else {
                  hasActiveOp = true;
                }
                activeOp = created.doc;
                if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});
                logInfo('scanner', `${signal.symbol} entrada SMC criada (1h→5m)`, {
                  score: signal.context?.score ?? null, structure_type: signal.context?.structure_type ?? null, trigger: confirmed5m.trigger, rr: rr.rr1,
                }, { symbol: signal.symbol, timeframe: '5m' });
              }
            }
            }
          } else {
            // item 38: rejectReason distinguishes "no 5m trigger yet" from
            // "trigger fired but the OTE leg zone rejected it" — the latter
            // is the new gate's own rejection, worth telling apart from mere
            // waiting when reading SystemLog later. item 45.3/49: rejectReason
            // now also distinguishes insufficient_data/fetch_error from a
            // genuine no_trigger (check5mSmcConfirmation).
            entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '1h_5m', reason: confirmed5m.rejectReason });
            await backend.entities.SystemLog.create({
              level: 'info',
              module: 'scanner',
              message: `${asset.symbol} 1H SMC ${signal.signal_type} — aguardando confirmação no 5m`,
              symbol: asset.symbol,
              timeframe: '5m',
              details: {
                signal_tf: '1h',
                direction: signal.signal_type,
                structure_type: signal.context?.structure_type ?? null,
                reason: confirmed5m.rejectReason,
                ote_zone: confirmed5m.oteZone,
              },
            });
            if (confirmed5m.rejectReason === 'ote_zone_unfavorable') {
              smc5mZoneRejections.push({ dedup_key: signal.dedup_key, symbol: signal.symbol, signal_type: signal.signal_type, ote_zone: confirmed5m.oteZone });
            }
          }
          }
        } else if (pineConfig.hierarchicalCascadesEnabled) {
          // docs/known-risks.md item 37 (Bloco 4 Fase 1) — same reasoning as
          // the RF block above: no cross-cascade arbitration in hierarchical
          // mode, this just means the 1h_5m slot itself is already occupied.
          if (!duplicateActiveOps) entryFunnelOutcomes.push({ dedup_key: signal.dedup_key, cascade: '1h_5m', reason: 'active_op_exists' });
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
        // entryPrice/entryCandleTime here are only ever used for the
        // promotion_confirm_candle_time audit field below — never for
        // op.entry_price (already set at the op's original SMC creation) —
        // so a fresh results['4h'] read (this pass, not stale) is fine, no
        // need for the sig.price_at_signal-based drift guard the other call
        // sites need.
        const confirmed15m = await resolveEntryConfirmation15m({
          symbol: activeOp.symbol, direction: activeOp.side, asset, pineConfig,
          entryPrice: tf4h?.lastClose, entryCandleTime: tf4h?.lastCandleTime,
        });
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
  const rfRetryExpiryMs = 4 * ONE_HOUR_MS;
  const fourHoursAgo = new Date(Date.now() - rfRetryExpiryMs).toISOString();
  // Corte servidor-side: sem ele esta query pagava 10 leituras por ativo por
  // passada (312×/dia) para descartar quase todas pelo tempo no laço abaixo —
  // era o termo dominante da cota de LEITURA, o lado apertado do plano Spark
  // (known-risks item 133). A janela é MAIOR que a de expiração de propósito;
  // ver RETRY_QUERY_WINDOW_FACTOR.
  const rfRetryQueryFloor = new Date(
    Date.now() - rfRetryExpiryMs * RETRY_QUERY_WINDOW_FACTOR,
  ).toISOString();
  const recent4hSignals = await backend.entities.SignalEvent.filter({
    asset_id: asset.id,
    source: 'range_filter',
    timeframe: '4h',
    created_date: { gte: rfRetryQueryFloor },
  }, '-created_date', 10);

  for (const sig of recent4hSignals) {
    if (sig.created_date < fourHoursAgo) {
      // known-risks item 47.2 — antes disso a expiração era muda: sem
      // TradeOperation e sem SystemLog, indistinguível de um sinal que nunca
      // chegou a ser tentado. `expired_logged` já veio junto com `sig` no
      // fetch acima — não custa leitura extra, só grava (uma vez) quando
      // ainda não gravou.
      if (!sig.expired_logged) {
        await backend.entities.SignalEvent.update(sig.id, { expired_logged: true });
        await backend.entities.SystemLog.create({
          level: 'info',
          module: 'scanner',
          message: `${sig.symbol} 4h ${sig.signal_type} — sinal expirou sem nunca confirmar entrada (4h)${sig.last_rejection_reason ? ` — último motivo: ${sig.last_rejection_reason}` : ''}`,
          symbol: sig.symbol,
          timeframe: '4h',
          details: { dedup_key: sig.dedup_key, signal_created_at: sig.created_date, cascade: '4h_15m', last_rejection_reason: sig.last_rejection_reason ?? null },
        });
      }
      continue; // stale, skip
    }
    if (sig.is_dismissed) continue;
    // docs/known-risks.md item 78 — same gate as the 1st-pass branch above:
    // native cascade creates no operation while this flag is on, freeing
    // the slot entirely for RF_1H_COND_CASCADE/RF_1H_UNCOND_CASCADE.
    if (pineConfig.rf1hExclusiveEnabled) continue;

    // docs/known-risks.md item 37 (Bloco 4 Fase 1) — same per-cascade gate
    // as the 1st pass above; activeOp4h15m (not the shared activeOp) is the
    // right reference in hierarchical mode since a same-pass 1h_5m creation
    // never touches it.
    if (pineConfig.hierarchicalCascadesEnabled ? hasActiveOp4h15m : hasActiveOp) {
      // Codex review (PR #102): this same signal is re-evaluated by this
      // retry loop on every scan while ITS OWN op stays open (it stays in
      // the `recent4hSignals` lookback until 9 newer signals bump it out or
      // it ages past the 4h window) — including the very same
      // persistScanResults call that just created the op via the 1st-pass
      // block above. That is not a rejection, it is the signal that
      // SUCCEEDED; counting it as `active_op_exists` would make every
      // successful RF entry pollute the funnel with a false rejection each
      // pass. tradeOpId mirrors the deterministic id the 1st-pass/retry
      // creation blocks both use (`trade_${dedup_key}`), so this only
      // suppresses the count for the signal that actually owns activeOp —
      // a genuinely different pending signal blocked by another op still
      // counts normally.
      const ownsActiveOp = (pineConfig.hierarchicalCascadesEnabled ? activeOp4h15m : activeOp)?.id === `trade_${sig.dedup_key}`;
      if (!ownsActiveOp) entryFunnelOutcomes.push({ dedup_key: sig.dedup_key, cascade: '4h_15m', reason: 'active_op_exists' });
      continue;
    }

    // Verify 4H trend still aligned with signal direction (may have reversed)
    const tfData4h = results['4h'];
    if (!tfData4h || !tfData4h.atrValue) continue;
    // docs/known-risks.md item 71 — mesmo gate do 1º passo, aqui no retry.
    // Codex review (PR #156): diferente de trend_reversed/regime_rejected
    // (que podem genuinely mudar de passada pra passada), o LADO de um
    // sinal é decidido no nascimento e nunca muda dentro do run — usar
    // recordRejection aqui empurraria uma rejeição nova (em memória) a
    // CADA passada de retry até o sinal expirar (~48x numa janela de 4h a
    // cada 5min), inflando `report.entryFunnel...side_filter_blocked` bem
    // além da contagem real de sinais bloqueados. Grava/conta só na 1ª vez.
    if (pineConfig.allowedSide && sig.signal_type !== pineConfig.allowedSide) {
      if (sig.last_rejection_reason !== 'side_filter_blocked') {
        entryFunnelOutcomes.push({ dedup_key: sig.dedup_key, cascade: '4h_15m', reason: 'side_filter_blocked' });
        await backend.entities.SignalEvent.update(sig.id, { last_rejection_reason: 'side_filter_blocked' });
        sig.last_rejection_reason = 'side_filter_blocked';
      }
      continue;
    }
    // docs/known-risks.md item 100 — mesmo gate do 1º passo, aqui no retry.
    // Diferente de allowedSide (o LADO é decidido no nascimento do sinal e
    // nunca muda dentro do run — por isso aquele usa write-on-change
    // manual), a direção 1D é condição de mercado AO VIVO — pode
    // genuinamente mudar entre passadas de retry, mesma classe de
    // trend_reversed/regime_rejected logo abaixo. Por isso usa
    // recordRejection (o helper padrão), não o inline manual de allowedSide.
    // Codex review (PR #203): ler sig.context.tf_1d_direction aqui seria o
    // valor CONGELADO no nascimento do sinal — nunca mudaria entre
    // retries, contradizendo o próprio comentário acima. Lê o 1D AO VIVO
    // de results['1d'] (já buscado nesta mesma passada, mesmo padrão de
    // tfData4h.rf.direction logo abaixo) — undefined conta como bloqueado,
    // mesma filosofia conservadora do gate original.
    if (pineConfig.buyRegimeFilterEnabled && sig.signal_type === 'BUY' && results['1d']?.rf?.direction !== 1) {
      await recordRejection(sig, '4h_15m', 'buy_regime_filter_blocked', entryFunnelOutcomes);
      continue;
    }
    const tf4hDir = tfData4h.rf.direction;
    const sigDir = sig.signal_type === 'BUY' ? 1 : -1;
    if (tf4hDir !== sigDir) { await recordRejection(sig, '4h_15m', 'trend_reversed', entryFunnelOutcomes); continue; }

    // Regime gate (ADX + Choppiness) — re-evaluated every retry pass since
    // conditions may have changed since the signal first fired.
    const regime = evaluateRegime(tfData4h, pineConfig);
    rfRegimeOutcomes.push({
      dedup_key: sig.dedup_key, cascade: '4h_15m',
      ok: regime.ok, adxOk: regime.adxOk, chopOk: regime.chopOk,
      adx: tfData4h.adx?.adx ?? null, chop: tfData4h.chop ?? null, tier: tfData4h.tier?.tier ?? null,
    });
    if (!regime.ok) { await recordRejection(sig, '4h_15m', 'regime_rejected', entryFunnelOutcomes); continue; }

    // Candle pattern gate (engolfo) — re-evaluated every retry pass, same
    // reasoning as regime above: the signal candle doesn't change, but the
    // flag/config could between passes.
    const candlePattern = evaluateCandlePatternGate(tfData4h, sig.signal_type, pineConfig);
    if (candlePattern) {
      candlePatternOutcomes.push({ dedup_key: sig.dedup_key, cascade: '4h_15m', ok: candlePattern.ok, pattern: candlePattern.pattern, reason: candlePattern.reason });
      if (!candlePattern.ok) { await recordRejection(sig, '4h_15m', 'candle_pattern_rejected', entryFunnelOutcomes); continue; }
    }

    // Same optional SMC confirmation gate as the initial entry check —
    // re-evaluated every retry pass since trend/zone may have changed
    // since the signal first fired.
    if (asset.smc_confirm_4h15m && tfData4h.smc) {
      const trendAligned = sigDir === 1 ? tfData4h.smc.trend === 1 : tfData4h.smc.trend === -1;
      const zoneOk = sigDir === 1 ? tfData4h.smc.pdZone !== 'premium' : tfData4h.smc.pdZone !== 'discount';
      if (!trendAligned || !zoneOk) { await recordRejection(sig, '4h_15m', 'smc_confirm_zone_rejected', entryFunnelOutcomes); continue; }
    }

    // Fase 2 rodada 1 (docs/known-risks.md item 40) — off by default, same
    // passthrough guarantee as the 1st-pass block above. Silent on a miss
    // (no SystemLog), matching this retry loop's own established pattern
    // just below (!confirmed.confirmed -> continue with no log) — the 1st
    // pass already wrote the "awaiting_retest" record once; logging again on
    // every ~5min retry tick would be exactly the write-per-pending-signal
    // spam this loop was built to avoid.
    const retestGate = pineConfig.retestEnabled
      ? await evaluateRetestGate({
          symbol: sig.symbol,
          direction: sig.signal_type,
          level: sig.context?.rf_value,
          signalCandleTime: sig.candle_time,
          timeframe: '15m',
          pineConfig,
        })
      : null;
    // In-memory only (no Firestore write) — cheap to push every retry tick,
    // unlike the SystemLog above. backtestEngine.js dedupes by dedup_key,
    // last-write-wins, so a later "retested:true" here correctly overwrites
    // the "pending" outcome the 1st pass recorded.
    if (retestGate) retestOutcomes.push({ dedup_key: sig.dedup_key, cascade: '4h_15m', retested: retestGate.retested, barsToConfirm: retestGate.barsToConfirm, reason: retestGate.reason });
    if (retestGate && !retestGate.retested) { await recordRejection(sig, '4h_15m', 'retest_pending', entryFunnelOutcomes); continue; }

    // Re-run 15m confirmation (or bypass it — pineConfig.skip15mConfirmationEnabled,
    // item 67). Codex review (PR #147, P1): a retry can fire hours after the
    // signal was born (blocked earlier by active_op_exists/regime/retest —
    // this loop's own reason for existing). Bypassed, this must use the
    // CURRENT pass's tfData4h.lastClose/lastCandleTime as entry — a stale
    // sig.price_at_signal here would open the position at a price that may
    // no longer be executable, mixing an hours-old entry with THIS pass's
    // current ATR/stop/tp math. tfData4h is guaranteed same-direction as the
    // signal at this point (the trend_reversed guard above already checked
    // it), so it's a safe, causal substitute — same pattern already used by
    // the promotion confirmation above (tf4h.lastClose/lastCandleTime).
    const confirmed = await resolveEntryConfirmation15m({
      symbol: sig.symbol, direction: sig.signal_type, asset, pineConfig,
      entryPrice: tfData4h.lastClose, entryCandleTime: tfData4h.lastCandleTime,
    });
    if (!confirmed.confirmed) { await recordRejection(sig, '4h_15m', 'confirmation_15m_not_aligned', entryFunnelOutcomes); continue; }

    const opData = buildTradeOpData(sig, tfData4h, pineConfig, confirmed);
    if (pineConfig.smcAlignmentScoreEnabled) {
      opData.smc_alignment_at_entry = computeSmcAlignmentAtEntry(sig.signal_type, tfData4h.smc, sig.context?.smc_align_leg_high, sig.context?.smc_align_leg_low, opData.entry_price);
    }
    if (retestGate) stampRetestFields(opData, retestGate);
    const minRR = pineConfig.minRR ?? 1.2;
    const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
    if (!rr.pass) {
      await recordRejection(sig, '4h_15m', rr.reason, entryFunnelOutcomes);
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
    // docs/known-risks.md item 37 (Bloco 4 Fase 1) — stamped on the op
    // itself, read back by groupActiveOpsByAsset.
    if (pineConfig.hierarchicalCascadesEnabled) opData.hierarchical_cascade = true;

    const tradeOpId = `trade_${sig.dedup_key || sig.id}`;
    const created = await createTradeOpIfNoneActiveCapped(
      sig.asset_id, tradeOpId, opData,
      pineConfig.hierarchicalCascadesEnabled ? '4h_15m' : undefined,
    );
    if (!created.created) continue;
    if (pineConfig.hierarchicalCascadesEnabled) {
      hasActiveOp4h15m = true;
      activeOp4h15m = created.doc;
      activeOp1h5m = await coupleSiblingRiskOnOpen(activeOp1h5m, '1h_5m');
    } else {
      hasActiveOp = true;
    }

    if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});

    await backend.entities.SystemLog.create({
      level: 'info',
      module: 'scanner',
      message: `${sig.symbol} 4h ${sig.signal_type} — confirmação 15m OK, entrada criada`,
      symbol: sig.symbol,
      timeframe: '15m',
      details: { signal_tf: '4h', direction: sig.signal_type, score: sig.context?.score ?? null, rr: rr.rr1, retry: true },
    });
  }

  // ─── Retry: re-check 15m confirmation for pending 1h signals (RF 1h
  // condicionado ao 4h, Fase 1, docs/known-risks.md item 56 "Fase 1") ───
  // Backtest-only (pineConfig.rf1hCondEnabled) — skip entirely when off,
  // zero extra Firestore read, mesma convenção dos demais flags opt-in.
  // Janela de retry de 4 BARRAS de 1h (não "4h absolutos" da cascata 4h
  // nativa acima) — mesmo padrão já usado pelo retry SMC logo abaixo, que
  // também parte de um sinal-mãe de 1h.
  if (pineConfig.rf1hCondEnabled === true) {
    const oneHourAgo4xRf = new Date(Date.now() - 4 * ONE_HOUR_MS).toISOString();
    const recent1hRfSignals = await backend.entities.SignalEvent.filter({
      asset_id: asset.id,
      source: 'range_filter',
      timeframe: '1h',
    }, '-created_date', 10);

    for (const sig of recent1hRfSignals) {
      if (sig.created_date < oneHourAgo4xRf) {
        if (!sig.expired_logged) {
          await backend.entities.SignalEvent.update(sig.id, { expired_logged: true });
          await backend.entities.SystemLog.create({
            level: 'info',
            module: 'scanner',
            message: `${sig.symbol} 1h RF ${sig.signal_type} — sinal expirou sem nunca confirmar entrada (15m, experimental)${sig.last_rejection_reason ? ` — último motivo: ${sig.last_rejection_reason}` : ''}`,
            symbol: sig.symbol,
            timeframe: '1h',
            details: { dedup_key: sig.dedup_key, signal_created_at: sig.created_date, cascade: RF_1H_COND_CASCADE, last_rejection_reason: sig.last_rejection_reason ?? null },
          });
        }
        continue;
      }
      if (sig.is_dismissed) continue;

      if (hasActiveOp) {
        const ownsActiveOp = activeOp?.id === `trade_${sig.dedup_key}`;
        if (!ownsActiveOp) entryFunnelOutcomes.push({ dedup_key: sig.dedup_key, cascade: RF_1H_COND_CASCADE, reason: 'active_op_exists' });
        continue;
      }

      const tfData4h = results['4h'];
      if (!tfData4h || !tfData4h.atrValue) continue;
      const tf4hDir = tfData4h.rf.direction;
      const sigDir = sig.signal_type === 'BUY' ? 1 : -1;
      if (tf4hDir !== sigDir) { await recordRejection(sig, RF_1H_COND_CASCADE, 'trend_reversed', entryFunnelOutcomes); continue; }

      const regime = evaluateRegime(tfData4h, pineConfig);
      rfRegimeOutcomes.push({
        dedup_key: sig.dedup_key, cascade: RF_1H_COND_CASCADE,
        ok: regime.ok, adxOk: regime.adxOk, chopOk: regime.chopOk,
        adx: tfData4h.adx?.adx ?? null, chop: tfData4h.chop ?? null, tier: tfData4h.tier?.tier ?? null,
      });
      if (!regime.ok) { await recordRejection(sig, RF_1H_COND_CASCADE, 'regime_rejected', entryFunnelOutcomes); continue; }

      // Codex review (PR #147, P1) — same reasoning as the native retry loop
      // above: a retry here can fire hours after the signal was born, so a
      // bypassed confirmation must use the CURRENT tfData4h (causal,
      // executable), never the stale sig.price_at_signal. tfData4h is
      // confirmed same-direction by the trend_reversed guard just above.
      const confirmed = await resolveEntryConfirmation15m({
        symbol: sig.symbol, direction: sig.signal_type, asset, pineConfig,
        entryPrice: tfData4h.lastClose, entryCandleTime: tfData4h.lastCandleTime,
      });
      if (!confirmed.confirmed) { await recordRejection(sig, RF_1H_COND_CASCADE, 'confirmation_15m_not_aligned', entryFunnelOutcomes); continue; }

      const opData = buildTradeOpData(sig, tfData4h, pineConfig, confirmed, { cascade: RF_1H_COND_CASCADE, signalTimeframe: '1h' });
      const minRR = pineConfig.minRR ?? 1.2;
      const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
      if (!rr.pass) {
        await recordRejection(sig, RF_1H_COND_CASCADE, rr.reason, entryFunnelOutcomes);
        continue;
      }
      opData.rr_at_entry = rr.rr1;
      opData.rr_gate_mode = RR_GATE_MODE;
      opData.rr_target_basis = RR_TARGET_BASIS;

      const tradeOpId = `trade_${sig.dedup_key || sig.id}`;
      const created = await createTradeOpIfNoneActiveCapped(sig.asset_id, tradeOpId, opData);
      if (!created.created) continue;
      hasActiveOp = true;
      activeOp = created.doc;

      if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});

      await backend.entities.SystemLog.create({
        level: 'info',
        module: 'scanner',
        message: `${sig.symbol} 1h RF ${sig.signal_type} — confirmação 15m OK, entrada criada (condicionado ao 4h, experimental)`,
        symbol: sig.symbol,
        timeframe: '15m',
        details: { signal_tf: '1h', direction: sig.signal_type, score: sig.context?.score ?? null, rr: rr.rr1, retry: true },
      });
    }
  }

  // ─── Retry: re-check 15m confirmation for pending 1h signals (RF 1h
  // TOTALMENTE independente do 4h, docs/known-risks.md item 68) ───
  // Backtest-only (pineConfig.rf1hUncondEnabled) — skip entirely when off,
  // zero extra Firestore read. Bloco IRMÃO do retry rf1hCondEnabled acima
  // (não aninhado) — mesma query de SignalEvent, mesma janela de retry de
  // 4 barras de 1h; a única diferença é a ausência do gate `tf4hDir !==
  // sigDir`. createTradeOpIfNoneActive dedupa por tradeOpId determinístico
  // (`trade_${dedup_key}`), então não há risco de dupla-criação mesmo que
  // os dois blocos avaliem o mesmo sinal na mesma passada (convenção do
  // projeto: nunca ligar os dois flags juntos, mas o dedup protege mesmo
  // assim).
  if (pineConfig.rf1hUncondEnabled === true) {
    const oneHourAgo4xRfUncond = new Date(Date.now() - 4 * ONE_HOUR_MS).toISOString();
    const recent1hRfSignalsUncond = await backend.entities.SignalEvent.filter({
      asset_id: asset.id,
      source: 'range_filter',
      timeframe: '1h',
    }, '-created_date', 10);

    for (const sig of recent1hRfSignalsUncond) {
      if (sig.created_date < oneHourAgo4xRfUncond) {
        if (!sig.expired_logged) {
          await backend.entities.SignalEvent.update(sig.id, { expired_logged: true });
          await backend.entities.SystemLog.create({
            level: 'info',
            module: 'scanner',
            message: `${sig.symbol} 1h RF ${sig.signal_type} — sinal expirou sem nunca confirmar entrada (15m, independente do 4h, experimental)${sig.last_rejection_reason ? ` — último motivo: ${sig.last_rejection_reason}` : ''}`,
            symbol: sig.symbol,
            timeframe: '1h',
            details: { dedup_key: sig.dedup_key, signal_created_at: sig.created_date, cascade: RF_1H_UNCOND_CASCADE, last_rejection_reason: sig.last_rejection_reason ?? null },
          });
        }
        continue;
      }
      if (sig.is_dismissed) continue;

      if (hasActiveOp) {
        const ownsActiveOp = activeOp?.id === `trade_${sig.dedup_key}`;
        if (!ownsActiveOp) entryFunnelOutcomes.push({ dedup_key: sig.dedup_key, cascade: RF_1H_UNCOND_CASCADE, reason: 'active_op_exists' });
        continue;
      }

      const tfData4hUncond = results['4h'];
      if (!tfData4hUncond || !tfData4hUncond.atrValue) continue;

      const regime = evaluateRegime(tfData4hUncond, pineConfig);
      rfRegimeOutcomes.push({
        dedup_key: sig.dedup_key, cascade: RF_1H_UNCOND_CASCADE,
        ok: regime.ok, adxOk: regime.adxOk, chopOk: regime.chopOk,
        adx: tfData4hUncond.adx?.adx ?? null, chop: tfData4hUncond.chop ?? null, tier: tfData4hUncond.tier?.tier ?? null,
      });
      if (!regime.ok) { await recordRejection(sig, RF_1H_UNCOND_CASCADE, 'regime_rejected', entryFunnelOutcomes); continue; }

      // Mesmo raciocínio do retry rf1hCondEnabled (Codex PR #147, P1): usar
      // o candle 4h ATUAL (causal/executável) como entrada, nunca o
      // sig.price_at_signal obsoleto — aqui não há guard de trend_reversed
      // pra confirmar direção antes (não existe mais essa checagem), mas
      // tfData4hUncond ainda é a referência de risk sizing (ATR/tier),
      // igual ao bloco A — não a fonte de direção do sinal.
      const confirmed = await resolveEntryConfirmation15m({
        symbol: sig.symbol, direction: sig.signal_type, asset, pineConfig,
        entryPrice: tfData4hUncond.lastClose, entryCandleTime: tfData4hUncond.lastCandleTime,
      });
      if (!confirmed.confirmed) { await recordRejection(sig, RF_1H_UNCOND_CASCADE, 'confirmation_15m_not_aligned', entryFunnelOutcomes); continue; }

      const opData = buildTradeOpData(sig, tfData4hUncond, pineConfig, confirmed, { cascade: RF_1H_UNCOND_CASCADE, signalTimeframe: '1h' });
      const minRR = pineConfig.minRR ?? 1.2;
      const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
      if (!rr.pass) {
        await recordRejection(sig, RF_1H_UNCOND_CASCADE, rr.reason, entryFunnelOutcomes);
        continue;
      }
      opData.rr_at_entry = rr.rr1;
      opData.rr_gate_mode = RR_GATE_MODE;
      opData.rr_target_basis = RR_TARGET_BASIS;

      const tradeOpId = `trade_${sig.dedup_key || sig.id}`;
      const created = await createTradeOpIfNoneActiveCapped(sig.asset_id, tradeOpId, opData);
      if (!created.created) continue;
      hasActiveOp = true;
      activeOp = created.doc;

      if (isTelegramConfigured()) notifyTradeCreated(created.doc).catch(() => {});

      await backend.entities.SystemLog.create({
        level: 'info',
        module: 'scanner',
        message: `${sig.symbol} 1h RF ${sig.signal_type} — confirmação 15m OK, entrada criada (independente do 4h, experimental)`,
        symbol: sig.symbol,
        timeframe: '15m',
        details: { signal_tf: '1h', direction: sig.signal_type, score: sig.context?.score ?? null, rr: rr.rr1, retry: true },
      });
    }
  }

  // ─── Retry: re-check 5m SMC confirmation for pending 1h signals ───
  if (asset.smc_enabled) {
    const smcRetryExpiryMs = 4 * ONE_HOUR_MS;
    const oneHourAgo4x = new Date(Date.now() - smcRetryExpiryMs).toISOString();
    // Gêmeo do corte da cascata RF acima — mesmo motivo, mesma ressalva de
    // expiração (known-risks item 133).
    const smcRetryQueryFloor = new Date(
      Date.now() - smcRetryExpiryMs * RETRY_QUERY_WINDOW_FACTOR,
    ).toISOString();
    const recentSmcSignals = await backend.entities.SignalEvent.filter({
      asset_id: asset.id,
      source: 'smc_structure',
      timeframe: '1h',
      created_date: { gte: smcRetryQueryFloor },
    }, '-created_date', 10);

    for (const sig of recentSmcSignals) {
      if (sig.created_date < oneHourAgo4x) {
        // Mesmo mecanismo do retry RF acima — known-risks item 45.4/47.2.
        if (!sig.expired_logged) {
          await backend.entities.SignalEvent.update(sig.id, { expired_logged: true });
          await backend.entities.SystemLog.create({
            level: 'info',
            module: 'scanner',
            message: `${sig.symbol} 1h SMC ${sig.signal_type} — sinal expirou sem nunca confirmar entrada (5m)${sig.last_rejection_reason ? ` — último motivo: ${sig.last_rejection_reason}` : ''}`,
            symbol: sig.symbol,
            timeframe: '1h',
            details: { dedup_key: sig.dedup_key, signal_created_at: sig.created_date, cascade: '1h_5m', last_rejection_reason: sig.last_rejection_reason ?? null },
          });
        }
        continue; // stale, skip
      }
      if (sig.is_dismissed) continue;

      // docs/known-risks.md item 37 (Bloco 4 Fase 1) — same per-cascade gate
      // as the 1st pass above.
      if (pineConfig.hierarchicalCascadesEnabled ? hasActiveOp1h5m : hasActiveOp) {
        // Codex review (PR #102) — same reasoning as the RF retry loop above:
        // don't count the signal that OWNS the currently active op as a
        // false `active_op_exists` rejection.
        const ownsActiveOp = (pineConfig.hierarchicalCascadesEnabled ? activeOp1h5m : activeOp)?.id === `trade_smc_${sig.dedup_key}`;
        if (!ownsActiveOp) entryFunnelOutcomes.push({ dedup_key: sig.dedup_key, cascade: '1h_5m', reason: 'active_op_exists' });
        continue;
      }

      // Verify 1h structure bias still aligned (may have reversed since signal fired)
      const tfData1h = results['1h'];
      if (!tfData1h || !tfData1h.atrValue || !tfData1h.smc) continue;
      const sigDir = sig.signal_type === 'BUY' ? 1 : -1;
      if (tfData1h.smc.trend !== sigDir) { await recordRejection(sig, '1h_5m', 'trend_reversed', entryFunnelOutcomes); continue; }

      // Fase 3 (docs/known-risks.md item 42) — off by default; silent on
      // reject, same reasoning as the retest/displacement retry loops below
      // (no SystemLog per ~5min retry tick, 1st pass already logged it once).
      const regime = pineConfig.smcTierEnabled ? evaluateRegime(tfData1h, pineConfig) : { ok: true, adxOk: true, chopOk: true };
      if (pineConfig.smcTierEnabled) smcRegimeOutcomes.push({
        dedup_key: sig.dedup_key, cascade: '1h_5m',
        ok: regime.ok, adxOk: regime.adxOk, chopOk: regime.chopOk,
        adx: tfData1h.adx?.adx ?? null, chop: tfData1h.chop ?? null, tier: tfData1h.tier?.tier ?? null,
      });
      if (!regime.ok) { await recordRejection(sig, '1h_5m', 'regime_rejected', entryFunnelOutcomes); continue; }

      // Fase 2 rodada 1 (docs/known-risks.md item 40) — off by default;
      // silent on a miss, same reasoning as the RF retry loop above (the 1st
      // pass already logged "awaiting_retest" once). Anchor is
      // context.smc_broken_level, same field the 1st-pass SMC block reads —
      // legacy signals predating this round have no such field and fail
      // closed (evaluateRetestGate/detectRetest both return retested:false
      // on a null level), unlike legBounds' fail-open just below.
      const retestGate = pineConfig.retestEnabled
        ? await evaluateRetestGate({
            symbol: sig.symbol,
            direction: sig.signal_type,
            level: sig.context?.smc_broken_level,
            signalCandleTime: sig.candle_time,
            timeframe: '5m',
            pineConfig,
          })
        : null;
      // In-memory only — see the RF retry loop's comment above.
      if (retestGate) retestOutcomes.push({ dedup_key: sig.dedup_key, cascade: '1h_5m', retested: retestGate.retested, barsToConfirm: retestGate.barsToConfirm, reason: retestGate.reason });
      if (retestGate && !retestGate.retested) { await recordRejection(sig, '1h_5m', 'retest_pending', entryFunnelOutcomes); continue; }

      // Legacy SignalEvents predating item 38 have no ote_leg_high/low —
      // legBounds resolves to {legHigh: undefined, legLow: undefined},
      // which classifyZone (via check5mSmcConfirmation) already treats as
      // not-evaluable and fails OPEN, same as a freshly-created signal whose
      // protected pivot wasn't confirmed yet.
      const legBounds = { legHigh: sig.context?.ote_leg_high, legLow: sig.context?.ote_leg_low };
      const confirmed = await check5mSmcConfirmation(sig.symbol, sig.signal_type, legBounds);
      smcTriggerOutcomes.push({
        dedup_key: sig.dedup_key, cascade: '1h_5m',
        confirmed: confirmed.confirmed, trigger: confirmed.trigger ?? null,
        rejectReason: confirmed.rejectReason ?? null,
        sweepAligned: confirmed.sweepAligned ?? null, structureAligned: confirmed.structureAligned ?? null,
      });
      if (!confirmed.confirmed) { await recordRejection(sig, '1h_5m', confirmed.rejectReason, entryFunnelOutcomes); continue; }

      // Fase 2 rodada 2 (docs/known-risks.md item 41) — off by default;
      // silent on a miss, same reasoning as the retest gate above (no
      // SystemLog per ~5min retry tick). Reuses confirmed.closedCandles —
      // no extra fetchCandles.
      const displacementGate = pineConfig.displacementEnabled
        ? evaluateDisplacementGate({
            closedCandles: confirmed.closedCandles,
            entryCandleTime: confirmed.entryCandleTime,
            direction: sig.signal_type,
            pineConfig,
          })
        : null;
      if (displacementGate) displacementOutcomes.push({ dedup_key: sig.dedup_key, cascade: '1h_5m', isDisplacement: displacementGate.isDisplacement, bodyRatio: displacementGate.bodyRatio, reason: displacementGate.reason });
      if (displacementGate && !displacementGate.isDisplacement) { await recordRejection(sig, '1h_5m', 'displacement_gate_rejected', entryFunnelOutcomes); continue; }

      const opData = buildSmcTradeOpData(sig, tfData1h, pineConfig, confirmed);
      if (retestGate) stampRetestFields(opData, retestGate);
      if (displacementGate) stampDisplacementFields(opData, displacementGate);
      const minRR = pineConfig.minRR ?? 1.2;
      const rr = passesRiskReward({ entry: opData.entry_price, stop: opData.initial_stop, tp1: opData.tp1, tp2: opData.tp2, minRR });
      if (!rr.pass) {
        await recordRejection(sig, '1h_5m', rr.reason, entryFunnelOutcomes);
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
      // docs/known-risks.md item 37 (Bloco 4 Fase 1) — stamped on the op
      // itself, read back by groupActiveOpsByAsset.
      if (pineConfig.hierarchicalCascadesEnabled) opData.hierarchical_cascade = true;

      const tradeOpId = `trade_smc_${sig.dedup_key || sig.id}`;
      const created = await createTradeOpIfNoneActiveCapped(
        sig.asset_id, tradeOpId, opData,
        pineConfig.hierarchicalCascadesEnabled ? '1h_5m' : undefined,
      );
      if (!created.created) continue;
      if (pineConfig.hierarchicalCascadesEnabled) {
        hasActiveOp1h5m = true;
        activeOp1h5m = created.doc;
        activeOp4h15m = await coupleSiblingRiskOnOpen(activeOp4h15m, '4h_15m');
      } else {
        hasActiveOp = true;
      }

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
    // Set below (RUNNER_ACTIVE branch only) when a trailing advance happens
    // this pass — passed to transitionTradeOp so it can drop the marker
    // transactionally if a racing worker's fresher stop wins the clamp
    // instead (docs/known-risks.md item 59 addendum).
    let stopAdvanceMarkerField = null;

    // Bars since entry, in units of the SIGNAL timeframe — same elapsed-time
    // proxy the Time Stop already uses below (barsOpen), lifted up here so
    // both branches (pre/post TP1) and the MFE/MAE block can share it.
    const barMs = SIGNAL_TF_MS[op.signal_timeframe] || FOUR_HOURS_MS;
    const barsSinceEntry = entryRef && tfData.lastCandleTime
      ? Math.round((new Date(tfData.lastCandleTime).getTime() - new Date(entryRef).getTime()) / barMs)
      : null;

    // MFE/MAE — known-risks item 47.2. Recomputed every pass from THIS
    // candle's high/low, which is unchanged pass-to-pass until a new candle
    // closes — so mfe_r/mae_r naturally stabilize within a candle and only
    // (therefore only ever WRITE, via the guard below) change when a
    // genuinely new extreme candle arrives, the same write cadence as
    // everything else in this loop, not a new source of per-pass writes.
    // Gated by candleUsable for the same P0-c/P0-g reason as stop/TP: a
    // pre-entry candle's range must never count as this operation's
    // excursion.
    let mfeR = op.mfe_r;
    let maeR = op.mae_r;
    let barsToMfe = op.bars_to_mfe ?? null;
    let barsToMae = op.bars_to_mae ?? null;
    if (candleUsable && Number.isFinite(op.entry_price) && Number.isFinite(op.initial_stop)) {
      const excursionRisk = Math.abs(op.entry_price - op.initial_stop);
      if (excursionRisk > 0) {
        const favorableExtreme = isBuy ? candleHigh : candleLow;
        const adverseExtreme = isBuy ? candleLow : candleHigh;
        const sign = isBuy ? 1 : -1;
        const favorableR = (sign * (favorableExtreme - op.entry_price)) / excursionRisk;
        const adverseR = (sign * (adverseExtreme - op.entry_price)) / excursionRisk;
        if (!Number.isFinite(mfeR) || favorableR > mfeR) { mfeR = favorableR; barsToMfe = barsSinceEntry; }
        if (!Number.isFinite(maeR) || adverseR < maeR) { maeR = adverseR; barsToMae = barsSinceEntry; }
      }
    }
    if (mfeR !== op.mfe_r) { updatePayload.mfe_r = mfeR; updatePayload.bars_to_mfe = barsToMfe; }
    if (maeR !== op.mae_r) { updatePayload.mae_r = maeR; updatePayload.bars_to_mae = barsToMae; }

    if (!tp1Hit) {
      // Codex review (PR #106, P1): the cron re-runs persistScanResults every
      // ~5 minutes while the signal timeframe's candle (4h/1h) can stay the
      // "latest closed" one for hours — so the SAME candle is re-evaluated
      // many times before a genuinely new one closes (same reason
      // rf_reverse_bars_count dedups by candle below). If the pre-TP1 stop
      // protection gate (docs/known-risks.md items 53/54) advances
      // current_stop on pass N using THIS candle's close, pass N+1 would
      // test this SAME candle's low/high against the NEWLY advanced stop —
      // a look-ahead false STOP_HIT using data already safely evaluated
      // against the OLD stop in pass N. Reproduced: entry 100, stop 98,
      // candle low 99/high 102.5/close 102.5 — pass 1 doesn't stop (99 > 98),
      // advances to breakeven 100; pass 2 (same candle) would read
      // 99 <= 100 = true. Excluding the candle that caused the LAST advance
      // from the stop check (mirrors candleUsable's "already settled, don't
      // re-litigate" contract) closes this — `undefined !== lastCandleTime`
      // keeps every op that never used the gate byte-identical to before.
      const stopAdvancedThisCandle = op.pre_tp1_stop_advanced_candle_time != null
        && op.pre_tp1_stop_advanced_candle_time === tfData.lastCandleTime;
      // Check stop first (stop has priority over TP on same candle for safety)
      const stopHit = candleUsable && !stopAdvancedThisCandle
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

      // Codex review (PR #213): stop_hit_real_time/tp1_hit_real_time/
      // tp2_hit_real_time below are the CLOSE of the candle whose high/low
      // (stopCheckPrice/tpCheckPrice, both intrabar extremes) confirmed the
      // exit — an upper bound on when the level was actually touched, not
      // the exact intrabar instant (only OHLC is available here, no tick
      // data within the candle). For a 4h candle, the true cross could be
      // up to ~4h earlier than this value. Still far more accurate than
      // the wall-clock *_at during a cron gap (which can be off by days,
      // not hours) — DetectionLag/UI/Telegram label these "(vela)" to keep
      // this bound honest rather than implying tick-level precision.
      // INVALIDATION/CHOP_EXIT below are different: their condition is
      // evaluated directly against the candle's CLOSE price, so their
      // closed_at_real_time IS the exact decision instant, no caveat.
      if (stopHit) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_real_time = tfData.lastCandleTime || null;
        updatePayload.stop_hit_price = op.current_stop;
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
        updatePayload.closed_at_real_time = tfData.lastCandleTime || null;
        updatePayload.bars_to_stop = barsSinceEntry;
        if (stopTp1Ambiguous) updatePayload.exit_ambiguous = true;
      } else if (invalidationTriggered) {
        newStatus = 'INVALIDATED';
        updatePayload.closed_reason = 'INVALIDATION';
        updatePayload.exit_price = closePrice;
        updatePayload.closed_at = nowIso;
        updatePayload.closed_at_real_time = tfData.lastCandleTime || null;
      } else if (chopExitTriggered) {
        newStatus = 'CLOSED';
        updatePayload.closed_reason = 'CHOP_EXIT';
        updatePayload.exit_price = closePrice;
        updatePayload.closed_at = nowIso;
        updatePayload.closed_at_real_time = tfData.lastCandleTime || null;
      } else if (timeStopTriggered) {
        newStatus = 'CLOSED';
        updatePayload.closed_reason = 'TIME_STOP';
        updatePayload.exit_price = closePrice;
        updatePayload.closed_at = nowIso;
        // Codex review (PR #213): Time Stop fires off WALL-CLOCK age
        // (barsOpen above), unrelated to tfData.lastCandleTime — using the
        // candle's close here would label an arbitrary earlier timestamp as
        // the "real" trigger. The real trigger is deterministic: the exact
        // instant the deadline (entryRef + timeStopBars candles) elapsed.
        updatePayload.closed_at_real_time = entryRef
          ? new Date(new Date(entryRef).getTime() + timeStopBars * barMs).toISOString()
          : null;
      } else if (tp1Touched) {
        tp1Hit = true;
        updatePayload.tp1_hit_at = nowIso;
        updatePayload.tp1_hit_real_time = tfData.lastCandleTime || null;
        updatePayload.tp1_hit_price = op.tp1;
        updatePayload.bars_to_tp1 = barsSinceEntry;
        if (closesFullyAtTp1(op)) {
          // Sem runner: TP1 é saída TERMINAL. CLOSED (não um status novo)
          // porque já é terminal, então o clearActiveOp DENTRO da transação
          // libera o ativo de graça — ver known-risks item 46.
          newStatus = 'CLOSED';
          updatePayload.closed_reason = 'TP1_FULL';
          updatePayload.exit_price = op.tp1;
          updatePayload.closed_at = nowIso;
          updatePayload.closed_at_real_time = tfData.lastCandleTime || null;
        } else {
          newStatus = 'RUNNER_ACTIVE';
          newCurrentStop = op.entry_price;
        }
      }

      // Pre-TP1 stop protection (opt-in, docs/known-risks.md items 53/54) —
      // only after no exit fired on THIS candle. Reads the DECISION frozen
      // on the op at creation (pre_tp1_stop_protection_enabled/
      // _trigger_atr_mult), not pineConfig directly — same reasoning as
      // closesFullyAtTp1/runnerEnabled: a later flag flip must govern only
      // the NEXT operation, never silently start (or stop) protecting a
      // position already in flight. Computed from THIS candle's close but,
      // per advancePreTp1StopProtection's own contract, only protects
      // starting the NEXT candle — same look-ahead discipline as P0-d's
      // post-TP1 trailing below.
      if (newStatus === op.status && op.pre_tp1_stop_protection_enabled === true
          && candleUsable && tfData.atrValue) {
        // docs/known-risks.md item 132 — dois modos MUTUAMENTE EXCLUSIVOS, e
        // qual deles vale é lido da OPERAÇÃO (`pre_tp1_stop_mode`, congelado
        // na criação), nunca do pineConfig ao vivo: mesmo contrato de
        // closesFullyAtTp1/runnerEnabled. 'breakeven' (default, e o que toda
        // op legada sem o campo usa) salta pra entrada e satura;
        // 'trailing' acompanha o extremo favorável a uma distância fixa de
        // ATR e nunca satura.
        const trailingMode = op.pre_tp1_stop_mode === 'trailing';
        if (trailingMode) {
          // Ancorado no extremo favorável reconstruído do mfe_r que o próprio
          // loop acabou de atualizar (bloco MFE/MAE acima), em vez de um 2º
          // campo de pico que poderia dessincronizar. null = ainda sem MFE
          // utilizável => não trilha (nunca trata como zero).
          const favorableExtreme = favorableExtremeFromMfe({
            ...op,
            mfe_r: updatePayload.mfe_r ?? op.mfe_r,
          });
          if (favorableExtreme !== null) {
            newCurrentStop = advancePreTp1Trailing({
              isBuy,
              currentStop: newCurrentStop,
              entry: op.entry_price,
              favorableExtreme,
              atrValue: tfData.atrValue,
              startAtrMult: op.pre_tp1_trail_start_atr_mult ?? 1.0,
              trailAtrMult: op.pre_tp1_trail_atr_mult ?? 2.5,
            });
          }
        } else {
          newCurrentStop = advancePreTp1StopProtection({
            isBuy,
            currentStop: newCurrentStop,
            entry: op.entry_price,
            closePrice,
            atrValue: tfData.atrValue,
            triggerAtrMult: op.pre_tp1_stop_advance_trigger_atr_mult ?? 1.0,
          });
        }
        // O breakeven avança UMA vez só (satura na entrada, então um 2º
        // avanço é impossível por construção); o trailing avança a cada
        // candle novo em que o extremo melhora — por isso o one-shot
        // `!op.pre_tp1_stop_advanced_at` só vale no modo breakeven.
        if (newCurrentStop !== op.current_stop
            && (trailingMode || !op.pre_tp1_stop_advanced_at)) {
          updatePayload.pre_tp1_stop_advanced_at = nowIso;
          // See the stopAdvancedThisCandle guard above (Codex PR #106, P1) —
          // marks THIS candle as already-settled so a repeat pass over it
          // (same still-latest-closed candle, next cron tick) never tests it
          // against the just-advanced stop.
          updatePayload.pre_tp1_stop_advanced_candle_time = tfData.lastCandleTime;
          // Same transactional protection as the runner branch below
          // (docs/known-risks.md item 59 addendum) — without this, a racing
          // worker on a stale candle could overwrite this marker even
          // though advancePreTp1StopProtection saturates at a fixed target
          // (breakeven), so two racing workers usually compute the exact
          // SAME candidate stop — a value tie stopAdvanceCandidateWon
          // resolves by candle recency (item 80, B-1).
          stopAdvanceMarkerField = 'pre_tp1_stop_advanced_candle_time';
        }
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
      // Same fix as the pre-TP1 branch above (Codex PR #106, P1): the cron
      // re-runs this loop every ~5min while the signal candle can stay "the
      // latest closed" one for hours, so the trail can advance on pass N
      // (using this candle's close) and pass N+1 would otherwise re-test
      // this SAME candle's low/high against the now-tighter stop — a
      // look-ahead false STOP_HIT using data already safely evaluated
      // against the OLD stop one pass earlier. Excluding the candle that
      // caused the last advance mirrors stopAdvancedThisCandle exactly;
      // `undefined !== lastCandleTime` keeps every op byte-identical to
      // before for the (until now) common case where this never fires.
      const runnerStopAdvancedThisCandle = op.runner_stop_advanced_candle_time != null
        && op.runner_stop_advanced_candle_time === tfData.lastCandleTime;
      const runnerStopHit = candleUsable && !runnerStopAdvancedThisCandle
        && (isBuy ? stopCheckPrice <= op.current_stop : stopCheckPrice >= op.current_stop);
      // See the pre-TP1 branch above for why this is computed alongside
      // runnerStopHit instead of only inline in the tp2 else-if.
      // docs/known-risks.md item 114 — tp2_cap_disabled (frozen at creation,
      // pineConfig.disableTp2CapEnabled) makes this always false: the runner
      // then only ever exits via STOP_HIT/INVALIDATED/CLOSED below, matching
      // the real Pine (no fixed second target, trailing-only after TP1).
      const tp2Touched = !op.tp2_cap_disabled && candleUsable
        && ((isBuy && tpCheckPrice >= op.tp2) || (!isBuy && tpCheckPrice <= op.tp2));
      const { ambiguous: stopTp2Ambiguous } = resolveCandleExit({ stopTouched: runnerStopHit, targetTouched: tp2Touched });
      if (runnerStopHit) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_real_time = tfData.lastCandleTime || null;
        updatePayload.stop_hit_price = op.current_stop;
        // Runner stopped at BE (entry) or current stop
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
        updatePayload.closed_at_real_time = tfData.lastCandleTime || null;
        updatePayload.bars_to_stop = barsSinceEntry;
        if (stopTp2Ambiguous) updatePayload.exit_ambiguous = true;
      } else if (tp2Touched) {
        tp2Hit = true;
        newStatus = 'TP2_HIT';
        updatePayload.tp2_hit_at = nowIso;
        updatePayload.tp2_hit_real_time = tfData.lastCandleTime || null;
        updatePayload.tp2_hit_price = op.tp2;
        updatePayload.exit_price = op.tp2;
        updatePayload.closed_at = nowIso;
        updatePayload.closed_at_real_time = tfData.lastCandleTime || null;
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
          updatePayload.closed_at_real_time = tfData.lastCandleTime || null;
        }
      } else if (rfFilt && op.exit_mode !== 'ATR_TRAILING') {
        const rfInval = isBuy ? (rfDir === -1 && closePrice < rfFilt) : (rfDir === 1 && closePrice > rfFilt);
        if (rfInval) {
          newStatus = 'INVALIDATED';
          updatePayload.closed_reason = 'INVALIDATION';
          updatePayload.exit_price = closePrice;
          updatePayload.closed_at = nowIso;
          updatePayload.closed_at_real_time = tfData.lastCandleTime || null;
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
        // Mark this candle as the source of the advance so runnerStopHit
        // above excludes it on a repeat pass — see that guard's comment.
        // Unlike pre_tp1_stop_advanced_at (fires once, then stays put at
        // breakeven), the trail can legitimately re-advance on every
        // genuinely new favourable candle, so this overwrites each time
        // (advanceTrailingStop is monotonic/idempotent against the same
        // close, so a repeat pass over the same candle never re-triggers
        // this branch with a changed value). The actual write is decided
        // transactionally (stopAdvanceMarkerField below) — this candidate
        // value only lands if clampMonotonicStop keeps THIS worker's stop.
        if (newCurrentStop !== op.current_stop) {
          updatePayload.runner_stop_advanced_candle_time = tfData.lastCandleTime;
          stopAdvanceMarkerField = 'runner_stop_advanced_candle_time';
        }
      }
    }
    if (newStatus !== op.status || tp1Hit !== op.tp1_hit || tp2Hit !== op.tp2_hit || newCurrentStop !== op.current_stop
        || updatePayload.rf_reverse_bars_count !== (op.rf_reverse_bars_count || 0)
        || updatePayload.mfe_r !== undefined || updatePayload.mae_r !== undefined) {
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
      }, {
        assetId: op.asset_id,
        stopAdvanceMarkerField,
        // Bloco 4 Fase 1 (hierarchicalCascadesEnabled) uses a per-cascade
        // anchor doc (assetActiveOps/{assetId}__{cascade}) — without this,
        // a terminal transition here tries to clear assetActiveOps/{assetId}
        // (never written for a hierarchical op), leaving the real anchor
        // pointing at a now-terminal op (docs/known-risks.md item 80, B-2).
        cascade: op.hierarchical_cascade === true ? op.cascade : undefined,
      });
      // Observability for the cross-loop precedence residual (see
      // .claude/rules/trading-engine.md): a dropped transition means the other
      // loop won the race — measure how often before designing a hard rule.
      if (!applied) {
        logWarn('scanner', `Transição descartada pelo CAS: op ${op.id} (${op.symbol}) ${op.status}→${newStatus}; status atual ${currentStatus}`, { op_id: op.id, from: op.status, attempted: newStatus, current: currentStatus }, { symbol: op.symbol });
      }
      // Only notify when THIS pass actually applied the transition — prevents
      // duplicate Telegram messages when both loops race the same op. Notify
      // functions get the op MERGED with updatePayload (not the stale
      // pre-transition op) so they can read the *_real_time fields just
      // written above — the candle's actual close time, not this pass's
      // wall-clock detection time (docs/known-risks.md: horário real do
      // alerta vs. horário em que o scan detectou).
      if (applied && isTelegramConfigured()) {
        const notifiedOp = { ...op, ...updatePayload, tp1_hit: tp1Hit, tp2_hit: tp2Hit };
        if (newStatus === 'STOP_HIT' && op.status !== 'STOP_HIT') notifyStopHit(notifiedOp, closePrice).catch(() => {});
        else if (newStatus === 'TP2_HIT') notifyTP2Hit(notifiedOp, closePrice).catch(() => {});
        else if (newStatus === 'INVALIDATED') notifyInvalidated(notifiedOp, closePrice).catch(() => {});
        else if (newStatus === 'CLOSED' && updatePayload.closed_reason === 'TIME_STOP') notifyTimeStop(notifiedOp, closePrice).catch(() => {});
        else if (newStatus === 'CLOSED' && updatePayload.closed_reason === 'CHOP_EXIT') notifyChopExit(notifiedOp, closePrice).catch(() => {});
        else if (tp1Hit && !op.tp1_hit) notifyTP1Hit(notifiedOp, closePrice).catch(() => {});
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
  // Captured in a local var (not just inlined in the .update() call below) so
  // the exact just-written fields can be returned to the caller — scanAllAssetsInner
  // reuses this to keep its own asset snapshot fresh WITHOUT a second read
  // (docs/known-risks.md item 148): recomputing the same fields there from
  // scratch would duplicate this logic and risk drifting from what was
  // actually persisted, so the payload itself is threaded through instead.
  const assetScanUpdate = {
    last_scan_at: new Date().toISOString(),
    scan_status: errors.length > 0 ? 'error' : 'success',
    scan_error: errors.length > 0 ? errors.map(e => `${e.timeframe}: ${e.error}`).join('; ') : '',
    scan_error_since: errors.length > 0
      ? (asset.scan_status === 'error' ? (asset.scan_error_since || new Date().toISOString()) : new Date().toISOString())
      : null,
  };
  await backend.entities.MonitoredAsset.update(asset.id, assetScanUpdate);

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

  return { persistedSignals, errors, smc5mZoneRejections, arbitrationOutcomes, retestOutcomes, displacementOutcomes, smcRegimeOutcomes, rfRegimeOutcomes, smcObFvgOutcomes, smcTriggerOutcomes, entryFunnelOutcomes, candlePatternOutcomes, portfolioCapOutcomes, assetScanUpdate };
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
 * Ativação MANUAL de um sinal, a partir do painel ("Ativar agora" no
 * AssetCard). Existe porque aquele botão criava a operação com
 * `TradeOperation.create` cru (Codex, PR #95) — e o resultado era uma operação
 * inoperável, não só mal configurada:
 *
 *   - sem `initial_stop`/`current_stop`/`tp1`/`tp2`, então NENHUM dos dois
 *     loops de saída tinha o que comparar: a operação ficava em
 *     `SIGNAL_CONFIRMED` para sempre, sem stop e sem alvo;
 *   - sem passar por `createTradeOpIfNoneActive`, então o ponteiro
 *     `assetActiveOps` continuava vazio e o scanner abria a operação DELE para
 *     o mesmo ativo. Duas ativas no mesmo ativo é exatamente o que a guarda do
 *     item 39.1 detecta — e a reação dela é **suspender toda a gestão de
 *     stop/TP daquele ativo** até resolução manual;
 *   - `partial_percent`/`runner_percent` fixos em 50, ignorando `runnerEnabled`
 *     (o achado literal do revisor — o menor dos três).
 *
 * A correção é rotear pelo caminho único de criação, reusando `scanAsset` para
 * obter ATR/tier do 4h (em vez de recalcular e arriscar divergir) e
 * `buildTradeOpData` para o resto — a MESMA função que a cascata RF usa, então
 * a operação manual nasce com a mesma forma e a mesma gestão de uma automática.
 *
 * **A operação passa a ser gerida pelas regras da cascata RF 4h** (stop ATR×tier
 * do 4h, trailing no 4h, Time Stop em barras de 4h), qualquer que seja o sinal
 * que a motivou. Isso é escolha explícita, não efeito colateral: é a única
 * gestão que o motor sabe aplicar a partir de um clique, e é melhor do que a
 * alternativa anterior (nenhuma). O botão do painel avisa isso antes de criar.
 *
 * `entry_candle_time_15m` é o instante do clique, o que faz a guarda temporal
 * P0-g rejeitar todo candle já em andamento — nenhuma vela anterior à entrada
 * pode disparar stop/TP nesta operação.
 */
export async function activateSignalManually(signal, asset) {
  if (!signal || !asset) return { created: false, reason: 'missing_input' };

  const { results, pineConfig } = await scanAsset(asset);
  const tf4hData = results['4h'];
  // Fail-fechado: sem ATR não há stop calculável, e criar operação sem stop é
  // precisamente o defeito que esta função existe para eliminar.
  if (!tf4hData || !tf4hData.atrValue) {
    return { created: false, reason: 'no_4h_atr' };
  }

  // Preço do clique, não o do sinal: um sinal pode ter horas de idade, e
  // registrar o preço antigo como entrada falsificaria o R desde o começo.
  const entryPrice = await fetchCurrentPrice(asset.symbol);
  if (!entryPrice) return { created: false, reason: 'no_price' };

  const opData = {
    ...buildTradeOpData(signal, tf4hData, pineConfig, {
      entryPrice,
      entryCandleTime: new Date().toISOString(),
    }),
    source: 'manual',
    signal_reasons: signal.reason ? [signal.reason] : (signal.context?.reasons || []),
  };

  const tradeOpId = `trade_manual_${signal.id || signal.dedup_key || Date.now()}`;
  const res = await backend.tradeOps.createTradeOpIfNoneActive(asset.id, tradeOpId, opData);

  if (res.created) {
    logInfo('scanner', `${asset.symbol} — operação criada MANUALMENTE pelo painel (${signal.signal_type}) @ ${entryPrice}`, {
      op_id: tradeOpId, entry: entryPrice, stop: opData.initial_stop, tp1: opData.tp1, tier: opData.tier,
    }, { symbol: asset.symbol });
    if (isTelegramConfigured()) notifyTradeCreated({ ...opData, id: tradeOpId }).catch(() => {});
  }
  return { created: res.created, reason: res.created ? null : 'active_op_exists', opId: tradeOpId };
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
    return { errors: [], skipped: true };
  }

  try {
    return await priceCheckActiveOpsInner();
  } finally {
    await tryReleaseScanLock('price-check', holder);
  }
}

// Same duplicate-active-ops invariant as persistScanResults
// (groupActiveOpsByAsset, src/lib/opTransition.js) applied to this — the
// OTHER TradeOperation mutator (.claude/rules/trading-engine.md) — loop, so
// a corrupted asset never gets its price/stop/TP mutated here either, even
// when the full scan already suspended it. This runs far more often than
// the full scan (every price-check tick, not ~5min), so the log is written
// via SystemLog.createUnique keyed by the exact duplicate id set: the same
// unresolved anomaly returns the existing doc (no new write) tick after
// tick, and only a CHANGED id set (an op resolved, added, or removed)
// produces a fresh log entry.
async function logDuplicateActiveOpsPriceCheck(assetKey, ops) {
  const sorted = [...ops].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dedupKey = `duplicate_active_ops::${assetKey}::${sorted.map(o => o.id).join(',')}`;
  await backend.entities.SystemLog.createUnique(dedupKey, {
    level: 'error',
    module: 'scanner',
    message: `${sorted[0]?.symbol ?? assetKey}: ${sorted.length} operações ativas simultâneas detectadas no price check — atualização de preço/stop/TP suspensa até resolução manual.`,
    symbol: sorted[0]?.symbol ?? null,
    details: {
      reason: 'duplicate_active_ops_detected',
      source: 'price_check',
      op_ids: sorted.map(o => o.id),
      op_statuses: sorted.map(o => o.status),
      op_cascades: sorted.map(o => o.cascade),
      op_sides: sorted.map(o => o.side),
      op_created_dates: sorted.map(o => o.created_date ?? null),
    },
  });
}

async function priceCheckActiveOpsInner() {
  // Firestore-quota-exhaustion errors from the per-op catch below (item 138
  // addendum) — collected here so the caller (scripts/run-scan.mjs) can
  // detect and alert on them, since logError there is fire-and-forget and
  // never propagates. Purely a reporting side-channel: does not change any
  // state transition, and a per-op error still never aborts the loop for
  // the other ops (same isolation as before).
  const errors = [];

  // Filtered server-side by status instead of fetching every TradeOperation
  // ever created and discarding most of it client-side — that unfiltered
  // read grows with trade history forever and was a real, documented
  // Firestore-quota risk (see docs/known-risks.md item 13).
  const activeOps = await backend.entities.TradeOperation.filter({ status: ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'] });
  if (activeOps.length === 0) return { errors };

  // Invariant guard (docs/known-risks.md item 39 residual limitation, now
  // closed): group by asset and never let a duplicated asset's ops reach the
  // mutation loop below — mirrors persistScanResults exactly, via the same
  // pure helper, so the two mutator loops can't disagree on what "duplicate"
  // means. Other (non-duplicated) assets keep being processed normally.
  const { validGroups, duplicateGroups } = groupActiveOpsByAsset(activeOps);
  for (const [assetKey, ops] of duplicateGroups) {
    await logDuplicateActiveOpsPriceCheck(assetKey, ops);
  }
  const opsToProcess = [...validGroups.values()];
  if (opsToProcess.length === 0) return { errors };

  const symbols = [...new Set(opsToProcess.map(op => op.symbol))];
  const prices = {};
  await Promise.all(symbols.map(async sym => {
    try { prices[sym] = await fetchCurrentPrice(sym); }
    catch (e) { logWarn('scanner', `Falha ao buscar preço de ${sym}`, { error: e.message }, { symbol: sym }); }
  }));

  for (const op of opsToProcess) {
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
        tp1Hit = true;
        updatePayload.tp1_hit_at = nowIso;
        updatePayload.tp1_hit_price = op.tp1;
        // Mesma regra pura do loop por candle — os dois loops NÃO podem
        // divergir sobre isto (a lição do item 39.1).
        if (closesFullyAtTp1(op)) {
          newStatus = 'CLOSED';
          updatePayload.closed_reason = 'TP1_FULL';
          updatePayload.exit_price = op.tp1;
          updatePayload.closed_at = nowIso;
        } else {
          newStatus = 'RUNNER_ACTIVE';
          newCurrentStop = op.entry_price;
        }
      }
    } else {
      if (isBuy ? price <= op.current_stop : price >= op.current_stop) {
        newStatus = 'STOP_HIT';
        updatePayload.stop_hit_at = nowIso;
        updatePayload.stop_hit_price = price;
        updatePayload.exit_price = op.current_stop;
        updatePayload.closed_at = nowIso;
      } else if (!op.tp2_cap_disabled && ((isBuy && price >= op.tp2) || (!isBuy && price <= op.tp2))) {
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
      const { applied, currentStatus } = await backend.tradeOps.transitionTradeOp(op.id, op.status, { status: newStatus, tp1_hit: tp1Hit, tp2_hit: tp2Hit, current_stop: newCurrentStop, ...updatePayload }, {
        assetId: op.asset_id,
        // Same fix as persistScanResults above (docs/known-risks.md item 80, B-2).
        cascade: op.hierarchical_cascade === true ? op.cascade : undefined,
      });
      // Same cross-loop race observability as persistScanResults.
      if (!applied) {
        logWarn('scanner', `Transição descartada pelo CAS (price check): op ${op.id} (${op.symbol}) ${op.status}→${newStatus}; status atual ${currentStatus}`, { op_id: op.id, from: op.status, attempted: newStatus, current: currentStatus }, { symbol: op.symbol });
      }
      if (applied && isTelegramConfigured()) {
        // No candle here (price-based, not candle-based) — *_real_time is
        // left absent, so notify* falls back to the wall-clock *_at, which
        // IS the real time at this loop's resolution (continuous price
        // ticks, not a 4h/1h candle boundary).
        const notifiedOp = { ...op, ...updatePayload, tp1_hit: tp1Hit, tp2_hit: tp2Hit };
        if (newStatus === 'STOP_HIT') notifyStopHit(notifiedOp, price).catch(() => {});
        else if (newStatus === 'TP2_HIT') notifyTP2Hit(notifiedOp, price).catch(() => {});
        else if (tp1Hit && !op.tp1_hit) notifyTP1Hit(notifiedOp, price).catch(() => {});
      }
    }
    } catch (err) {
      logError('scanner', `Falha ao atualizar status da operação ${op.id} (${op.symbol}) no price check`, { error: err.message });
      errors.push({ symbol: op.symbol, error: err.message });
    }
  }

  return { errors };
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
    return { total: 0, results: [], assets: [] };
  }

  const allResults = [];
  // Post-scan snapshot of each asset, built up as the loop below writes to
  // MonitoredAsset — NOT a second read. scripts/run-scan.mjs's per-asset
  // healthcheck (checkAssetHealthchecks) needs the freshly-written
  // last_scan_at/scan_error_since to decide staleness correctly; reusing the
  // PRE-scan `assets` array above would silently feed it data from the
  // previous pass. Merging each asset's just-written fields here keeps the
  // caller's list accurate without an extra Firestore query
  // (docs/known-risks.md item 148).
  const updatedAssets = [];

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
      updatedAssets.push({ ...asset, ...persisted.assetScanUpdate });

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

      const assetScanUpdate = {
        scan_status: 'error',
        scan_error: err.message,
        last_scan_at: new Date().toISOString(),
        scan_error_since: asset.scan_status === 'error' ? (asset.scan_error_since || new Date().toISOString()) : new Date().toISOString(),
      };
      await backend.entities.MonitoredAsset.update(asset.id, assetScanUpdate);
      updatedAssets.push({ ...asset, ...assetScanUpdate });

      // Deduped like logDuplicateActiveOpsPriceCheck (item 39.1): a Firestore
      // outage/quota exhaustion (docs/known-risks.md item 106) repeats the
      // SAME error for the SAME asset on every ~5min pass, all day — an
      // unconditional create() here was writing one SystemLog per failed
      // pass, compounding the very write-quota problem it was reporting.
      // createUnique caps it at 1 write per (asset, day, exact error
      // message): dedupKey includes today's date so a NEW day still gets a
      // fresh log entry even if the same outage recurs tomorrow, preserving
      // visibility instead of silencing it after the first occurrence ever.
      const today = new Date().toISOString().slice(0, 10);
      const scanErrorDedupKey = `scan_error::${asset.id}::${today}::${err.message}`;
      await backend.entities.SystemLog.createUnique(scanErrorDedupKey, {
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

  return { total: assets.length, results: allResults, assets: updatedAssets };
}