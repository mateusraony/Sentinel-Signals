// Contexto de Mercado — Fase 4b (docs/known-risks.md item 285, addendum 26): aviso AUTOMÁTICO "1 hora antes" do próximo evento.
// Parte PURA (sem rede, sem relógio global, sem arquivo): decide QUAIS eventos merecem aviso agora e mantém o registro do
// "já avisei". O relógio é o fim do "Scheduled scan" (~15 min); o registro vai num arquivo público pequeno da branch
// `context-data` (`alerts-sent.json`), porque não há banco (a trava de isolamento proíbe: o Neon não pode acordar por causa do Contexto).
//
// Por que uma JANELA e um registro, e não "avisar quando faltar exatamente 60 min": o scan não roda em minutos exatos (o disparo
// externo atrasa e às vezes pula). Com a janela [45 min, 75 min] sempre há ao menos 1 passada (a cadência é ~15 min), e o registro
// garante que a 2ª passada dentro da janela não repete o aviso.
//
// Só entra evento com data FIRME (oficial ou confirmada) que ainda não começou — `a_confirmar` nunca avisa (a hora pode mudar).
import { STATUS_LABELS } from '../src/lib/marketContextBand.js';

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;

/** Janela do aviso: falta de 45 a 75 minutos para o evento (inclusive). */
export const PRE_ALERT_FROM_MS = 45 * MIN_MS;
export const PRE_ALERT_TO_MS = 75 * MIN_MS;

/** Arquivo do registro na branch pública e o prazo de guarda de cada entrada (um evento só aparece na janela uma vez). */
export const SENT_FILE = 'alerts-sent.json';
export const SENT_VERSION = 1;
export const SENT_KEEP_MS = 30 * DAY_MS;
/** Teto de entradas (defesa: o arquivo é pequeno por construção — 1 aviso por evento, ~2 eventos por semana). */
export const SENT_MAX_ENTRIES = 200;

const KEY_RE = /^[A-Z]+-\d{4}-\d{2}-\d{2}:(pre|post|dia)$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIRM = new Set(Object.keys(STATUS_LABELS).filter((s) => s !== 'a_confirmar'));

/** A chave do "já avisei" de um evento e fase — `pre` (1 h antes), `post` (resultado) ou `dia` (o resumo do dia, addendum 35: o "evento" é `DIA-AAAA-MM-DD`). O id traz o tipo e a data; remarcar a data muda o id, então é um aviso novo. */
export const alertKey = (event, phase = 'pre') => `${event.id}:${phase}`;

const emptyState = () => ({ version: SENT_VERSION, sent: {} });

/**
 * O registro lido do arquivo (veio da rede/disco: não é confiável). Entrada fora do formato é DESCARTADA; arquivo ilegível vira
 * registro vazio (pior caso: um aviso repetido, nunca um evento perdido nem uma quebra).
 */
export function parseSent(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.version !== SENT_VERSION) return emptyState();
  const src = json.sent && typeof json.sent === 'object' && !Array.isArray(json.sent) ? json.sent : {};
  const sent = {};
  for (const [key, at] of Object.entries(src)) {
    if (KEY_RE.test(key) && typeof at === 'string' && ISO_RE.test(at) && Number.isFinite(Date.parse(at))) sent[key] = at;
  }
  return { version: SENT_VERSION, sent };
}

/** Eventos que pedem aviso AGORA, do mais próximo ao mais distante: data firme, ainda não começou, na janela e sem registro. */
export function pickDueEvents(events, nowMs, sent = emptyState()) {
  const registry = parseSent(sent).sent;
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.startMs) && FIRM.has(e.status))
    .filter((e) => {
      const falta = e.startMs - nowMs;
      return falta >= PRE_ALERT_FROM_MS && falta <= PRE_ALERT_TO_MS;
    })
    .filter((e) => !Object.prototype.hasOwnProperty.call(registry, alertKey(e)))
    .sort((a, b) => (a.startMs === b.startMs ? String(a.id).localeCompare(String(b.id)) : a.startMs - b.startMs));
}

