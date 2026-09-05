/**
 * Linha do tempo de uma operação ou de um aviso — o registro de QUANDO cada
 * coisa aconteceu (docs/known-risks.md item 161).
 *
 * Pedido do usuário (2026-09-05): *"precisa colocar o horário que foi negado
 * ou fechado ou aberto de tudo pra poder comparar depois e ver como está
 * agindo o sistema"*. É uma necessidade de AUDITORIA: sem horário absoluto,
 * "há 5 horas" não serve para conferir nada depois.
 *
 * Módulo puro: sem React, sem I/O, sem formatação de fuso (quem formata é o
 * componente, que sabe o fuso do usuário). Só decide QUAIS eventos existem,
 * COM QUAL carimbo, e o quanto esse carimbo é confiável.
 *
 * ## Dois relógios, de propósito
 *
 * O schema grava dois horários para cada saída:
 *
 * - `X_hit_real_time` / `closed_at_real_time` — o fechamento da vela que
 *   confirmou o evento. É o horário de MERCADO.
 * - `X_hit_at` / `closed_at` — quando a passada do scan DETECTOU e gravou.
 *   É o horário de relógio, e pode atrasar bastante numa falha do cron ou
 *   numa queda de cota.
 *
 * O schema é explícito: *"Prefer this over X_at for display"*. Então
 * `at` aqui é sempre o horário de mercado quando ele existe, e `detectedAt`
 * carrega o outro para o componente poder mostrar a defasagem — que é
 * justamente o sinal de diagnóstico que o usuário quer poder comparar.
 */

/** Janela de confirmação de um sinal (scanner.js FOUR_HOURS_MS). */
export const CONFIRMATION_WINDOW_MS = 4 * 60 * 60 * 1000;

function iso(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Um evento da linha do tempo.
 *
 * @typedef {object} TimelineEvent
 * @property {string} key
 * @property {string} label      texto curto, em português simples
 * @property {string} at         ISO — o melhor horário disponível (mercado > relógio)
 * @property {string|null} detectedAt  ISO do relógio, quando difere de `at`
 * @property {boolean} candleBound  `at` é o fechamento da vela (cota máxima), não o instante exato
 */

const EXIT_LABEL = {
  TP2_HIT: 'TP2 atingido',
  STOP_HIT: 'Stop atingido',
  INVALIDATED: 'Invalidada',
  CLOSED: 'Encerrada',
};

const CLOSED_REASON_LABEL = {
  TIME_STOP: 'tempo esgotado',
  CHOP_EXIT: 'mercado sem direção',
  INVALIDATION: 'condição técnica caiu',
  TP1_FULL: 'TP1 fechou tudo',
};

/** Texto em português simples do motivo do encerramento, ou `null`. */
export function closedReasonLabel(op) {
  return CLOSED_REASON_LABEL[op?.closed_reason] ?? null;
}

function event(key, label, realTime, detectedAt) {
  const market = iso(realTime);
  const clock = iso(detectedAt);
  const at = market ?? clock;
  if (!at) return null;
  return {
    key,
    label,
    at,
    // Só carrega o relógio quando ele é uma informação a mais (temos os dois).
    detectedAt: market && clock ? clock : null,
    candleBound: Boolean(market),
  };
}

/**
 * Eventos de uma operação, em ordem cronológica.
 *
 * Só entra o que realmente aconteceu — nada de linha vazia para um TP que
 * nunca foi atingido.
 *
 * @returns {TimelineEvent[]}
 */
export function opTimeline(op) {
  if (!op) return [];
  const events = [
    event('opened', 'Aberta', null, op.created_date),
    event('tp1', 'TP1 atingido', op.tp1_hit_real_time, op.tp1_hit_at),
    event('tp2', 'TP2 atingido', op.tp2_hit_real_time, op.tp2_hit_at),
    event('stop', 'Stop atingido', op.stop_hit_real_time, op.stop_hit_at),
  ].filter(Boolean);

  // O fechamento terminal só entra se não for redundante com o TP2/stop que
  // já apareceu acima — senão a mesma coisa apareceria duas vezes.
  const closed = event('closed', EXIT_LABEL[op.status] ?? 'Encerrada', op.closed_at_real_time, op.closed_at);
  if (closed && !events.some((e) => e.at === closed.at && e.key !== 'opened')) {
    events.push(closed);
  }

  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
}

/**
 * Eventos de um aviso (SignalEvent).
 *
 * ⚠️ **O horário da rejeição não existe no banco.** `SignalEvent` grava
 * `last_rejection_reason` (texto) e `expired_logged` (booleano), mas nenhum
 * carimbo de quando a rejeição foi registrada — confirmado no schema. Mostrar
 * um horário aproximado aqui seria inventar dado de auditoria, então esta
 * função devolve só o que é verificável: quando o aviso apareceu e quando o
 * prazo fecha/fechou (derivado, exato). Ver item 161 para a mudança de motor
 * que destravaria isso.
 *
 * @returns {TimelineEvent[]}
 */
export function signalTimeline(signal, { now = Date.now() } = {}) {
  if (!signal) return [];
  const appeared = event('appeared', 'Aviso apareceu', null, signal.created_date);
  if (!appeared) return [];

  const events = [appeared];
  // Só a cascata de 4h tem prazo de verdade; 1h/1d nunca confirmam nem expiram.
  if (signal.timeframe === '4h') {
    const deadline = new Date(appeared.at).getTime() + CONFIRMATION_WINDOW_MS;
    events.push({
      key: 'deadline',
      label: deadline <= now ? 'Prazo fechou' : 'Prazo fecha',
      at: new Date(deadline).toISOString(),
      detectedAt: null,
      candleBound: false,
    });
  }
  return events;
}
