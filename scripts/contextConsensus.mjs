// Contexto de Mercado — Fase 4b-4 (docs/known-risks.md item 285, addendum 30): a PROJEÇÃO que o USUÁRIO registra (e o "Anterior" quando não há fonte oficial).
// O consenso do mercado é dado pago e raspar de terceiros viola os termos (addendum 5); mas o usuário vê a "Projeção" de graça no calendário do TradingView e pode
// digitar 4 ou 5 números por mês. O que ele digita vira `consensus.json` na branch pública `context-data`, e os avisos passam a comparar o resultado com ESSE número
// ("acima / abaixo / igual à projeção que você registrou"). Não é o consenso oficial do mercado e a mensagem diz de quem é o número.
//
// Parte PURA (sem rede, sem relógio global, sem arquivo). O arquivo é PÚBLICO: só formatos fechados (os mesmos textos do BLS — "+0,3% m/m · +3,1% a/a", "+150 mil" —,
// a decisão do FOMC numa lista fechada e a faixa de juros), travados por `assertPublicConsensus`. Texto livre nunca entra.
import { PREVIOUS_TEXT_RE } from './contextBls.mjs';

export const CONSENSUS_FILE = 'consensus.json';
export const CONSENSUS_VERSION = 1;
export const CONSENSUS_KEEP_MS = 120 * 24 * 60 * 60 * 1000;
export const CONSENSUS_MAX_ENTRIES = 60;

