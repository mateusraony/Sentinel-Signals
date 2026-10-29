// Contexto de Mercado (docs/known-risks.md itens 284/285, addenda 2-4) — calendário fixo
// dos EUA (CPI = inflação, Payroll = relatório de emprego).
//
// POR QUE EXISTE: o BLS bloqueia o servidor do GitHub (HTTP 403 nas 3 URLs
// testadas, mesmo com contato no identificador — item 285). A fonte oficial não
// pode ser lida pelo coletor, então as datas ficam numa lista no repositório.
//
// REGRA DE OURO — nunca inventar data:
// - 'confirmada'   : 2 ou mais fontes independentes concordam (busca na web;
//                    www.bls.gov não abre da sessão de desenvolvimento).
// - 'a_confirmar'  : fontes divergem, só uma fonte, ou a data é projeção. Aparece
//                    no painel como "data a confirmar" e NUNCA dispara alerta
//                    nem marca sobreposição com operação.
// - 'oficial'      : conferida numa fonte oficial — a tabela do próprio BLS ou o
//                    FRED (Fed de St. Louis, que republica o calendário do BLS;
//                    lido pela sonda em 29/10, run 5). Exige uma fonte oficial
//                    na lista de `fontes`.
//
// Parte pura: sem rede, sem Date.now implícito, sem banco. Horário de Nova York
// → UTC sempre por `nyToUtc` (nunca deslocamento fixo; o horário de verão dos
// EUA acaba em 2026-11-01).
import { nyToUtc } from './contextTime.mjs';

export const STATUS = Object.freeze({
  OFICIAL: 'oficial',
  CONFIRMADA: 'confirmada',
  A_CONFIRMAR: 'a_confirmar',
});

export const KINDS = Object.freeze({
  CPI: 'CPI (inflação dos EUA)',
  NFP: 'Payroll (emprego dos EUA)',
});

/** Data em que a lista abaixo foi montada (para o painel dizer "conferida em"). */
export const CALENDAR_CHECKED_AT = '2026-10-29';

/** Aviso quando faltar menos que isto para a última data confirmada. */
export const COVERAGE_WARN_DAYS = 60;

const S_BLS_CPI = 'https://www.bls.gov/schedule/news_release/cpi.htm';
const S_BLS_EMP = 'https://www.bls.gov/schedule/news_release/empsit.htm';
const S_FINCAL_CPI = 'https://www.financecalendar.com/us-cpi-report/';
const S_FINCAL_JOBS = 'https://www.financecalendar.com/us-jobs-report/';
const S_THRIVE_CPI = 'https://thriveinmarkets.com/calendar/dates/cpi-2026/';
const S_THRIVE_NFP = 'https://thriveinmarkets.com/calendar/dates/nfp-2026/';
// FRED (sem a chave na URL; a chave só existe na requisição da sonda).
const S_FRED_CPI = 'https://api.stlouisfed.org/fred/release/dates?release_id=10';
const S_FRED_EMP = 'https://api.stlouisfed.org/fred/release/dates?release_id=50';

/** Fontes que contam como oficiais (BLS ou FRED). */
const OFFICIAL_SOURCE_RE = /^https:\/\/(www\.bls\.gov|api\.stlouisfed\.org|fred\.stlouisfed\.org)\//;

/**
 * Lista fixa. `reference` = mês de referência do dado; `date` = dia da divulgação
 * (Nova York); `time` = hora em Nova York (as duas saem às 08:30 ET).
 * Montada em 2026-10-29 por busca na web; as 4 primeiras viraram 'oficial' no mesmo dia,
 * quando o FRED (sonda, run 5) confirmou as datas — ver `fontes` de cada linha.
 * Manter em ORDEM CRONOLÓGICA (o validateCalendar reprova fora de ordem).
 */
