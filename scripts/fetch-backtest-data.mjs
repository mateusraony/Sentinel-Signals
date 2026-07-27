// Baixa histórico REAL de candles da Binance Spot (data-api.binance.vision —
// a MESMA fonte que o cron 24/7 já usa, scripts/adminMarketDataProvider.js)
// para uso pelo motor de backtest local (scripts/run-backtest.mjs).
//
// SÓ roda na máquina do usuário, NUNCA nesta sessão nem no CI — a rede das
// sessões deste projeto bloqueia a Binance (mesma restrição documentada em
// .claude/rules/pine-parity.md para scripts/fetch-golden-fixture.mjs, que
// segue o mesmo padrão de paginação usado aqui).
//
// Uso:
//   node scripts/fetch-backtest-data.mjs --symbols BTCUSDT,ETHUSDT \
//     --from 2025-01-01 --to 2026-01-01 \
//     [--timeframes 1h,4h,1d,15m] [--out scripts/__fixtures__/backtest]
//
// Grava um JSON por símbolo/timeframe (array simples de candles), lido por
// scripts/backtestMarketDataProvider.js. Pagina em lotes de até 1000 candles
// (limite da API klines) avançando por startTime até cobrir o intervalo
// pedido, com uma pausa entre chamadas para não estourar rate limit.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://data-api.binance.vision/api/v3';
const MAX_LIMIT = 1000;
const PAGE_DELAY_MS = 250;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Um 429/5xx transitório não pode matar o download inteiro. Com 7 símbolos
// eram ~340 requisições; com a carteira de 20 são ~980, e o passo leva ~18 min
// — perder tudo por uma resposta ruim no meio é caro e evitável. Só erro
// transitório é retentado: 4xx que não seja 429 (símbolo inexistente, par
// deslistado, parâmetro inválido) falha na hora, como deve.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

async function fetchWithRetry(url, contexto) {
  let ultimoErro;
  for (let tentativa = 0; tentativa <= MAX_RETRIES; tentativa++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      // Falha de rede (DNS, socket) — mesma política dos 5xx.
      ultimoErro = err;
      if (tentativa === MAX_RETRIES) break;
      await sleep(PAGE_DELAY_MS * 2 ** (tentativa + 1));
      continue;
    }
    if (res.ok) return res;
    const corpo = await res.text();
    if (!RETRY_STATUSES.has(res.status) || tentativa === MAX_RETRIES) {
      throw new Error(`Binance API error (${res.status}) em ${contexto}: ${corpo}`);
    }
    ultimoErro = new Error(`Binance API error (${res.status}) em ${contexto}: ${corpo}`);
    const espera = PAGE_DELAY_MS * 2 ** (tentativa + 1);
    console.warn(`[fetch-backtest-data] ${contexto}: HTTP ${res.status}, retentando em ${espera}ms (${tentativa + 1}/${MAX_RETRIES})`);
    await sleep(espera);
  }
  throw ultimoErro;
}

// Only bars that have ACTUALLY closed relative to real wall-clock time are
// meaningful for a historical replay — a still-forming candle at fetch time
// would otherwise get baked into the fixture as if it were a closed bar.
async function fetchRange(symbol, interval, startMs, endMs) {
  const all = [];
  let cursor = startMs;
  const now = Date.now();

  while (cursor < endMs) {
    const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=${MAX_LIMIT}`;
    const res = await fetchWithRetry(url, `${symbol} ${interval}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const c of raw) {
      const closeTime = c[6];
      if (closeTime > now) continue; // ainda não fechou de verdade
      all.push({
        openTime: c[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
        closeTime,
      });
    }

    if (raw.length < MAX_LIMIT) break; // última página
    cursor = raw[raw.length - 1][6] + 1; // próximo candle começa logo após o close deste
    await sleep(PAGE_DELAY_MS);
  }

  return all;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.symbols || !args.from || !args.to) {
    console.error('Uso: fetch-backtest-data.mjs --symbols SYM1,SYM2 --from DATA --to DATA [--timeframes 1h,4h,1d,15m] [--out DIR]');
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
      console.log(`[fetch-backtest-data] ${symbol} ${tf}: baixando ${args.from} → ${args.to}...`);
      const candles = await fetchRange(symbol, tf, fromMs, toMs);
      const outFile = path.join(outDir, `${symbol}_${tf}.json`);
      fs.writeFileSync(outFile, JSON.stringify(candles));
      console.log(`[fetch-backtest-data] ${symbol} ${tf}: ${candles.length} candles → ${outFile}`);
    }
  }
}

main().catch((err) => {
  console.error('[fetch-backtest-data] FALHOU:', err);
  process.exitCode = 1;
});
