// Contexto de Mercado (docs/known-risks.md item 284/285) — sonda das fontes.
// Responde, com teste REAL feito a partir do servidor do GitHub: "a fonte
// responde, no formato que o coletor espera, sem bloqueio nem limite?".
// A CLI é scripts/context-probe.mjs; este módulo é a parte testável (a rede é
// injetada, então os testes simulam resposta boa, página de erro com status 200,
// 429, bloqueio por região, arquivo cortado e timeout).
//
// Só LEITURA e só dados públicos: 1 requisição por fonte, `User-Agent`
// identificado, nenhum segredo obrigatório, nenhum banco, nenhum Telegram.
// O que a sonda NÃO prova: estabilidade por semanas (isso é a coleta "sombra"
// da Fase 2) nem os termos de uso — esses estão em docs/known-risks.md item 284.

import { compareWithFixedList, formatComparison } from './contextCalendar.mjs';
import { nyToUtc } from './contextTime.mjs';

export const USER_AGENT = 'SentinelSignals-ContextProbe/1.0 (+https://github.com/mateusraony/Sentinel-Signals)';

// Só ASCII imprimível (0x21-0x7E): o fetch rejeita cabeçalho com não-Latin/controle, o que derrubaria toda requisição.
const EMAIL_RE = /^(?=[\x21-\x7E]+$)[^@;()<>]+@[^@;()<>]+\.[^@;()<>]+$/;

/**
 * Contato do robô (item 286). A política de uso do BLS pede que robôs informem um
 * contato; sem ele o site responde 403 (visto nas 2 execuções reais de 28-29/10).
 * O e-mail vem do segredo `CONTEXT_CONTACT_EMAIL` (dedicado, escolhido pelo usuário),
 * só vai no cabeçalho `User-Agent` e **nunca** é impresso, gravado em arquivo ou posto
 * na URL. Valor malformado é ignorado (não derruba a sonda).
 */
export function contactEmail(env = {}) {
  const v = String(env.CONTEXT_CONTACT_EMAIL ?? '').trim();
  return EMAIL_RE.test(v) ? v : null;
}

export function buildUserAgent(env = {}) {
  const email = contactEmail(env);
  return email ? `${USER_AGENT.slice(0, -1)}; contact: ${email})` : USER_AGENT;
}
export const SITE_ORIGIN = 'https://sentinel-signals.onrender.com';
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const TWO_SYMBOLS = encodeURIComponent('["BTCUSDT","ETHUSDT"]');

const tryJson = (body) => { try { return { value: JSON.parse(body) }; } catch { return { error: true }; } };
const fail = (detail) => ({ ok: false, detail });
const pass = (detail) => ({ ok: true, detail });

// --- validadores de formato: reprovam página de erro devolvida com status 200 ---

export function validateIcs({ body }) {
  const text = body.trim();
  if (!text.startsWith('BEGIN:VCALENDAR')) return fail('não é um calendário .ics (não começa com BEGIN:VCALENDAR)');
  if (!text.endsWith('END:VCALENDAR')) return fail('calendário .ics cortado (não termina com END:VCALENDAR)');
  const events = (text.match(/BEGIN:VEVENT/g) || []).length;
  if (events === 0) return fail('calendário .ics sem nenhum evento');
  return pass(`${events} eventos`);
}

export function validateFearGreed({ body }) {
  const j = tryJson(body);
  if (j.error) return fail('resposta não é JSON');
  const row = j.value?.data?.[0];
  const value = Number(row?.value);
  if (!row || !Number.isFinite(value) || value < 0 || value > 100) return fail('sem data[0].value entre 0 e 100');
  if (!row.timestamp) return fail('sem data[0].timestamp');
  return pass(`índice ${value} (${row.value_classification || 'sem classificação'})`);
}

export function validateRss({ body }) {
  const text = body.trim();
  if (!/^<\?xml|^<rss|^<feed/i.test(text)) return fail('não é XML/RSS');
  if (!/<\/rss>\s*$|<\/feed>\s*$/i.test(text)) return fail('RSS cortado (sem fechamento)');
  const items = (text.match(/<item[\s>]|<entry[\s>]/gi) || []).length;
  if (items === 0) return fail('RSS sem nenhum item');
  return pass(`${items} itens`);
}