/** O registro com `event` marcado como avisado (fase `pre` ou `post`) em `nowMs`; entradas com mais de 30 dias saem (e o teto é respeitado). Não muda o original. */
export function markSent(state, event, nowMs, phase = 'pre') {
  const base = parseSent(state).sent;
  const next = {};
  for (const [key, at] of Object.entries(base)) if (nowMs - Date.parse(at) <= SENT_KEEP_MS) next[key] = at;
  next[alertKey(event, phase)] = new Date(nowMs).toISOString();
  const keep = Object.entries(next).sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0])).slice(0, SENT_MAX_ENTRIES);
  return { version: SENT_VERSION, sent: Object.fromEntries(keep.sort((a, b) => a[0].localeCompare(b[0]))) };
}

/**
 * Trava do conteúdo PÚBLICO (a branch `context-data` é legível por qualquer pessoa): só `version` e `sent` (chave "TIPO-AAAA-MM-DD:pre|post|dia" →
 * instante ISO). Nada de texto livre, mensagem, chat, erro ou segredo. Lança se o formato fugir.
 */
export function assertPublicSent(state) {
  const fail = (msg) => { throw new Error(`alerts-sent.json fora do formato: ${msg}`); };
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('não é um objeto');
  if (Object.keys(state).sort().join(',') !== 'sent,version') fail('campos devem ser só version e sent');
  if (state.version !== SENT_VERSION) fail('versão');
  if (!state.sent || typeof state.sent !== 'object' || Array.isArray(state.sent)) fail('sent não é um objeto');
  const entries = Object.entries(state.sent);
  if (entries.length > SENT_MAX_ENTRIES) fail('entradas demais');
  for (const [key, at] of entries) {
    if (!KEY_RE.test(key)) fail(`chave inválida (${String(key).slice(0, 40)})`);
    if (typeof at !== 'string' || !ISO_RE.test(at) || !Number.isFinite(Date.parse(at))) fail('instante inválido');
  }
  return state;
}

/** O texto exato gravado no arquivo (chaves em ordem, 2 espaços, quebra de linha final). */
export const serializeSent = (state) => `${JSON.stringify(assertPublicSent(state), null, 2)}\n`;

// ---------------------------------------------------------------------------------------------------------------------------------
// Fase 4b-3 (addendum 28): o aviso de DEPOIS — o resultado e o que o BTC fez desde a divulgação.
/** Com o "Atual" oficial no arquivo (BLS; BEA para o PCE), avisa assim que passaram 5 min da divulgação (já existe o movimento de +5 min). */
export const RESULT_AFTER_ACTUAL_MS = 5 * MIN_MS;
/** BLS/BEA sem o "Atual" ainda: espera até 2 h; passado isso avisa só com o BTC e diz que o número oficial não chegou. */
export const RESULT_BLS_WAIT_MS = 120 * MIN_MS;
/** FOMC não tem número oficial coletado: avisa depois de 35 min (já existe o movimento de +30 min). O PCE tem desde o addendum 33 (BEA). */
export const RESULT_NO_NUMBER_AFTER_MS = 35 * MIN_MS;
/** Depois disto o aviso de resultado já não faz sentido (o resumo do dia cobre). */
export const RESULT_MAX_AFTER_MS = 6 * 60 * MIN_MS;
const HAS_OFFICIAL_NUMBER = new Set(['CPI', 'PPI', 'NFP', 'PCE']);

