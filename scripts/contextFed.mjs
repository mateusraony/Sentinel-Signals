// Contexto de Mercado — leitor do calendário OFICIAL do FOMC, na página do Fed (docs/known-risks.md item 285, addendum 34).
//
// Por quê: a lista fixa (`contextCalendar.mjs`) é a ÚNICA fonte das datas do FOMC e termina na reunião de 09/12/2026; sem atualização,
// não há aviso de FOMC em 2027. O usuário pediu tudo automático (opção A, 19/11/2026): o coletor, que roda no GitHub e alcança o site do
// Fed, lê a página a cada coleta.
//
// Addendum 34: começou em OBSERVAÇÃO (só no resumo do coletor). A 1ª coleta real (19/11/2026, 15:01 UTC) provou a estrutura: 2021 a 2026 saíram com 8
// reuniões cada e 2026 bateu com a lista fixa. Addendum 36: as datas dos anos aceitos passaram a entrar no `events.json` (`fomcDatesFromCalendar`).
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
/**
 * Dias da semana (0 = domingo) em que uma reunião pode TERMINAR: terça a quinta. O comunicado costuma sair numa quarta, mas em semana de eleição a reunião vai
 * de quarta a quinta (o log real de 19/11/2026 mostrou 07/11/2024, uma quinta-feira — uma regra "sempre quarta" rejeitaria um calendário correto).
 * Sábado, domingo, segunda e sexta só aparecem se a página foi lida errado.
 */
export const MEETING_END_WEEKDAYS = Object.freeze([2, 3, 4]);

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
});

const pad = (n) => String(n).padStart(2, '0');
// O traço entre os dias pode vir como entidade (&ndash;, &#8211;) em vez do caractere: sem isto "27&ndash;28" nunca casaria o formato do dia.
const stripTags = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&(?:ndash|mdash|#8211|#8212|#x2013|#x2014);/gi, '-').replace(/\s+/g, ' ').trim();

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
  const first = Number(m[1]);
  const last = Number(m[2] ?? m[1]);
  const month = months[months.length - 1];
  if (months.length === 2 && !m[2]) return null; // "Apr/May" com um dia só: incoerente
  // Mesmo mês: o fim não pode vir antes do começo ("April 30-1" não existe: seria 1º de abril, uma data inventada). Reunião que cruza o mês ("Apr/May 30-1"):
  // o fim É do 2º mês, então tem de ser menor que o começo. Qualquer outra combinação é lixo e vira null (achado da revisão independente de 19/11).
  if (months.length === 1 && last < first) return null;
  if (months.length === 2 && last >= first) return null;
  if (!validDate(year, month, last)) return null;
  return `${year}-${pad(month)}-${pad(last)}`;
}

/**
 * Lê a página do calendário do FOMC. Cada ano vem num bloco cujo título é "AAAA FOMC Meetings"; cada reunião, num par de blocos
 * `fomc-meeting__month` (mês) e `fomc-meeting__date` (dias).
 * @returns {{ years: Record<string, string[]>, rejected: Record<string, number>, odd: Record<string, string[]> }|null} `years`: só os anos com exatamente
 *   8 reuniões válidas, em ordem, e TODAS terminando de terça a quinta (`MEETING_END_WEEKDAYS`; uma data fora disso é sinal de página lida errado —
 *   melhor sem a data do que com uma errada); `rejected`: ano → quantas reuniões válidas ele tinha (≠ 8); `odd`: ano → as datas fora desses dias. null se a página não tem nenhum ano reconhecível.
 */
export function parseFomcCalendar(html) {
  if (typeof html !== 'string' || !html) return null;
  const heads = [...html.matchAll(/(\d{4})\s+FOMC\s+Meetings/gi)];
  if (!heads.length) return null;
  const years = {};
  const rejected = {};
  const odd = {};
  const seen = (y) => [years, rejected, odd].some((o) => Object.prototype.hasOwnProperty.call(o, y));
  for (const [i, h] of heads.entries()) {
    const year = Number(h[1]);
    if (year < 2000 || year > 2100 || seen(h[1])) continue;
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
    const offDay = sorted.filter((d) => !MEETING_END_WEEKDAYS.includes(new Date(`${d}T00:00:00.000Z`).getUTCDay()));
    if (sorted.length === MEETINGS_PER_YEAR && inOrder && !offDay.length) years[h[1]] = sorted;
    else if (sorted.length === MEETINGS_PER_YEAR && inOrder) odd[h[1]] = offDay;
    else rejected[h[1]] = sorted.length;
  }
  return [years, rejected, odd].some((o) => Object.keys(o).length) ? { years, rejected, odd } : null;
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
  const head = 'Fed — calendário do FOMC (lido da página do Fed; os anos aceitos entram no events.json):';
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
  for (const [year, list] of Object.entries(fed.calendar.odd ?? {}).sort()) {
    lines.push(`• ${year}: ano descartado (data(s) que não caem de terça a quinta: ${list.map(ddmm).join(', ')}).`);
  }
  return lines;
}

/**
 * As datas que o coletor USA (addendum 36): do calendário já lido, só os anos aceitos. `upcoming` = do ano corrente em diante (viram eventos);
 * `past` = todas as datas já passadas dos anos aceitos (alimentam o histórico do BTC nas reuniões); `years` = os anos aceitos a partir do corrente
 * (só neles a lista fixa pode ser rebaixada). null se o Fed não respondeu ou nenhum ano passou nas travas.
 * @returns {{ upcoming: string[], past: string[]|null, years: string[] }|null}
 */
export function fomcDatesFromCalendar(fed, nowMs) {
  const years = fed?.calendar?.years;
  if (!years || !Object.keys(years).length || !Number.isFinite(nowMs)) return null;
  const currentYear = String(new Date(nowMs).getUTCFullYear());
  const all = Object.entries(years).sort(([a], [b]) => a.localeCompare(b));
  const upcomingYears = all.filter(([y]) => y >= currentYear);
  return {
    upcoming: upcomingYears.flatMap(([, dates]) => dates),
    // O histórico só é SUBSTITUÍDO quando o ano corrente foi aceito: sem ele (ex.: o Fed devolveu 2026 inválido e aceitou 2021–2025) a lista de passadas ficaria sem as reuniões
    // mais recentes e o aviso mostraria reuniões antigas como "as últimas". null = mantém o histórico anterior (achado da revisão independente de 19/11).
    past: years[currentYear] ? all.flatMap(([, dates]) => dates).filter((d) => d < new Date(nowMs).toISOString().slice(0, 10)) : null,
    years: upcomingYears.map(([y]) => y),
  };
}