export const US_RELEASES = Object.freeze([
  { id: 'nfp-2026-10', kind: 'NFP', reference: '2026-10', date: '2026-11-06', time: '08:30', status: STATUS.OFICIAL, fontes: [S_FRED_EMP, S_BLS_EMP, S_FINCAL_JOBS, S_THRIVE_NFP] },
  { id: 'cpi-2026-10', kind: 'CPI', reference: '2026-10', date: '2026-11-10', time: '08:30', status: STATUS.OFICIAL, fontes: [S_FRED_CPI, S_BLS_CPI, S_FINCAL_CPI, S_THRIVE_CPI] },
  { id: 'nfp-2026-11', kind: 'NFP', reference: '2026-11', date: '2026-12-04', time: '08:30', status: STATUS.OFICIAL, fontes: [S_FRED_EMP, S_BLS_EMP, S_THRIVE_NFP] },
  // A dúvida 10×11/12 (um calendário de terceiros dizia 11/12) foi resolvida pelo FRED: 10/12.
  { id: 'cpi-2026-11', kind: 'CPI', reference: '2026-11', date: '2026-12-10', time: '08:30', status: STATUS.OFICIAL, fontes: [S_FRED_CPI, S_BLS_CPI, S_FINCAL_CPI] },
  { id: 'nfp-2026-12', kind: 'NFP', reference: '2026-12', date: '2027-01-08', time: '08:30', status: STATUS.A_CONFIRMAR, fontes: [S_BLS_EMP], nota: 'a outra fonte só aplica "primeira sexta"; o FRED ainda não tem 2027 (29/10)' },
  { id: 'cpi-2026-12', kind: 'CPI', reference: '2026-12', date: '2027-01-13', time: '08:30', status: STATUS.A_CONFIRMAR, fontes: [S_BLS_CPI], nota: 'projeção; fontes divergem entre 13 e 14/01 e o FRED ainda não tem 2027 (29/10)' },
]);

const VALID_STATUS = new Set(Object.values(STATUS));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida a lista inteira. Devolve a lista de problemas (vazia = válida).
 * Regras: campos obrigatórios, tipo/status conhecidos, id único, ordem por
 * data, dia útil, horário existente em Nova York, 'confirmada' com 2+ fontes
 * distintas, 'oficial' com pelo menos uma fonte oficial (BLS ou FRED).
 */
