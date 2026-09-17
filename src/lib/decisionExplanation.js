/**
 * Fase 1 — Explainability V2. Camada única de explicação: dado um SignalEvent
 * (com ou sem `decision_snapshot`), produz um objeto pronto para Dashboard,
 * Telegram e Histórico traduzirem, sem cada tela deduzir por conta própria.
 *
 * Não reescreve `src/lib/signalStatus.js` — COMPÕE com ele. `rejectionCopy()`
 * já resolve `headline`/`why` de forma fail-closed (chave ausente, motivo
 * desconhecido, sinal expirado sem motivo salvo — nunca lança, nunca inventa).
 * O que este módulo adiciona é `evidence`: os fatos numéricos de
 * `decision_snapshot.facts` (src/lib/decisionSnapshot.js), que hoje só
 * `SignalEvent`s rejeitados por `regime_rejected`/`trend_reversed` carregam.
 *
 * Contrato fail-closed: entidade sem `decision_snapshot` (sinal legado, ou
 * rejeitado por um motivo que esta fase ainda não instrumenta) devolve
 * `evidence: null` — nunca um valor calculado on-the-fly nem um texto que
 * pareça mais preciso do que os dados registrados permitem.
 *
 * Fase 3 — Explainability V2 estende este módulo com `explainOperationDecision`
 * para `TradeOperation` ativa (HOLDING/PROTECTED). `EXIT` (STOP_HIT/TP2_HIT/
 * INVALIDATED/CLOSED) ainda não tem `decision_snapshot` — ver docs/known-risks.md.
 *
 * Módulo puro: sem React, sem I/O, sem Firestore.
 */

import { rejectionCopy, classifySignal } from './signalStatus';

const NOTHING_TO_DO = 'Nada a fazer — o app continua verificando sozinho.';

