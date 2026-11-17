// Contexto de Mercado — Fase 4a (docs/known-risks.md item 285, addendum 12): mensagens do Telegram do Contexto.
// Parte PURA (sem rede, sem Date.now). Texto neutro de propósito — só fatos da agenda: nada de "vai subir/cair",
// probabilidade, compra ou venda. Reaproveita a lógica da faixa do painel (`src/lib/marketContextBand.js`) para que a
// hora, a contagem regressiva e os rótulos sejam exatamente os mesmos nos dois lugares.
import {
  parseEvents, upcomingEvents, formatCountdown, formatEventWhen, EVENT_LABELS, EVENT_HINTS, EVENT_META, STATUS_LABELS,
} from '../src/lib/marketContextBand.js';
import { summarizeReactions } from './contextBtcHistory.mjs';

/** Categorias de aviso. `teste` é sempre permitida (é o botão manual); as outras só se estiverem na variável do repositório. */
export const CATEGORIES = Object.freeze(['teste', 'agenda', 'pre-evento']);
export const NEUTRAL_NOTE = 'Só informação — não altera sinais nem operações.';
const EMOJI = '🗓️';

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Ligadas quando a variável do repositório está vazia ou ausente (addendum 27): os avisos automáticos. `agenda` é só o botão manual. */
export const DEFAULT_CATEGORIES = Object.freeze(['pre-evento']);
/** O valor que desliga todos os avisos automáticos. */
export const OFF_WORD = 'nenhuma';

/**
 * "agenda, pre-evento" → Set com as categorias válidas (o resto é ignorado). Vazio/ausente = o PADRÃO (avisos automáticos ligados);
 * `nenhuma` = tudo desligado; uma lista liga só o que está nela.
 */
export function parseCategories(csv) {
  const tokens = String(csv ?? '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return new Set(DEFAULT_CATEGORIES);
  if (tokens.includes(OFF_WORD)) return new Set();
  return new Set(tokens.filter((c) => CATEGORIES.includes(c)));
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Fase 4b (addendum 27): o aviso COMPLETO de antes do evento. Só fatos e medições do passado — nada de previsão de direção, de "alta/baixa"
// provável nem de ordem: o texto é conferido por `contextMessages.test.js` (lista `PROIBIDO`). Cada bloco diz de onde vem (ou que não tem fonte).

/** Importância de REFERÊNCIA (rótulo editorial do projeto, `EVENT_META.impact`); não é previsão de tamanho de movimento. */
const IMPACT_WORDS = Object.freeze({ 3: 'alta', 2: 'média' });
/** Tipos cujo "Anterior" vem do BLS (CPI, PPI, Payroll). PCE e FOMC não têm fonte oficial automática hoje. */
const HAS_BLS_PREVIOUS = new Set(['CPI', 'PPI', 'NFP']);

/** "+0,40%" / "−1,20%" / "0,00%" (duas casas, vírgula, sinal escrito; o menos é o verdadeiro "−"). */
export function formatPct(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '—';
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  return `${sign}${Math.abs(x).toFixed(2).replace('.', ',')}%`;
}

const dayMonth = (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const casos = (n) => (n === 1 ? '1 caso' : `${n} casos`);

/** O bloco "BTC nas últimas divulgações". `rows`: `null` = a fonte de preços não respondeu; `[]` = o tipo não tem histórico; ou as linhas medidas. */
export function buildReactionBlock(label, rows) {
  if (rows === null || rows === undefined) return [`<b>BTC nas últimas divulgações de ${escapeHtml(label)}:</b> indisponível agora (a fonte de preços não respondeu).`];
  if (!rows.length) return [`<b>BTC nas últimas divulgações de ${escapeHtml(label)}:</b> ainda sem histórico automático para este tipo.`];
  const quando = rows.length === 1 ? 'na última divulgação' : `nas últimas ${rows.length} divulgações`;
  const lines = [`<b>BTC ${quando} de ${escapeHtml(label)}</b> (movimento 1 h depois):`];
  for (const r of rows) {
    if (!r.reaction) {
      lines.push(`• ${dayMonth(r.date)}: sem dado`);
      continue;
    }
    const m = r.reaction.moves;
    lines.push(`• ${dayMonth(r.date)}: <b>${formatPct(m[60])}</b> (5 min ${formatPct(m[5])} · 30 min ${formatPct(m[30])})`);
  }
  const sum = summarizeReactions(rows);
  if (sum.n > 0) {
    lines.push(`Tamanho mediano do movimento: ${formatPct(sum.medAbs60).replace('+', '')} · subiu ${sum.up60} de ${sum.n}, caiu ${sum.down60} de ${sum.n}.`);
    lines.push(`Só ${casos(sum.n)}: descreve o passado, não prevê o próximo.`);
  }
  return lines;
}

/**
 * Aviso COMPLETO antes do evento: o que é, a importância, o valor anterior (BLS), onde a projeção do mercado está indisponível e o que o BTC fez nas últimas
 * divulgações do mesmo tipo. Sem operações abertas (decisão do usuário em 01/11: ler o banco acordaria o Neon).
 * @param {{ reactions?: Array<{ date: string, reaction: object|null }>|null }} [extra]
 */
export function buildPreEventBriefing(event, nowMs, { reactions = null } = {}) {
  const label = EVENT_LABELS[event.kind];
  const meta = EVENT_META[event.kind];
  const lines = [
    `${EMOJI} <b>${escapeHtml(label)} — ${escapeHtml(formatCountdown(event.startMs - nowMs))}</b>`,
    `${escapeHtml(meta?.title ?? EVENT_HINTS[event.kind])} · importância ${IMPACT_WORDS[meta?.impact] ?? 'média'} (rótulo de referência do mercado)`,
    `${escapeHtml(formatEventWhen(event.startsAtUtc))} · data ${escapeHtml(STATUS_LABELS[event.status])}`,
    '',
  ];
  if (event.values?.previous) lines.push(`<b>Anterior (BLS):</b> ${escapeHtml(event.values.previous)}`);
  else if (HAS_BLS_PREVIOUS.has(event.kind)) lines.push('<b>Anterior:</b> indisponível agora (o BLS não respondeu na última coleta).');
  else lines.push('<b>Anterior:</b> sem fonte oficial automática para este tipo.');
  lines.push('<b>Projeção do mercado (consenso):</b> indisponível — é dado pago; o sistema não inventa um número.', '');
  lines.push(...buildReactionBlock(label, reactions), '');
  lines.push('Sem previsão de direção (alta ou baixa): com poucos casos isso seria precisão inventada.', NEUTRAL_NOTE);
  return lines.join('\n');
}
