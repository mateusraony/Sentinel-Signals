// Contexto de Mercado — Fase 4b-4 (docs/known-risks.md item 285, addenda 30 e 31): a PROJEÇÃO que o USUÁRIO registra (e o "Anterior" quando não há fonte oficial).
// O consenso do mercado é dado pago e raspar de terceiros viola os termos (addendum 5); mas o usuário vê a "Projeção" de graça no calendário do TradingView e pode
// digitar os números. O que ele digita vira `consensus.json` na branch pública `context-data`, e os avisos passam a comparar o resultado com ESSE número
// ("acima / abaixo / igual à projeção que você registrou"). Não é o consenso oficial do mercado e a mensagem diz de quem é o número.
//
// Addendum 31 (19/11): a 1ª versão tinha UM campo de texto para tudo e o usuário, confuso, colou os exemplos de todos os tipos juntos ("0,3 / 3,1. 150. manter").
// Agora cada coisa tem o SEU campo numerado (no mês, em 12 meses, vagas, juros, anterior), no mesmo jeito que o TradingView mostra, e o que não é do tipo escolhido
// é IGNORADO com aviso (não derruba o registro). O FOMC passou a ser a TAXA de juros ("3,75"), como o TradingView mostra, em vez de "manter/cortar".
//
// Parte PURA (sem rede, sem relógio global, sem arquivo). O arquivo é PÚBLICO: só formatos fechados (os mesmos textos do BLS — "+0,3% m/m · +3,1% a/a", "+150 mil" —
// e a taxa de juros "3,75%"), travados por `assertPublicConsensus`. Texto livre nunca entra.
import { PREVIOUS_TEXT_RE } from './contextBls.mjs';

export const CONSENSUS_FILE = 'consensus.json';
export const CONSENSUS_VERSION = 1;
export const CONSENSUS_KEEP_MS = 120 * 24 * 60 * 60 * 1000;
export const CONSENSUS_MAX_ENTRIES = 60;

const ID_RE = /^([A-Z]+)-(\d{4}-\d{2}-\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const KINDS = Object.freeze(['CPI', 'NFP', 'PPI', 'PCE', 'FOMC']);
const PERCENT_KINDS = new Set(['CPI', 'PPI', 'PCE']);
/** A taxa de juros do FOMC (topo da faixa, como o TradingView mostra): "3,75%". */
const RATE_RE = /^\d{1,2},\d{2}%$/;
const MAX_RATE = 25;

/** Os campos do formulário, na ordem e com o número que o usuário vê na tela (o texto do erro cita "campo 3", "campo 5"...). */
export const FIELDS = Object.freeze({
  mes: { n: 3, label: 'projeção NO MÊS em % (CPI, PPI ou PCE)', example: '0,3' },
  ano: { n: 4, label: 'projeção EM 12 MESES em % (CPI, PPI ou PCE, opcional)', example: '3,1' },
  vagas: { n: 5, label: 'projeção de VAGAS em milhares (Payroll)', example: '150' },
  juros: { n: 6, label: 'juros ESPERADO em % (FOMC)', example: '3,75' },
  anterior: { n: 7, label: 'ANTERIOR (opcional, PCE ou FOMC)', example: 'PCE 0,3 · FOMC 4,00' },
});
/** Quais campos cada tipo usa (o resto é ignorado com aviso). */
const FIELDS_OF = Object.freeze({ CPI: ['mes', 'ano', 'anterior'], PPI: ['mes', 'ano', 'anterior'], PCE: ['mes', 'ano', 'anterior'], NFP: ['vagas', 'anterior'], FOMC: ['juros', 'anterior'] });
const MAIN_FIELD = Object.freeze({ CPI: 'mes', PPI: 'mes', PCE: 'mes', NFP: 'vagas', FOMC: 'juros' });

const emptyState = () => ({ version: CONSENSUS_VERSION, items: {} });

/** Tira o que a pessoa costuma escrever junto do número: "%", "k", "mil", "m/m", "a/a", espaços. Vírgula ou ponto como decimal. */
function cleanNumber(raw) {
  return String(raw ?? '').trim().toLowerCase()
    .replace(/m\/m|a\/a|mom|yoy|%|mil|k\b/g, '')
    .replace(/\s+/g, '')
    .replace(',', '.');
}

/** Percentual com UMA casa (o que o BLS e o BEA publicam). Duas casas são ARREDONDADAS (e o aviso diz). → { text: "+0,3", rounded } | null */
function percentOneDecimal(raw) {
  const t = cleanNumber(raw);
  if (!/^[+-]?\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || Math.abs(n) >= 100) return null;
  const r = Math.round(Math.abs(n) * 10) / 10;
  const rounded = Math.abs(Math.abs(n) - r) > 1e-9;
  const sign = n < 0 && r > 0 ? '-' : '+';
  return { text: `${sign}${r.toFixed(1).replace('.', ',')}`, rounded };
}

/** Vagas em milhares (inteiro). "150", "150k", "150 mil", "-92" → "+150 mil" | null */
function jobs(raw) {
  const t = cleanNumber(raw);
  if (!/^[+-]?\d{1,3}$/.test(t)) return null;
  return `${t.startsWith('-') ? '-' : '+'}${t.replace(/^[+-]/, '')} mil`;
}

/** Taxa de juros com DUAS casas. "3,75", "3.75%", "4" → "3,75%" / "4,00%" | null */
function rate(raw) {
  const t = cleanNumber(raw);
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > MAX_RATE) return null;
  return `${n.toFixed(2).replace('.', ',')}%`;
}

