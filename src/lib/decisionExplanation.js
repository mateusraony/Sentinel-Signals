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
 * Só cobre `SignalEvent` nesta fase — `TradeOperation` (HOLDING/PROTECTED/
 * EXIT) ainda não tem `decision_snapshot`; ver docs/known-risks.md.
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

/**
 * Formata `decision_snapshot.facts` numa frase curta, por `reason_code`.
 * Só os dois reason_codes que `decisionSnapshot.js` já produz nesta fase —
 * um reason_code sem formatador conhecido (ou fatos incompletos) devolve
 * `null`, nunca um texto genérico fingindo evidência.
 */
function formatEvidence(snapshot) {
  if (!snapshot || snapshot.data_status === 'UNKNOWN') return null;
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
    evidence: formatEvidence(snapshot),
    missing: null,
    nextStep: null,
    userAction: NOTHING_TO_DO,
    warnings: warningsFor(snapshot),
    technical: snapshot,
  };
}
