// Alvos estruturais — docs/known-risks.md item 281.
// BACKTEST-ONLY: só é usado quando `pineConfig.targetMode` é 'fib_ext_15m' ou
// 'swing_4h' (chaves `targetMode`/`targetNearPolicy` existem apenas em
// scripts/backtestPineConfig.js, travadas por src/lib/targetModeTripwire.test.js).
// Mantém a entrada e o stop de sempre e troca SÓ o TP1/TP2. Original a este
// projeto, sem paridade Pine.
//
// Funções puras: sem I/O, sem Date.now(). Toda referência de tempo vem do
// chamador e velas com closeTime > nowMs são descartadas aqui dentro (causal).
//
// Regras PRÉ-REGISTRADAS (item 281). Mudar qualquer constante depois de ver
// resultado invalida o teste — structuralTargets.test.js trava os valores.

import { planFibEntry, closedAsOf } from './fibEntry.js';

export const TARGET_RULES = Object.freeze({
  modes: Object.freeze(['r_multiple', 'fib_ext_15m', 'swing_4h']),
  // literal: primeiro nível além da entrada, a qualquer distância.
  // min_r_fallback: esse mesmo nível; a menos de minTargetR → alvo do controle.
  // next_level: primeiro nível a pelo menos minTargetR da entrada.
  nearPolicies: Object.freeze(['literal', 'min_r_fallback', 'next_level']),
  minTargetR: 0.5,
  fibLadder: Object.freeze([1.272, 1.618, 2.0, 2.618]), // extensões medidas da origem da perna
  fibFetch15m: 200, // folga para o retry: a perna fica nas 32 velas até o sinal
  swingPivotBars: 5, // pivô confirmado com 5 velas fechadas de cada lado
  swingLookback4h: 150,
  swingFetch4h: 160,
  tp2FallbackMult: 2, // sem nível seguinte: TP2 = entrada + 2×(TP1 − entrada)
});

/**
 * Escada de extensões de Fibonacci da perna de 15m do item 267 — a MESMA perna
 * (`planFibEntry` medido no instante do fechamento do sinal, sem olhar nenhuma
 * vela depois dele). Entrada e stop do item 267 ficam de fora.
 * @param {{ candles15m: object[], direction: 'BUY'|'SELL', signalCloseMs: number }} p
 * @returns {{ levels?: number[], leg?: object, atr?: number, reason?: string, dataProblem?: boolean }}
 */
export function fibLevels({ candles15m, direction, signalCloseMs }) {
  const plan = planFibEntry({ candles15m, direction, signalCloseMs, nowMs: signalCloseMs });
  if (!plan.leg || !Number.isFinite(plan.tp1)) {
    return { reason: plan.reason ? `fib_${plan.status}:${plan.reason}` : `fib_${plan.status}`, dataProblem: plan.status === 'insufficient_data' };
  }
  const sign = direction === 'BUY' ? 1 : -1;
  const { origin, delta } = plan.leg;
  return { levels: TARGET_RULES.fibLadder.map((ext) => origin + sign * ext * delta), leg: plan.leg, atr: plan.atr };
}

/**
 * Pivôs de 4h confirmados: a vela i é pivô de máxima (compra) se a máxima dela
 * for estritamente maior que as das `k` velas fechadas de cada lado; pivô de
 * mínima (venda) é o espelho. Só entram velas fechadas até `nowMs`, então um
 * pivô só existe depois que as `k` velas da direita fecharam (não repinta).
 * @param {{ candles4h: object[], direction: 'BUY'|'SELL', nowMs: number }} p
 * @returns {{ levels?: number[], reason?: string, dataProblem?: boolean }}
 */
export function swingLevels({ candles4h, direction, nowMs }) {
  const R = TARGET_RULES;
  if (direction !== 'BUY' && direction !== 'SELL') return { reason: 'swing_invalid_direction' };
  if (!Number.isFinite(nowMs)) return { reason: 'swing_invalid_input' };
  const closed = closedAsOf(candles4h, nowMs).slice(-R.swingLookback4h);
  const k = R.swingPivotBars;
  if (closed.length < 2 * k + 1) return { reason: 'swing_insufficient_data', dataProblem: true };
  const isBuy = direction === 'BUY';
  const pick = (c) => (isBuy ? c.high : c.low);
  const beats = (a, b) => (isBuy ? a > b : a < b);
  const levels = [];
  for (let i = k; i < closed.length - k; i += 1) {
    const v = pick(closed[i]);
    let ok = true;
    for (let j = i - k; j <= i + k && ok; j += 1) {
      if (j !== i && !beats(v, pick(closed[j]))) ok = false;
    }
    if (ok) levels.push(v);
  }
  return { levels };
}

const BASIS = Object.freeze({ fib_ext_15m: 'FIB_EXT_15M', swing_4h: 'SWING_4H' });

/**
 * Escolhe TP1/TP2 entre os níveis candidatos, pela política de alvo perto.
 * Os níveis além da entrada são ordenados do mais perto ao mais longe; TP2 é o
 * nível seguinte ao TP1 (senão entrada + 2×(TP1 − entrada)). Sem alvo → a
 * operação fica com o alvo do controle (1,5R/3R) e o motivo vai para
 * `target_basis`/`target_fallback_reason`.
 * @param {{ mode: string, policy: string, direction: 'BUY'|'SELL', entry: number, stop: number,
 *   candidate: { levels?: number[], reason?: string } }} p
 * @returns {{ ok: boolean, tp1: number|null, tp2: number|null, basis: string,
 *   reason: string|null, rrTarget: number|null, firstLevelR: number|null }}
 */
export function resolveTarget({ mode, policy, direction, entry, stop, candidate }) {
  const fallback = (reason, firstLevelR = null) => ({ ok: false, tp1: null, tp2: null, basis: 'R_MULTIPLE_FALLBACK', reason, rrTarget: null, firstLevelR });
  const basis = BASIS[mode];
  if (!basis) return fallback('unknown_mode');
  if (!TARGET_RULES.nearPolicies.includes(policy)) return fallback('unknown_policy');
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !Number.isFinite(entry)) return fallback('invalid_risk');
  if (!Array.isArray(candidate?.levels)) return fallback(candidate?.reason ?? 'no_target');
  const sign = direction === 'BUY' ? 1 : -1;
  const beyond = [...new Set(candidate.levels.filter((v) => Number.isFinite(v) && (v - entry) * sign > 0))]
    .sort((a, b) => (a - b) * sign);
  if (beyond.length === 0) return fallback('no_level_beyond_entry');
  const distR = (v) => ((v - entry) * sign) / risk;
  const firstLevelR = distR(beyond[0]);
  let idx = 0;
  if (policy === 'min_r_fallback' && firstLevelR < TARGET_RULES.minTargetR) return fallback('target_below_min_r', firstLevelR);
  if (policy === 'next_level') {
    idx = beyond.findIndex((v) => distR(v) >= TARGET_RULES.minTargetR);
    if (idx === -1) return fallback('no_level_at_min_r', firstLevelR);
  }
  const tp1 = beyond[idx];
  const tp2 = beyond[idx + 1] ?? entry + TARGET_RULES.tp2FallbackMult * (tp1 - entry);
  return { ok: true, tp1, tp2, basis, reason: null, rrTarget: distR(tp1), firstLevelR };
}
