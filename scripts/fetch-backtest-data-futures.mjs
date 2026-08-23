// Baixa histórico REAL de candles Futures (USDⓈ-M perpétuo) da Binance via
// data.binance.vision (arquivo em lote/CDN estático) para uso pelo motor de
// backtest local (scripts/run-backtest.mjs) — alternativa a
// scripts/fetch-backtest-data.mjs, que usa Spot (data-api.binance.vision).
//
// docs/known-risks.md item 4: o scan AO VIVO (cron 24/7) usa Spot porque a
// API de trading Futures (fapi.binance.com) bloqueia IP de datacenter dos
// EUA — isso não muda aqui. item 86: o arquivo HISTÓRICO em lote
// (data.binance.vision, CDN CloudFront/S3) é um serviço diferente, não
// sujeito ao mesmo bloqueio — confirmado acessível a partir de runners do
// GitHub Actions. item 122: pedido explícito do usuário (opera Futures/
// Perpétuo de verdade no TradingView) para fazer o BACKTEST medir o mesmo
// mercado que ele realmente opera, em vez de Spot.
//
// Mesma interface de scripts/fetch-backtest-data.mjs (mesmo formato de saída
// — um JSON por símbolo/timeframe, lido por scripts/backtestMarketDataProvider.js
// sem nenhuma mudança), só troca DE ONDE o dado vem e COMO é baixado (arquivo
// ZIP em vez de API REST — ver scripts/binanceArchive.js para o parsing).
//
// Uso:
//   node scripts/fetch-backtest-data-futures.mjs --symbols BTCUSDT,ETHUSDT \
//     --from 2025-01-01 --to 2026-01-01 \
//     [--timeframes 1h,4h,1d,15m] [--out scripts/__fixtures__/backtest]
//
// SÓ roda na máquina do usuário ou no runner do GitHub Actions
// (.github/workflows/backtest.yml) — a rede das sessões do Claude Code
// bloqueia a Binance (mesma restrição de scripts/fetch-backtest-data.mjs).
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fetchWithRetry } from '../src/lib/httpRetry.js';
import {
  buildMonthlyUrl,
  buildDailyUrl,
  monthsInRange,
  daysInMonthRange,
  parseKlineCsv,
  dedupeAndFilterCandles,
} from './binanceArchive.js';

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

// Extrai o CSV de dentro do ZIP baixado — o arquivo da Binance contém
// exatamente 1 entrada de dado (o `.CHECKSUM` correspondente é um download
// SEPARADO, nunca vem dentro do próprio ZIP), mas seleciona por extensão
// em vez de assumir "entrada 0" por segurança.
function extractCsvFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.csv'));
  if (!entry) throw new Error('ZIP não contém nenhum arquivo .csv');
  return entry.getData().toString('utf-8');
}

// Um 404 no arquivo MENSAL é esperado (mês corrente/recente ainda não foi
// consolidado) e aciona o fallback diário — não é erro transitório, não
// entra no retry. fetchWithRetry já trata 429/5xx/falha de rede.
async function downloadArchive(url, contexto) {
  const res = await fetchWithRetry(url, { context: contexto });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Binance archive error (${res.status}) em ${contexto}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchFuturesArchive(symbol, interval, fromMs, toMs) {
  const all = [];
  for (const { year, month } of monthsInRange(fromMs, toMs)) {
    const monthlyUrl = buildMonthlyUrl(symbol, interval, year, month);
    const monthlyBuf = await downloadArchive(monthlyUrl, `${symbol} ${interval} ${year}-${String(month).padStart(2, '0')} (mensal)`);
    if (monthlyBuf) {
      all.push(...parseKlineCsv(extractCsvFromZip(monthlyBuf)));
      continue;
    }
    // Mês sem arquivo mensal publicado ainda — tenta dia a dia.
    console.log(`[fetch-backtest-data-futures] ${symbol} ${interval} ${year}-${String(month).padStart(2, '0')}: sem arquivo mensal, tentando diário...`);
    for (const day of daysInMonthRange(year, month, fromMs, toMs)) {
      const dailyUrl = buildDailyUrl(symbol, interval, year, month, day);
      const dailyBuf = await downloadArchive(
        dailyUrl,
        `${symbol} ${interval} ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} (diário)`
      );
      if (dailyBuf) all.push(...parseKlineCsv(extractCsvFromZip(dailyBuf)));
      // Um dia realmente sem arquivo (símbolo listado depois dessa data, ou
      // dia sem pregão publicado) é esperado no início/fim da cobertura de
      // um símbolo — não é falha do download, só ausência real de dado.
    }
  }
  return dedupeAndFilterCandles(all, fromMs, toMs, Date.now());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.symbols || !args.from || !args.to) {
    console.error('Uso: fetch-backtest-data-futures.mjs --symbols SYM1,SYM2 --from DATA --to DATA [--timeframes 1h,4h,1d,15m] [--out DIR]');
    process.exitCode = 1;
    return;
  }

  const symbols = String(args.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const timeframes = String(args.timeframes || '1h,4h,1d,15m').split(',').map((s) => s.trim()).filter(Boolean);
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
    for (const tf of timeframes) {
      console.log(`[fetch-backtest-data-futures] ${symbol} ${tf}: baixando ${args.from} → ${args.to} (Futures USDⓈ-M)...`);
      const candles = await fetchFuturesArchive(symbol, tf, fromMs, toMs);
      const outFile = path.join(outDir, `${symbol}_${tf}.json`);
      fs.writeFileSync(outFile, JSON.stringify(candles));
      console.log(`[fetch-backtest-data-futures] ${symbol} ${tf}: ${candles.length} candles → ${outFile}`);
    }
  }
}

main().catch((err) => {
  console.error('[fetch-backtest-data-futures] FALHOU:', err);
  process.exitCode = 1;
});