export function validateBinanceTicker({ body }) {
  const j = tryJson(body);
  if (j.error) return fail('resposta não é JSON');
  if (!Array.isArray(j.value) || j.value.length !== 2) return fail('esperado array com BTCUSDT e ETHUSDT');
  const bad = j.value.find((r) => typeof r?.symbol !== 'string' || !(Number(r.price) > 0));
  if (bad) return fail('item sem symbol/price válidos');
  return pass(j.value.map((r) => `${r.symbol} ${Number(r.price).toFixed(2)}`).join(' · '));
}

export function validateRawGithubCors({ headers }) {
  const allow = headers['access-control-allow-origin'];
  if (!allow) return fail('sem cabeçalho Access-Control-Allow-Origin (o navegador bloquearia a leitura)');
  if (allow !== '*' && allow !== SITE_ORIGIN) return fail(`CORS não libera o site (permitido: ${allow})`);
  const cache = headers['cache-control'] || 'sem cache-control';
  return pass(`CORS ${allow}; ${cache}`);
}

export function validateCoingeckoPing({ body }) {
  const j = tryJson(body);
  if (j.error || !j.value?.gecko_says) return fail('sem gecko_says');
  return pass(String(j.value.gecko_says));
}

export function validateCoingeckoGlobal({ body }) {
  const j = tryJson(body);
  if (j.error || !j.value?.data?.total_market_cap) return fail('sem data.total_market_cap');
  const dom = j.value.data.market_cap_percentage?.btc;
  return pass(`dominância BTC ${Number.isFinite(dom) ? dom.toFixed(1) : '?'}%`);
}

export function validateDefillamaChains({ body }) {
  const j = tryJson(body);
  if (j.error || !Array.isArray(j.value)) return fail('esperado uma lista de redes');
  const eth = j.value.find((c) => c?.name === 'Ethereum');
  if (!eth || !(Number(eth.tvl) > 0)) return fail('sem a rede Ethereum com TVL positivo');
  return pass(`${j.value.length} redes; Ethereum TVL ${(Number(eth.tvl) / 1e9).toFixed(1)} bi`);
}

export function validateMempoolFees({ body }) {
  const j = tryJson(body);
  if (j.error || !(Number(j.value?.fastestFee) > 0)) return fail('sem fastestFee');
  return pass(`taxa rápida ${j.value.fastestFee} sat/vB`);
}

export function validateHtmlContains(...needles) {
  return ({ body }) => {
    const missing = needles.filter((n) => !body.includes(n));
    return missing.length ? fail(`página sem: ${missing.join(', ')}`) : pass('página esperada');
  };
}

export function validateBinanceAnnouncements({ body }) {
  const j = tryJson(body);
  if (j.error || j.value?.success !== true) return fail('sem success=true');
  return pass('resposta do CMS da Binance');
}

