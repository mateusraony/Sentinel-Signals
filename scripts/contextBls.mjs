// Contexto de Mercado — Fase 4a: o valor "Anterior" dos números oficiais (docs/known-risks.md item 285, addendum 14).
//
// Fonte: API pública do BLS (domínio público, com pedido de citação → o painel mostra "Fonte: BLS"). Lê só o histórico mensal
// de 3 indicadores e CALCULA o que foi divulgado da vez anterior:
//   CPI e PPI : variação no mês (série com ajuste sazonal) e em 12 meses (série SEM ajuste, a que a imprensa cita);
//   Payroll   : variação do mês, em milhares de vagas.
// O "Anterior" de um evento é o período que vem ANTES do `reference` dele (CPI de 10/11 mede outubro → Anterior = setembro).
//
// Regras de honestidade:
//   - dado faltando ("-", mês ausente, série inexistente) → a parte do número SOME; nunca se preenche nem se estima;
//   - número fora de uma faixa plausível (série errada, dado corrompido) → some também;
//   - nada de previsão: só o que o BLS já divulgou.
//
// Busca: com a chave (v2, 500 consultas/dia) e, se o BLS a recusar ou não responder, a versão pública sem chave (v1, 25 consultas/dia,
// por endereço compartilhado — por isso a chave é o caminho seguro). Falha → `null` SEM mensagem (uma mensagem pode citar a URL com a chave).
// Módulo puro + `fetch` injetável. Sem banco, sem Telegram, sem motor.
import { buildUserAgent, MAX_BODY_BYTES } from './contextProbe.mjs';

export const BLS_SOURCE = 'BLS';
export const BLS_V1 = 'https://api.bls.gov/publicAPI/v1/timeseries/data';
export const BLS_V2 = 'https://api.bls.gov/publicAPI/v2/timeseries/data';

/** Séries por tipo de evento. `month`/`year`/`jobs` dizem para que cada uma serve. */
export const BLS_SERIES = Object.freeze({
  CPI: Object.freeze({ month: 'CUSR0000SA0', year: 'CUUR0000SA0' }),
  PPI: Object.freeze({ month: 'WPSFD4', year: 'WPUFD4' }),
  NFP: Object.freeze({ jobs: 'CES0000000001' }),
});

export const allSeriesIds = () => [...new Set(Object.values(BLS_SERIES).flatMap((o) => Object.values(o)))];

// Faixas plausíveis: fora delas o número é descartado (série errada ou dado corrompido não vira "Anterior").
const MAX_ABS_MONTH_PCT = 5;
const MAX_ABS_YEAR_PCT = 30;
const MAX_ABS_JOBS_THOUSANDS = 3000;

const PCT = '[+-]?\\d{1,2},\\d%';
/**
 * Formato ÚNICO do texto do "Anterior" (o produtor e a trava do conteúdo público usam o MESMO regex):
 *   "+0,3% m/m" · "+3,0% a/a" · "+0,3% m/m · +3,0% a/a" · "+119 mil" · "-92 mil".
 */
export const PREVIOUS_TEXT_RE = new RegExp(`^(?:${PCT} m/m(?: · ${PCT} a/a)?|${PCT} a/a|[+-]?\\d{1,3}(?:\\.\\d{3})? mil)$`);

const PERIOD_RE = /^M(0[1-9]|1[0-2])$/;

/**
 * Motivos (lista FECHADA) de um mês que o BLS marcou com "-" (nunca publicado). O texto da nota do BLS nunca é guardado nem publicado: só estes códigos.
 *  - 'paralisacao_2025': a nota cita a paralisação do governo dos EUA em 2025 (outubro de 2025 não foi coletado nem será);
 *  - 'nao_divulgado': qualquer outro "-".
 */
export const GAP_REASONS = Object.freeze(['paralisacao_2025', 'nao_divulgado']);
function gapReason(footnotes) {
  const texto = Array.isArray(footnotes) ? footnotes.map((f) => String(f?.text ?? '')).join(' ') : '';
  return /lapse in appropriations|shutdown/i.test(texto) ? 'paralisacao_2025' : 'nao_divulgado';
}

