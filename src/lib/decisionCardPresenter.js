/**
 * Presenter do Decision Card (Fase 1 do plano de UI de decisão) — TRADUZ dados
 * já persistidos em blocos legíveis; nunca decide nada sobre a operação.
 *
 * Regras desta camada (docs/known-risks.md itens 154/168/180/181/182/193-196):
 *  - Puro: sem React, sem fetch, sem Firestore/Postgres, sem relógio
 *    implícito (`now` entra por parâmetro) e SEM importar `scanner.js` ou
 *    `pineParser` (travado por `decisionCardPresenter.test.js`).
 *  - Nada é recalculado: nem score, nem R, nem stop/TP, nem direção. Só
 *    escolhe o campo persistido e reaproveita os presenters existentes
 *    (`explainDecision`, `explainOperationDecision`, `rejectionCopy`,
 *    `classifySignal`, `stopPosture`, `assetHealthcheckReason`).
 *  - Fail-closed: dado ausente vira `null`/UNKNOWN, nunca valor favorável;
 *    erro de carregamento nunca vira "sem operação"/"sem sinal".
 *  - `op.invalidates_if` (texto fixo, não reflete a regra real) e
 *    `op.data_status` (gravado fixo como 'LIVE') são IGNORADOS de propósito.
 *  - Probabilidade: o slot existe, mas nunca é preenchido aqui. Score e
 *    histórico não são probabilidade calibrada.
 */
import { isTerminalStatus } from './opTransition.js';
import { classifySignal, phaseCopy, rejectionCopy, REASON_KIND, SIGNAL_PHASE } from './signalStatus.js';
import { explainDecision, explainOperationDecision } from './decisionExplanation.js';
import { usablePrice, stopPosture } from './priceProximity.js';
import { assetHealthcheckReason } from './assetHealthcheck.js';

export const SCORE_NOTE = 'Score técnico: concordância das regras atuais — não é probabilidade de acerto.';

export const PROBABILITY_NOT_CALIBRATED = Object.freeze({ available: false, reason: 'not_calibrated' });

export const NOT_RECORDED = 'não registrado';

const OP_STATE_LABEL = Object.freeze({
  SIGNAL_CONFIRMED: 'Entrada confirmada',
  RUNNER_ACTIVE: 'Runner ativo (TP1 atingido)',
});

const CASCADE_LABEL = Object.freeze({
  '4h_15m': 'estrutura 4h com confirmação 15m',
  '1h_5m': 'estrutura 1h com gatilho 5m',
});

const TIMEFRAMES = ['1d', '4h', '1h'];