const ID_RE = /^([A-Z]+)-(\d{4}-\d{2}-\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const KINDS = Object.freeze(['CPI', 'NFP', 'PPI', 'PCE', 'FOMC']);
const PERCENT_KINDS = new Set(['CPI', 'PPI', 'PCE']);
/** A decisão esperada do FOMC: lista FECHADA. */
export const FOMC_DECISIONS = Object.freeze(['manter', 'cortar 25 pb', 'cortar 50 pb', 'subir 25 pb', 'subir 50 pb']);
const FOMC_RANGE_RE = /^(\d{1,2}),(\d{2})%–(\d{1,2}),(\d{2})%$/;

const emptyState = () => ({ version: CONSENSUS_VERSION, items: {} });

/** Um número com UMA casa decimal ("0,3", "+0.3", "-0,2") → "+0,3" / "-0,2"; null se não for. */
function oneDecimal(token) {
  const m = /^([+-]?)(\d{1,2})[.,](\d)$/.exec(token);
  if (!m) return null;
  return `${m[1] === '-' ? '-' : '+'}${m[2]},${m[3]}`;
}

/**
 * Converte o que o usuário digitou no texto CANÔNICO do tipo (ou explica o que corrigir). Tolerante com o jeito de escrever (vírgula ou ponto, "/" ";" "·" ou espaço
 * entre os números, maiúsculas, "pb" opcional), rígido no resultado.
 *  - CPI/PPI/PCE: 1 número = no mês ("+0,3% m/m"); 2 números = no mês e em 12 meses ("+0,3% m/m · +3,1% a/a"). UMA casa decimal (é o que o BLS e o BEA publicam).
 *  - NFP (Payroll): um inteiro em milhares ("150" → "+150 mil").
 *  - FOMC: `manter` | `cortar 25` | `cortar 50` | `subir 25` | `subir 50`.
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function parseProjection(kind, raw) {
  const t = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return { ok: false, error: 'o valor está vazio' };
  if (PERCENT_KINDS.has(kind)) {
    const tokens = t.split(/[\s/;·|]+/).filter(Boolean);
    const nums = tokens.map(oneDecimal);
    if (tokens.length < 1 || tokens.length > 2 || nums.some((n) => n === null)) {
      return { ok: false, error: `${kind}: escreva 1 ou 2 números com UMA casa decimal — o do mês e, se quiser, o de 12 meses (ex.: 0,3 / 3,1)` };
    }
    const text = nums.length === 1 ? `${nums[0]}% m/m` : `${nums[0]}% m/m · ${nums[1]}% a/a`;
    return PREVIOUS_TEXT_RE.test(text) ? { ok: true, text } : { ok: false, error: `${kind}: número fora da faixa aceita` };
  }
  if (kind === 'NFP') {
    const m = /^([+-]?)(\d{1,3})(?:\s*mil)?$/.exec(t);
    if (!m) return { ok: false, error: 'NFP: escreva um número inteiro em milhares de vagas (ex.: 150)' };
    const text = `${m[1] === '-' ? '-' : '+'}${m[2]} mil`;
    return PREVIOUS_TEXT_RE.test(text) ? { ok: true, text } : { ok: false, error: 'NFP: número fora da faixa aceita' };
  }
  if (kind === 'FOMC') {
    const m = /^(manter|cortar|subir)(?: (25|50))?(?: pb)?$/.exec(t);
    if (!m || (m[1] !== 'manter' && !m[2]) || (m[1] === 'manter' && m[2])) {
      return { ok: false, error: `FOMC: escreva uma destas — ${FOMC_DECISIONS.join(', ')}` };
    }
    const text = m[1] === 'manter' ? 'manter' : `${m[1]} ${m[2]} pb`;
    return FOMC_DECISIONS.includes(text) ? { ok: true, text } : { ok: false, error: 'FOMC: decisão fora da lista' };
  }
  return { ok: false, error: `tipo desconhecido (${String(kind).slice(0, 12)})` };
}

/** O "Anterior" digitado: igual à projeção para CPI/PPI/PCE/NFP; para o FOMC é a faixa de juros ("3,75-4,00" → "3,75%–4,00%"). */
export function parsePrevious(kind, raw) {
  if (kind !== 'FOMC') return parseProjection(kind, raw);
  const m = /^(\d{1,2})[.,](\d{2})\s*%?\s*[-–—a]\s*(\d{1,2})[.,](\d{2})\s*%?$/.exec(String(raw ?? '').trim().toLowerCase());
  if (!m) return { ok: false, error: 'FOMC: escreva a faixa de juros anterior, ex.: 3,75-4,00' };
  const text = `${m[1]},${m[2]}%–${m[3]},${m[4]}%`;
  const lo = Number(`${m[1]}.${m[2]}`);
  const hi = Number(`${m[3]}.${m[4]}`);
  return hi > lo && FOMC_RANGE_RE.test(text) ? { ok: true, text } : { ok: false, error: 'FOMC: a faixa precisa ter o limite de cima maior que o de baixo' };
}

/** O texto já canônico (vem do arquivo público): é o que o formato fechado do tipo aceita? */
export function isValidText(kind, field, text) {
  if (typeof text !== 'string') return false;
  if (kind === 'FOMC') {
    if (field === 'projection') return FOMC_DECISIONS.includes(text);
    const m = FOMC_RANGE_RE.exec(text);
    return Boolean(m) && Number(`${m[3]}.${m[4]}`) > Number(`${m[1]}.${m[2]}`);
  }
  if (kind === 'NFP' || PERCENT_KINDS.has(kind)) return PREVIOUS_TEXT_RE.test(text);
  return false;
}

/** O registro lido do arquivo (disco/rede: não é confiável): só entradas bem formadas e recentes. Lixo vira registro vazio. Nunca lança. */
export function parseConsensus(json, nowMs = Date.now()) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.version !== CONSENSUS_VERSION) return emptyState();
  const src = json.items && typeof json.items === 'object' && !Array.isArray(json.items) ? json.items : {};
  const items = {};
  for (const [id, e] of Object.entries(src)) {
    const m = ID_RE.exec(id);
    if (!m || !KINDS.includes(m[1]) || !e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (typeof e.at !== 'string' || !ISO_RE.test(e.at) || !Number.isFinite(Date.parse(e.at)) || nowMs - Date.parse(e.at) > CONSENSUS_KEEP_MS) continue;
    const entry = { at: e.at };
    if (isValidText(m[1], 'projection', e.projection)) entry.projection = e.projection;
    if (isValidText(m[1], 'previous', e.previous)) entry.previous = e.previous;
    if (entry.projection || entry.previous) items[id] = entry;
  }
  return { version: CONSENSUS_VERSION, items };
}