/**
 * Lê a resposta do BLS (v1 e v2 têm o mesmo formato).
 * @returns {{ values: Map<string, number>|null, reason: 'ok'|'key_rejected'|'limit'|'format'|'no_data', gaps?: Map<string, string>|null }}
 *   `values`: 'AAAA-MM' → valor; só meses (M01–M12), valor numérico. `gaps` (só nos ramos "ok" e "sem dados"): 'AAAA-MM' → motivo (`GAP_REASONS`)
 *   para a linha "-" (mês NUNCA publicado pelo BLS); null se não há nenhuma. Valor corrompido ("1,5") e a média anual (M13) não são lacuna.
 */
export function parseBlsSeries(body, seriesId) {
  let j;
  try { j = JSON.parse(body ?? ''); } catch { return { values: null, reason: 'format' }; }
  if (!j || typeof j !== 'object') return { values: null, reason: 'format' };
  if (j.status !== 'REQUEST_SUCCEEDED') {
    const msgs = Array.isArray(j.message) ? j.message.map(String).join(' ') : '';
    if (/key/i.test(msgs) && /invalid|not valid|expired/i.test(msgs)) return { values: null, reason: 'key_rejected' };
    if (/threshold|limit/i.test(msgs)) return { values: null, reason: 'limit' };
    return { values: null, reason: 'format' };
  }
  const series = Array.isArray(j?.Results?.series) ? j.Results.series.find((s) => s?.seriesID === seriesId) : null;
  if (!series || !Array.isArray(series.data)) return { values: null, reason: 'format' };
  const values = new Map();
  const gaps = new Map();
  for (const d of series.data) {
    if (!d || !/^\d{4}$/.test(String(d.year ?? '')) || !PERIOD_RE.test(String(d.period ?? ''))) continue;
    const ym = `${d.year}-${String(d.period).slice(1)}`;
    // O BLS usa ponto decimal e nenhum separador de milhar: "1,5" não é número aqui (viraria 15 em silêncio). "-" = mês NUNCA publicado (lacuna).
    const raw = String(d.value ?? '').trim();
    if (raw === '-') {
      if (!gaps.has(ym)) gaps.set(ym, gapReason(d.footnotes));
      continue;
    }
    const num = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(num)) continue;
    if (!values.has(ym)) values.set(ym, num);
  }
  for (const ym of values.keys()) gaps.delete(ym); // resposta incoerente (valor E "-" no mesmo mês): o valor vence
  const lacunas = gaps.size ? gaps : null;
  return values.size ? { values, reason: 'ok', gaps: lacunas } : { values: null, reason: 'no_data', gaps: lacunas };
}

// A "janela alternativa" (addendum 22): quando o mês-base do "em 12 meses" é uma lacuna OFICIAL, a variação entre o 1º mês publicado depois dela e o mês do
// evento (11 meses). Formato fechado e auto-contido: "+3,5% de 2025-11 a 2026-10" (o sinal é obrigatório, menos no zero).
const ALT_PCT = '(?:[+-]\\d{1,2},\\d|0,0)%';
const ALT_YM = '\\d{4}-(?:0[1-9]|1[0-2])';
export const ALT_TEXT_RE = new RegExp(`^${ALT_PCT} de (${ALT_YM}) a (${ALT_YM})$`);

/** 'AAAA-MM' deslocado `delta` meses. */
export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

const pctChange = (now, before) => (Number.isFinite(now) && Number.isFinite(before) && before > 0 ? (now / before - 1) * 100 : null);

/** "+0,3%" / "-0,1%" / "0,0%": 1 casa, vírgula, arredonda meio para longe do zero, sem "-0,0%". */
export function formatPct(x) {
  // 6 casas antes do arredondamento final: 100 → 100,25 dá 0,24999999999998 em ponto flutuante e viraria "+0,2%" em vez de "+0,3%".
  const x6 = Math.round(x * 1e6) / 1e6;
  const r = (Math.sign(x6) * Math.round(Math.abs(x6) * 10)) / 10;
  if (r === 0) return '0,0%';
  return `${r > 0 ? '+' : '-'}${Math.abs(r).toFixed(1).replace('.', ',')}%`;
}

