/**
 * "A história até agora" — a operação ABERTA contada em frases simples, na ordem em que aconteceu (aba Trades,
 * docs/known-risks.md item 303). Irmã de `tradeStory.js` (a história da operação FECHADA, aba Histórico, item 291): mesmo tom,
 * mesmas regras — só usa campos que a operação JÁ tem; o que faltar não vira frase (nunca "undefined", "NaN" nem horário
 * inventado); descreve o que ocorreu, não prevê nem opina.
 *
 * O que o motor NÃO grava e por isso não aparece aqui: o histórico das mudanças do stop. Existe o stop inicial, o atual, a hora
 * da última mudança e — só enquanto o último `decision_snapshot` ainda for o da mudança — o "de A para B" dela. Mostrar mais do
 * que isso exigiria gravar algo novo no motor (decisão do usuário, fora desta tarefa).
 *
 * Módulo puro (sem React, sem I/O): o componente injeta `fmt` (horário no fuso de Brasília).
 */
import { getTp1Price } from './tradeMetrics.js';
import { closesFullyAtTp1 } from './opExitRules.js';
import { formatPrice, formatSignedPct, stopPosture } from './priceProximity.js';
import { opSignalTimeframe, elapsedLabel, formatWhen } from './tradeStory.js';
import { formatSignedR } from './stopGuarantee.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPrice = (v) => isNum(v) && v > 0;
const money = (v) => (isPrice(v) ? `$${formatPrice(v)}` : null);
const lower = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);
const sameLevel = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6;

/** `decision_snapshot.reason_code` que registram uma MUDANÇA de stop (com `facts.stop_before`/`stop_after`). */
export const STOP_MOVE_REASON_CODES = Object.freeze([
  'pre_tp1_trailing_advanced', 'breakeven_triggered', 'tp1_hit_stop_to_breakeven', 'runner_trailing_advanced',
]);

/**
 * O que se sabe sobre a movimentação do stop de uma operação aberta.
 *
 * - `lastMove` (o "de A para B" da ÚLTIMA mudança) só existe quando o snapshot atual é de mudança E o `stop_after` dele é o stop
 *   atual. O snapshot é regravado a cada avaliação que persiste; depois disso o valor anterior se perde e `lastMove` é `null`.
 * - `when` é a hora da última mudança que o motor carimba: `pre_tp1_stop_advanced_at` antes do TP1; a vela
 *   (`runner_stop_advanced_candle_time`) no runner. Sem carimbo confiável, `null` — nunca um palpite.
 *
 * @returns {null | { initial: number|null, current: number, moved: boolean, favorable: boolean,
 *   lastMove: { from: number, to: number } | null, when: string|null, whenKind: string|null }} `whenKind`: 'at' | 'candle'
 */
export function describeStopMove(op) {
  if (!op || typeof op !== 'object' || !isPrice(op.current_stop)) return null;
  const current = op.current_stop;
  const initial = isPrice(op.initial_stop) ? op.initial_stop : null;
  const isBuy = op.side !== 'SELL';

  let lastMove = null;
  const snap = op.decision_snapshot;
  const facts = snap && typeof snap === 'object' ? snap.facts : null;
  if (facts && STOP_MOVE_REASON_CODES.includes(snap.reason_code)
    && isPrice(facts.stop_before) && isPrice(facts.stop_after)
    && !sameLevel(facts.stop_before, facts.stop_after) && sameLevel(facts.stop_after, current)) {
    lastMove = { from: facts.stop_before, to: facts.stop_after };
  }

  const moved = lastMove !== null || (initial !== null && !sameLevel(initial, current));
  const reference = initial ?? lastMove?.from ?? null;
  const favorable = reference !== null && !sameLevel(reference, current) && (isBuy ? current > reference : current < reference);

  let when = null;
  let whenKind = null;
  if (moved) {
    if (op.status === 'RUNNER_ACTIVE') {
      if (typeof op.runner_stop_advanced_candle_time === 'string' && op.runner_stop_advanced_candle_time) {
        when = op.runner_stop_advanced_candle_time; whenKind = 'candle';
      }
    } else if (typeof op.pre_tp1_stop_advanced_at === 'string' && op.pre_tp1_stop_advanced_at) {
      when = op.pre_tp1_stop_advanced_at; whenKind = 'at';
    }
  }

  return { initial, current, moved, favorable, lastMove, when, whenKind };
}

