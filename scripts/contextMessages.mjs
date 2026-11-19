// Contexto de Mercado — Fase 4a (docs/known-risks.md item 285, addendum 12): mensagens do Telegram do Contexto.
// Parte PURA (sem rede, sem Date.now). Texto neutro de propósito — só fatos da agenda: nada de "vai subir/cair",
// probabilidade, compra ou venda. Reaproveita a lógica da faixa do painel (`src/lib/marketContextBand.js`) para que a
// hora, a contagem regressiva e os rótulos sejam exatamente os mesmos nos dois lugares.
import {
  parseEvents, upcomingEvents, formatCountdown, formatEventWhen, resultRows, splitValueText, compareValues, EVENT_LABELS, EVENT_HINTS, EVENT_META, STATUS_LABELS, CONTEXT_EMOJI,
} from '../src/lib/marketContextBand.js';
import { summarizeReactions } from './contextBtcHistory.mjs';
import { describeFomc } from './contextConsensus.mjs';
import { dayBoundsBrt } from './contextAlert.mjs';

/** Categorias de aviso. `teste` é sempre permitida (é o botão manual); as outras só se estiverem na variável do repositório. */
export const CATEGORIES = Object.freeze(['teste', 'agenda', 'pre-evento']);
/** Categorias que só existem no envio AUTOMÁTICO (o botão manual não as oferece): o resultado depois da divulgação (addendum 28). */
export const AUTOMATIC_ONLY = Object.freeze(['resultado', 'resumo']);
export const NEUTRAL_NOTE = 'Só informação — não altera sinais nem operações.';
const EMOJI = '🗓️';

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Ligadas quando a variável do repositório está vazia ou ausente (addendum 27): os avisos automáticos. `agenda` é só o botão manual. */
export const DEFAULT_CATEGORIES = Object.freeze(['pre-evento', 'resultado', 'resumo']);
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
  return new Set(tokens.filter((c) => CATEGORIES.includes(c) || AUTOMATIC_ONLY.includes(c)));
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
/** Tipo → órgão que publica o número oficial coletado: BLS (CPI, PPI, Payroll) e BEA (PCE, addendum 33). FOMC não tem número automático. */
const OFFICIAL_SOURCE = Object.freeze({ CPI: 'BLS', PPI: 'BLS', NFP: 'BLS', PCE: 'BEA' });
/** O PCE tem duas linhas no calendário do TradingView (PCE e Core PCE): a projeção digitada vale só para a que o usuário copiou. */
const PCE_PROJECTION_NOTE = 'o TradingView mostra duas linhas (PCE e Core PCE): ela vale para a linha que você copiou';
const CORE_LABEL = 'núcleo (sem alimentos e energia)';

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
export function buildPreEventBriefing(event, nowMs, { reactions = null, consensus = null } = {}) {
  const label = EVENT_LABELS[event.kind];
  const meta = EVENT_META[event.kind];
  const lines = [
    `${EMOJI} <b>${escapeHtml(label)} — ${escapeHtml(formatCountdown(event.startMs - nowMs))}</b>`,
    `${escapeHtml(meta?.title ?? EVENT_HINTS[event.kind])} · importância ${IMPACT_WORDS[meta?.impact] ?? 'média'} (rótulo de referência do mercado)`,
    `${escapeHtml(formatEventWhen(event.startsAtUtc))} · data ${escapeHtml(STATUS_LABELS[event.status])}`,
    '',
  ];
  const v = event.values;
  const source = OFFICIAL_SOURCE[event.kind];
  if (event.kind === 'PCE' && (v?.previous || v?.core_previous)) {
    // As duas medidas, sempre lado a lado (addendum 33): o usuário não precisa saber qual linha do calendário é qual.
    lines.push(`<b>Anterior (${source}):</b> PCE cheio ${escapeHtml(v.previous ?? 'indisponível')} · ${CORE_LABEL} ${escapeHtml(v.core_previous ?? 'indisponível')}`);
  } else if (v?.previous) lines.push(`<b>Anterior (${source ?? 'BLS'}):</b> ${escapeHtml(v.previous)}`);
  else if (consensus?.previous) lines.push(`<b>Anterior (informado por você):</b> ${escapeHtml(consensus.previous)}`);
  else if (source) lines.push(`<b>Anterior:</b> indisponível agora (${source === 'BEA' ? 'a BEA' : `o ${source}`} não respondeu na última coleta).`);
  else lines.push('<b>Anterior:</b> sem fonte oficial automática para este tipo (você pode registrar no botão "Registrar projeção do Contexto").');
  if (consensus?.projection) {
    // FOMC: a projeção é a TAXA (como o TradingView mostra); com o "Anterior" registrado, diz o que ela implica (fato aritmético sobre os dois números do usuário).
    const fomc = event.kind === 'FOMC' ? describeFomc(consensus.projection, consensus.previous) : null;
    const pce = event.kind === 'PCE' ? ` (${PCE_PROJECTION_NOTE})` : '';
    lines.push(`<b>Projeção (informada por você):</b> ${escapeHtml(consensus.projection)}${fomc ? ` — ${escapeHtml(fomc)}` : ''}${pce} — não é o consenso oficial do mercado.`, '');
  } else {
    lines.push('<b>Projeção do mercado (consenso):</b> indisponível — é dado pago; o sistema não inventa um número. Você pode registrar a sua no botão "Registrar projeção do Contexto" (Actions).', '');
  }
  lines.push(...buildReactionBlock(label, reactions), '');
  lines.push('Sem previsão de direção (alta ou baixa): com poucos casos isso seria precisão inventada.', NEUTRAL_NOTE);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fase 4b-3 (addendum 28): o aviso de DEPOIS — o resultado (Atual × Anterior × Revisado, com "acima/abaixo do anterior" como FATO sobre os dois números)
// e o que o BTC fez desde a divulgação. Sem projeção do mercado (não existe de graça), então nunca diz que foi "surpresa" nem prevê o próximo passo.

const DIRECTION_WORDS = Object.freeze({ acima: 'acima do anterior', abaixo: 'abaixo do anterior', igual: 'igual ao anterior' });
const PROJECTION_WORDS = Object.freeze({ acima: 'acima da projeção', abaixo: 'abaixo da projeção', igual: 'igual à projeção' });

/** "+0,10%" por prazo, ou "ainda não passou" enquanto aquele prazo não terminou. */
const moveWord = (n, v) => (v === null || v === undefined ? `${n} min ainda não passou` : `${n} min ${formatPct(v)}`);

/**
 * O bloco dos números do resultado de UM evento (usado pelo aviso de resultado e pelo resumo do dia): uma linha por medida (com o anterior,
 * "acima/abaixo do anterior" e o "Revisado") e a fonte; ou o que falta (o número oficial ainda não chegou, ou o tipo não tem número automático).
 * Só FATOS sobre os números. `comparedToProjection`: alguma medida foi comparada com a projeção que o usuário registrou.
 * @returns {{ lines: string[], comparedToProjection: boolean }}
 */
export function resultNumberBlock(event, consensus = null) {
  const v = event.values;
  const isPce = event.kind === 'PCE';
  const rows = v?.actual ? resultRows(v, event.reference ?? null) : [];
  // PCE (addendum 33): o PCE cheio e o NÚCLEO, cada um com as suas linhas (no mês / em 12 meses).
  if (isPce) for (const r of rows) r.label = `PCE cheio — ${r.label.toLowerCase()}`;
  if (isPce && v?.core_actual) {
    for (const r of resultRows({ previous: v.core_previous ?? null, actual: v.core_actual, revised: v.core_revised ?? null })) rows.push({ ...r, label: `Núcleo — ${r.label.toLowerCase()}` });
  }
  const withNumber = rows.filter((r) => r.actual !== null);
  // A projeção que o USUÁRIO registrou (addendum 30), medida por medida ("mom"/"yoy"/"jobs"), para dizer acima/abaixo/igual a ELA. No PCE não compara:
  // o calendário tem duas linhas (PCE e Core PCE) e não dá para saber de qual ela veio — comparar com a errada seria afirmar o que não se sabe.
  const projection = consensus?.projection ?? null;
  const projectionByKey = new Map(projection && !isPce ? splitValueText(projection).map((x) => [x.key, x.value]) : []);
  const out = [];
  let comparedToProjection = false;
  if (withNumber.length) {
    for (const r of withNumber) {
      const prev = r.previous !== null ? ` (anterior ${escapeHtml(r.previous)})` : '';
      const dir = r.direction ? ` — ${DIRECTION_WORDS[r.direction]}` : '';
      const projValue = projectionByKey.get(r.key) ?? null;
      const projDir = projValue !== null ? compareValues(r.actual, projValue) : null;
      if (projDir) comparedToProjection = true;
      const proj = projDir ? ` · ${PROJECTION_WORDS[projDir]} (${escapeHtml(projValue)})` : '';
      const rev = r.revised !== null ? `; mês anterior revisado para ${escapeHtml(r.revised)}` : '';
      out.push(`${CONTEXT_EMOJI.compare} ${escapeHtml(r.label)}: <b>${escapeHtml(r.actual)}</b>${prev}${dir}${proj}${rev}`);
    }
    if (isPce && projection) out.push(`Sua projeção era: ${escapeHtml(projection)} — ${PCE_PROJECTION_NOTE}.`);
    out.push(`Fonte dos números: ${OFFICIAL_SOURCE[event.kind] ?? 'BLS'}.`);
  } else if (OFFICIAL_SOURCE[event.kind]) {
    out.push(isPce
      ? 'O número oficial da BEA ainda não chegou ao sistema.'
      : 'O número oficial do BLS ainda não chegou ao sistema; assim que chegar ele aparece no painel.');
    if (projection) out.push(`Sua projeção era: ${escapeHtml(projection)}${isPce ? ` — ${PCE_PROJECTION_NOTE}` : ''}.`);
  } else {
    out.push('Este tipo não tem número oficial coletado automaticamente: só o movimento do BTC é mostrado.');
    if (projection) out.push(`Sua projeção era: ${escapeHtml(projection)} — confira o resultado no site do órgão.`);
  }
  return { lines: out, comparedToProjection };
}

/**
 * @param {{ moves?: { 5: number|null, 30: number|null, 60: number|null }|null, typical?: ReturnType<typeof summarizeReactions>|null }} [extra]
 *   `moves`: movimento do BTC desde a divulgação (`partialMoves`); `null` = a fonte de preços não respondeu. `typical`: resumo das últimas divulgações do tipo.
 */
export function buildResultMessage(event, nowMs, { moves = null, typical = null, consensus = null } = {}) {
  const label = EVENT_LABELS[event.kind];
  const lines = [
    `${CONTEXT_EMOJI.released} <b>${escapeHtml(label)} — saiu o resultado</b>`,
    `${escapeHtml(EVENT_META[event.kind]?.title ?? EVENT_HINTS[event.kind])} · ${escapeHtml(formatEventWhen(event.startsAtUtc))}`,
    '',
  ];
  const numbers = resultNumberBlock(event, consensus);
  lines.push(...numbers.lines);
  const comparedToProjection = numbers.comparedToProjection;
  lines.push('');
  if (moves) {
    lines.push(`${CONTEXT_EMOJI.horizon} <b>BTC desde a divulgação:</b> ${moveWord(5, moves[5])} · ${moveWord(30, moves[30])} · ${moveWord(60, moves[60])}`);
  } else {
    lines.push(`${CONTEXT_EMOJI.horizon} <b>BTC desde a divulgação:</b> indisponível agora (a fonte de preços não respondeu).`);
  }
  if (typical && typical.n > 0) {
    const quando = typical.n === 1 ? 'Na última divulgação' : `Nas últimas ${typical.n} divulgações`;
    lines.push(`${quando} de ${escapeHtml(label)}, o tamanho mediano do movimento em 1 h foi ${formatPct(typical.medAbs60).replace('+', '')}.`);
  }
  if (comparedToProjection) {
    lines.push('', 'A projeção é a que você registrou (não é o consenso oficial do mercado): "acima/abaixo da projeção" compara só com ela.', NEUTRAL_NOTE);
  } else {
    lines.push('', 'Sem a projeção do mercado (dado pago) não dá para dizer se o número foi surpresa.', NEUTRAL_NOTE);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fase 4c (addendum 35): o RESUMO DO DIA, às 21h de Brasília — o que saiu hoje, com os números oficiais, o que o BTC fez depois de cada divulgação e no dia, e o
// que vem a seguir. Só FATOS e medições do passado: nada de previsão de direção, de probabilidade nem de ordem (travado por `PROIBIDO` nos testes).

const WEEKDAY_DAY_MONTH = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit' });
const dayLabel = (day) => WEEKDAY_DAY_MONTH.format(new Date(dayBoundsBrt(day).startMs + 12 * 3600000)).replace('.', '');

/**
 * @param {{ day: string, events: object[], agenda?: object[], nowMs: number, moves?: Map<string, object|null>, btcDay?: { pct: number, rangePct: number }|null,
 *   consensusOf?: (event: object) => object|null }} p
 *   `events`: os eventos do dia (`eventsOfDay`); `agenda`: a lista inteira para "o que vem a seguir"; `moves`: id do evento → `partialMoves` (ausente/`null` = fonte de preços fora);
 *   `btcDay`: `loadBtcDay` (`null` = indisponível).
 */
export function buildDaySummary({ day, events, agenda = [], nowMs, moves = new Map(), btcDay = null, consensusOf = () => null }) {
  const lines = [`${CONTEXT_EMOJI.released} <b>Resumo do dia — ${escapeHtml(dayLabel(day))}</b>`, ''];
  lines.push(events.length === 1 ? 'Saiu 1 divulgação monitorada hoje:' : `Saíram ${events.length} divulgações monitoradas hoje:`, '');
  for (const e of events) {
    lines.push(`<b>${escapeHtml(EVENT_LABELS[e.kind])}</b> — ${escapeHtml(EVENT_META[e.kind]?.title ?? EVENT_HINTS[e.kind])} · ${escapeHtml(formatEventWhen(e.startsAtUtc))}`);
    lines.push(...resultNumberBlock(e, consensusOf(e)).lines);
    const m = moves.get(e.id) ?? null;
    lines.push(m
      ? `${CONTEXT_EMOJI.horizon} BTC depois: ${moveWord(5, m[5])} · ${moveWord(30, m[30])} · ${moveWord(60, m[60])}`
      : `${CONTEXT_EMOJI.horizon} BTC depois: indisponível agora (a fonte de preços não respondeu).`);
    lines.push('');
  }
  if (btcDay) {
    lines.push(`${CONTEXT_EMOJI.gauge} <b>BTC no dia</b> (de 00:00 até agora, Brasília): ${formatPct(btcDay.pct)} contra a abertura · amplitude de ${formatPct(btcDay.rangePct).replace('+', '')} entre a mínima e a máxima.`);
  } else {
    lines.push(`${CONTEXT_EMOJI.gauge} <b>BTC no dia:</b> indisponível agora (a fonte de preços não respondeu).`);
  }
  const next = (Array.isArray(agenda) ? agenda : []).filter((e) => Number.isFinite(e?.startMs) && e.startMs > nowMs).slice(0, 3);
  lines.push('');
  if (next.length) {
    lines.push('<b>O que vem a seguir:</b>');
    for (const e of next) {
      const quando = e.status === 'a_confirmar' ? '' : ` · ${formatCountdown(e.startMs - nowMs)}`;
      lines.push(`• <b>${escapeHtml(EVENT_LABELS[e.kind])}</b> — ${escapeHtml(formatEventWhen(e.startsAtUtc))}${quando} · ${escapeHtml(STATUS_LABELS[e.status])}`);
    }
  } else {
    lines.push('<b>O que vem a seguir:</b> nenhum evento na agenda por enquanto.');
  }
  lines.push('', 'Os números vêm do órgão oficial de cada divulgação; o BTC é o que aconteceu, medido nas velas da Binance — descreve o passado, não prevê o próximo.', NEUTRAL_NOTE);
  return lines.join('\n');
}
