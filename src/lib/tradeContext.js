/**
 * "O que o sistema via e como o trade se formou" (aba Histórico, docs/known-risks.md item 292) — três blocos de LEITURA sobre uma operação
 * fechada, todos montados só com campos que a operação JÁ tem:
 *
 *   1. `buildEntryContext`  — o que o sistema via NA ENTRADA (tendências 1d/4h/1h, regras alinhadas, ADX, Choppiness, tier, padrão de vela, SMC).
 *   2. `buildPlanVsActual`  — o PLANO (risco, alvos em R, prazo máximo) contra o REALIZADO (quanto durou).
 *   3. `buildResultBreakdown` — como o resultado se formou: bruto → custos estimados → líquido, com a parte do TP1 e a do restante.
 *
 * Mesma regra do `tradeStory.js`: campo que falta (operação legada) vira linha OMITIDA — nunca "undefined", "NaN", "0" nem horário/valor
 * inventado. Texto neutro: descreve o que foi medido, não prevê nem opina sobre o que "deveria" ter acontecido. "Regras alinhadas" não é
 * chance de acerto (item 264/277), e os custos são do MODELO do painel, não o extrato da corretora — dito na própria tela.
 *
 * Módulo puro (sem React, sem I/O).
 */
import {
  DEFAULT_COST_MODEL, ZERO_COST, getOpenedAt, getExitPrice, getTp1Price, getWeights,
  calcRealizedR, calcRealizedPnlPct, calcCostR, isClosedOp,
} from './tradeMetrics.js';
import { closesFullyAtTp1 } from './opExitRules.js';
import { agreementLabel, AGREEMENT_HINT } from './ruleAgreement.js';
import { opSignalTimeframe, hoursLabel, elapsedLabel } from './tradeStory.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPrice = (v) => isNum(v) && v > 0;
const signed = (v, digits = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;

/** Rótulos do padrão de vela que confirmou a entrada (`candlePatterns.js`; só existe com o gate de padrão ligado). */
export const CANDLE_PATTERN_LABEL = Object.freeze({
  bullish_engulfing: 'engolfo de alta',
  bearish_engulfing: 'engolfo de baixa',
  hammer: 'martelo',
  shooting_star: 'estrela cadente',
  bullish_marubozu: 'marubozu de alta',
  bearish_marubozu: 'marubozu de baixa',
});

const SMC_ALIGNMENT_LABEL = Object.freeze({ aligned: 'a favor da operação', against: 'contra a operação' });

/** Lado da operação como número (BUY = 1, SELL = -1) — o mesmo sinal das tendências `tf_*_direction`; `null` se desconhecido. */
function sideSign(op) {
  return op?.side === 'BUY' ? 1 : op?.side === 'SELL' ? -1 : null;
}

/**
 * @typedef {{ key: string, label: string, value: string, hint?: string }} ContextRow
 */

/**
 * O que o sistema via na entrada. Linha por linha, só o que existe; vazio se nada foi gravado.
 * @param {object} op operação (fechada ou não)
 * @returns {ContextRow[]}
 */
export function buildEntryContext(op) {
  if (!op || typeof op !== 'object') return [];
  const rows = [];
  const side = sideSign(op);

  // Tendências: só 1 (alta) / -1 (baixa). 0 e ausente = sem leitura (mesma regra de translateSignalContext). "a favor/contra" só com o lado conhecido.
  const trendBits = [];
  for (const [tf, value] of [['1D', op.tf_1d_direction], ['4H', op.tf_4h_direction], ['1H', op.tf_1h_direction]]) {
    if (value !== 1 && value !== -1) continue;
    const relation = side === null ? '' : value === side ? ' (a favor)' : ' (contra)';
    trendBits.push(`${tf} ${value === 1 ? 'alta' : 'baixa'}${relation}`);
  }
  if (trendBits.length > 0) rows.push({ key: 'trends', label: 'Tendências', value: trendBits.join(' · ') });

  // Regras alinhadas: score 0/ausente = sem dado (o scanner grava 0 quando não havia score) — nunca "0/100".
  const score = isNum(op.entry_score) ? op.entry_score : op.score;
  if (isNum(score) && score > 0) {
    const label = agreementLabel({ score });
    if (label) rows.push({ key: 'agreement', label: 'Regras alinhadas', value: label, hint: AGREEMENT_HINT });
  }

  if (typeof op.tier === 'string' && op.tier.trim()) {
    rows.push({ key: 'tier', label: 'Volatilidade (tier)', value: op.tier.trim().toUpperCase() });
  }
  if (isNum(op.adx_at_entry)) {
    rows.push({ key: 'adx', label: 'ADX (força da tendência)', value: op.adx_at_entry.toFixed(1), hint: 'Quanto maior, mais forte era a tendência.' });
  }
  if (isNum(op.chop_at_entry)) {
    rows.push({ key: 'chop', label: 'Choppiness (de 0 a 100)', value: op.chop_at_entry.toFixed(1), hint: 'Quanto maior, mais o preço andava de lado.' });
  }

  const pattern = CANDLE_PATTERN_LABEL[op.entry_candle_pattern];
  if (pattern) rows.push({ key: 'pattern', label: 'Padrão da vela', value: pattern });

  const smc = SMC_ALIGNMENT_LABEL[op.smc_alignment_at_entry];
  if (smc) rows.push({ key: 'smc', label: 'Estrutura SMC', value: smc });

  return rows;
}

/**
 * Primeiro carimbo de ENCERRAMENTO que existe. Mesma régua do `tradeStory.js`: nunca `getClosedAt` (cai em `updated_date`/`created_date`
 * em documento legado e faria a operação "durar zero").
 */
function closingStamp(op) {
  const candidates = op.status === 'STOP_HIT'
    ? [op.stop_hit_real_time, op.stop_hit_at, op.closed_at_real_time, op.closed_at]
    : [op.closed_at_real_time, op.closed_at];
  for (const iso of candidates) {
    if (typeof iso === 'string' && iso && Number.isFinite(new Date(iso).getTime())) return iso;
  }
  return null;
}

/** Alvo em R (positivo = do lado certo da entrada); `null` se o preço não existe ou está do lado errado. */
function targetR(op, price, risk, sign) {
  if (!isPrice(price) || !isPrice(risk) || sign === null) return null;
  const r = (sign * (price - op.entry_price)) / risk;
  return r > 0 ? r : null;
}

/**
 * O plano contra o realizado: risco previsto, alvos em R, prazo máximo e quanto a operação durou.
 * @param {object} op
 * @returns {ContextRow[]}
 */
export function buildPlanVsActual(op) {
  if (!op || typeof op !== 'object') return [];
  const rows = [];
  const sign = sideSign(op);
  const hasLevels = isPrice(op.entry_price) && isPrice(op.initial_stop) && op.entry_price !== op.initial_stop;
  const risk = hasLevels ? Math.abs(op.entry_price - op.initial_stop) : null;

  if (hasLevels) {
    rows.push({
      key: 'risk',
      label: 'Risco previsto',
      value: `${((risk / op.entry_price) * 100).toFixed(2)}% do preço de entrada`,
      hint: 'Distância da entrada até o stop inicial. É o "1R" das contas desta tela.',
    });
  }

  if (risk !== null) {
    const tp1 = targetR(op, op.tp1, risk, sign);
    // TP2 só vale quando a operação tem runner e o teto fixo está ativo (mesma regra de getTp2Tooltip).
    const tp2UsedByOp = !closesFullyAtTp1(op) && !op.tp2_cap_disabled;
    const tp2 = tp2UsedByOp ? targetR(op, op.tp2, risk, sign) : null;
    const bits = [];
    if (tp1 !== null) bits.push(`TP1 ${signed(tp1)}R${closesFullyAtTp1(op) ? ' (fecha toda a posição)' : ''}`);
    if (tp2 !== null) bits.push(`TP2 ${signed(tp2)}R`);
    if (bits.length > 0) rows.push({ key: 'targets', label: 'Alvos planejados', value: bits.join(' · ') });
  }

  // Prazo máximo (Time Stop) congelado na criação, em velas do timeframe do aviso.
  const signalTf = opSignalTimeframe(op);
  if (isNum(op.tier_time_stop_bars) && op.tier_time_stop_bars > 0 && (signalTf === '4h' || signalTf === '1h')) {
    const bars = Math.round(op.tier_time_stop_bars);
    rows.push({
      key: 'deadline',
      label: 'Prazo máximo',
      value: `${bars} velas de ${signalTf.toUpperCase()} (${elapsedLabel(bars, signalTf)})`,
      hint: 'Se a operação não atingir o TP1 dentro desse prazo, o sistema a encerra (Time Stop).',
    });
  }

  // Quanto durou de verdade: entrada → carimbo de encerramento conhecido. Sem os dois, sem linha.
  if (isClosedOp(op)) {
    const stamp = closingStamp(op);
    const openedAt = getOpenedAt(op);
    if (stamp && openedAt) {
      // `hoursLabel` já recusa NaN e negativo (encerramento "antes" da entrada): sem linha, nunca "-3 h".
      const label = hoursLabel((new Date(stamp).getTime() - new Date(openedAt).getTime()) / 3600000);
      if (label) rows.push({ key: 'duration', label: 'Durou', value: label });
    }
  }

  return rows;
}

/** Texto das premissas de custo, lido do MESMO modelo que calcula o líquido — se o modelo mudar, a frase muda junto. */
export function costModelNote() {
  const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
  const m = DEFAULT_COST_MODEL;
  return `Custos estimados pelo modelo do painel (taxa ${pct(m.feeBpsEntry)} na entrada e ${pct(m.feeBpsExit)} na saída, `
    + `deslizamento ${pct(m.slippageBpsPerSide)} por lado e funding ${pct(m.fundingBpsPer8h)} a cada 8 h) — não são o extrato da corretora. `
    + 'A saída no TP1 usa o nível planejado, não um preenchimento medido.';
}

/**
 * Como o resultado se formou. `null` se a operação não está fechada ou não tem resultado calculável.
 * Invariante (testada): bruto − custos = líquido, e as partes (TP1 + restante) somam o bruto.
 *
 * @param {object} op
 * @returns {null | {
 *   grossPct: number, costPct: number, netPct: number,
 *   grossR: number|null, costR: number|null, netR: number|null,
 *   legs: { key: string, label: string, r: number }[],
 * }}
 */
export function buildResultBreakdown(op) {
  if (!op || typeof op !== 'object' || !isClosedOp(op)) return null;
  const netPct = calcRealizedPnlPct(op);
  const grossPct = calcRealizedPnlPct(op, ZERO_COST);
  if (netPct === null || grossPct === null) return null;

  const netR = calcRealizedR(op);
  const grossR = calcRealizedR(op, ZERO_COST);
  const costR = grossR !== null && netR !== null ? calcCostR(op) : null;

  // Partes do bruto: só quando o TP1 realizou uma parcela e o resto seguiu (partial entre 0 e 100%), e o risco é conhecido.
  const legs = [];
  const sign = sideSign(op);
  const exit = getExitPrice(op);
  const tp1Price = op.tp1_hit ? getTp1Price(op) : null;
  const risk = isPrice(op.entry_price) && isPrice(op.initial_stop) ? Math.abs(op.entry_price - op.initial_stop) : 0;
  if (grossR !== null && sign !== null && tp1Price !== null && exit !== null && risk > 0) {
    const { partial, runner } = getWeights(op);
    if (partial > 0 && runner > 0) {
      const leg = (weight, price) => (weight * sign * (price - op.entry_price)) / risk;
      legs.push(
        { key: 'tp1_leg', label: `${Math.round(partial * 100)}% fechado no TP1`, r: leg(partial, tp1Price) },
        { key: 'runner_leg', label: `${Math.round(runner * 100)}% restante, até a saída`, r: leg(runner, exit) },
      );
    }
  }

  return { grossPct, costPct: grossPct - netPct, netPct, grossR, costR, netR, legs };
}