export function validateCalendar(list) {
  const problems = [];
  if (!Array.isArray(list)) return ['a lista não é um array'];
  const seen = new Set();
  let prevMs = -Infinity;
  for (const e of list) {
    const tag = e?.id || '(sem id)';
    if (!e?.id) problems.push(`${tag}: falta id`);
    else if (seen.has(e.id)) problems.push(`${tag}: id repetido`);
    else seen.add(e.id);
    if (!Object.prototype.hasOwnProperty.call(KINDS, e?.kind)) problems.push(`${tag}: tipo desconhecido (${e?.kind})`);
    if (!VALID_STATUS.has(e?.status)) problems.push(`${tag}: status desconhecido (${e?.status})`);
    if (!/^\d{4}-\d{2}$/.test(e?.reference || '')) problems.push(`${tag}: mês de referência inválido`);
    if (!DATE_RE.test(e?.date || '') || Number.isNaN(Date.parse(`${e.date}T00:00:00Z`))) {
      problems.push(`${tag}: data inválida (${e?.date})`);
      continue;
    }
    const dow = new Date(`${e.date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) problems.push(`${tag}: ${e.date} cai em fim de semana`);
    let utc = null;
    try { utc = nyToUtc(e.date, e.time); } catch { utc = null; }
    if (!utc) problems.push(`${tag}: horário inexistente em Nova York (${e.date} ${e.time})`);
    else {
      if (utc.ms < prevMs) problems.push(`${tag}: fora de ordem (anterior a uma linha acima)`);
      prevMs = Math.max(prevMs, utc.ms);
    }
    const nFontes = Array.isArray(e.fontes) ? new Set(e.fontes).size : 0;
    if (e.status === STATUS.CONFIRMADA && nFontes < 2) problems.push(`${tag}: 'confirmada' exige 2+ fontes distintas (tem ${nFontes})`);
    if (e.status === STATUS.OFICIAL && !(Array.isArray(e.fontes) && e.fontes.some((f) => OFFICIAL_SOURCE_RE.test(f)))) {
      problems.push(`${tag}: 'oficial' exige uma fonte oficial (BLS ou FRED)`);
    }
    if (e.status === STATUS.A_CONFIRMAR && !e.nota) problems.push(`${tag}: 'a_confirmar' precisa de nota dizendo por quê`);
  }
  return problems;
}

/** Eventos com o instante em UTC (nunca deslocamento fixo). Ignora linha inválida. */
export function calendarEvents(list = US_RELEASES) {
  const out = [];
  for (const e of list) {
    let utc = null;
    try { utc = nyToUtc(e.date, e.time); } catch { utc = null; }
    if (!utc) continue;
    out.push({
      id: e.id,
      kind: e.kind,
      label: KINDS[e.kind] || e.kind,
      reference: e.reference,
      status: e.status,
      startsAtUtc: utc.iso,
      startsAtMs: utc.ms,
      confirmed: e.status !== STATUS.A_CONFIRMAR,
      note: e.nota || null,
    });
  }
  return out.sort((a, b) => a.startsAtMs - b.startsAtMs);
}

/** Só o que pode disparar alerta / marcar sobreposição: 'confirmada' e 'oficial'. */
export function alertableEvents(list = US_RELEASES) {
  return calendarEvents(list).filter((e) => e.confirmed);
}

/**
 * Quanto da lista ainda está no futuro. `expired` = nada confirmado à frente;
 * `warn` = a última data confirmada está a menos de COVERAGE_WARN_DAYS.
 */
export function calendarCoverage(list = US_RELEASES, nowMs = Date.now(), warnDays = COVERAGE_WARN_DAYS) {
  const future = alertableEvents(list).filter((e) => e.startsAtMs > nowMs);
  if (!future.length) return { expired: true, warn: true, lastConfirmedUtc: null, daysLeft: 0, futureConfirmed: 0 };
  const last = future[future.length - 1];
  const daysLeft = Math.floor((last.startsAtMs - nowMs) / 86400000);
  return { expired: false, warn: daysLeft < warnDays, lastConfirmedUtc: last.startsAtUtc, daysLeft, futureConfirmed: future.length };
}

/**
 * Linha para a tabela da sonda (grupo `us-calendar`, alternativa ao BLS bloqueado).
 * OK só se a lista é válida E ainda há data confirmada à frente.
 */
export function staticCalendarProbeResult(list = US_RELEASES, nowMs = Date.now()) {
  const base = { id: 'calendario-fixo', name: 'Calendário fixo no repositório (CPI e Payroll)', required: true, group: 'us-calendar', url: null, httpStatus: null, latencyMs: null, bytes: null, rateLimit: '' };
  const problems = validateCalendar(list);
  if (problems.length) return { ...base, status: 'FALHOU', detail: `lista inválida: ${problems.slice(0, 3).join('; ')}` };
  const cov = calendarCoverage(list, nowMs);
  if (cov.expired) return { ...base, status: 'FALHOU', detail: 'lista vencida: nenhuma data confirmada à frente — atualizar' };
  const pending = list.filter((e) => e.status === STATUS.A_CONFIRMAR).length;
  const oficiais = list.filter((e) => e.status === STATUS.OFICIAL).length;
  const terceiros = list.filter((e) => e.status === STATUS.CONFIRMADA).length;
  const aviso = cov.warn ? ` — ATENÇÃO: só ${cov.daysLeft} dia(s) de cobertura, atualizar` : '';
  return { ...base, status: 'OK', detail: `${cov.futureConfirmed} data(s) confirmada(s) à frente (até ${cov.lastConfirmedUtc.slice(0, 10)}); ${oficiais} oficial(is) (BLS/FRED), ${terceiros} de terceiros, ${pending} a confirmar; conferida em ${CALENDAR_CHECKED_AT}${aviso}` };
}

/**
 * Compara as datas que uma fonte externa (financecalendar.com, FRED) devolveu com a
 * lista fixa, para um tipo (CPI ou NFP). Só informa — nenhuma data da lista muda sozinha.
 * - bate        : data da lista que a fonte também traz
 * - ausenteNaFonte : data da lista que a fonte NÃO traz (dentro da janela da lista)
 * - soNaFonte   : data que a fonte traz dentro da janela da lista e a lista não tem
 * A janela é [primeira data da lista do tipo, última]: fora dela a lista não tem opinião.
 * @param {'CPI'|'NFP'} kind
 * @param {string[]} dates  AAAA-MM-DD
 */
export function compareWithFixedList(kind, dates, list = US_RELEASES) {
  const mine = list.filter((e) => e.kind === kind).map((e) => e.date).sort();
  if (!mine.length) return { bate: [], ausenteNaFonte: [], soNaFonte: [], semLista: true };
  const src = new Set((dates || []).filter((d) => DATE_RE.test(d)));
  const lo = mine[0];
  const hi = mine[mine.length - 1];
  return {
    bate: mine.filter((d) => src.has(d)),
    ausenteNaFonte: mine.filter((d) => !src.has(d)),
    soNaFonte: [...src].filter((d) => d >= lo && d <= hi && !mine.includes(d)).sort(),
    semLista: false,
  };
}

/** Texto curto para o `detail` da sonda. */
export function formatComparison(cmp) {
  if (cmp.semLista) return 'sem datas desse tipo na lista fixa';
  const part = (label, arr) => `${label}: ${arr.length ? arr.join(', ') : '—'}`;
  return `vs lista fixa — ${part('bate', cmp.bate)}; ${part('ausente na fonte', cmp.ausenteNaFonte)}; ${part('só na fonte', cmp.soNaFonte)}`;
}
