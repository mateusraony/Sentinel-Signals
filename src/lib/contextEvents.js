// Contexto de Mercado — Fase 5 (docs/known-risks.md item 285): a lista de eventos (instante UTC de cada divulgação) montada a partir dos arquivos
// PÚBLICOS da branch `context-data` (`history.json`, as datas passadas; e `events.json`, os recentes), e os BURACOS do histórico.
// Módulo PURO (sem rede, sem banco, sem relógio global), usado pela medição do portão (scripts/overlap-measure.mjs) e pelo marcador do Histórico
// (navegador): as duas contas têm que ser a MESMA. O motor nunca importa este arquivo (travado por scripts/contextIsolationTripwire.test.js).
import { nyToUtc } from '../../scripts/contextTime.mjs';
import { ALL_KINDS } from './contextOverlap.js';

/**
 * A hora da divulgação de cada tipo, em Nova York (08:30; FOMC 14:00). É a MESMA tabela de `scripts/contextCalendar.mjs` (`KIND_TIMES`): está repetida aqui para o
 * navegador não puxar o arquivo inteiro do calendário; `scripts/overlapMeasure.test.js` confere que as duas são iguais.
 */
export const KIND_TIMES = Object.freeze({ CPI: '08:30', NFP: '08:30', PPI: '08:30', PCE: '08:30', FOMC: '14:00' });

const DAY_MS = 86400000;
/** Tipos mensais (uma divulgação por mês); o FOMC tem 8 por ano (intervalo máximo normal ~8 semanas). */
const MONTHLY_KINDS = new Set(['CPI', 'NFP', 'PPI', 'PCE']);
const FOMC_MAX_GAP_DAYS = 75;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIRM_STATUS = new Set(['oficial', 'confirmada']);

/** 'AAAA-MM-DD' + tipo → instante UTC (ms) da divulgação, pelo horário fixo do tipo em Nova York. null se a data/tipo não servem. */
export function eventInstant(kind, date) {
  if (!DATE_RE.test(date ?? '') || !KIND_TIMES[kind]) return null;
  const r = nyToUtc(date, KIND_TIMES[kind]);
  return r ? r.ms : null;
}

/**
 * Junta o que a branch `context-data` publica: `history.json` ({ dates: { CPI: ['AAAA-MM-DD'…] } }, passadas) e `events.json` (lista com `startsAtUtc`
 * e `status`; só os de data firme e já ocorridos entram). Sem repetição (tipo + instante).
 * `coverageStartMs`: o mais RECENTE dos "primeiros dias conhecidos" dos tipos pedidos — antes disso ao menos um tipo não tem histórico, e contar
 * "sem evento" ali seria só falta de dado.
 */
export function buildEvents({ history, events, nowMs, kinds = ALL_KINDS }) {
  const seen = {};
  const add = (kind, ms) => { if (Number.isFinite(ms)) seen[`${kind}|${ms}`] = { kind, startsAtMs: ms }; };
  const firstKnown = {};
  const dates = history && typeof history === 'object' ? history.dates : null;
  for (const kind of kinds) {
    const list = Array.isArray(dates?.[kind]) ? dates[kind] : [];
    for (const d of list) {
      const ms = eventInstant(kind, d);
      if (ms == null) continue;
      add(kind, ms);
      if (firstKnown[kind] == null || ms < firstKnown[kind]) firstKnown[kind] = ms;
    }
  }
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !kinds.includes(e.kind) || !FIRM_STATUS.has(e.status)) continue;
    const ms = Date.parse(e.startsAtUtc ?? '');
    if (Number.isFinite(ms) && ms <= nowMs) add(e.kind, ms);
  }
  const have = kinds.filter((k) => firstKnown[k] != null);
  const coverageStartMs = have.length === kinds.length ? Math.max(...have.map((k) => firstKnown[k])) : null;
  const events2 = Object.values(seen).sort((a, b) => a.startsAtMs - b.startsAtMs);
  /** @type {Record<string, number[]>} */
  const msByKind = {};
  for (const e of events2) (msByKind[e.kind] ??= []).push(e.startsAtMs);
  return { events: events2, coverageStartMs, kindsWithHistory: have, gaps: findGaps(msByKind, nowMs) };
}

/**
 * Os BURACOS do histórico de cada tipo (achado do Codex no PR #596): o coletor tira do histórico o mês com 2 datas (`contextHistory.mjs`), então "a data mais antiga"
 * não prova que não faltou nenhuma depois dela. Tipo mensal: cada mês, do primeiro ao anterior ao atual, sem nenhuma data. FOMC: espaço maior que 75 dias entre duas
 * reuniões conhecidas (ou desde a última até agora). Um intervalo {startMs, endMs} por buraco, por tipo.
 * @param {Record<string, number[]>} msByKind instantes conhecidos por tipo
 */
export function findGaps(msByKind, nowMs) {
  /** @type {Record<string, { startMs: number, endMs: number }[]>} */
  const gaps = {};
  for (const [kind, list] of Object.entries(msByKind)) {
    const known = [...list].sort((a, b) => a - b);
    if (!known.length) continue;
    const out = [];
    if (MONTHLY_KINDS.has(kind)) {
      const have = new Set(known.map((ms) => new Date(ms).toISOString().slice(0, 7)));
      const first = new Date(known[0]);
      const now = new Date(nowMs);
      let y = first.getUTCFullYear();
      let m = first.getUTCMonth();
      const stop = now.getUTCFullYear() * 12 + now.getUTCMonth(); // o mês de hoje não conta: a divulgação dele pode ainda não ter saído
      while (y * 12 + m < stop) {
        const key = `${y}-${String(m + 1).padStart(2, '0')}`;
        if (!have.has(key)) out.push({ startMs: Date.UTC(y, m, 1), endMs: Date.UTC(y, m + 1, 1) - 1 });
        m += 1;
        if (m > 11) { m = 0; y += 1; }
      }
    } else {
      for (let i = 1; i < known.length; i += 1) {
        if (known[i] - known[i - 1] > FOMC_MAX_GAP_DAYS * DAY_MS) out.push({ startMs: known[i - 1] + 1, endMs: known[i] - 1 });
      }
      const last = known[known.length - 1];
      if (nowMs - last > FOMC_MAX_GAP_DAYS * DAY_MS) out.push({ startMs: last + 1, endMs: nowMs });
    }
    if (out.length) gaps[kind] = out;
  }
  return gaps;
}

