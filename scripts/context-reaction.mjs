#!/usr/bin/env node
// Contexto de Mercado — Agenda 4d, etapa 1 (docs/known-risks.md item 285, addendum 18). SÓ MEDE: lê as datas passadas de CPI, Payroll, PPI e PCE
// no FRED, baixa as velas de 1 min do BTC/USDT (Binance Spot, data-api.binance.vision) em volta de cada divulgação e imprime como o BTC se
// mexeu, comparado ao mesmo horário em dias úteis sem divulgação (contextReaction.mjs). Não grava arquivo no repositório, não publica nada na
// branch de dados, não manda mensagem. Lê só as DATAS do FRED (nunca valor de série: os termos do FRED proíbem guardá-los).
//
// Segredos (env): FRED_API_KEY (só na URL da requisição) e CONTEXT_CONTACT_EMAIL (só no User-Agent). Opções: --json <arquivo> grava os agregados;
// --since AAAA-MM-DD muda o início (padrão 2024-01-01). Sai com 1 se não houver dado suficiente.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FRED_RELEASES, parseFredReleaseDates } from './contextCollect.mjs';
import { buildUserAgent, MAX_BODY_BYTES } from './contextProbe.mjs';
import {
  MIN_NORMAL_DAYS, WINDOW_CANDLES, parseKlines, releaseInstants, normalDayInstants, reactionAt, summarizeGroup, compareToNormal,
  formatReport, formatEventList, toJson,
} from './contextReaction.mjs';

const KLINES_URL = 'https://data-api.binance.vision/api/v3/klines';
const FRED_DATES_URL = 'https://api.stlouisfed.org/fred/release/dates';
export const DEFAULT_SINCE = '2024-01-01';
export const NORMAL_DAYS = 90;
const CONCURRENCY = 4;
const MIN = 60 * 1000;

/** Datas passadas do FRED por tipo. A chave só existe na URL; qualquer falha vira null SEM mensagem (a mensagem poderia citar a URL). */
export async function fetchPastFredDates({ fetchImpl = fetch, env = {}, timeoutMs = 15000 } = {}) {
  const key = String(env.FRED_API_KEY ?? '');
  const out = {};
  for (const [kind, releaseId] of Object.entries(FRED_RELEASES)) {
    out[kind] = null;
    if (!key) continue;
    const url = `${FRED_DATES_URL}?release_id=${releaseId}&file_type=json&include_release_dates_with_no_data=false&sort_order=desc&limit=120&api_key=${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': buildUserAgent(env), Accept: 'application/json' }, signal: controller.signal });
      const text = await res.text();
      if (res.status >= 200 && res.status < 300 && Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES) out[kind] = parseFredReleaseDates(text);
    } catch { /* fica null */ } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/** Velas de 1 min de [t0 − 1 min, t0 + 60 min). Até 3 tentativas em 429/418/5xx e erro de rede; null se não deu. */
export async function fetchWindow(t0Ms, { fetchImpl = fetch, env = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 15000 } = {}) {
  const url = `${KLINES_URL}?symbol=BTCUSDT&interval=1m&startTime=${t0Ms - MIN}&limit=${WINDOW_CANDLES}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': buildUserAgent(env), Accept: 'application/json' }, signal: controller.signal });
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) return Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES ? parseKlines(text) : null;
      if (![418, 429].includes(res.status) && res.status < 500) return null;
    } catch { /* tenta de novo */ } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) await sleep(attempt * 1000);
  }
  return null;
}

async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function parseArgs(argv) {
  const opts = { json: null, since: DEFAULT_SINCE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') { opts.json = argv[i + 1] ?? null; i += 1; } else if (argv[i] === '--since') { opts.since = argv[i + 1] ?? ''; i += 1; }
  }
  return opts;
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, nowMs = Date.now(), log = console.log, sleep } = {}) {
  const opts = parseArgs(argv);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) { log('Data inicial inválida (use AAAA-MM-DD).'); return 1; }
  if (!String(env.FRED_API_KEY ?? '')) { log('Falta o segredo FRED_API_KEY (as datas passadas vêm do FRED).'); return 1; }

  const datesByKind = await fetchPastFredDates({ fetchImpl, env });
  if (!Object.values(datesByKind).some((d) => Array.isArray(d) && d.length)) { log('O FRED não respondeu com datas; nada foi medido.'); return 1; }

  const events = releaseInstants(datesByKind, { sinceDate: opts.since, nowMs });
  const eventDates = Object.values(datesByKind).flatMap((d) => (Array.isArray(d) ? d : []));
  const normals = normalDayInstants({ eventDates, nowMs, count: NORMAL_DAYS });
  const fetchOpts = { fetchImpl, env, sleep };

  const measured = await pool([...events, ...normals], async (inst) => {
    const candles = await fetchWindow(inst.ms, fetchOpts);
    return { kind: inst.kind, date: inst.date, reaction: candles ? reactionAt(candles, inst.ms) : null };
  }, CONCURRENCY);

  const rowsByKind = {};
  for (const r of measured.filter((m) => m.kind !== 'NORMAL')) (rowsByKind[r.kind] ??= []).push({ date: r.date, reaction: r.reaction });
  const normal = summarizeGroup(measured.filter((m) => m.kind === 'NORMAL'));
  const perKind = {};
  for (const [kind, rows] of Object.entries(rowsByKind)) {
    const group = summarizeGroup(rows);
    perKind[kind] = { group, vsNormal: compareToNormal(group, normal) };
  }

  const withData = Object.values(perKind).reduce((s, k) => s + k.group.n, 0);
  if (withData === 0 || normal.n < MIN_NORMAL_DAYS) {
    log(`Dado insuficiente: ${withData} divulgação(ões) e ${normal.n} dia(s) normal(is) com velas completas (mínimo ${MIN_NORMAL_DAYS} dias normais). Nada concluído.`);
    return 1;
  }

  const result = { perKind, normal, generatedAtMs: nowMs, sinceDate: opts.since };
  log(formatReport(result));
  log(formatEventList(rowsByKind));
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(toJson(result), null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