const has = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Monta a projeção e o "Anterior" a partir dos campos do formulário. Só usa os campos do tipo escolhido; o resto é IGNORADO (e vira um aviso), para que um campo
 * preenchido a mais não impeça o registro. Erro só quando o que é DO tipo está faltando ou mal escrito — e o texto diz qual campo (pelo número da tela) e um exemplo.
 * @param {string} kind
 * @param {{ mes?: string, ano?: string, vagas?: string, juros?: string, anterior?: string }} inputs
 * @returns {{ ok: true, fields: { projection?: string, previous?: string }, notes: string[] } | { ok: false, error: string, notes: string[] }}
 */
export function buildFields(kind, inputs = {}) {
  const notes = [];
  if (!KINDS.includes(kind)) return { ok: false, error: `tipo desconhecido (${String(kind).slice(0, 12)})`, notes };
  const own = FIELDS_OF[kind];
  for (const name of Object.keys(FIELDS)) {
    if (!own.includes(name) && has(inputs[name])) notes.push(`O campo ${FIELDS[name].n} (${FIELDS[name].label}) não é do ${kind} e foi ignorado.`);
  }
  const main = MAIN_FIELD[kind];
  const fields = {};
  const bad = (name, what) => ({ ok: false, error: `campo ${FIELDS[name].n} (${FIELDS[name].label}): ${what}. Exemplo: ${FIELDS[name].example}`, notes });

  if (PERCENT_KINDS.has(kind)) {
    if (has(inputs.mes)) {
      const m = percentOneDecimal(inputs.mes);
      if (!m) return bad('mes', `"${String(inputs.mes).trim().slice(0, 20)}" não é um número em %`);
      let text = `${m.text}% m/m`;
      if (m.rounded) notes.push(`O campo 3 foi arredondado para ${m.text}% (o ${kind} é publicado com uma casa decimal).`);
      if (has(inputs.ano)) {
        const a = percentOneDecimal(inputs.ano);
        if (!a) return bad('ano', `"${String(inputs.ano).trim().slice(0, 20)}" não é um número em %`);
        if (a.rounded) notes.push(`O campo 4 foi arredondado para ${a.text}%.`);
        text += ` · ${a.text}% a/a`;
      }
      if (!PREVIOUS_TEXT_RE.test(text)) return bad('mes', 'número fora da faixa aceita');
      fields.projection = text;
    } else if (has(inputs.ano)) {
      return bad('mes', 'preencha também a projeção no mês (o campo 4, de 12 meses, é complemento)');
    }
  } else if (kind === 'NFP') {
    if (has(inputs.vagas)) {
      const j = jobs(inputs.vagas);
      if (!j || !PREVIOUS_TEXT_RE.test(j)) return bad('vagas', `"${String(inputs.vagas).trim().slice(0, 20)}" não é um número inteiro de milhares`);
      fields.projection = j;
    }
  } else if (kind === 'FOMC') {
    if (has(inputs.juros)) {
      const r = rate(inputs.juros);
      if (!r) return bad('juros', `"${String(inputs.juros).trim().slice(0, 20)}" não é uma taxa em %`);
      fields.projection = r;
    }
  }

  if (has(inputs.anterior)) {
    let prev = null;
    if (PERCENT_KINDS.has(kind)) {
      const p = percentOneDecimal(inputs.anterior);
      if (p) {
        prev = `${p.text}% m/m`;
        if (p.rounded) notes.push(`O campo 7 foi arredondado para ${p.text}%.`);
      }
    } else if (kind === 'NFP') prev = jobs(inputs.anterior);
    else if (kind === 'FOMC') prev = rate(inputs.anterior);
    if (!prev || !isValidText(kind, 'previous', prev)) {
      return bad('anterior', `"${String(inputs.anterior).trim().slice(0, 20)}" não está no formato do ${kind} (${kind === 'FOMC' ? 'juros atual em %, ex.: 4,00' : kind === 'NFP' ? 'milhares, ex.: 119' : '% no mês, ex.: 0,3'})`);
    }
    fields.previous = prev;
  }

  if (!fields.projection && !fields.previous) {
    return { ok: false, error: `para ${kind}, preencha o campo ${FIELDS[main].n} (${FIELDS[main].label}). Exemplo: ${FIELDS[main].example}`, notes };
  }
  return { ok: true, fields, notes };
}

