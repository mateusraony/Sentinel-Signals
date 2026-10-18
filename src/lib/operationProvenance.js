/**
 * De onde veio uma operação (item 278, PR-C). A estatística ao vivo só deve
 * medir o que o MOTOR decidiu: entrada pelo caminho normal e saída pelas
 * regras. Ficam fora da conta:
 *  - `manual`: "🧪 Simular entrada" no painel (`activateSignalManually`, que
 *    grava `source: 'manual'`) — pula os filtros de entrada do motor;
 *  - `backfill`: reconstruída do histórico ao adicionar/reativar o ativo
 *    (item 137) — não foi vivida em tempo real;
 *  - `edited`: encerrada à mão pelo painel (Trades: diálogo de edição,
 *    botões Encerrar e Invalidar), que gravam um dos `MANUAL_CLOSE_REASONS`
 *    em `closed_reason` — o resultado não é do motor.
 * Limite conhecido: editar só stop/alvo sem encerrar não deixa marca.
 */
export const MANUAL_EDIT_REASON = 'Alterado manualmente';
export const MANUAL_CLOSE_REASON = 'Encerrado manualmente';
export const MANUAL_INVALIDATE_REASON = 'Invalidado manualmente';
export const MANUAL_CLOSE_REASONS = Object.freeze([MANUAL_EDIT_REASON, MANUAL_CLOSE_REASON, MANUAL_INVALIDATE_REASON]);

export const PROVENANCE = Object.freeze({ ENGINE: 'engine', MANUAL: 'manual', BACKFILL: 'backfill', EDITED: 'edited' });

export function operationProvenance(op) {
  if (op?.source === 'manual') return PROVENANCE.MANUAL;
  // Encerrar/Invalidar também gravam `decision_snapshot.executor: 'manual'`
  // (decisionSnapshot.js) — marca estruturada, aceita junto do texto.
  if (MANUAL_CLOSE_REASONS.includes(op?.closed_reason) || op?.decision_snapshot?.executor === 'manual') return PROVENANCE.EDITED;
  if (op?.source === 'backfill') return PROVENANCE.BACKFILL;
  return PROVENANCE.ENGINE;
}

/** Rótulos únicos (selo curto e banner) para o que fica fora da medição. */
export const PROVENANCE_LABEL = Object.freeze({
  [PROVENANCE.MANUAL]: {
    tag: '🧪 Simulação',
    banner: '🧪 Simulação manual — entrada criada por você no painel, sem os filtros do motor. Operação virtual: nenhuma ordem foi enviada à corretora. Fica fora da medição do motor (Confiança ao Vivo e comparação com o histórico).',
  },
  [PROVENANCE.EDITED]: {
    tag: '✏️ Encerrada à mão',
    banner: '✏️ Encerrada à mão — pelo painel (Encerrar, Invalidar ou edição); o resultado não é do motor. Fica fora da medição do motor (Confiança ao Vivo e comparação com o histórico).',
  },
});

/** `{ engine, excluded: { manual, backfill, edited, total } }` */
export function splitByProvenance(ops) {
  const engine = [];
  const excluded = { manual: 0, backfill: 0, edited: 0, total: 0 };
  for (const op of ops ?? []) {
    const p = operationProvenance(op);
    if (p === PROVENANCE.ENGINE) { engine.push(op); continue; }
    excluded[p]++;
    excluded.total++;
  }
  return { engine, excluded };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "Fora da conta: 2 simulações manuais · 1 retroativa · 1 encerrada à mão" ou null. */
export function provenanceExclusionText(excluded) {
  if (!excluded?.total) return null;
  const parts = [];
  if (excluded.manual) parts.push(plural(excluded.manual, 'simulação manual', 'simulações manuais'));
  if (excluded.backfill) parts.push(plural(excluded.backfill, 'retroativa', 'retroativas'));
  if (excluded.edited) parts.push(plural(excluded.edited, 'encerrada à mão', 'encerradas à mão'));
  return `Fora da conta: ${parts.join(' · ')}`;
}
