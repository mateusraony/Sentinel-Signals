// Contexto de Mercado — Fase 2: coletor das datas dos eventos (docs/known-risks.md item 285,
// addendum 9). Monta os 2 arquivos PÚBLICOS da branch `context-data`:
//   events.json : eventos (CPI, Payroll, PPI, PCE, FOMC) com tipo, data/hora e situação;
//   status.json : quando checou, se o FRED respondeu, quantos eventos, até quando há cobertura.
//
// O que NUNCA vai para lá (repositório público; lição do item 25): URL, chave, mensagem de
// erro, valor de CPI/Payroll (termos do FRED) ou volatilidade (termos da Deribit). A trava é
// `assertPublicShape`: lista FECHADA de campos e formato de cada valor — texto livre não passa.
//
// Fontes: as datas do FRED (CPI, Payroll, PPI, PCE) são a fonte principal; a lista fixa
// (`contextCalendar.mjs`) é a reserva e a única fonte do FOMC. A hora vem de `KIND_TIMES`.
// Parte pura + uma busca com `fetch` injetável (testável). Sem banco, sem Telegram, sem motor.
import { createHash } from 'node:crypto';
import { KINDS, KIND_TIMES, STATUS, US_RELEASES } from './contextCalendar.mjs';
import { nyToUtc } from './contextTime.mjs';
import { buildUserAgent, MAX_BODY_BYTES } from './contextProbe.mjs';

/** Releases do FRED, conferidos pelo nome na sonda (runs 5-8). FOMC não está aqui: vem da lista fixa. */
export const FRED_RELEASES = Object.freeze({ CPI: 10, NFP: 50, PPI: 46, PCE: 54 });

export const PUBLIC_VERSION = 1;
export const EVENT_KEYS = Object.freeze(['id', 'kind', 'reference', 'startsAtUtc', 'status', 'firstSeenAt', 'lastChangedAt']);
export const STATUS_KEYS = Object.freeze(['version', 'checkedAt', 'fred', 'eventsCount', 'coverageUntil', 'hash']);
export const FRED_STATES = Object.freeze(['ok', 'parcial', 'falhou']);

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ALERTABLE = new Set([STATUS.OFICIAL, STATUS.CONFIRMADA]);

export const eventId = (kind, date) => `${kind}-${date}`;

/** Datas AAAA-MM-DD de `release/dates` do FRED (sem repetir, em ordem); null se o corpo não serve. */
export function parseFredReleaseDates(body) {
  let j;
  try { j = JSON.parse(body ?? ''); } catch { return null; }
  if (!Array.isArray(j?.release_dates)) return null;
  const dates = [...new Set(j.release_dates.map((r) => String(r?.date ?? '')).filter((d) => DATE_RE.test(d)))].sort();
  return dates.length ? dates : null;
}

/**
 * Do `events.json` anterior, só as linhas bem formadas (mesmo formato que `assertPublicShape` exige).
 * Linha com situação/referência/data fora do formato é DESCARTADA (vira evento novo) em vez de ser
 * copiada para a saída: copiada, a trava do conteúdo público recusaria tudo e o coletor travaria
 * para sempre num arquivo ruim (achado da auditoria de 31/10).
 */
export function sanitizePrevious(previous) {
  if (!Array.isArray(previous)) return [];
  return previous.filter((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.id !== 'string') return false;
    const m = /^([A-Z]+)-(\d{4}-\d{2}-\d{2})$/.exec(p.id);
    if (!m || !Object.prototype.hasOwnProperty.call(KINDS, m[1]) || p.kind !== m[1]) return false;
    if (!Object.values(STATUS).includes(p.status)) return false;
    if (!(p.reference === null || /^\d{4}-\d{2}$/.test(String(p.reference)))) return false;
    return ISO_RE.test(p.startsAtUtc ?? '');
  });
}

const instant = (kind, date) => {
  try { return nyToUtc(date, KIND_TIMES[kind]); } catch { return null; }
};