/** O texto já canônico (vem do arquivo público): é o que o formato fechado do tipo aceita? */
export function isValidText(kind, field, text) {
  if (typeof text !== 'string') return false;
  if (kind === 'FOMC') return RATE_RE.test(text) && Number(text.replace('%', '').replace(',', '.')) <= MAX_RATE;
  if (kind === 'NFP' || PERCENT_KINDS.has(kind)) return PREVIOUS_TEXT_RE.test(text);
  return false;
}

/**
 * FOMC: a decisão que a projeção do usuário implica, contra o "Anterior" (juros atual). Fato aritmético sobre os DOIS números que ele registrou — não é previsão do
 * sistema. "manter em 4,00%" | "corte de 0,25 p.p. (de 4,00% para 3,75%)" | "alta de 0,25 p.p. (...)"; null se faltar um dos dois.
 */
export function describeFomc(projection, previous) {
  if (!isValidText('FOMC', 'projection', projection) || !isValidText('FOMC', 'previous', previous)) return null;
  const p = Number(projection.replace('%', '').replace(',', '.'));
  const a = Number(previous.replace('%', '').replace(',', '.'));
  const diff = Math.round((p - a) * 100) / 100;
  if (diff === 0) return `manter em ${projection}`;
  const pp = Math.abs(diff).toFixed(2).replace('.', ',');
  return `${diff < 0 ? 'corte' : 'alta'} de ${pp} p.p. (de ${previous} para ${projection})`;
}

/** O registro lido do arquivo (disco/rede: não é confiável): só entradas bem formadas e recentes. Lixo vira registro vazio. Nunca lança. */
export function parseConsensus(json, nowMs) {
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'a data (campo 2) precisa ser AAAA-MM-DD, ou fique em branco para o próximo evento' };
    const e = list.find((x) => x?.id === `${kind}-${d}`);
    return e ? { ok: true, event: e } : { ok: false, error: `não achei o evento ${kind} de ${d} na agenda (deixe a data em branco para o próximo)` };
  }
  const next = list
    .filter((x) => x?.kind === kind && Number.isFinite(x.startMs) && x.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)[0];
  return next ? { ok: true, event: next } : { ok: false, error: `não há próximo evento ${kind} na agenda` };
}