function formatNum(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function directionLabel(dir) {
  if (dir === 1) return 'compra';
  if (dir === -1) return 'venda';
  return 'indefinida';
}

// Achado de revisão independente (2026-09-17): `decision_snapshot` só é
// regravado quando algo mais já ia gravar mesmo (write-on-change em
// SignalEvent; carona nas escritas de mfe_r/current_stop em TradeOperation —
// ver docs/known-risks.md itens 181/182). Isso significa que um snapshot com
// `data_status: 'LIVE'` pode estar descrevendo uma avaliação de várias
// passadas atrás, sem nenhum sinal visual disso. Em vez de tentar adivinhar
// um limiar de "desatualizado" (que varia por timeframe — 4h vs 1h — e por
// isso seria fácil de errar), expõe o horário em que os fatos foram medidos
// e deixa o usuário julgar. Sem `moment` de propósito — este módulo é
// dependency-free, mesmo padrão de src/lib/opExitRules.js.
function formatMeasuredAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const hh = String(brt.getUTCHours()).padStart(2, '0');
  const mm = String(brt.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function withMeasuredAt(evidence, snapshot) {
  if (!evidence) return evidence;
  const time = formatMeasuredAt(snapshot?.evaluated_at);
  return time ? `${evidence} (medido às ${time} BRT)` : evidence;
}

/**
 * Formata `decision_snapshot.facts` numa frase curta, por `reason_code`.
 * Só os dois reason_codes que `decisionSnapshot.js` já produz nesta fase —
 * um reason_code sem formatador conhecido (ou fatos incompletos) devolve
 * `null`, nunca um texto genérico fingindo evidência.
 *
 * `currentReasonCode` é o motivo categórico ATUAL do sinal
 * (`signal.last_rejection_reason`) — `recordRejection()` (scanner.js) só
 * grava `decision_snapshot` nos motivos regime_rejected/trend_reversed; os
 * outros ~8 motivos (candle_pattern_rejected, retest_pending, etc.) mudam
 * `last_rejection_reason` via write-on-change SEM tocar `decision_snapshot`,
 * que fica com o valor da última vez que um desses dois motivos esteve
 * ativo. Sem este guard, a evidência numérica podia descrever um motivo já
 * resolvido enquanto o chip/frase acima já mostra o motivo atual — achado
 * de revisão independente (`sentinel-trading-engine-review` + `code-review`,
 * 2026-09-17), não hipotético.
 */
function formatEvidence(snapshot, currentReasonCode) {
  if (!snapshot || snapshot.data_status === 'UNKNOWN') return null;
  if (currentReasonCode && snapshot.reason_code !== currentReasonCode) return null;
  const { reason_code: reasonCode, facts = {} } = snapshot;

  if (reasonCode === 'regime_rejected') {
    const parts = [];
    const adx = formatNum(facts.adx);
    const adxMin = formatNum(facts.adx_min);
    if (adx != null) parts.push(`força do movimento (ADX) ${adx}${adxMin != null ? ` — mínimo exigido ${adxMin}` : ''}`);
    const chop = formatNum(facts.chop);
    const chopMax = formatNum(facts.chop_max);
    if (chop != null) parts.push(`lateralização (Chop) ${chop}${chopMax != null ? ` — máximo permitido ${chopMax}` : ''}`);
    if (!parts.length) return null;
    return `Medido: ${parts.join(' · ')}.`;
  }

  if (reasonCode === 'trend_reversed') {
    if (!Number.isFinite(facts.current_direction) || !Number.isFinite(facts.signal_direction)) return null;
    return `Medido: tendência atual aponta para ${directionLabel(facts.current_direction)}; o aviso era de ${directionLabel(facts.signal_direction)}.`;
  }

  return null;
}

function warningsFor(snapshot) {
  if (!snapshot) return [];
  if (snapshot.data_status === 'UNKNOWN') {
    return ['Os números desta avaliação não estavam disponíveis no momento — o motivo categórico acima continua válido.'];
  }
  if (snapshot.data_status === 'STALE') {
    return ['Os números abaixo podem estar desatualizados.'];
  }
  return [];
}

/**
 * @param {object} signal  SignalEvent completo (com ou sem decision_snapshot)
 * @param {object} [ctx]   { now } — injetável para teste; usado só para a fase
 * @returns {{
 *   headline: string, why: string, evidence: string|null, missing: null,
 *   nextStep: null, userAction: string, warnings: string[], technical: object|null,
 * }}
 */
export function explainDecision(signal, ctx = {}) {
  const phase = classifySignal(signal, ctx.now ?? Date.now()).phase;
  const copy = rejectionCopy(signal, phase);
  const snapshot = signal?.decision_snapshot ?? null;
  return {
    headline: copy.chip,
    why: copy.detail,
    evidence: withMeasuredAt(formatEvidence(snapshot, signal?.last_rejection_reason ?? null), snapshot),
    missing: null,
    nextStep: null,
    userAction: NOTHING_TO_DO,
    warnings: warningsFor(snapshot),
    technical: snapshot,
  };
}

/**
 * Fase 3 — texto por `reason_code` de gestão de `TradeOperation` ativa. Não
 * existe hoje nenhum equivalente categórico (diferente de `SignalEvent`, que
 * já tinha `rejectionCopy()`) — este é o texto novo desta fase, no mesmo tom
 * de `signalStatus.js`: título curto, "por quê" em uma frase, `userAction`
 * sempre "nada a fazer" (a gestão é 100% automática).
 */
const OPERATION_COPY = Object.freeze({
  awaiting_tp1: {
    headline: 'Monitorando',
    why: 'Nenhuma condição de saída foi atingida. A proteção de stop desta operação ainda não está ativa nesta passada.',
  },
  pre_tp1_protection_armed_not_triggered: {
    headline: 'Monitorando — proteção armada',
    why: 'Nenhuma condição de saída foi atingida. O preço ainda não avançou o suficiente para elevar o stop até a entrada.',
  },
  breakeven_triggered: {
    headline: 'Proteção aumentada',
    why: 'O preço avançou o suficiente para a regra de proteção elevar o stop até a entrada — a partir de agora a operação não fecha mais no vermelho.',
  },
  pre_tp1_trailing_dormant: {
    headline: 'Monitorando — trilha inativa',
    why: 'Nenhuma condição de saída foi atingida. O preço ainda não se moveu o suficiente a favor para a trilha de proteção começar a seguir.',
  },
  pre_tp1_trailing_advanced: {
    headline: 'Proteção aumentada',
    why: 'O preço avançou o suficiente para a trilha de proteção elevar o stop.',
  },
  tp1_hit_stop_to_breakeven: {
    headline: 'TP1 atingido — proteção aumentada',
    why: 'TP1 foi atingido: parte da posição foi realizada e o stop subiu para a entrada — o restante não pode mais fechar no vermelho.',
  },
  tp1_hit_stop_unchanged: {
    headline: 'TP1 atingido',
    why: 'TP1 foi atingido: parte da posição foi realizada. O stop já estava na entrada, então não houve mudança adicional.',
  },
  runner_rf_managed: {
    headline: 'Runner ativo',
    why: 'TP1 já foi atingido. O restante da posição é encerrado pela reversão do indicador, não por uma trilha de stop.',
  },
  runner_trailing_dormant: {
    headline: 'Runner ativo — trilha estável',
    why: 'TP1 já foi atingido. O preço ainda não se moveu o suficiente nesta passada para a trilha elevar o stop.',
  },
  runner_trailing_advanced: {
    headline: 'Runner ativo — proteção aumentada',
    why: 'TP1 já foi atingido e o preço avançou o suficiente para a trilha elevar o stop.',
  },
});

const FALLBACK_OPERATION_COPY = Object.freeze({
  headline: 'Monitorando',
  why: 'Nenhuma condição de saída foi atingida. O app não guardou os fatos exatos desta avaliação — a gestão continua automática.',
});

/**
 * Formata `decision_snapshot.facts` por `reason_code` de gestão. Mesma regra
 * fail-closed de `formatEvidence`: `data_status !== 'LIVE'` ou `reason_code`
 * sem formatador conhecido devolvem `null`, nunca um texto inventado.
 */
function formatOperationEvidence(snapshot) {
  if (!snapshot || snapshot.data_status !== 'LIVE') return null;
  const { reason_code: reasonCode, facts = {} } = snapshot;

  if (reasonCode === 'awaiting_tp1') {
    const toTp1 = formatNum(facts.distance_to_tp1);
    const toStop = formatNum(facts.distance_to_stop);
    if (toTp1 == null || toStop == null) return null;
    return `Medido: faltam ${toTp1} até o TP1, ${toStop} de folga até o stop.`;
  }

  if (reasonCode === 'tp1_hit_stop_to_breakeven' || reasonCode === 'tp1_hit_stop_unchanged') {
    const before = formatNum(facts.stop_before);
    const after = formatNum(facts.stop_after);
    if (before == null || after == null) return null;
    return reasonCode === 'tp1_hit_stop_to_breakeven'
      ? `Medido: stop foi de ${before} para ${after} (entrada).`
      : `Medido: stop mantido em ${after} (já era a entrada).`;
  }

  if (reasonCode === 'pre_tp1_protection_armed_not_triggered' || reasonCode === 'breakeven_triggered') {
    const move = formatNum(facts.favorable_move);
    const required = formatNum(facts.required_move);
    if (move == null || required == null) return null;
    const base = `Medido: movimento favorável ${move}, necessário ${required} para acionar.`;
    if (reasonCode === 'breakeven_triggered') {
      const before = formatNum(facts.stop_before);
      const after = formatNum(facts.stop_after);
      return before != null && after != null ? `${base} Stop foi de ${before} para ${after}.` : base;
    }
    return base;
  }

  if (reasonCode === 'pre_tp1_trailing_dormant' || reasonCode === 'pre_tp1_trailing_advanced') {
    const required = formatNum(facts.required_move);
    if (facts.favorable_move == null) {
      return required != null ? `Medido: ainda sem movimento favorável registrado — necessário ${required} para a trilha começar.` : null;
    }
    const move = formatNum(facts.favorable_move);
    if (move == null || required == null) return null;
    const base = `Medido: movimento favorável ${move}, gatilho da trilha em ${required}.`;
    if (reasonCode === 'pre_tp1_trailing_advanced') {
      const before = formatNum(facts.stop_before);
      const after = formatNum(facts.stop_after);
      return before != null && after != null ? `${base} Stop foi de ${before} para ${after}.` : base;
    }
    return base;
  }

  if (reasonCode === 'runner_rf_managed') {
    const toStop = formatNum(facts.distance_to_stop);
    if (toStop == null) return null;
    const toTp2 = formatNum(facts.distance_to_tp2);
    return toTp2 != null
      ? `Medido: ${toStop} de folga até o stop, faltam ${toTp2} até o TP2.`
      : `Medido: ${toStop} de folga até o stop.`;
  }

  if (reasonCode === 'runner_trailing_dormant' || reasonCode === 'runner_trailing_advanced') {
    const before = formatNum(facts.stop_before);
    const after = formatNum(facts.stop_after);
    if (reasonCode === 'runner_trailing_advanced' && before != null && after != null) {
      return `Medido: stop foi de ${before} para ${after}.`;
    }
    return before != null ? `Medido: stop mantido em ${before}.` : null;
  }

  return null;
}

/**
 * @param {object} op    TradeOperation completo (com ou sem decision_snapshot)
 * @returns mesmo contrato de `explainDecision`
 */
export function explainOperationDecision(op) {
  const snapshot = op?.decision_snapshot ?? null;
  const copy = snapshot && OPERATION_COPY[snapshot.reason_code]
    ? OPERATION_COPY[snapshot.reason_code]
    : FALLBACK_OPERATION_COPY;
  return {
    headline: copy.headline,
    why: copy.why,
    evidence: withMeasuredAt(formatOperationEvidence(snapshot), snapshot),
    missing: null,
    nextStep: null,
    userAction: NOTHING_TO_DO,
    warnings: warningsFor(snapshot),
    technical: snapshot,
  };
}