/**
 * Monta os eventos públicos.
 * @param {object} p
 * @param {Record<string, string[]|null|undefined>} p.fredDatesByKind datas do FRED por tipo;
 *   null/ausente = o FRED não respondeu para esse tipo (cai na lista fixa, sem rebaixar nada).
 * @param {object[]} [p.fixedList] lista fixa (`US_RELEASES`)
 * @param {object[]} [p.previous] o `events.json` anterior (para `firstSeenAt` e remarcação)
 * @param {number} p.nowMs
 *
 * Regras:
 * 1. Data do FRED → 'oficial'. Mesma data na lista fixa → herda o mês de referência dela.
 * 2. Data da lista fixa (tipo do FRED) que o FRED NÃO traz → 'a_confirmar' (remarcação, antecipação,
 *    retirada ou divergência; não alerta), QUALQUER que seja a data. Antes só se rebaixava até a
 *    última data que o FRED publicou: uma antecipação (PCE de 23/12 para 22/12) ou a retirada das
 *    datas futuras deixava a antiga "oficial" ao lado da nova (achado G1 da auditoria de 31/10).
 *    Lado seguro: se o FRED vier incompleto, o efeito é "a confirmar" (sem alerta) até ele
 *    publicar — nunca dois dias oficiais para o mesmo evento.
 * 3. Evento futuro já publicado que sumiu das fontes → 'a_confirmar' (se a fonte daquele tipo
 *    respondeu); se a fonte falhou, fica como estava (uma queda do FRED não apaga nada).
 * 4. FRED sem resposta para um tipo: evento JÁ publicado mantém a situação publicada, mesmo que
 *    também esteja na lista fixa — a lista só decide evento novo. Sem isso, uma queda do FRED
 *    depois de uma remarcação publicaria os dois dias como oficiais (achado do Codex no PR #529).
 * 5. Só de ontem em diante.
 */
export function buildEvents({ fredDatesByKind = {}, fixedList = US_RELEASES, previous = [], nowMs }) {
  const nowIso = new Date(nowMs).toISOString();
  const cutoffMs = nowMs - DAY_MS;
  const cand = new Map(); // id → { kind, date, reference, status }

  for (const e of fixedList) {
    if (!Object.prototype.hasOwnProperty.call(KINDS, e?.kind) || !DATE_RE.test(e?.date ?? '')) continue;
    cand.set(eventId(e.kind, e.date), { kind: e.kind, date: e.date, reference: e.reference ?? null, status: e.status });
  }

  const fredAnswered = new Set();
  for (const kind of Object.keys(FRED_RELEASES)) {
    const dates = fredDatesByKind[kind];
    if (!Array.isArray(dates) || !dates.length) continue;
    fredAnswered.add(kind);
    const set = new Set(dates);
    for (const d of dates) {
      const id = eventId(kind, d);
      const prev = cand.get(id);
      cand.set(id, { kind, date: d, reference: prev?.reference ?? null, status: STATUS.OFICIAL });
    }
    for (const [id, c] of cand) {
      if (c.kind === kind && !set.has(c.date)) cand.set(id, { ...c, status: STATUS.A_CONFIRMAR });
    }
  }

  const prevById = new Map(sanitizePrevious(previous).map((p) => [p.id, p]));
  for (const [id, c] of cand) {
    const p = prevById.get(id);
    if (!p || !(c.kind in FRED_RELEASES) || fredAnswered.has(c.kind) || !Object.values(STATUS).includes(p.status)) continue;
    cand.set(id, { ...c, status: p.status, reference: c.reference ?? (typeof p.reference === 'string' ? p.reference : null) });
  }
  for (const [id, p] of prevById) {
    if (cand.has(id)) continue;
    const m = /^([A-Z]+)-(\d{4}-\d{2}-\d{2})$/.exec(id);
    if (!m || !Object.prototype.hasOwnProperty.call(KINDS, m[1])) continue;
    const kind = m[1];
    const sourceAnswered = kind in FRED_RELEASES ? fredAnswered.has(kind) : true; // FOMC: a lista fixa sempre "responde"
    cand.set(id, {
      kind,
      date: m[2],
      reference: typeof p.reference === 'string' ? p.reference : null,
      status: sourceAnswered ? STATUS.A_CONFIRMAR : p.status,
    });
  }

  const out = [];
  for (const [id, c] of cand) {
    const utc = instant(c.kind, c.date);
    if (!utc || utc.ms < cutoffMs) continue;
    const p = prevById.get(id);
    // Mudou = situação, hora OU mês de referência (antes a referência era ignorada).
    const changed = !p || p.status !== c.status || p.startsAtUtc !== utc.iso || (p.reference ?? null) !== (c.reference ?? null);
    out.push({
      id,
      kind: c.kind,
      reference: c.reference,
      startsAtUtc: utc.iso,
      status: c.status,
      firstSeenAt: typeof p?.firstSeenAt === 'string' && ISO_RE.test(p.firstSeenAt) ? p.firstSeenAt : nowIso,
      lastChangedAt: changed ? nowIso : (ISO_RE.test(p.lastChangedAt ?? '') ? p.lastChangedAt : nowIso),
    });
  }
  return out.sort((a, b) => (a.startsAtUtc === b.startsAtUtc ? a.id.localeCompare(b.id) : a.startsAtUtc.localeCompare(b.startsAtUtc)));
}