const toMs = (iso) => {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const byCreatedDesc = (a, b) => (toMs(b?.created_date) ?? 0) - (toMs(a?.created_date) ?? 0);

function directionOrNull(value) {
  return value === 1 || value === -1 || value === 0 ? value : null;
}

// Só estas fontes viram candidatas a entrada no motor (scanner.js: range_filter
// e smc_structure). MACD/EMA/RSI também gravam SignalEvent em 4h, mas são
// observação de mercado — nunca "aguardando confirmação".
const ENTRY_SOURCES = new Set(['range_filter', 'smc_structure']);
const isEntrySignal = (signal) => ENTRY_SOURCES.has(signal?.source);

function pickSubject({ assetOps, assetSignals, now }) {
  const activeOp = [...assetOps].filter((op) => op && !isTerminalStatus(op.status)).sort(byCreatedDesc)[0] ?? null;
  if (activeOp) return { kind: 'op', op: activeOp, signal: null };
  // Candidato de entrada tem prioridade: um evento informativo mais novo não
  // pode esconder um aviso de entrada ainda pendente.
  const entrySignals = assetSignals.filter(isEntrySignal);
  const signal = [...(entrySignals.length ? entrySignals : assetSignals)].sort(byCreatedDesc)[0] ?? null;
  if (signal) {
    const phase = isEntrySignal(signal) ? classifySignal(signal, now).phase : SIGNAL_PHASE.INFO;
    return { kind: 'signal', op: null, signal, phase };
  }
  return { kind: 'none', op: null, signal: null };
}

// TradeOperation.jsonc: `signal_timeframe` ausente = operação legada da
// cascata 4h/15m → tratar como '4h'. `timeframe` é o candle de confirmação (15m/5m).
const opSignalTimeframe = (op) => op?.signal_timeframe ?? '4h';

function buildState({ subject, opsUnavailable, signalsUnavailable }) {
  if (subject.kind === 'op') {
    const { op } = subject;
    return {
      code: op.status,
      kind: 'active_op',
      label: OP_STATE_LABEL[op.status] ?? String(op.status ?? NOT_RECORDED),
      side: op.side ?? null,
      timeframe: opSignalTimeframe(op),
    };
  }
  // Sem operação ativa conhecida: se as operações não carregaram, NÃO se pode
  // afirmar "aguardando confirmação"/"sem operação" (item 193-196).
  if (opsUnavailable) {
    return { code: 'ops_unavailable', kind: 'unavailable', label: 'Não foi possível carregar as operações agora', side: null, timeframe: null };
  }
  if (subject.kind === 'signal') {
    const { signal, phase } = subject;
    const side = signal.signal_type ?? null;
    const label = phase === SIGNAL_PHASE.WAITING
      ? `Aguardando confirmação · ${side ?? '—'}`
      : `${phaseCopy(phase).badge} · ${side ?? '—'}`;
    return { code: phase, kind: phase, label, side, timeframe: signal.timeframe ?? null };
  }
  if (signalsUnavailable) {
    return { code: 'signals_unavailable', kind: 'unavailable', label: 'Não foi possível carregar os sinais agora', side: null, timeframe: null };
  }
  return { code: 'none', kind: 'none', label: 'Sem sinal nem operação registrados', side: null, timeframe: null };
}

function buildAction({ subject, state, now }) {
  if (state.kind === 'unavailable') return null;
  if (subject.kind === 'op') {
    const { headline, why, userAction } = explainOperationDecision(subject.op);
    return { headline, why, userAction };
  }
  if (subject.kind === 'signal') {
    const { headline, why, userAction } = explainDecision(subject.signal, { now });
    // Fase INFO nunca vira operação: o texto de rejeição ("o app está vendo se
    // vale abrir uma operação") seria falso para ela.
    if (subject.phase === SIGNAL_PHASE.INFO) {
      const copy = phaseCopy(SIGNAL_PHASE.INFO);
      return { headline: copy.badge, why: copy.reassurance, userAction };
    }
    return { headline, why, userAction };
  }
  return null;
}

function buildLevels(op) {
  if (!op) return null;
  const rr = Number.isFinite(op.rr_at_entry) ? op.rr_at_entry : null;
  return {
    side: op.side ?? null,
    entry: usablePrice(op.entry_price),
    initialStop: usablePrice(op.initial_stop),
    stop: usablePrice(op.current_stop),
    tp1: usablePrice(op.tp1),
    tp2: usablePrice(op.tp2),
    rr,
    stopPosture: stopPosture(op),
  };
}

function buildScore(subject) {
  const raw = subject.kind === 'op'
    ? (Number.isFinite(subject.op.score) ? subject.op.score : subject.op.entry_score)
    : subject.signal?.context?.score;
  return Number.isFinite(raw) ? { value: raw, note: SCORE_NOTE } : null;
}

function buildThesis(subject) {
  if (subject.kind === 'signal') {
    return typeof subject.signal.reason === 'string' && subject.signal.reason ? subject.signal.reason : null;
  }
  if (subject.kind === 'op' && subject.op.cascade) {
    const where = CASCADE_LABEL[subject.op.cascade] ?? String(subject.op.cascade);
    return `Operação ${subject.op.side === 'SELL' ? 'vendedora' : 'compradora'} — ${where}`;
  }
  return null;
}

function buildPros(subject) {
  const list = subject.kind === 'op' ? subject.op.signal_reasons : subject.signal?.context?.reasons;
  return Array.isArray(list) ? list.filter((r) => typeof r === 'string' && r) : [];
}

function buildMultiTf(subject, stateByTf) {
  const frozen = subject.kind === 'op' ? subject.op : subject.signal?.context;
  const source = subject.kind === 'op' ? 'entry' : 'signal';
  return TIMEFRAMES.map((tf) => {
    const persisted = directionOrNull(frozen?.[`tf_${tf}_direction`]);
    if (persisted !== null) return { tf, direction: persisted, source };
    const current = directionOrNull(stateByTf.get(tf)?.rf_direction);
    return { tf, direction: current, source: current === null ? null : 'now' };
  });
}

/**
 * Evidências CONTRA: cada regra lê UM campo persistido, compara direção com o
 * lado do sinal/operação e devolve uma frase. Nada é limiar novo nem
 * recalculado — `rsi_zone`/`trend_ema` já chegam classificados pelo motor.
 * Resto = vazio; quem renderiza deve escrever "Contra: não registrado",
 * nunca "nenhum contra" (`consStatus` existe para isso).
 */
function buildCons({ subject, side, signalTf, stateByTf, now }) {
  const cons = [];
  const want = side === 'SELL' ? -1 : side === 'BUY' ? 1 : null;
  const frozen = subject.kind === 'op' ? subject.op : subject.signal?.context;
  const frozenSource = subject.kind === 'op' ? 'entry' : 'signal';

  // `alignment` é gravado no nível de cima do SignalEvent (scanner.js, newSignals.push), não em `context`.
  if (subject.signal?.alignment === 'against_trend') {
    cons.push({ code: 'against_trend', scope: 'signal', text: 'Contra a tendência maior (alinhamento dos timeframes)' });
  }
  if (want !== null && directionOrNull(frozen?.tf_1d_direction) === -want) {
    cons.push({ code: 'tf_1d_against', scope: frozenSource, text: '1D contrário ao lado da operação' });
  }

  const current = stateByTf.get(signalTf);
  if (want !== null && current) {
    if ((want === 1 && current.rsi_zone === 'overbought') || (want === -1 && current.rsi_zone === 'oversold')) {
      cons.push({ code: 'rsi_extreme', scope: 'now', text: `RSI ${current.rsi_zone === 'overbought' ? 'sobrecomprado' : 'sobrevendido'} agora no ${signalTf}` });
    }
    if (Number.isFinite(current.macd_histogram) && current.macd_histogram !== 0 && Math.sign(current.macd_histogram) === -want) {
      cons.push({ code: 'macd_against', scope: 'now', text: `MACD contra agora no ${signalTf}` });
    }
    if (current.trend_ema === 'bullish' || current.trend_ema === 'bearish') {
      if ((current.trend_ema === 'bullish' ? 1 : -1) === -want) {
        cons.push({ code: 'ema_against', scope: 'now', text: `Tendência das médias (EMA) contra agora no ${signalTf}` });
      }
    }
  }

  if (subject.kind === 'signal' && isEntrySignal(subject.signal)) {
    const copy = rejectionCopy(subject.signal, subject.phase);
    if (copy.kind === REASON_KIND.WORSE) {
      const { evidence } = explainDecision(subject.signal, { now });
      cons.push({ code: 'rejection_worse', scope: 'now', text: copy.detail, evidence: evidence ?? null });
    }
  }

  return cons;
}

function buildInvalidation(subject, levels) {
  if (subject.kind === 'op' && Number.isFinite(levels?.stop)) {
    return { kind: 'stop', stop: levels.stop, text: 'Stop atual da operação (as saídas automáticas seguem as regras do motor)' };
  }
  return { kind: 'not_defined', stop: null, text: 'Ainda não definida — a operação ainda não existe' };
}

const HEALTH_LABEL = Object.freeze({
  persistent_error: 'Falha persistente de leitura',
  silent: 'Sem atualização recente',
});

function buildQuality({ asset, subject, signalTf, stateByTf, now }) {
  const origin = subject.op ?? subject.signal ?? null;
  const nowMs = Number.isFinite(now) ? now : null;
  const reason = asset && nowMs !== null ? assetHealthcheckReason(asset, { now: nowMs }) : null;
  const lastScanMs = toMs(asset?.last_scan_at);

  let status = 'unknown';
  if (asset?.is_active === false) status = 'inactive';
  else if (reason === 'persistent_error') status = 'error';
  else if (reason === 'silent') status = 'stale';
  else if (nowMs !== null && lastScanMs !== null) status = 'ok';

  return {
    status,
    label: reason ? HEALTH_LABEL[reason] : null,
    ageMin: nowMs !== null && lastScanMs !== null ? Math.max(0, Math.floor((nowMs - lastScanMs) / 60000)) : null,
    lastScanAt: asset?.last_scan_at ?? null,
    lastCandleTime: stateByTf.get(signalTf)?.last_candle_time ?? null,
    source: {
      marketSource: origin?.market_source ?? null,
      dataExchange: origin?.data_exchange ?? null,
      executor: origin?.executor ?? null,
    },
    evaluatedAt: origin?.decision_snapshot?.evaluated_at ?? null,
  };
}

/**
 * @param {{
 *   asset: object, assetStates?: object[], signals?: object[], tradeOps?: object[],
 *   signalsUnavailable?: boolean, tradeOpsUnavailable?: boolean,
 *   now: number, funding?: { rate: number, nextFundingTime?: number } | null,
 * }} input
 */
export function buildDecisionCard({
  asset,
  assetStates = [],
  signals = [],
  tradeOps = [],
  signalsUnavailable = false,
  tradeOpsUnavailable = false,
  now,
  funding = null,
}) {
  const assetOps = (tradeOps ?? []).filter((op) => op && op.asset_id === asset?.id);
  const assetSignals = (signals ?? []).filter((s) => s && s.asset_id === asset?.id);
  const stateByTf = new Map((assetStates ?? []).filter((s) => s && s.asset_id === asset?.id).map((s) => [s.timeframe, s]));

  const subject = pickSubject({ assetOps, assetSignals, now });
  const state = buildState({ subject, opsUnavailable: tradeOpsUnavailable, signalsUnavailable });
  const signalTf = state.timeframe ?? '4h';
  const levels = buildLevels(subject.op);
  const decided = state.kind !== 'unavailable' && subject.kind !== 'none';
  const cons = decided ? buildCons({ subject, side: state.side, signalTf, stateByTf, now }) : [];

  return {
    asset: { id: asset?.id ?? null, name: asset?.display_name ?? asset?.symbol ?? null, symbol: asset?.symbol ?? null, exchange: asset?.exchange ?? null },
    state,
    action: buildAction({ subject, state, now }),
    levels,
    score: decided ? buildScore(subject) : null,
    why: decided
      ? {
        thesis: buildThesis(subject),
        pros: buildPros(subject),
        cons,
        invalidation: buildInvalidation(subject, levels),
        multiTf: buildMultiTf(subject, stateByTf),
      }
      : null,
    tech: {
      funding: Number.isFinite(funding?.rate)
        ? { available: true, rate: funding.rate, nextFundingTime: funding.nextFundingTime ?? null, informational: true }
        : { available: false, rate: null, nextFundingTime: null, informational: true },
    },
    quality: buildQuality({ asset, subject, signalTf, stateByTf, now }),
    probability: PROBABILITY_NOT_CALIBRATED,
    unavailable: { signals: Boolean(signalsUnavailable), tradeOps: Boolean(tradeOpsUnavailable) },
    consStatus: decided ? (cons.length > 0 ? 'derived' : 'not_recorded') : null,
  };
}
