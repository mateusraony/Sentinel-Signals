// Baixa os dados do laboratório de padrões — docs/known-risks.md item 266.
// Só roda no runner do GitHub Actions (a rede das sessões do Claude Code
// bloqueia a Binance). Fonte: data.binance.vision (arquivo público, grátis).
//
// O que baixa, por símbolo (Futures USDⓈ-M), sempre dentro de
// [dataStart, dataEnd) LIDO DO PRÉ-REGISTRO — nunca de argumento, para o
// período lacrado (holdout) nem chegar ao runner:
//   - klines 4h COM o volume agressor de compra (fluxo);
//   - premiumIndexKlines 4h (prêmio/basis);
//   - fundingRate;
//   - metrics diários (linhas de 5 em 5 min: contratos em aberto e
//     proporções de comprados/vendidos), reduzidos à grade de 4h já aqui.
// Meses inteiros antes do mês final vêm do arquivo mensal; o mês final vem
// dia a dia, só até o dia anterior a dataEnd.
//
// Uso:
//   node scripts/fetch-pattern-lab-data.mjs [--prereg docs/experiments/pattern-lab-prereg.json] [--out lab-data]
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fetchWithRetry } from '../src/lib/httpRetry.js';
import {
  buildMonthlyUrl,
  buildDailyUrl,
  buildMonthlyFundingUrl,
  buildDailyFundingUrl,
  daysInMonthRange,
  monthsInRange,
  parseKlineCsv,
  parseFundingCsv,
  dedupeAndFilterFunding,
  assertArchiveSizeWithinLimit,
} from './binanceArchive.js';
import {
  buildMonthlyPremiumUrl,
  buildDailyPremiumUrl,
  buildDailyMetricsUrl,
  parseFlowKlineCsv,
  parseMetricsCsv,
  buildLabBars,
} from './patternLabArchive.js';
import { writeJsonAtomic } from './writeJsonAtomic.mjs';

const CONCURRENCY = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

function extractCsv(buffer) {
  const entry = new AdmZip(buffer).getEntries().find((e) => e.entryName.toLowerCase().endsWith('.csv'));
  if (!entry) throw new Error('ZIP sem arquivo .csv');
  return entry.getData().toString('utf-8');
}

async function download(url, context) {
  const res = await fetchWithRetry(url, { context });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Binance archive (${res.status}) em ${context}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  assertArchiveSizeWithinLimit(buffer.length, context);
  return extractCsv(buffer);
}

// Pool simples de concorrência: no máximo `limit` downloads ao mesmo tempo.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Lista de arquivos: mensais para os meses inteiros antes do mês de
// (dataEnd − 1 ms); diários para os dias do mês final antes de dataEnd.
function archivePlan(fromMs, toMs) {
  const lastMonth = new Date(toMs - 1);
  const ly = lastMonth.getUTCFullYear();
  const lm = lastMonth.getUTCMonth() + 1;
  const monthly = [];
  const daily = [];
  for (const { year, month } of monthsInRange(fromMs, toMs - 1)) {
    if (year === ly && month === lm) {
      for (const day of daysInMonthRange(year, month, fromMs, toMs)) daily.push({ year, month, day });
    } else {
      monthly.push({ year, month });
    }
  }
  return { monthly, daily };
}

async function fetchSeries(label, plan, monthlyUrl, dailyUrl, parse) {
  const jobs = [
    ...plan.monthly.map((m) => ({ url: monthlyUrl(m), ctx: `${label} ${m.year}-${m.month}` })),
    ...plan.daily.map((d) => ({ url: dailyUrl(d), ctx: `${label} ${d.year}-${d.month}-${d.day}` })),
  ];
  const texts = await mapPool(jobs, CONCURRENCY, (j) => download(j.url, j.ctx));
  return texts.filter(Boolean).flatMap(parse);
}