/** Impressão digital dos eventos (sem a hora da checagem): muda só quando algum evento muda. */
export function eventsHash(events) {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

/** O `status.json`. `fred`: 'ok' (os 4 tipos), 'parcial' ou 'falhou' (nenhum). */
export function buildStatus({ events, fredDatesByKind = {}, nowMs }) {
  const answered = Object.keys(FRED_RELEASES).filter((k) => Array.isArray(fredDatesByKind[k]) && fredDatesByKind[k].length).length;
  const total = Object.keys(FRED_RELEASES).length;
  const future = events.filter((e) => ALERTABLE.has(e.status) && Date.parse(e.startsAtUtc) > nowMs);
  return {
    version: PUBLIC_VERSION,
    checkedAt: new Date(nowMs).toISOString(),
    fred: answered === total ? 'ok' : answered === 0 ? 'falhou' : 'parcial',
    eventsCount: events.length,
    coverageUntil: future.length ? future[future.length - 1].startsAtUtc : null,
    hash: eventsHash(events),
  };
}

const sameKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj)
  && Object.keys(obj).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));

/**
 * Trava do que vai para o repositório público. Lança se houver campo fora da lista ou valor fora
 * do formato esperado (nada de texto livre: URL, mensagem de erro e valor de série não passam).
 */
export function assertPublicShape(events, status) {
  const problems = [];
  if (!Array.isArray(events)) problems.push('events não é uma lista');
  for (const [i, e] of (Array.isArray(events) ? events : []).entries()) {
    const tag = `evento ${i}`;
    if (!sameKeys(e, EVENT_KEYS)) { problems.push(`${tag}: campos diferentes de ${EVENT_KEYS.join(', ')}`); continue; }
    if (!Object.prototype.hasOwnProperty.call(KINDS, e.kind)) problems.push(`${tag}: tipo inválido`);
    if (typeof e.id !== 'string' || e.id !== eventId(e.kind, String(e.id).slice(-10)) || !DATE_RE.test(String(e.id).slice(-10))) problems.push(`${tag}: id inválido`);
    if (!(e.reference === null || /^\d{4}-\d{2}$/.test(e.reference))) problems.push(`${tag}: referência inválida`);
    for (const k of ['startsAtUtc', 'firstSeenAt', 'lastChangedAt']) if (!ISO_RE.test(e[k] ?? '')) problems.push(`${tag}: ${k} inválido`);
    if (!Object.values(STATUS).includes(e.status)) problems.push(`${tag}: situação inválida`);
  }
  if (!sameKeys(status, STATUS_KEYS)) problems.push(`status: campos diferentes de ${STATUS_KEYS.join(', ')}`);
  else {
    if (status.version !== PUBLIC_VERSION) problems.push('status: versão inválida');
    if (!ISO_RE.test(status.checkedAt ?? '')) problems.push('status: checkedAt inválido');
    if (!FRED_STATES.includes(status.fred)) problems.push('status: fred inválido');
    if (!Number.isInteger(status.eventsCount) || status.eventsCount < 0) problems.push('status: eventsCount inválido');
    if (!(status.coverageUntil === null || ISO_RE.test(status.coverageUntil))) problems.push('status: coverageUntil inválido');
    if (!/^[0-9a-f]{64}$/.test(status.hash ?? '')) problems.push('status: hash inválido');
  }
  if (problems.length) throw new Error(`conteúdo público recusado: ${problems.slice(0, 5).join('; ')}`);
}

const FRED_DATES_URL = 'https://api.stlouisfed.org/fred/release/dates';

/**
 * Busca as datas do FRED para os 4 tipos. A chave só existe na URL da requisição; qualquer falha
 * vira `null` para aquele tipo, SEM mensagem (uma mensagem de erro pode citar a URL com a chave).
 * @returns {Promise<Record<string, string[]|null>>}
 */
export async function fetchFredDates({ fetchImpl = fetch, env = {}, timeoutMs = 15000 } = {}) {
  const key = String(env.FRED_API_KEY ?? '');
  const out = {};
  for (const [kind, releaseId] of Object.entries(FRED_RELEASES)) {
    out[kind] = null;
    if (!key) continue;
    const url = `${FRED_DATES_URL}?release_id=${releaseId}&file_type=json&include_release_dates_with_no_data=true&sort_order=desc&limit=20&api_key=${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': buildUserAgent(env), Accept: 'application/json' }, signal: controller.signal });
      const text = await res.text();
      if (res.status >= 200 && res.status < 300 && Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES) out[kind] = parseFredReleaseDates(text);
    } catch { /* fica null: a lista fixa cobre */ } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
