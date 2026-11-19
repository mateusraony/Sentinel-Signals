// Contexto de Mercado — leitor do calendário OFICIAL do FOMC, na página do Fed (docs/known-risks.md item 285, addendum 34).
//
// Por quê: a lista fixa (`contextCalendar.mjs`) é a ÚNICA fonte das datas do FOMC e termina na reunião de 09/12/2026; sem atualização,
// não há aviso de FOMC em 2027. O usuário pediu tudo automático (opção A, 19/11/2026): o coletor, que roda no GitHub e alcança o site do
// Fed, lê a página a cada coleta.
//
// FASE DE OBSERVAÇÃO (este arquivo, por enquanto): as datas lidas só aparecem no RESUMO do coletor, comparadas com a lista fixa — NÃO
// entram no `events.json`. A estrutura da página não pôde ser conferida desta sessão (rede bloqueada); o resumo das coletas reais é a
// conferência. Só depois de bater com a página real um PR separado passa a usá-las.
//
// Regras de honestidade:
//   - só reunião AGENDADA (o Fed se reúne 8 vezes por ano): "15 (unscheduled)", "23 (notation vote)" e afins não passam no formato
//     fechado do dia ("27-28", "30-1", "17-18*", "9") e ficam de fora;
//   - um ano que não traz exatamente 8 reuniões válidas é DESCARTADO inteiro (página mudou ou ano ainda incompleto) — nunca meio calendário;
//   - a data do evento é o ÚLTIMO dia da reunião (o comunicado sai às 14:00 desse dia, `KIND_TIMES.FOMC`).
// Módulo puro + `fetch` injetável. Sem banco, sem Telegram, sem motor, sem chave.
import { buildUserAgent, MAX_BODY_BYTES } from './contextProbe.mjs';

export const FED_FOMC_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
export const MEETINGS_PER_YEAR = 8;

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
});

const pad = (n) => String(n).padStart(2, '0');
const stripTags = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

/** Dia válido no calendário? (rejeita 31/04, 30/02...) */
function validDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * O último dia de UMA reunião, ou null. `monthText`: "January" ou "Apr/May"; `dateText`: "27-28", "30-1", "17-18*", "9".
 * Na reunião que atravessa o mês ("Apr/May" + "30-1"), o último dia é do 2º mês. Texto fora do formato fechado (ex.: "15 (unscheduled)") = null.
 */
export function meetingEndDate(year, monthText, dateText) {
  const months = String(monthText).toLowerCase().split('/').map((m) => MONTHS[m.trim()]).filter(Boolean);
  if (!months.length || months.length > 2) return null;
  const m = /^(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*\*?$/.exec(String(dateText).trim());
  if (!m) return null;
  const last = Number(m[2] ?? m[1]);
  const month = months[months.length - 1];
  if (months.length === 2 && !m[2]) return null; // "Apr/May" com um dia só: incoerente
  if (!validDate(year, month, last)) return null;
  return `${year}-${pad(month)}-${pad(last)}`;
}

/**
 * Lê a página do calendário do FOMC. Cada ano vem num bloco cujo título é "AAAA FOMC Meetings"; cada reunião, num par de blocos
 * `fomc-meeting__month` (mês) e `fomc-meeting__date` (dias).
 * @returns {{ years: Record<string, string[]>, rejected: Record<string, number> }|null} `years`: só os anos com exatamente 8 reuniões válidas
 *   (datas AAAA-MM-DD em ordem); `rejected`: ano → quantas reuniões válidas ele tinha (≠ 8). null se a página não tem nenhum ano reconhecível.
 */
export function parseFomcCalendar(html) {
  if (typeof html !== 'string' || !html) return null;
  const heads = [...html.matchAll(/(\d{4})\s+FOMC\s+Meetings/gi)];
  if (!heads.length) return null;
  const years = {};
  const rejected = {};
  for (const [i, h] of heads.entries()) {
    const year = Number(h[1]);
    if (year < 2000 || year > 2100 || Object.prototype.hasOwnProperty.call(years, h[1]) || Object.prototype.hasOwnProperty.call(rejected, h[1])) continue;
    const block = html.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : html.length);
    const months = [...block.matchAll(/class="[^"]*fomc-meeting__month[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)].map((x) => stripTags(x[1]));
    const dates = [...block.matchAll(/class="[^"]*fomc-meeting__date[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)].map((x) => stripTags(x[1]));
    const out = [];
    if (months.length === dates.length) {
      for (let k = 0; k < months.length; k += 1) {
        const d = meetingEndDate(year, months[k], dates[k]);
        if (d) out.push(d);
      }
    }
    const sorted = [...new Set(out)].sort();
    const inOrder = sorted.length === out.length && sorted.every((d, k) => d === out[k]);
    if (sorted.length === MEETINGS_PER_YEAR && inOrder) years[h[1]] = sorted;
    else rejected[h[1]] = sorted.length;
  }
  return Object.keys(years).length || Object.keys(rejected).length ? { years, rejected } : null;
}

/**
 * Busca a página do Fed. Nunca lança; falha vira `{ calendar: null, reason }` com um código curto (nunca texto de erro).
 * @returns {Promise<{ calendar: ReturnType<typeof parseFomcCalendar>, reason: 'ok'|'http'|'formato'|'rede' }>}
 */
export async function fetchFomcCalendar({ fetchImpl = fetch, env = {}, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(FED_FOMC_URL, { headers: { 'User-Agent': buildUserAgent(env), Accept: 'text/html' }, signal: controller.signal });
    const text = await res.text();
    if (!(res.status >= 200 && res.status < 300) || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { calendar: null, reason: 'http' };
    const calendar = parseFomcCalendar(text);
    return calendar ? { calendar, reason: 'ok' } : { calendar: null, reason: 'formato' };
  } catch {
    return { calendar: null, reason: 'rede' };
  } finally {
    clearTimeout(timer);
  }
}

const ddmm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/**
 * As linhas do resumo do coletor (FASE DE OBSERVAÇÃO): o que a página do Fed trouxe, por ano, e se bate com as datas de FOMC da lista fixa.
 * @param {{ calendar: object|null, reason: string }|null} fed @param {string[]} fixedDates datas AAAA-MM-DD do FOMC na lista fixa
 */
export function describeFomcCalendar(fed, fixedDates = []) {
  if (!fed) return [];
  const head = 'Fed — calendário do FOMC (só observação: ainda NÃO entra no events.json):';
  if (!fed.calendar) {
    const why = { http: 'a página não respondeu', formato: 'a página não está no formato esperado', rede: 'erro de rede' }[fed.reason] ?? 'falhou';
    return [`${head} ${why}.`];
  }
  const lines = [head];
  for (const [year, dates] of Object.entries(fed.calendar.years).sort()) {
    const fixed = fixedDates.filter((d) => d.startsWith(`${year}-`));
    const cmp = fixed.length
      ? ` — lista fixa: ${fixed.filter((d) => dates.includes(d)).length} de ${fixed.length} bate(m)${fixed.some((d) => !dates.includes(d)) ? ` (NÃO bate: ${fixed.filter((d) => !dates.includes(d)).map(ddmm).join(', ')})` : ''}`
      : '';
    lines.push(`• ${year}: ${dates.length} reuniões, comunicado em ${dates.map(ddmm).join(', ')}${cmp}.`);
  }
  for (const [year, n] of Object.entries(fed.calendar.rejected).sort()) {
    lines.push(`• ${year}: ano descartado (${n} reunião(ões) válida(s), o esperado é ${MEETINGS_PER_YEAR}).`);
  }
  return lines;
}
