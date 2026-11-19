// Contexto de Mercado — o "Anterior" e o "Atual" OFICIAIS do PCE, pela API da BEA (docs/known-risks.md item 285, addendum 33).
//
// Fonte: API pública da BEA (Bureau of Economic Analysis, governo dos EUA: domínio público, como o BLS → o painel diz "Fonte: BEA").
// Tabelas confirmadas pela sonda real de 19/11/2026 (addendum 32):
//   T20807 — variação de preços do PCE contra o mês anterior (%, 1 casa): é o número "no mês" que a BEA divulga;
//   T20804 — índice de preços do PCE (nível): o "em 12 meses" = índice do mês ÷ índice do mesmo mês do ano anterior − 1.
// Duas medidas, sempre lado a lado (o TradingView tem as duas linhas): o PCE CHEIO (linha "Personal consumption expenditures (PCE)")
// e o NÚCLEO (linha "PCE excluding food and energy" — NUNCA o "Market-based PCE excluding food and energy", que é outra série; achado
// do Codex no PR #588). As linhas são achadas pelo NOME, não pelo número (a BEA pode renumerar).
//
// Regras de honestidade (as mesmas do BLS, `contextBls.mjs`):
//   - dado faltando ou nome de linha ambíguo → a parte do número SOME; nunca se preenche nem se estima;
//   - número fora de uma faixa plausível → some também;
//   - nada de previsão: só o que a BEA já divulgou.
// A chave (UserID) só existe na URL da requisição; falha → `null` SEM mensagem (uma mensagem poderia citar a URL com a chave). A resposta da
// BEA ECOA o UserID em `BEAAPI.Request`: este módulo nunca lê esse campo. Módulo puro + `fetch` injetável. Sem banco, sem Telegram, sem motor.
import { buildUserAgent, MAX_BODY_BYTES } from './contextProbe.mjs';
import { formatPct, shiftMonth, PREVIOUS_TEXT_RE } from './contextBls.mjs';

export const BEA_SOURCE = 'BEA';
export const BEA_API = 'https://apps.bea.gov/api/data';
export const BEA_TABLES = Object.freeze({ mom: 'T20807', index: 'T20804' });

/** As duas medidas e como reconhecer a linha de cada uma pelo nome. */
const MEASURES = Object.freeze({
  headline: (d) => /^personal consumption expenditures \(pce\)$/i.test(d),
  core: (d) => /excluding food and energy/i.test(d) && !/market-based/i.test(d),
});

const MAX_ABS_MONTH_PCT = 5;
const MAX_ABS_YEAR_PCT = 30;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERIOD_RE = /^(\d{4})M(0[1-9]|1[0-2])$/;
// Número da BEA: ponto decimal; vírgula SÓ como separador de milhar ("1,234.5"). "1,5" não é número aqui (viraria 15 em silêncio).
const NUM_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/**
 * Lê UMA tabela mensal da BEA. Devolve, por medida (`headline`/`core`), um Map 'AAAA-MM' → número; ou `null` se o corpo não serve.
 * Linha cujo nome aparece em mais de uma série (código diferente) é AMBÍGUA e fica de fora (não se escolhe uma no chute).
 * @returns {{ headline: Map<string, number>|null, core: Map<string, number>|null }|null}
 */
export function parseBeaTable(body, tableName) {
  let j;
  try { j = JSON.parse(body ?? ''); } catch { return null; }
  const results = j?.BEAAPI?.Results;
  if (!results || results.Error || j?.BEAAPI?.Error) return null;
  const rows = Array.isArray(results.Data) ? results.Data : null;
  if (!rows) return null;
  const out = {};
  for (const [key, matches] of Object.entries(MEASURES)) {
    const mine = rows.filter((r) => r?.TableName === tableName && matches(String(r?.LineDescription ?? '').trim()));
    const codes = new Set(mine.map((r) => String(r?.SeriesCode ?? '')));
    if (!mine.length || codes.size !== 1) { out[key] = null; continue; }
    const values = new Map();
    for (const r of mine) {
      const m = PERIOD_RE.exec(String(r?.TimePeriod ?? ''));
      const raw = String(r?.DataValue ?? '').trim();
      if (!m || !NUM_RE.test(raw)) continue;
      const ym = `${m[1]}-${m[2]}`;
      if (!values.has(ym)) values.set(ym, Number(raw.replace(/,/g, '')));
    }
    out[key] = values.size ? values : null;
  }
  return out.headline || out.core ? out : null;
}

/**
 * O texto de UMA medida num mês: "+0,5% m/m · +2,8% a/a" (só a parte calculável; nunca estimada). `null` se nada der.
 * @param {Map<string, number>|null} mom variação no mês (T20807) @param {Map<string, number>|null} index índice (T20804)
 */
export function beaMonthText(mom, index, ym) {
  if (!MONTH_RE.test(ym ?? '')) return null;
  const parts = [];
  const m = mom?.get(ym);
  if (Number.isFinite(m) && Math.abs(m) <= MAX_ABS_MONTH_PCT) parts.push(`${formatPct(m)} m/m`);
  const now = index?.get(ym);
  const before = index?.get(shiftMonth(ym, -12));
  if (Number.isFinite(now) && Number.isFinite(before) && before > 0) {
    const yoy = (now / before - 1) * 100;
    if (Math.abs(yoy) <= MAX_ABS_YEAR_PCT) parts.push(`${formatPct(yoy)} a/a`);
  }
  const text = parts.join(' · ');
  return text && PREVIOUS_TEXT_RE.test(text) ? text : null;
}

