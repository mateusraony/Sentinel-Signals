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

const KEY_RE = /^[A-Z]+-\d{4}-\d{2}-\d{2}:pre$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIRM = new Set(Object.keys(STATUS_LABELS).filter((s) => s !== 'a_confirmar'));

/** A chave do "já avisei" de um evento (o id traz o tipo e a data; remarcar a data muda o id, então é um aviso novo). */
export const alertKey = (event) => `${event.id}:pre`;

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

/** O registro com `event` marcado como avisado em `nowMs`; entradas com mais de 30 dias saem (e o teto é respeitado). Não muda o original. */
export function markSent(state, event, nowMs) {
  const base = parseSent(state).sent;
  const next = {};
  for (const [key, at] of Object.entries(base)) if (nowMs - Date.parse(at) <= SENT_KEEP_MS) next[key] = at;
  next[alertKey(event)] = new Date(nowMs).toISOString();
  const keep = Object.entries(next).sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0])).slice(0, SENT_MAX_ENTRIES);
  return { version: SENT_VERSION, sent: Object.fromEntries(keep.sort((a, b) => a[0].localeCompare(b[0]))) };
}

/**
 * Trava do conteúdo PÚBLICO (a branch `context-data` é legível por qualquer pessoa): só `version` e `sent` (chave "TIPO-AAAA-MM-DD:pre" →
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