/** Eventos que pedem o aviso de RESULTADO agora: data firme, já começou, dentro da janela de cada caso e sem registro `post`. Do mais antigo ao mais novo. */
export function pickDueResults(events, nowMs, sent = emptyState()) {
  const registry = parseSent(sent).sent;
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.startMs) && FIRM.has(e.status))
    .filter((e) => {
      const depois = nowMs - e.startMs;
      if (depois > RESULT_MAX_AFTER_MS) return false;
      if (e.values?.actual) return depois >= RESULT_AFTER_ACTUAL_MS;
      if (HAS_OFFICIAL_NUMBER.has(e.kind)) return depois >= RESULT_BLS_WAIT_MS;
      return depois >= RESULT_NO_NUMBER_AFTER_MS;
    })
    .filter((e) => !Object.prototype.hasOwnProperty.call(registry, alertKey(e, 'post')))
    .sort((a, b) => (a.startMs === b.startMs ? String(a.id).localeCompare(String(b.id)) : a.startMs - b.startMs));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fase 4c (addendum 35): o RESUMO DO DIA, às 21h de Brasília. Só nos dias em que houve divulgação monitorada (dia sem evento não manda nada: o volume de
// mensagens é um risco registrado do projeto). Brasília é UTC−3 o ano todo (o horário de verão acabou em 2019); se o país o reinstituir, é só trocar a constante.
export const BRT_OFFSET_MS = 3 * 60 * MIN_MS;
/** O resumo sai a partir das 21:00 de Brasília e, se a passada atrasar, até as 02:59 do dia seguinte (depois disso o dia "vence" sem aviso). */
export const SUMMARY_FROM_HOUR_BRT = 21;
export const SUMMARY_WINDOW_HOURS = 6;

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** O dia de Brasília ('AAAA-MM-DD') que o resumo cobre AGORA, ou null se não é hora de resumo (fora de 21:00–02:59 de Brasília). */
export function summaryDay(nowMs) {
  if (!Number.isFinite(nowMs)) return null;
  const w = new Date(nowMs - BRT_OFFSET_MS - SUMMARY_FROM_HOUR_BRT * 60 * MIN_MS); // o relógio de Brasília deslocado: 21:00 vira 00:00
  return w.getUTCHours() < SUMMARY_WINDOW_HOURS ? ymd(w.getTime()) : null;
}

/** Limites do dia de Brasília `day` em ms UTC: [00:00, 24:00). */
export function dayBoundsBrt(day) {
  const start = Date.parse(`${day}T00:00:00.000Z`) + BRT_OFFSET_MS;
  return { startMs: start, endMs: start + DAY_MS };
}

/** Eventos de data firme que JÁ aconteceram no dia de Brasília `day` (do mais cedo ao mais tarde). */
export function eventsOfDay(events, day, nowMs) {
  const { startMs, endMs } = dayBoundsBrt(day);
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.startMs) && FIRM.has(e.status) && e.startMs >= startMs && e.startMs < endMs && e.startMs <= nowMs)
    .sort((a, b) => (a.startMs === b.startMs ? String(a.id).localeCompare(String(b.id)) : a.startMs - b.startMs));
}

/**
 * Há resumo para enviar AGORA? `{ day, id, events }` quando: é hora (21:00–02:59 de Brasília), o dia teve ao menos 1 divulgação de data firme e ainda
 * não há registro `DIA-AAAA-MM-DD:dia`. Senão null.
 */
export function pickDueSummary(events, nowMs, sent = emptyState()) {
  const day = summaryDay(nowMs);
  if (!day) return null;
  const id = `DIA-${day}`;
  if (Object.prototype.hasOwnProperty.call(parseSent(sent).sent, `${id}:dia`)) return null;
  const list = eventsOfDay(events, day, nowMs);
  // Ainda falta um evento de data firme DESTE dia (ex.: às 23:30 de Brasília, depois das 21h)? Espera: o resumo sai quando ele já tiver acontecido, e o dia só
  // "vence" às 02:59 (achado da revisão independente de 19/11). Hoje nenhum evento monitorado cai depois das 21h (todos saem entre 09:30 e 16:00 de Brasília).
  const { startMs, endMs } = dayBoundsBrt(day);
  const ainda = (Array.isArray(events) ? events : []).some((e) => e && Number.isFinite(e.startMs) && FIRM.has(e.status) && e.startMs > nowMs && e.startMs >= startMs && e.startMs < endMs);
  return list.length && !ainda ? { day, id, events: list } : null;
}