function defaultFmt(iso) {
  return String(iso);
}

/**
 * @param {object} op operação aberta (SIGNAL_CONFIRMED / RUNNER_ACTIVE)
 * @param {{ fmt?: (iso: string) => string }} [opts]
 * @returns {{ key: string, text: string }[]} `key`: 'opened' | 'plan' | 'path' | 'tp1' | 'stop'
 */
export function buildOpenTradeStory(op, { fmt = defaultFmt } = {}) {
  if (!op || typeof op !== 'object') return [];
  const steps = [];
  const isSell = op.side === 'SELL';
  const sideWord = op.side === 'BUY' ? 'compra' : isSell ? 'venda' : null;
  const signalTf = opSignalTimeframe(op);
  const execTf = lower(op.timeframe);
  const entry = isPrice(op.entry_price) ? op.entry_price : null;
  const risk = entry !== null && isPrice(op.initial_stop) ? Math.abs(entry - op.initial_stop) : null;
  const riskPct = risk !== null && risk > 0 ? (risk / entry) * 100 : null;

  // 1. Abriu
  const when = formatWhen(fmt, op.created_date);
  const via = signalTf && execTf && signalTf !== execTf
    ? ` (aviso do gráfico de ${signalTf.toUpperCase()}, confirmado no de ${execTf.toUpperCase()})`
    : '';
  steps.push({
    key: 'opened',
    text: `📍 Abriu uma operação${sideWord ? ` de ${sideWord}` : ''}${entry !== null ? ` a ${money(entry)}` : ''}${when ? ` em ${when}` : ''}${via}.`,
  });

  // 2. O plano: stop inicial e o tamanho do risco (é ele que define o "R" usado nas frases seguintes)
  if (riskPct !== null) {
    steps.push({
      key: 'plan',
      text: `O stop inicial ficou em ${money(op.initial_stop)}: o risco assumido era de ${formatSignedPct(-riskPct)} (isso é 1R, a régua das contas abaixo).`,
    });
  }

  // 3. O caminho: melhor e pior ponto vistos pelo motor (resolução de vela, não de tick)
  const hasMfe = isNum(op.mfe_r);
  const hasMae = isNum(op.mae_r);
  if (hasMfe || hasMae) {
    // `mfe_r`/`mae_r` têm sinal: o melhor ponto pode ainda ser negativo (nunca ficou a favor) e o pior pode ser positivo.
    const both = (r) => (riskPct !== null ? `${formatSignedPct(r * riskPct)} (${formatSignedR(r)})` : formatSignedR(r));
    const bits = [];
    if (hasMfe) bits.push(op.mfe_r > 0 ? `no melhor ponto chegou a ${both(op.mfe_r)}` : 'ainda não ficou a favor');
    if (hasMae) bits.push(op.mae_r < 0 ? `no pior ponto, a ${both(op.mae_r)}` : 'não chegou a ficar contra a posição');
    let text = `Desde a entrada: ${bits.join('; ')}`;
    const whenBest = hasMfe && op.mfe_r > 0 ? elapsedLabel(op.bars_to_mfe, signalTf) : null;
    if (whenBest) text += ` (o melhor ponto veio ${whenBest} depois da entrada)`;
    steps.push({ key: 'path', text: `${text}.` });
  }

  // 4. TP1
  if (op.tp1_hit === true || op.tp1_hit_at) {
    const price = money(getTp1Price(op));
    const partial = isNum(op.partial_percent) ? op.partial_percent : 50;
    const what = closesFullyAtTp1(op) ? 'fechou toda a posição' : `realizou ${partial}% da posição, deixando o resto correndo`;
    const whenTp1 = formatWhen(fmt, op.tp1_hit_real_time) ?? formatWhen(fmt, op.tp1_hit_at);
    steps.push({ key: 'tp1', text: `🎯 Bateu o TP1${price ? ` (${price})` : ''}${whenTp1 ? ` em ${whenTp1}` : ''} e ${what}.` });
  }

  // 5. O stop
  const move = describeStopMove(op);
  if (move) {
    if (!move.moved) {
      if (move.initial !== null) steps.push({ key: 'stop', text: `O stop continua no valor inicial (${money(move.current)}).` });
    } else {
      const posture = stopPosture(op);
      // 🛡️ = stop na entrada ou melhor (emojiRegistry). Stop que andou mas ainda arrisca não ganha o escudo.
      const lead = posture === 'locked' || posture === 'breakeven' ? '🛡️ Stop protegido: ' : 'Stop aproximado: ';
      const whenMove = formatWhen(fmt, move.when);
      const whenText = whenMove ? (move.whenKind === 'candle' ? ` na vela de ${whenMove}` : ` em ${whenMove}`) : '';
      let text;
      if (move.lastMove) {
        text = `${lead}a última mudança foi${whenText}, de ${money(move.lastMove.from)} para ${money(move.lastMove.to)}`;
        if (move.initial !== null && !sameLevel(move.initial, move.lastMove.from)) text += ` (o inicial era ${money(move.initial)})`;
      } else {
        text = `${lead}saiu de ${money(move.initial)} (inicial) para ${money(move.current)} (atual)`;
        if (whenText) text += `; a última mudança foi${whenText}`;
      }
      if (!move.favorable) text += ' — contra a posição (alterado à mão)';
      steps.push({ key: 'stop', text: `${text}.` });
    }
  }

  return steps;
}