const measureText = (series, key, ym) => beaMonthText(series?.mom?.[key] ?? null, series?.index?.[key] ?? null, ym);

/**
 * O "Anterior" de um evento do PCE: o mês ANTES do que ele mede, nas duas medidas. `{ previous?, core_previous?, source: 'BEA' }` ou null.
 * @param {{ mom: object|null, index: object|null }|null} series a saída de `fetchBeaPce().series`
 */
export function beaPreviousValues(series, reference) {
  if (!MONTH_RE.test(reference ?? '')) return null;
  const ym = shiftMonth(reference, -1);
  const previous = measureText(series, 'headline', ym);
  const core = measureText(series, 'core', ym);
  if (!previous && !core) return null;
  return { ...(previous ? { previous } : {}), ...(core ? { core_previous: core } : {}), source: BEA_SOURCE };
}

/**
 * O "Atual" de um evento do PCE: o PRÓPRIO mês que ele mede. Só vale quando a BEA já traz esse mês nas DUAS tabelas para o PCE cheio
 * (antes da divulgação as tabelas terminam no mês anterior: nunca há "Atual" falso; metade publicada espera a próxima coleta em vez de
 * congelar pela metade). `{ actual, core_actual? }` ou null.
 */
export function beaActualValues(series, reference) {
  if (!MONTH_RE.test(reference ?? '')) return null;
  if (!series?.mom?.headline?.has(reference) || !series?.index?.headline?.has(reference)) return null;
  const actual = measureText(series, 'headline', reference);
  if (!actual) return null;
  const core = measureText(series, 'core', reference);
  return { actual, ...(core ? { core_actual: core } : {}) };
}

/**
 * Anos pedidos à BEA: os 3 últimos (o "em 12 meses" de janeiro precisa do janeiro do ano anterior). `withCurrent: false` (2ª tentativa) deixa o ano corrente de fora:
 * de 1º de janeiro até o fim de fevereiro a BEA ainda não tem nenhum valor do ano novo, e um pedido com um ano sem dado pode ser recusado inteiro (achado da
 * revisão independente de 19/11; o comportamento real nunca foi observado, por isso a tentativa de reserva).
 */
export function beaYears(nowMs, { withCurrent = true } = {}) {
  const y = new Date(nowMs).getUTCFullYear();
  return withCurrent ? `${y - 2},${y - 1},${y}` : `${y - 2},${y - 1}`;
}

async function getTable(table, key, years, fetchImpl, env, timeoutMs) {
  const url = `${BEA_API}?UserID=${encodeURIComponent(key)}&method=GetData&DataSetName=NIPA&TableName=${table}&Frequency=M&Year=${years}&ResultFormat=JSON`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': buildUserAgent(env), Accept: 'application/json' }, signal: controller.signal });
    const text = await res.text();
    if (!(res.status >= 200 && res.status < 300) || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return null;
    return parseBeaTable(text, table);
  } catch {
    return null; // rede/tempo: sem mensagem (poderia citar a URL com a chave)
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Busca as 2 tabelas do PCE. Sem o segredo `BEA_API_KEY` não faz nenhuma requisição. A chave só existe na URL da requisição e NUNCA aparece
 * no resultado. Nunca lança.
 * @returns {Promise<{ series: { mom: object|null, index: object|null }|null, keyPresent: boolean, read: number }>} `read`: quantas das 2 tabelas vieram.
 */
export async function fetchBeaPce({ fetchImpl = fetch, env = {}, nowMs = Date.now(), timeoutMs = 20000 } = {}) {
  const key = String(env.BEA_API_KEY ?? '').trim();
  if (!key) return { series: null, keyPresent: false, read: 0 };
  const ask = async (years) => ({
    mom: await getTable(BEA_TABLES.mom, key, years, fetchImpl, env, timeoutMs),
    index: await getTable(BEA_TABLES.index, key, years, fetchImpl, env, timeoutMs),
  });
  let { mom, index } = await ask(beaYears(nowMs));
  if (!mom && !index) ({ mom, index } = await ask(beaYears(nowMs, { withCurrent: false }))); // 2ª tentativa sem o ano corrente (ver `beaYears`)
  const read = (mom ? 1 : 0) + (index ? 1 : 0);
  return { series: read ? { mom, index } : null, keyPresent: true, read };
}

/** A linha do resumo do coletor sobre a BEA: só contagens (nunca a chave, a URL nem texto de erro). */
export function describeBea(bea) {
  if (!bea) return null;
  if (!bea.keyPresent) return 'BEA (números do PCE): sem o segredo `BEA_API_KEY` — o PCE fica sem "Anterior"/"Atual" oficiais.';
  if (bea.read === 2) return 'BEA (números do PCE): 2 de 2 tabelas lidas.';
  return `BEA (números do PCE): ${bea.read} de 2 tabelas lidas — o que já estava publicado foi mantido.`;
}
