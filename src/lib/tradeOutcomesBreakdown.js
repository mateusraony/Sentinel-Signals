/**
 * "Como terminaram" (aba Histórico, docs/known-risks.md item 293) — as operações FECHADAS contadas pelo TIPO de saída, em linguagem simples:
 * alvo final · TP1 fechou tudo · stop com lucro · stop no zero a zero · stop com perda · invalidada · tempo esgotado · mercado sem direção · encerrada à mão.
 *
 * Só conta e agrupa: a classificação vem de campos que a operação já tem (`status`, `closed_reason`, proveniência) e do resultado da fonte única
 * (`classifyOutcome` de `tradeMetrics`) — nenhuma regra de resultado própria. Cada operação cai em EXATAMENTE uma categoria (a soma das categorias é
 * o total: invariante testada). Texto neutro: descreve como terminaram, não prevê nada.
 *
 * Módulo puro (sem React, sem I/O).
 */
import { classifyOutcome, isClosedOp } from './tradeMetrics.js';
import { isManualExit } from './operationProvenance.js';

export const OUTCOME_KIND = Object.freeze({
  TP2: 'tp2',
  TP1_FULL: 'tp1_full',
  STOP_WIN: 'stop_win',
  STOP_BE: 'stop_be',
  STOP_LOSS: 'stop_loss',
  INVALIDATED: 'invalidated',
  TIME_STOP: 'time_stop',
  CHOP_EXIT: 'chop_exit',
  MANUAL: 'manual',
  OTHER: 'other',
});

/** Ordem fixa de exibição + rótulo, dica e cor (as cores seguem `outcomeColor.js`: verde ganho, amarelo zero a zero, rosa perda, laranja invalidada). */
export const OUTCOME_META = Object.freeze({
  [OUTCOME_KIND.TP2]: { label: 'Alvo final (TP2)', hint: 'O preço chegou ao alvo final.', color: '#00ff80' },
  [OUTCOME_KIND.TP1_FULL]: { label: 'TP1 fechou tudo', hint: 'Operação sem runner: o TP1 fechou toda a posição.', color: '#00ff80' },
  [OUTCOME_KIND.STOP_WIN]: { label: 'Stop com lucro', hint: 'O stop foi tocado, mas o resultado final foi lucro (o stop já tinha subido ou o TP1 já tinha sido realizado).', color: '#00ff80' },
  [OUTCOME_KIND.STOP_BE]: { label: 'Stop no zero a zero', hint: 'O stop foi tocado e o resultado ficou perto de zero depois dos custos.', color: '#ffd166' },
  [OUTCOME_KIND.STOP_LOSS]: { label: 'Stop com perda', hint: 'O stop foi tocado e o resultado final foi perda.', color: '#ff1478' },
  [OUTCOME_KIND.INVALIDATED]: { label: 'Invalidada', hint: 'A condição técnica que sustentava a entrada caiu e a operação foi encerrada.', color: '#ff9f43' },
  [OUTCOME_KIND.TIME_STOP]: { label: 'Tempo esgotado', hint: 'Passou do prazo máximo sem atingir o TP1 e foi encerrada.', color: '#94a3b8' },
  [OUTCOME_KIND.CHOP_EXIT]: { label: 'Mercado sem direção', hint: 'O preço passou a andar de lado antes do TP1 e a operação foi encerrada.', color: '#60a5fa' },
  [OUTCOME_KIND.MANUAL]: { label: 'Encerrada à mão', hint: 'Encerrada, invalidada ou editada por você no painel — o resultado não é decisão do motor.', color: '#c4b5fd' },
  [OUTCOME_KIND.OTHER]: { label: 'Outras', hint: 'Fechada sem um motivo de saída reconhecido, ou sem resultado calculável.', color: '#64748b' },
});

const ORDER = Object.keys(OUTCOME_META);

/**
 * Em qual categoria uma operação FECHADA cai. `null` se a operação não está fechada.
 * Precedência: encerrada à mão (o resultado não é do motor) → status terminal → `closed_reason`.
 * "À mão" olha só o MOTIVO do encerramento (`isManualExit`), não a proveniência da entrada: uma simulação (`source: 'manual'`) encerrada à mão
 * pelo painel continua com `source: 'manual'` e `operationProvenance` a chama de simulação antes de ver o encerramento (achado do Codex, PR #545).
 * Uma simulação que o MOTOR encerrou (stop, TP, tempo…) segue classificada pela saída.
 */
export function classifyClosedOp(op) {
  if (!op || typeof op !== 'object' || !isClosedOp(op)) return null;
  if (isManualExit(op)) return OUTCOME_KIND.MANUAL;
  switch (op.status) {
    case 'TP2_HIT':
      return OUTCOME_KIND.TP2;
    case 'STOP_HIT': {
      const outcome = classifyOutcome(op);
      if (outcome === 'WIN') return OUTCOME_KIND.STOP_WIN;
      if (outcome === 'BE') return OUTCOME_KIND.STOP_BE;
      if (outcome === 'LOSS') return OUTCOME_KIND.STOP_LOSS;
      return OUTCOME_KIND.OTHER; // sem resultado calculável: não afirma ganho nem perda
    }
    case 'INVALIDATED':
      return OUTCOME_KIND.INVALIDATED;
    case 'CLOSED':
      switch (op.closed_reason) {
        case 'TP1_FULL': return OUTCOME_KIND.TP1_FULL;
        case 'TIME_STOP': return OUTCOME_KIND.TIME_STOP;
        case 'CHOP_EXIT': return OUTCOME_KIND.CHOP_EXIT;
        case 'INVALIDATION': return OUTCOME_KIND.INVALIDATED;
        default: return OUTCOME_KIND.OTHER;
      }
    default:
      return OUTCOME_KIND.OTHER;
  }
}

/**
 * @param {object[]} ops operações (só as FECHADAS entram; abertas e valores inválidos são ignorados)
 * @returns {{ total: number, items: { key: string, label: string, hint: string, color: string, count: number, pct: number }[] }}
 *   `items` só com as categorias que têm ao menos 1 operação, na ordem fixa; `pct` em % do total (soma ≈ 100); `total` = soma dos `count`.
 */
export function buildOutcomeBreakdown(ops) {
  const counts = Object.fromEntries(ORDER.map((k) => [k, 0]));
  let total = 0;
  for (const op of Array.isArray(ops) ? ops : []) {
    const kind = classifyClosedOp(op);
    if (kind === null) continue;
    counts[kind] += 1;
    total += 1;
  }
  const items = ORDER.filter((k) => counts[k] > 0).map((key) => ({
    key, ...OUTCOME_META[key], count: counts[key], pct: (counts[key] / total) * 100,
  }));
  return { total, items };
}
