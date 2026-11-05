/**
 * Estilo do cartão do ativo (Dashboard) pela FASE do último aviso — só visual, sem decidir nada sobre operação
 * (docs/known-risks.md item 290).
 *
 * Contexto: o item 277 (17/10) tirou a cor do LADO (verde/rosa) da barra de proximidade e do brilho do cartão — soava
 * como "compra/venda iminente" — e deixou tudo em azul neutro. Sem operação aberta, vários ativos ficam "perto da
 * linha" ao mesmo tempo e o Dashboard inteiro fica azul: nada diferencia um ativo com aviso esperando confirmação de
 * um que só está perto da linha. E o cartão chamava QUALQUER último aviso de "🔔 Aviso pendente BUY/SELL", inclusive um
 * de 3 dias atrás já expirado (afirmação falsa).
 *
 * Aqui a diferença é por ESTADO do aviso, nunca por direção:
 *   - WAITING (dentro da janela de 4 h de confirmação): âmbar, com o rótulo "⏳ Esperando confirmação";
 *   - EXPIRED (a janela acabou, nenhuma operação abriu): cinza, "🚫 Já passou" — sem destaque;
 *   - INFO (aviso que nunca vira operação): azul de "só informação", sem destaque.
 * Os textos e as cores de fase vêm de `phaseCopy` (`signalStatus.js`) — fonte única, a mesma dos alertas e do drawer.
 * Cor nunca vai sozinha: o rótulo em texto acompanha sempre. Módulo puro (sem React, sem I/O).
 */
import { SIGNAL_PHASE, REASON_KIND, phaseCopy } from './signalStatus.js';

/** Cor do motivo ("por que ainda não entrou"): mesma família das fases — esperando amarelo, piorou laranja. */
export const REASON_COLORS = Object.freeze({
  [REASON_KIND.WAITING]: '#ffd166',
  [REASON_KIND.WORSE]: '#ff9f43',
  [REASON_KIND.APP]: '#94a3b8',
  [REASON_KIND.INFO]: '#60a5fa',
});

export function reasonColor(kind) {
  return REASON_COLORS[kind] ?? REASON_COLORS[REASON_KIND.WAITING];
}

/** Cor do motivo no cartão: a da família enquanto o aviso vale; cinza se já passou / nunca vira operação. */
export function reasonColorFor(style, kind) {
  return style?.reasonMuted ? REASON_COLORS[REASON_KIND.APP] : reasonColor(kind);
}

/**
 * Rótulo, cor e contorno do cartão para um aviso SEM operação aberta. `null` para fase desconhecida (o cartão cai no
 * comportamento de antes). `border`/`glow` `null` = manter o contorno padrão do cartão.
 * `dimBadge`: o selo grande BUY/SELL só fica vivo enquanto o aviso ainda está valendo.
 */
export function signalCardStyle(phase) {
  if (phase !== SIGNAL_PHASE.WAITING && phase !== SIGNAL_PHASE.EXPIRED && phase !== SIGNAL_PHASE.INFO) return null;
  const copy = phaseCopy(phase);
  const waiting = phase === SIGNAL_PHASE.WAITING;
  return {
    phase,
    label: `${copy.icon} ${copy.badge}`,
    labelColor: copy.color,
    border: waiting ? 'rgba(255,209,102,0.32)' : null,
    glow: waiting ? '0 0 18px rgba(255,209,102,0.08)' : null,
    dimBadge: !waiting,
    // Motivo de aviso que já passou (ou que nunca vira operação) em cinza: em âmbar pareceria que ainda está valendo.
    reasonMuted: !waiting,
    // "Só informação" já é o rótulo: repetir o chip do motivo seria o mesmo texto duas vezes (e aviso informativo nunca tem motivo).
    showReason: phase !== SIGNAL_PHASE.INFO,
  };
}
