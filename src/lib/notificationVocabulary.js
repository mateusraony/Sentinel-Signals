/**
 * Auditoria do Telegram (2026-09-29), Fase 2 item 2.1 — vocabulário único do
 * ciclo de vida sinal→operação. Centraliza os pares emoji/rótulo que hoje
 * cada canal (Telegram, toast, banner, Alertas) escolhia por conta própria,
 * às vezes com palavras diferentes pro MESMO evento (ex.: toast dizia "Sinal
 * Confirmado" pra algo que o Telegram, corretamente, trata como "aguardando
 * confirmação de entrada" — auditoria, achado central).
 *
 * Consumido a partir desta fase por `telegram.js`/`adminTelegram.js`
 * (mensagens) e `SignalToast.jsx` (wording). A Fase 4 (arquitetura unificada
 * `NotificationEvent`) importa este MESMO arquivo em vez de redefinir do
 * zero — ver o plano em /root/.claude/plans/auditoria-do-telegram-sentinel-
 * snug-zephyr.md.
 *
 * Regra: 1 estágio = 1 emoji = 1 rótulo, sempre. Não reusar o emoji de um
 * estágio pra outro, mesmo que pareça parecido.
 */
export const NOTIFICATION_STAGES = {
  SIGNAL_DETECTED: { emoji: '🔔', label: 'Sinal Detectado' },
  VERIFICATION_NEEDED: { emoji: '🔎', label: 'Verificação Necessária' },
  AWAITING_ENTRY: { emoji: '⏳', label: 'Aguardando Entrada' },
  ENTRY_CONFIRMED: { emoji: '✅', label: 'Entrada Confirmada' },
  TP1_HIT: { emoji: '🎯', label: 'TP1 Atingido' },
  RUNNER_ACTIVE: { emoji: '🏃', label: 'Runner Ativo' },
  TP2_HIT: { emoji: '🏆', label: 'TP2 Atingido — Alvo Final' },
  STOP_LOSS: { emoji: '🛑', label: 'Stop Atingido' },
  STOP_BREAKEVEN: { emoji: '🟡', label: 'Encerrada no Breakeven' },
  STOP_LOCKED_PROFIT: { emoji: '💰', label: 'Stop Travou Lucro' },
  INVALIDATED: { emoji: '⚠️', label: 'Sinal Invalidado' },
  TIME_STOP: { emoji: '⏱️', label: 'Time Stop' },
  CHOP_EXIT: { emoji: '🌊', label: 'Chop Exit' },
  // Fase 3 (2026-10-02) — sinal que expira sem NUNCA ter virado operação
  // (categoria diferente de INVALIDATED/TIME_STOP/CHOP_EXIT, que fecham uma
  // operação já ABERTA). Emoji distinto de propósito, ver regra acima.
  SIGNAL_CANCELED: { emoji: '🚫', label: 'Sinal Cancelado' },
};

/** `${emoji} ${label}` pronto pra usar num cabeçalho de mensagem. */
export function stageHeader(stageId) {
  const stage = NOTIFICATION_STAGES[stageId];
  if (!stage) return '';
  return `${stage.emoji} ${stage.label}`;
}