/** Grava `fields` (`projection` e/ou `previous`, já canônicos) no evento `id`; o que não vier não é apagado. Não muda o original. */
export function setEntry(state, id, fields, nowMs) {
  const base = parseConsensus(state, nowMs).items;
  const kind = ID_RE.exec(id)?.[1];
  const entry = { ...(base[id] ?? {}), at: new Date(nowMs).toISOString() };
  if (fields.projection && isValidText(kind, 'projection', fields.projection)) entry.projection = fields.projection;
  if (fields.previous && isValidText(kind, 'previous', fields.previous)) entry.previous = fields.previous;
  const all = { ...base, [id]: entry };
  const keep = Object.entries(all).sort((a, b) => b[1].at.localeCompare(a[1].at) || a[0].localeCompare(b[0])).slice(0, CONSENSUS_MAX_ENTRIES);
  return { version: CONSENSUS_VERSION, items: Object.fromEntries(keep.sort((a, b) => a[0].localeCompare(b[0]))) };
}

/** Trava do conteúdo PÚBLICO: só `version` e `items`; cada item só `at`, `projection` e/ou `previous`, nos formatos fechados do tipo. Lança se fugir. */
export function assertPublicConsensus(state) {
  const fail = (msg) => { throw new Error(`consensus.json fora do formato: ${msg}`); };
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('não é um objeto');
  if (Object.keys(state).sort().join(',') !== 'items,version') fail('campos devem ser só version e items');
  if (state.version !== CONSENSUS_VERSION) fail('versão');
  if (!state.items || typeof state.items !== 'object' || Array.isArray(state.items)) fail('items não é um objeto');
  const entries = Object.entries(state.items);
  if (entries.length > CONSENSUS_MAX_ENTRIES) fail('entradas demais');
  for (const [id, e] of entries) {
    const m = ID_RE.exec(id);
    if (!m || !KINDS.includes(m[1])) fail(`id inválido (${String(id).slice(0, 30)})`);
    if (!e || typeof e !== 'object' || Array.isArray(e)) fail(`${id}: item não é um objeto`);
    if (Object.keys(e).some((k) => !['at', 'projection', 'previous'].includes(k))) fail(`${id}: campo fora da lista`);
    if (typeof e.at !== 'string' || !ISO_RE.test(e.at) || !Number.isFinite(Date.parse(e.at))) fail(`${id}: instante inválido`);
    if (e.projection === undefined && e.previous === undefined) fail(`${id}: item vazio`);
    if (e.projection !== undefined && !isValidText(m[1], 'projection', e.projection)) fail(`${id}: projeção fora do formato`);
    if (e.previous !== undefined && !isValidText(m[1], 'previous', e.previous)) fail(`${id}: anterior fora do formato`);
  }
  return state;
}

/** O texto exato gravado no arquivo. */
export const serializeConsensus = (state) => `${JSON.stringify(assertPublicConsensus(state), null, 2)}\n`;

/** `{ projection, previous, at }` registrados para o evento, ou null. `event` = linha de `parseEvents` (tem `id`); `nowMs` serve só para descartar o que passou de 120 dias. */
export function consensusFor(state, event, nowMs) {
  const e = parseConsensus(state, nowMs).items[event?.id];
  return e ? { projection: e.projection ?? null, previous: e.previous ?? null, at: e.at } : null;
}

/**
 * Qual evento o usuário quer dizer: com `date` (AAAA-MM-DD) é o evento exato `TIPO-data`; sem, é o PRÓXIMO do tipo que ainda não começou.
 * @returns {{ ok: true, event: object } | { ok: false, error: string }}
 */
export function resolveTarget(events, kind, date, nowMs) {
  const list = Array.isArray(events) ? events : [];
  if (!KINDS.includes(kind)) return { ok: false, error: `tipo desconhecido (${String(kind).slice(0, 12)})` };
  if (date && String(date).trim()) {
    const d = String(date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'a data precisa ser AAAA-MM-DD (ou deixe em branco para o próximo evento)' };
    const e = list.find((x) => x?.id === `${kind}-${d}`);
    return e ? { ok: true, event: e } : { ok: false, error: `não achei o evento ${kind}-${d} na agenda` };
  }
  const next = list
    .filter((x) => x?.kind === kind && Number.isFinite(x.startMs) && x.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)[0];
  return next ? { ok: true, event: next } : { ok: false, error: `não há próximo evento ${kind} na agenda` };
}
