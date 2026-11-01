// Contexto de Mercado — Fase 4a (docs/known-risks.md item 285, addendum 12): mensagens do Telegram do Contexto.
// Parte PURA (sem rede, sem Date.now). Texto neutro de propósito — só fatos da agenda: nada de "vai subir/cair",
// probabilidade, compra ou venda. Reaproveita a lógica da faixa do painel (`src/lib/marketContextBand.js`) para que a
// hora, a contagem regressiva e os rótulos sejam exatamente os mesmos nos dois lugares.
import {
  parseEvents, upcomingEvents, formatCountdown, formatEventWhen, EVENT_LABELS, EVENT_HINTS, STATUS_LABELS,
} from '../src/lib/marketContextBand.js';

/** Categorias de aviso. `teste` é sempre permitida (é o botão manual); as outras só se estiverem na variável do repositório. */
export const CATEGORIES = Object.freeze(['teste', 'agenda', 'pre-evento']);
export const NEUTRAL_NOTE = 'Só informação — não altera sinais nem operações.';
const EMOJI = '🗓️';

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "agenda, pre-evento" → Set com as categorias válidas (o resto é ignorado). Vazio/ausente = nenhuma ligada. */
export function parseCategories(csv) {
  return new Set(String(csv ?? '').toLowerCase().split(/[\s,;]+/).filter((c) => CATEGORIES.includes(c)));
}

export function isCategoryEnabled(category, csv) {
  return category === 'teste' || parseCategories(csv).has(category);
}

/** Eventos de `events.json` (corpo já lido). Linha ruim é ignorada; lança se o corpo nem é uma lista. */
export function readEvents(json) {
  return parseEvents(json);
}

export function buildTestMessage(nowMs) {
  return [
    `${EMOJI} <b>Teste do aviso do Contexto</b>`,
    '',
    'Se você recebeu esta mensagem, o caminho GitHub → Telegram do Contexto de Mercado funciona.',
    `Enviada em ${escapeHtml(formatEventWhen(new Date(nowMs).toISOString()))}.`,
    '',
    NEUTRAL_NOTE,
  ].join('\n');
}

export function buildAgendaMessage(events, nowMs, limit = 5) {
  const rows = upcomingEvents(events, nowMs, limit);
  const lines = [`${EMOJI} <b>Agenda de eventos dos EUA</b>`, ''];
  if (!rows.length) lines.push('Nenhum evento à frente na agenda.');
  for (const e of rows) {
    const quando = e.status === 'a_confirmar' ? '' : ` · ${e.phase === 'agora' ? 'acabou de sair' : formatCountdown(e.startMs - nowMs)}`;
    lines.push(`• <b>${escapeHtml(EVENT_LABELS[e.kind])}</b> (${escapeHtml(EVENT_HINTS[e.kind])}) — ${escapeHtml(formatEventWhen(e.startsAtUtc))}${quando} · ${escapeHtml(STATUS_LABELS[e.status])}`);
  }
  lines.push('', NEUTRAL_NOTE);
  return lines.join('\n');
}

/** O próximo evento com data firme (oficial ou confirmada) que ainda não começou; null se não há. */
export function nextAlertableEvent(events, nowMs) {
  return upcomingEvents(events, nowMs, 50).find((e) => e.phase === 'futuro' && e.status !== 'a_confirmar') ?? null;
}

/** Aviso ANTES do evento: só o evento e a hora. Sem lista de operações (decisão do usuário, 01/11: não lê o banco). */
export function buildPreEventMessage(event, nowMs) {
  const label = EVENT_LABELS[event.kind];
  return [
    `${EMOJI} <b>${escapeHtml(label)} — ${escapeHtml(formatCountdown(event.startMs - nowMs))}</b>`,
    '',
    `${escapeHtml(label)} (${escapeHtml(EVENT_HINTS[event.kind])}) — ${escapeHtml(formatEventWhen(event.startsAtUtc))}.`,
    `Situação da data: ${escapeHtml(STATUS_LABELS[event.status])}.`,
    '',
    NEUTRAL_NOTE,
  ].join('\n');
}