/** Variação de vagas em milhares: "+119 mil", "-92 mil", "+1.234 mil". */
export function formatJobs(thousands) {
  const r = Math.round(thousands);
  if (r === 0) return '0 mil';
  return `${r > 0 ? '+' : '-'}${String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} mil`;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * O texto do número de UM mês (variação no mês e em 12 meses; Payroll: vagas do mês), ou null se faltar dado ou se o valor sair
 * da faixa de plausibilidade. Base do "Anterior" (mês anterior ao que o evento mede) e do "Atual" (o próprio mês).
 */
function monthValueText(kind, seriesById, period) {
  const spec = BLS_SERIES[kind];
  if (!spec || !MONTH_RE.test(period ?? '')) return null;

  if (kind === 'NFP') {
    const s = seriesById?.[spec.jobs];
    const change = s ? s.get(period) - s.get(shiftMonth(period, -1)) : NaN;
    if (!Number.isFinite(change) || Math.abs(change) > MAX_ABS_JOBS_THOUSANDS) return null;
    return formatJobs(change);
  }

  const m = seriesById?.[spec.month];
  const y = seriesById?.[spec.year];
  const mom = m ? pctChange(m.get(period), m.get(shiftMonth(period, -1))) : null;
  const yoy = y ? pctChange(y.get(period), y.get(shiftMonth(period, -12))) : null;
  const parts = [];
  if (mom !== null && Math.abs(mom) <= MAX_ABS_MONTH_PCT) parts.push(`${formatPct(mom)} m/m`);
  if (yoy !== null && Math.abs(yoy) <= MAX_ABS_YEAR_PCT) parts.push(`${formatPct(yoy)} a/a`);
  const text = parts.join(' · ');
  return PREVIOUS_TEXT_RE.test(text) ? text : null;
}

/**
 * O texto do "Anterior" de um evento, ou null se não dá para calcular com segurança.
 * @param {string} kind 'CPI' | 'PPI' | 'NFP'
 * @param {Record<string, Map<string, number>|null>} seriesById séries lidas, por código
 * @param {string|null} reference mês que o evento mede ('AAAA-MM'); sem ele não há "Anterior"
 */
export function previousValueText(kind, seriesById, reference) {
  if (!MONTH_RE.test(reference ?? '')) return null;
  return monthValueText(kind, seriesById, shiftMonth(reference, -1));
}

/**
 * O texto do "Atual" de um evento: o número do PRÓPRIO mês que ele mede. Fica null enquanto o BLS não publicou aquele mês
 * (antes da divulgação a série termina no mês anterior, então nunca há "Atual" falso).
 */
export function actualValueText(kind, seriesById, reference) {
  if (!MONTH_RE.test(reference ?? '')) return null;
  const text = monthValueText(kind, seriesById, reference);
  if (text === null) return null;
  // O "Atual" congela no primeiro instante em que aparece. CPI/PPI usam DUAS séries (no mês e em 12 meses) e só valem quando AS DUAS já trazem o mês
  // de referência: metade publicada (uma das duas ainda sem o mês) espera a próxima coleta em vez de congelar pela metade.
  // A regra anterior exigia o texto "completo" (' · '), o que travava o CPI de 10/11/2026 para sempre: as duas séries já traziam outubro, mas a de
  // 12 meses não tem a base (outubro de 2025 não foi publicado), então o "em 12 meses" é impossível. Parte que não dá para calcular fica de fora do
  // texto (nunca se estima) e a tela a marca como "indisponível" (addendum 19).
  if (kind !== 'NFP') {
    const spec = BLS_SERIES[kind];
    if (!seriesById?.[spec.month]?.has(reference) || !seriesById?.[spec.year]?.has(reference)) return null;
  }
  return text;
}

/** Quantos meses de `a` até `b` (ambos 'AAAA-MM'); negativo se `b` vem antes. */
export function monthsBetween(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb * 12 + mb) - (ya * 12 + ma);
}

/** A janela alternativa é coerente? Formato fechado E de 2 a 11 meses (12 seria o número oficial, que não é "alternativo"). */
export function isValidAltText(text) {
  const m = typeof text === 'string' ? ALT_TEXT_RE.exec(text) : null;
  if (!m) return false;
  const n = monthsBetween(m[1], m[2]);
  return n >= 2 && n <= 11;
}

/**
 * A explicação do "em 12 meses" que NÃO existe (addendum 22): quando o mês que o evento mede já foi publicado, mas o mês-base (12 meses antes) é uma
 * LACUNA OFICIAL registrada (o BLS nunca o publicou), devolve `{ gap }` (o motivo, de `GAP_REASONS`) e, se o 1º mês publicado depois da lacuna existe,
 * `alt` (a variação até o mês do evento). Falta de dado SEM registro de lacuna não vale (não se afirma o que não se sabe); nunca se estima nem interpola.
 * @param {string} kind 'CPI' | 'PPI' | 'NFP' @param {Record<string, Map<string, number>|null>} seriesById
 * @param {Record<string, Map<string, string>|null>} gapsById lacunas oficiais por série (mês → motivo)
 * @returns {{ gap: string, alt?: string }|null}
 */