async function fetchSymbol(symbol, prereg) {
  const barMs = prereg.barMinutes * 60 * 1000;
  const fromMs = Date.parse(`${prereg.dataStart}T00:00:00Z`);
  const toMs = Date.parse(`${prereg.dataEnd}T00:00:00Z`);
  const plan = archivePlan(fromMs, toMs);
  const interval = '4h';

  const klines = await fetchSeries(`${symbol} klines`, plan,
    (m) => buildMonthlyUrl(symbol, interval, m.year, m.month),
    (d) => buildDailyUrl(symbol, interval, d.year, d.month, d.day),
    parseFlowKlineCsv);
  const premium = await fetchSeries(`${symbol} premium`, plan,
    (m) => buildMonthlyPremiumUrl(symbol, interval, m.year, m.month),
    (d) => buildDailyPremiumUrl(symbol, interval, d.year, d.month, d.day),
    parseKlineCsv);
  const funding = dedupeAndFilterFunding(await fetchSeries(`${symbol} funding`, plan,
    (m) => buildMonthlyFundingUrl(symbol, m.year, m.month),
    (d) => buildDailyFundingUrl(symbol, d.year, d.month, d.day),
    parseFundingCsv), fromMs - DAY_MS, toMs);

  // metrics só a partir da 1ª vela que existe (evita milhares de 404 antes
  // da listagem do par).
  const firstOpen = klines.length ? Math.min(...klines.map((k) => k.openTime)) : toMs;
  const metricsFrom = Math.max(fromMs, firstOpen - (firstOpen % DAY_MS));
  const days = [];
  for (let t = metricsFrom; t < toMs; t += DAY_MS) {
    const d = new Date(t);
    days.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  }
  let metricsDaysMissing = 0;
  const metricsTexts = await mapPool(days, CONCURRENCY, async (d) => {
    const text = await download(buildDailyMetricsUrl(symbol, d.year, d.month, d.day), `${symbol} metrics ${d.year}-${d.month}-${d.day}`);
    if (!text) metricsDaysMissing += 1;
    return text;
  });
  const metricsRows = metricsTexts.filter(Boolean).flatMap(parseMetricsCsv);

  const bars = buildLabBars({
    klines, premium, funding, metricsRows, barMs,
    dataStartMs: fromMs, dataEndMs: toMs,
    maxRowLagMs: prereg.metrics.maxRowLagMinutes * 60 * 1000,
    maxStaleMs: prereg.metrics.maxStaleMinutes * 60 * 1000,
  });
  const coverage = {
    bars: bars.length,
    firstBar: bars.length ? new Date(bars[0].t).toISOString() : null,
    lastBar: bars.length ? new Date(bars[bars.length - 1].t).toISOString() : null,
    withPremium: bars.filter((b) => b.premium != null).length,
    withFunding: bars.filter((b) => b.fundingPerHour != null).length,
    withMetrics: bars.filter((b) => b.openInterest != null).length,
    metricsDaysRequested: days.length,
    metricsDaysMissing,
  };
  return { symbol, coverage, bars };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preregPath = args.prereg || path.join('docs', 'experiments', 'pattern-lab-prereg.json');
  const prereg = JSON.parse(fs.readFileSync(preregPath, 'utf8'));
  const outDir = args.out || 'lab-data';
  fs.mkdirSync(outDir, { recursive: true });
  for (const symbol of prereg.symbols) {
    console.log(`[pattern-lab] ${symbol}: baixando ${prereg.dataStart} → ${prereg.dataEnd} (fim exclusivo, pré-registrado)...`);
    const result = await fetchSymbol(symbol, prereg);
    writeJsonAtomic(path.join(outDir, `${symbol}_lab.json`), result);
    console.log(`[pattern-lab] ${symbol}: ${JSON.stringify(result.coverage)}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('fetch-pattern-lab-data.mjs')) {
  main().catch((err) => {
    console.error('[pattern-lab] FALHOU:', err);
    process.exitCode = 1;
  });
}

export { archivePlan, fetchSymbol };
