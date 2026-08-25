// Baixa o histórico REAL de funding rate (Futures USDⓈ-M perpétuo) da Binance
// via data.binance.vision, para o motor de backtest cobrar funding com SINAL
// e por período, em vez da constante `fundingBpsPer8h: 1` de
// src/lib/tradeMetrics.js.
//
// docs/known-risks.md item 131 — por que isso importa: funding é 57,9-59% do
// custo medido (itens 44/109), o custo consome 45% do edge bruto, e num
// perpétuo funding é TRANSFERÊNCIA, não taxa: com taxa positiva (o regime
// dominante em cripto) o comprado paga e o VENDIDO RECEBE. O modelo constante
// cobrava dos dois lados igualmente — e SELL é justamente o lado medido
// positivo nas 5 janelas já rodadas neste projeto. O erro está exatamente em
// cima do único resultado consistente que o projeto encontrou.
//
// Mesma CDN e mesma mecânica de scripts/fetch-backtest-data-futures.mjs
// (arquivo mensal, fallback diário, ZIP em memória) — só muda o dataset
// (`fundingRate` em vez de `klines`) e o formato do CSV. Não substitui aquele
// script: candles e funding são downloads independentes, e o backtest roda
// normalmente sem este (cai na constante de sempre).
//
// SÓ roda na máquina do usuário ou no runner do GitHub Actions — a rede das
// sessões do Claude Code bloqueia a Binance (mesma restrição já documentada
// para fetch-backtest-data.mjs).
//
// Uso:
//   node scripts/fetch-backtest-funding.mjs --symbols BTCUSDT,ETHUSDT \
//     --from 2025-01-01 --to 2026-01-01 [--out scripts/__fixtures__/backtest]
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fetchWithRetry } from '../src/lib/httpRetry.js';
import {
  buildMonthlyFundingUrl,
  buildDailyFundingUrl,
  monthsInRange,
  daysInMonthRange,
  parseFundingCsv,
  dedupeAndFilterFunding,
  assertArchiveSizeWithinLimit,
} from './binanceArchive.js';
import { writeJsonAtomic } from './writeJsonAtomic.mjs';

export const FUNDING_FILE_SUFFIX = '_funding.json';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i++;
  }
  return args;
}

function extractCsvFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.csv'));
  if (!entry) throw new Error('ZIP não contém nenhum arquivo .csv');
  return entry.getData().toString('utf-8');
}

async function downloadArchive(url, contexto) {
  const res = await fetchWithRetry(url, { context: contexto });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Binance archive error (${res.status}) em ${contexto}: ${await res.text()}`);
  const contentLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 0) assertArchiveSizeWithinLimit(contentLength, contexto);
  const buffer = Buffer.from(await res.arrayBuffer());
  assertArchiveSizeWithinLimit(buffer.length, contexto);
  return buffer;
}

async function fetchFundingArchive(symbol, fromMs, toMs) {
  const all = [];
  for (const { year, month } of monthsInRange(fromMs, toMs)) {
    const mm = String(month).padStart(2, '0');
    const monthlyBuf = await downloadArchive(
      buildMonthlyFundingUrl(symbol, year, month),
      `${symbol} fundingRate ${year}-${mm} (mensal)`,
    );
    if (monthlyBuf) {
      all.push(...parseFundingCsv(extractCsvFromZip(monthlyBuf)));
      continue;
    }
    console.log(`[fetch-backtest-funding] ${symbol} ${year}-${mm}: sem arquivo mensal, tentando diário...`);
    for (const day of daysInMonthRange(year, month, fromMs, toMs)) {
      const dailyBuf = await downloadArchive(
        buildDailyFundingUrl(symbol, year, month, day),
        `${symbol} fundingRate ${year}-${mm}-${String(day).padStart(2, '0')} (diário)`,
      );
      if (dailyBuf) all.push(...parseFundingCsv(extractCsvFromZip(dailyBuf)));
    }
  }
  return dedupeAndFilterFunding(all, fromMs, toMs);
}

// Sanity report — a razão de existir é que este dado NÃO pode ser conferido
// visualmente depois (é um número pequeno somado sobre milhares de
// liquidações). Se o sinal médio vier trocado ou a cobertura vier furada, é
// aqui que aparece, antes de contaminar um relatório inteiro.
function summarize(symbol, rows, fromMs, toMs) {
  if (rows.length === 0) return `${symbol}: NENHUMA liquidação no período — funding real indisponível`;
  const rates = rows.map((r) => r.rate);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const positives = rates.filter((r) => r > 0).length;
  const expectedPer8h = Math.round((toMs - fromMs) / (8 * 60 * 60 * 1000));
  const coverage = expectedPer8h > 0 ? Math.round((rows.length / expectedPer8h) * 100) : 0;
  return [
    `${symbol}: ${rows.length} liquidações (~${coverage}% das ${expectedPer8h} janelas de 8h esperadas)`,
    `taxa média ${(mean * 100).toFixed(5)}% por liquidação`,
    `${Math.round((positives / rates.length) * 100)}% positivas (comprado paga)`,
  ].join(' · ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.symbols || !args.from || !args.to) {
    console.error('Uso: fetch-backtest-funding.mjs --symbols SYM1,SYM2 --from DATA --to DATA [--out DIR]');
    process.exitCode = 1;
    return;
  }

  const symbols = String(args.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const fromMs = new Date(args.from).getTime();
  const toMs = new Date(args.to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    console.error('--from/--to inválidos (precisa ser um intervalo válido, --to > --from)');
    process.exitCode = 1;
    return;
  }
  const outDir = args.out || path.join('scripts', '__fixtures__', 'backtest');
  fs.mkdirSync(outDir, { recursive: true });

  for (const symbol of symbols) {
    console.log(`[fetch-backtest-funding] ${symbol}: baixando ${args.from} → ${args.to}...`);
    const rows = await fetchFundingArchive(symbol, fromMs, toMs);
    const outFile = path.join(outDir, `${symbol}${FUNDING_FILE_SUFFIX}`);
    writeJsonAtomic(outFile, rows);
    console.log(`[fetch-backtest-funding] ${summarize(symbol, rows, fromMs, toMs)} → ${outFile}`);
  }
}

// Só executa quando chamado direto (permite importar FUNDING_FILE_SUFFIX sem
// disparar downloads).
if (process.argv[1] && process.argv[1].endsWith('fetch-backtest-funding.mjs')) {
  main().catch((err) => {
    console.error('[fetch-backtest-funding] FALHOU:', err);
    process.exitCode = 1;
  });
}