/**
 * Tradução, para leigo, dos números de "quanto o preço andou × quanto precisa andar para a proteção agir" que o
 * `decision_snapshot` traz em unidades de preço ("movimento favorável 20.3300, gatilho da trilha em 5.6857").
 *
 * @returns {string|null} `null` quando o snapshot não é de proteção pré-TP1 ou faltam os números.
 */
export function describeProtectionProgress(op) {
  const snap = op?.decision_snapshot;
  const facts = snap && typeof snap === 'object' ? snap.facts : null;
  if (!facts) return null;
  const trailing = snap.reason_code === 'pre_tp1_trailing_dormant' || snap.reason_code === 'pre_tp1_trailing_advanced';
  const breakeven = snap.reason_code === 'pre_tp1_protection_armed_not_triggered' || snap.reason_code === 'breakeven_triggered';
  if (!trailing && !breakeven) return null;
  const entry = isPrice(op.entry_price) ? op.entry_price : null;
  if (entry === null || !isNum(facts.required_move) || !(facts.required_move > 0)) return null;

  const pctOf = (v) => `${(Math.abs(v) / entry * 100).toFixed(2)}%`;
  const need = `$${formatPrice(facts.required_move)} (${pctOf(facts.required_move)} da entrada)`;
  const rule = trailing
    ? `A trilha do stop só começa a agir depois que o preço anda ${need} a favor`
    : `O stop só vai para a entrada depois que o preço anda ${need} a favor`;

  if (!isNum(facts.favorable_move) || facts.favorable_move <= 0) {
    return `${rule}. Até a última avaliação o preço ainda não tinha andado a favor.`;
  }
  const moved = `$${formatPrice(facts.favorable_move)} (${pctOf(facts.favorable_move)})`;
  const reached = facts.favorable_move >= facts.required_move;
  // Na trilha o número é o MELHOR ponto desde a entrada (reconstruído do MFE); no breakeven é o fechamento da última vela avaliada.
  const seen = trailing ? `No melhor ponto ele já andou ${moved}` : `Na última avaliação ele estava ${moved} a favor`;
  return `${rule}. ${seen}: ${reached ? 'a proteção está ativa' : 'ainda não chegou lá'}.`;
}