/** Todas as datas AAAA-MM-DD que aparecem em strings de um JSON (sem repetir, em ordem). */
export function collectIsoDates(value, limit = 5000) {
  const found = new Set();
  let visited = 0;
  const walk = (v, depth) => {
    if (visited++ > limit || depth > 8) return;
    if (typeof v === 'string') {
      // Limite por dígito (não \b): '2026-12-04T08:30' tem letra colada na data e \b não casaria.
      const m = v.match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g);
      if (m) for (const d of m) found.add(d);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(value, 0);
  return [...found].sort();
}

/**
 * financecalendar.com (terceiros, sem chave; limite 2.000/dia, zera 00:00 UTC — visto nos
 * cabeçalhos da 1ª execução real). Lê as datas só de `events`.
 * @param {'CPI'|'NFP'} kind
 */
export function validateFinanceCalendar(kind) {
  return ({ body }) => {
    const j = tryJson(body);
    if (j.error) return fail('resposta não é JSON');
    // Formato visto na 1ª execução real (29/10, run 5): { from, to, count, total, events, attribution }.
    // As datas vêm SÓ de `events` — `from`/`to` são a janela da consulta e viravam falsa divergência.
    const events = j.value?.events;
    if (!Array.isArray(events)) return fail('sem a lista events');
    const dates = collectIsoDates(events);
    if (!dates.length) return fail('events sem nenhuma data AAAA-MM-DD');
    const janela = j.value.from && j.value.to ? `janela ${String(j.value.from).slice(0, 10)} a ${String(j.value.to).slice(0, 10)}` : 'janela —';
    return pass(`${events.length} evento(s) de ${j.value.total ?? '?'} (${janela}); ${dates.length} data(s); ${formatComparison(compareWithFixedList(kind, dates))}`);
  };
}

/** FRED: confirma que o release_id é o esperado pelo NOME (não confio num id que não vi na doc). */
export function validateFredRelease(expectedName) {
  return ({ body }) => {
    const j = tryJson(body);
    if (j.error) return fail('resposta não é JSON');
    const row = j.value?.releases?.[0] ?? j.value?.release;
    const name = String(row?.name ?? '');
    if (!name) return fail('sem releases[0].name');
    if (!name.includes(expectedName)) return fail(`release "${name}" (esperado conter "${expectedName}")`);
    return pass(`release: ${name}`);
  };
}

/** FRED: datas de divulgação (inclui futuras com include_release_dates_with_no_data=true). */
export function validateFredDates(kind) {
  return ({ body, nowMs }) => {
    const j = tryJson(body);
    if (j.error) return fail('resposta não é JSON');
    const rows = j.value?.release_dates;
    if (!Array.isArray(rows) || !rows.length) return fail('sem release_dates');
    const dates = collectIsoDates(rows.map((r) => r?.date));
    if (!dates.length) return fail('release_dates sem datas');
    // PPI/PCE não estão na lista fixa: o que interessa é ver as próximas datas.
    const today = Number.isFinite(nowMs) ? new Date(nowMs).toISOString().slice(0, 10) : null;
    const next = today ? dates.filter((d) => d >= today).slice(0, 3) : [];
    const proximas = today ? `; próximas: ${next.length ? next.join(', ') : 'nenhuma publicada ainda'}` : '';
    return pass(`${dates.length} data(s) (${dates[0]} a ${dates[dates.length - 1]})${proximas}; ${formatComparison(compareWithFixedList(kind, dates))}`);
  };
}

/** `last_updated` do FRED vem como "AAAA-MM-DD HH:MM:SS-05" (fuso de St. Louis). */
export function parseFredTimestamp(text) {
  const m = String(text ?? '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2})$/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3]}:00`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * FRED: quando a série foi atualizada (metadado — nenhum valor da série é lido nem impresso;
 * os termos do FRED não permitem repassar os dados). Mede a DEMORA do FRED em relação à
 * divulgação oficial (08:30 de Nova York do mesmo dia): é o que decide se o número oficial
 * chega a tempo do aviso de "depois do evento" (item 285, addendum 5).
 * @param {string} seriesId
 * @param {string} releaseTimeNy hora oficial da divulgação em Nova York
 */
export function validateFredSeriesMeta(seriesId, releaseTimeNy = '08:30') {
  return ({ body }) => {
    const j = tryJson(body);
    if (j.error) return fail('resposta não é JSON');
    const row = j.value?.seriess?.[0];
    if (!row || row.id !== seriesId) return fail(`sem seriess[0] com id ${seriesId}`);
    const updatedMs = parseFredTimestamp(row.last_updated);
    if (updatedMs == null) return fail(`last_updated em formato inesperado: "${row.last_updated ?? ''}"`);
    const updatedIso = new Date(updatedMs).toISOString().slice(0, 16).replace('T', ' ');
    const day = String(row.last_updated).slice(0, 10);
    let demora = 'demora: —';
    try {
      const minutes = Math.round((updatedMs - nyToUtc(day, releaseTimeNy).ms) / 60000);
      if (minutes >= 0 && minutes < 24 * 60) demora = `${minutes} min depois das ${releaseTimeNy} de Nova York`;
      else demora = `atualizada fora do dia/horário da divulgação (${minutes} min)`;
    } catch { /* data inválida: fica "—" */ }
    return pass(`${seriesId}: última atualização ${updatedIso} UTC (${demora}); última observação ${row.observation_end ?? '—'}`);
  };
}

const HOUR_MS = 60 * 60 * 1000;
const HOURS_PER_YEAR = 365 * 24; // cripto negocia o ano todo

/**
 * Deribit DVOL (volatilidade implícita de 30 dias, anualizada, em %): base do "movimento
 * esperado" do aviso de evento. Faixa de 1 desvio para h horas = DVOL × √(h / 8760).
 * Formato esperado: result.data = [[timestamp, abertura, máxima, mínima, fechamento], ...].
 */
export function validateDeribitDvol(currency) {
  return ({ body, nowMs }) => {
    const j = tryJson(body);
    if (j.error) return fail('resposta não é JSON');
    if (j.value?.error) return fail(`erro da Deribit: ${j.value.error.message ?? JSON.stringify(j.value.error)}`);
    const rows = j.value?.result?.data;
    if (!Array.isArray(rows) || !rows.length) return fail('sem result.data');
    const last = rows[rows.length - 1];
    const ts = Number(last?.[0]);
    const close = Number(last?.[4]);
    if (!Number.isFinite(ts) || !Number.isFinite(close)) return fail('última linha sem [timestamp, …, fechamento] numéricos');
    if (close < 5 || close > 400) return fail(`DVOL ${close} fora da faixa plausível (5 a 400)`);
    if (Number.isFinite(nowMs) && nowMs - ts > 3 * HOUR_MS) return fail(`último valor velho (${new Date(ts).toISOString()})`);
    const band = (h) => (close * Math.sqrt(h / HOURS_PER_YEAR)).toFixed(2);
    return pass(`DVOL ${currency} ${close.toFixed(1)} (${new Date(ts).toISOString().slice(0, 16)} UTC, ${rows.length} vela(s)); faixa de 1 desvio: ±${band(1)}% em 1h, ±${band(4)}% em 4h, ±${band(24)}% em 24h`);
  };
}

/** .ics válido E com pelo menos um evento cujo texto contém `needle` (ex.: o PCE no calendário do BEA). */
export function validateIcsWith(needle) {
  return (res) => {
    const base = validateIcs(res);
    if (!base.ok) return base;
    const n = res.body.split('BEGIN:VEVENT').slice(1).filter((ev) => ev.includes(needle)).length;
    if (!n) return fail(`nenhum evento com "${needle}"`);
    return pass(`${base.detail}; ${n} com "${needle}"`);
  };
}

const FRED_BASE = 'https://api.stlouisfed.org/fred';
const FRED_KEY_PLACEHOLDER = '<FRED_API_KEY>';
const DERIBIT_DVOL = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const dvolUrl = (currency) => (nowMs) => `${DERIBIT_DVOL}?currency=${currency}&resolution=3600&start_timestamp=${nowMs - 6 * HOUR_MS}&end_timestamp=${nowMs}`;

const BLS_HINT = 'a política do BLS pede um contato do robô (segredo CONTEXT_CONTACT_EMAIL)';

/**
 * `required` entra no gate da fase. Fontes com o mesmo `group` são alternativas:
 * basta UMA do grupo responder bem (ex.: duas URLs candidatas do RSS do Fed).
 */
export const SOURCES = Object.freeze([
  // Calendário dos EUA (CPI, emprego, PPI). O BLS bloqueou o robô sem contato (403) nas 2 execuções
  // reais de 28-29/10: agora o identificador leva o e-mail dedicado e há 3 caminhos oficiais — basta UM.
  { id: 'bls-calendar', name: 'BLS — calendário .ics (CPI, emprego, PPI)', url: 'https://www.bls.gov/schedule/news_release/bls.ics', required: true, group: 'us-calendar', blockHint: BLS_HINT, validate: validateIcs },
  { id: 'bls-cpi-page', name: 'BLS — página de datas do CPI', url: 'https://www.bls.gov/schedule/news_release/cpi.htm', required: true, group: 'us-calendar', blockHint: BLS_HINT, validate: validateHtmlContains('Consumer Price Index') },
  { id: 'bls-empsit-page', name: 'BLS — página de datas do Emprego (payroll)', url: 'https://www.bls.gov/schedule/news_release/empsit.htm', required: true, group: 'us-calendar', blockHint: BLS_HINT, validate: validateHtmlContains('Employment Situation') },
  { id: 'alternative-me-fng', name: 'Alternative.me — Medo e Ganância', url: 'https://api.alternative.me/fng/?limit=1', required: true, validate: validateFearGreed },
  { id: 'fed-rss-press-all', name: 'Federal Reserve — RSS comunicados (todos)', url: 'https://www.federalreserve.gov/feeds/press_all.xml', required: true, group: 'fed-rss', validate: validateRss },
  { id: 'fed-rss-press-other', name: 'Federal Reserve — RSS comunicados (outros)', url: 'https://www.federalreserve.gov/feeds/press_other.xml', required: true, group: 'fed-rss', validate: validateRss },
  { id: 'binance-spot-api', name: 'Binance Spot — api.binance.com', url: `https://api.binance.com/api/v3/ticker/price?symbols=${TWO_SYMBOLS}`, required: true, group: 'binance-spot', validate: validateBinanceTicker },
  { id: 'binance-spot-vision', name: 'Binance Spot — data-api.binance.vision', url: `https://data-api.binance.vision/api/v3/ticker/price?symbols=${TWO_SYMBOLS}`, required: true, group: 'binance-spot', validate: validateBinanceTicker },
  {
    id: 'raw-github-cors', name: 'GitHub raw — CORS e cache (como o site vai ler)',
    url: 'https://raw.githubusercontent.com/mateusraony/Sentinel-Signals/main/README.md',
    headers: { Origin: SITE_ORIGIN }, required: true,
    validate: ({ status, body, headers }) => {
      if (!body.includes('Sentinel Signals')) return fail('arquivo inesperado');
      return validateRawGithubCors({ status, body, headers });
    },
  },
  { id: 'coingecko-ping', name: 'CoinGecko — ping (sem chave)', url: 'https://api.coingecko.com/api/v3/ping', required: false, validate: validateCoingeckoPing },
  { id: 'coingecko-global', name: 'CoinGecko — /global (precisa de chave Demo)', url: 'https://api.coingecko.com/api/v3/global', required: false, needsEnv: 'COINGECKO_API_KEY', headerFromEnv: { 'x-cg-demo-api-key': 'COINGECKO_API_KEY' }, validate: validateCoingeckoGlobal },
  { id: 'defillama-chains', name: 'DefiLlama — TVL por rede (/v2/chains)', url: 'https://api.llama.fi/v2/chains', required: false, validate: validateDefillamaChains },
  { id: 'mempool-fees', name: 'mempool.space — taxas Bitcoin', url: 'https://mempool.space/api/v1/fees/recommended', required: false, validate: validateMempoolFees },
  { id: 'fomc-calendar-page', name: 'Federal Reserve — página do calendário FOMC', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', required: false, validate: validateHtmlContains('FOMC', '2026') },
  // Opcionais (item 285, addendum 3): alternativas ao BLS bloqueado. Fora do portão da fase.
  // financecalendar.com: terceiros, sem chave; formato ainda desconhecido (validador tolerante).
  { id: 'financecalendar-cpi', name: 'financecalendar.com — datas do CPI (terceiros)', url: 'https://www.financecalendar.com/wp-json/fc/v1/calendar?series=cpi', required: false, validate: validateFinanceCalendar('CPI') },
  { id: 'financecalendar-nfp', name: 'financecalendar.com — datas do Payroll (terceiros)', url: 'https://www.financecalendar.com/wp-json/fc/v1/calendar?series=nfp', required: false, validate: validateFinanceCalendar('NFP') },
  // FRED (Fed de St. Louis, oficial, chave grátis). A chave vai na URL: o resultado mostra só o molde.
  { id: 'fred-release-cpi', name: 'FRED — release 10 é o CPI? (confere o nome)', url: `${FRED_BASE}/release?release_id=10&file_type=json&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredRelease('Consumer Price Index') },
  { id: 'fred-dates-cpi', name: 'FRED — datas do CPI (oficial)', url: `${FRED_BASE}/release/dates?release_id=10&file_type=json&include_release_dates_with_no_data=true&sort_order=desc&limit=20&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredDates('CPI') },
  { id: 'fred-release-nfp', name: 'FRED — release 50 é o Emprego? (confere o nome)', url: `${FRED_BASE}/release?release_id=50&file_type=json&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredRelease('Employment Situation') },
  { id: 'fred-dates-nfp', name: 'FRED — datas do Payroll (oficial)', url: `${FRED_BASE}/release/dates?release_id=50&file_type=json&include_release_dates_with_no_data=true&sort_order=desc&limit=20&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredDates('NFP') },
  // Rodada 8 (30/10, item 285 addendum 5): PPI e PCE também ganham aviso; o "movimento esperado" vem da
  // Deribit; a demora do FRED decide se o número oficial chega a tempo. Todas opcionais (fora do portão).
  { id: 'fred-release-ppi', name: 'FRED — release 46 é o PPI? (confere o nome)', url: `${FRED_BASE}/release?release_id=46&file_type=json&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredRelease('Producer Price Index') },
  { id: 'fred-dates-ppi', name: 'FRED — datas do PPI (oficial)', url: `${FRED_BASE}/release/dates?release_id=46&file_type=json&include_release_dates_with_no_data=true&sort_order=desc&limit=20&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredDates('PPI') },
  { id: 'fred-release-pce', name: 'FRED — release 54 é o PCE (Renda e Gastos Pessoais)? (confere o nome)', url: `${FRED_BASE}/release?release_id=54&file_type=json&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredRelease('Personal Income and Outlays') },
  { id: 'fred-dates-pce', name: 'FRED — datas do PCE (oficial)', url: `${FRED_BASE}/release/dates?release_id=54&file_type=json&include_release_dates_with_no_data=true&sort_order=desc&limit=20&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredDates('PCE') },
  // Demora do FRED: só o metadado `last_updated` de uma série de cada divulgação (nenhum valor).
  { id: 'fred-lag-nfp', name: 'FRED — demora no Payroll (PAYEMS, só metadado)', url: `${FRED_BASE}/series?series_id=PAYEMS&file_type=json&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredSeriesMeta('PAYEMS') },
  { id: 'fred-lag-cpi', name: 'FRED — demora no CPI (CPIAUCSL, só metadado)', url: `${FRED_BASE}/series?series_id=CPIAUCSL&file_type=json&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredSeriesMeta('CPIAUCSL') },
  { id: 'fred-lag-ppi', name: 'FRED — demora no PPI (PPIFIS, só metadado)', url: `${FRED_BASE}/series?series_id=PPIFIS&file_type=json&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredSeriesMeta('PPIFIS') },
  { id: 'fred-lag-pce', name: 'FRED — demora no PCE (PCEPI, só metadado)', url: `${FRED_BASE}/series?series_id=PCEPI&file_type=json&api_key=${FRED_KEY_PLACEHOLDER}`, required: false, needsEnv: 'FRED_API_KEY', secretInUrl: 'FRED_API_KEY', validate: validateFredSeriesMeta('PCEPI') },
  // Deribit DVOL (pública, sem chave). A janela depende da hora da execução: `urlAt` monta a URL real;
  // `url` é o molde que aparece na tabela.
  { id: 'deribit-dvol-btc', name: 'Deribit — DVOL do BTC (movimento esperado)', url: `${DERIBIT_DVOL}?currency=BTC&resolution=3600&start_timestamp=<agora-6h>&end_timestamp=<agora>`, urlAt: dvolUrl('BTC'), required: false, validate: validateDeribitDvol('BTC') },
  { id: 'deribit-dvol-eth', name: 'Deribit — DVOL do ETH (movimento esperado)', url: `${DERIBIT_DVOL}?currency=ETH&resolution=3600&start_timestamp=<agora-6h>&end_timestamp=<agora>`, urlAt: dvolUrl('ETH'), required: false, validate: validateDeribitDvol('ETH') },
  // BEA (dono do PCE): calendário oficial. O endereço do .ics vem de páginas antigas do BEA — a sonda confirma.
  { id: 'bea-calendar', name: 'BEA — calendário .ics (PCE)', url: 'https://www.bea.gov/newsreleases/general/iCal/bea_news_releases.ics', required: false, validate: validateIcsWith('Personal Income') },
  { id: 'bea-schedule-page', name: 'BEA — página do calendário de divulgações', url: 'https://www.bea.gov/news/schedule', required: false, validate: validateHtmlContains('Personal Income and Outlays') },
  { id: 'binance-announcements', name: 'Binance — anúncios (delisting; esperado bloqueio)', url: 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=161&pageNo=1&pageSize=5', required: false, validate: validateBinanceAnnouncements },
]);

const BLOCKED = new Set([403, 451]);

/** Cabeçalhos que dizem algo sobre limite de uso (para a tabela). */
export function extractRateLimit(headers) {
  const parts = [];
  for (const [k, v] of Object.entries(headers)) {
    if (/ratelimit|retry-after|x-mbx-used|x-cg-/i.test(k)) parts.push(`${k}=${v}`);
  }
  return parts.join('; ');
}

/**
 * Avalia UMA resposta já recebida. Não faz rede.
 * @returns {{ status: 'OK'|'FALHOU', detail: string }}
 */
export function evaluateResponse(source, { status, headers = {}, body = '', nowMs = undefined }) {
  if (status === 429) {
    const retry = headers['retry-after'] ? ` (Retry-After ${headers['retry-after']}s)` : '';
    return { status: 'FALHOU', detail: `limite de uso excedido (HTTP 429)${retry}` };
  }
  if (BLOCKED.has(status)) {
    const hint = source.blockHint ? ` — ${source.blockHint}` : '';
    return { status: 'FALHOU', detail: `acesso bloqueado desta origem (HTTP ${status})${hint}` };
  }
  if (status < 200 || status >= 300) return { status: 'FALHOU', detail: `HTTP ${status}` };
  const v = source.validate({ status, headers, body, nowMs });
  return { status: v.ok ? 'OK' : 'FALHOU', detail: v.ok ? v.detail : `formato inválido: ${v.detail}` };
}

/**
 * Faz a requisição e avalia. `fetchImpl` e `now` são injetáveis (testes).
 * Nunca lança: qualquer erro de rede vira uma linha FALHOU.
 */
export async function probeSource(source, { fetchImpl = fetch, now = Date.now, timeoutMs = 15000, env = {} } = {}) {
  const base = { id: source.id, name: source.name, required: !!source.required, group: source.group || null, url: source.url };

  if (source.needsEnv && !env[source.needsEnv]) {
    return { ...base, status: 'PULADO', httpStatus: null, latencyMs: null, bytes: null, rateLimit: '', detail: `sem ${source.needsEnv} (opcional)` };
  }

  const headers = { 'User-Agent': buildUserAgent(env), Accept: '*/*', ...(source.headers || {}) };
  for (const [header, envName] of Object.entries(source.headerFromEnv || {})) headers[header] = env[envName];

  // Chave na URL (FRED): a URL real só existe aqui, na hora do fetch. `base.url` (que vai para a tabela
  // e para o JSON do artifact) é sempre o molde SEM a chave, e o detail é limpo por `scrub` abaixo.
  const secret = source.secretInUrl ? String(env[source.secretInUrl] ?? '') : '';
  const startMs = now();
  // Janela que depende da hora (Deribit): a URL real é montada agora; `base.url` segue o molde.
  const rawUrl = typeof source.urlAt === 'function' ? source.urlAt(startMs) : source.url;
  const fetchUrl = secret ? rawUrl.replace(`<${source.secretInUrl}>`, encodeURIComponent(secret)) : rawUrl;
  const scrub = (r) => {
    if (!secret) return r;
    const clean = (t) => (typeof t === 'string' ? t.split(secret).join('***').split(encodeURIComponent(secret)).join('***') : t);
    return { ...r, detail: clean(r.detail) };
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = startMs;
  try {
    const res = await fetchImpl(fetchUrl, { headers, signal: controller.signal, redirect: 'follow' });
    const text = await res.text();
    const latencyMs = now() - t0;
    const bytes = Buffer.byteLength(text, 'utf8');
    const resHeaders = {};
    res.headers.forEach((v, k) => { resHeaders[k.toLowerCase()] = v; });
    if (bytes > MAX_BODY_BYTES) {
      return scrub({ ...base, status: 'FALHOU', httpStatus: res.status, latencyMs, bytes, rateLimit: extractRateLimit(resHeaders), detail: `resposta grande demais (${bytes} bytes)` });
    }
    const ev = evaluateResponse(source, { status: res.status, headers: resHeaders, body: text, nowMs: startMs });
    return scrub({ ...base, ...ev, httpStatus: res.status, latencyMs, bytes, rateLimit: extractRateLimit(resHeaders) });
  } catch (err) {
    const latencyMs = now() - t0;
    const aborted = err?.name === 'AbortError';
    const cause = err?.cause?.code || err?.cause?.message || err?.message || String(err);
    return scrub({ ...base, status: 'FALHOU', httpStatus: null, latencyMs, bytes: null, rateLimit: '', detail: aborted ? `sem resposta em ${timeoutMs / 1000}s (timeout)` : `erro de rede: ${cause}` });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gate da fase: toda fonte obrigatória sem grupo precisa estar OK; todo grupo
 * obrigatório precisa de pelo menos UMA fonte OK.
 */
export function summarize(results) {
  const required = results.filter((r) => r.required);
  const failed = [];
  for (const r of required.filter((x) => !x.group)) if (r.status !== 'OK') failed.push(r.id);
  const groups = [...new Set(required.filter((x) => x.group).map((x) => x.group))];
  for (const g of groups) {
    const members = required.filter((x) => x.group === g);
    if (!members.some((m) => m.status === 'OK')) failed.push(`${g} (nenhuma alternativa respondeu)`);
  }
  const optionalFailed = results.filter((r) => !r.required && r.status === 'FALHOU').map((r) => r.id);
  return { gateOk: failed.length === 0, failedRequired: failed, optionalFailed };
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** Tabela em markdown para o resumo do job. */
export function formatProbeMarkdown(results, { startedAt = null, runner = null, contactConfigured = null } = {}) {
  const sum = summarize(results);
  const lines = [];
  lines.push('## Sonda das fontes do Contexto de Mercado');
  if (startedAt) lines.push(`Executada em ${startedAt} (UTC)${runner ? ` — ${runner}` : ''}.`);
  if (contactConfigured !== null) lines.push(`Contato do robô no identificador: ${contactConfigured ? 'informado (e-mail do segredo, não exibido)' : 'NÃO informado'}.`);
  lines.push('');
  lines.push('| Fonte | Tipo | Resultado | HTTP | Tempo | Bytes | Detalhe | Sinais de limite |');
  lines.push('|---|---|---|---:|---:|---:|---|---|');
  for (const r of results) {
    const tipo = r.required ? (r.group ? `obrigatória (alternativa ${r.group})` : 'obrigatória') : 'opcional';
    lines.push(`| ${cell(r.name)} | ${tipo} | ${r.status} | ${r.httpStatus ?? '—'} | ${r.latencyMs == null ? '—' : `${r.latencyMs} ms`} | ${r.bytes ?? '—'} | ${cell(r.detail)} | ${cell(r.rateLimit) || '—'} |`);
  }
  lines.push('');
  lines.push(sum.gateOk
    ? '**Resultado do portão: APROVADO** — todas as fontes obrigatórias responderam no formato esperado.'
    : `**Resultado do portão: REPROVADO** — falharam: ${sum.failedRequired.join(', ')}.`);
  if (sum.optionalFailed.length) lines.push(`Opcionais que falharam (só informativo): ${sum.optionalFailed.join(', ')}.`);
  lines.push('');
  lines.push('Uma execução não prova estabilidade: o critério da fase é 3 execuções em horários diferentes.');
  return lines.join('\n');
}