export function gapNoteValues(kind, seriesById, gapsById, reference) {
  const spec = BLS_SERIES[kind];
  if (!spec?.year || !MONTH_RE.test(reference ?? '')) return null;
  const yoy = seriesById?.[spec.year];
  const gaps = gapsById?.[spec.year];
  if (!(yoy instanceof Map) || !(gaps instanceof Map)) return null;
  const base = shiftMonth(reference, -12);
  if (!yoy.has(reference) || yoy.has(base)) return null;
  const reason = gaps.get(base);
  if (!GAP_REASONS.includes(reason)) return null;
  const out = { gap: reason };
  const start = shiftMonth(base, 1);
  const pct = pctChange(yoy.get(reference), yoy.get(start));
  if (pct !== null && Math.abs(pct) <= MAX_ABS_YEAR_PCT) {
    const text = `${formatPct(pct)} de ${start} a ${reference}`;
    if (isValidAltText(text)) out.alt = text;
  }
  return out;
}

/** O objeto público `values` de um evento ainda NÃO divulgado: `{ previous, source }` ou null. */
export function previousValues(kind, seriesById, reference) {
  const previous = previousValueText(kind, seriesById, reference);
  return previous ? { previous, source: BLS_SOURCE } : null;
}

async function getOne(url, seriesId, fetchImpl, env, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': buildUserAgent(env), Accept: 'application/json' }, signal: controller.signal });
    const text = await res.text();
    if (!(res.status >= 200 && res.status < 300) || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { values: null, reason: 'format' };
    return parseBlsSeries(text, seriesId);
  } catch {
    return { values: null, reason: 'format' }; // rede/tempo: sem mensagem (poderia citar a URL com a chave)
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Busca as séries. Com a chave tenta a v2 primeiro; se o BLS a RECUSA, para de tentar a chave nesta passada (não gasta
 * consulta à toa) e usa a v1 sem chave. A chave só existe na URL da requisição e NUNCA aparece no resultado.
 * @returns {Promise<{ series: Record<string, Map<string, number>|null>, gaps: Record<string, Map<string, string>|null>, tally: { v2: number, v1: number, failed: number },
 *   keyPresent: boolean, keyRejected: boolean, limitHit: boolean }>} `gaps`: as lacunas oficiais ("-") por série, só com o código do motivo.
 */
export async function fetchBlsSeries({ fetchImpl = fetch, env = {}, timeoutMs = 15000, ids = allSeriesIds() } = {}) {
  const key = String(env.BLS_API_KEY ?? '').trim();
  const series = {};
  const gaps = {};
  const tally = { v2: 0, v1: 0, failed: 0 };
  let keyRejected = false;
  let limitHit = false;
  for (const id of ids) {
    series[id] = null;
    gaps[id] = null;
    let lacunasV2 = null; // resposta da v2 só com "-" (sem nenhum número) ainda traz lacunas oficiais: não se perdem na queda para a v1
    if (key && !keyRejected) {
      const r = await getOne(`${BLS_V2}/${id}?registrationkey=${encodeURIComponent(key)}`, id, fetchImpl, env, timeoutMs);
      if (r.values) { series[id] = r.values; gaps[id] = r.gaps ?? null; tally.v2 += 1; continue; }
      lacunasV2 = r.gaps ?? null;
      if (r.reason === 'key_rejected') keyRejected = true;
      if (r.reason === 'limit') limitHit = true;
    }
    const r1 = await getOne(`${BLS_V1}/${id}`, id, fetchImpl, env, timeoutMs);
    gaps[id] = r1.gaps ?? lacunasV2; // as lacunas valem mesmo quando a resposta não tem número algum
    if (r1.values) { series[id] = r1.values; tally.v1 += 1; } else {
      tally.failed += 1;
      if (r1.reason === 'limit') limitHit = true;
    }
  }
  return { series, gaps, tally, keyPresent: key !== '', keyRejected, limitHit };
}
