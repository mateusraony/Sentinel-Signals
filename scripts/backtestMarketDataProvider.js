// Node adapter for the historical backtest — the './marketDataProvider'
// redirect target for scanner.js during a backtest run. Reads candles from
// JSON files on disk (downloaded once, locally, by fetch-backtest-data.mjs —
// see docs/claude/backtest-usage.md) instead of hitting Binance, and windows
// them through sliceClosedAsOf/simNow (src/lib/backtestEngine.js) so a
// candle is only ever visible once the simulated clock has actually reached
// its close — never marketDataProvider.js's `Date.now() > candle.closeTime`,
// which is meaningless against historical data (every bar is trivially "in
// the past" relative to the real wall clock).
import fs from 'node:fs';
import path from 'node:path';
import { sliceClosedAsOf, simNow } from '../src/lib/backtestEngine.js';
import { validateCandleSeries } from './backtestDataIntegrity.js';

// Provenance stamped onto every TradeOperation/SignalEvent created during a
// backtest run — mirrors the cron's Spot/binance path (the historical data
// fetch-backtest-data.mjs downloads comes from the same Spot source
// scripts/adminMarketDataProvider.js uses live).
export const MARKET_SOURCE = 'spot';
export const DATA_EXCHANGE = 'binance';
export const EXECUTOR = 'cron';

// Read lazily (not at module load) — run-backtest.mjs sets this env var at
// the start of its own main(), which runs AFTER the whole import graph
// (including this module) has already been evaluated once; a top-level
// `const` here would freeze in the default before the CLI ever gets a say.
function getDataDir() {
  return process.env.BACKTEST_DATA_DIR || path.join('scripts', '__fixtures__', 'backtest');
}
const cache = new Map();
// docs/known-risks.md item 260 — problemas ESTRUTURAIS de cada série
// carregada (arquivo ausente, JSON inválido, ordem, duplicata, buraco),
// registrados uma vez por símbolo/timeframe junto com o cache acima.
// run-backtest.mjs lê isto antes do replay (recusa o run) e depois dele
// (série carregada só durante o replay também entra no relatório).
const integrityIssues = new Map();

export function getSeriesIntegrityIssues() {
  return [...integrityIssues.values()].flat();
}

// Toda série lida até agora (inclusive as que só o replay pediu) — para
// run-backtest.mjs checar a cobertura da janela de TODAS, não só da lista
// verificada antes do replay.
export function getLoadedSeries() {
  return [...cache.entries()].map(([key, series]) => {
    const [symbol, timeframe] = key.split(':');
    return { symbol, timeframe, series };
  });
}

// Exportado (docs/known-risks.md item 69) para o simulador de operação-
// fantasma (src/lib/indicatorAttribution.js, invocado só por
// backtestEngine.js) andar para a FRENTE no tempo a partir de um sinal —
// diferente de fetchCandles, que sempre corta em simNow() (causal para o
// scanner ao vivo). Só faz sentido aqui: este arquivo é Node-only, redirect
// exclusivo de scripts/build-backtest.mjs — build-scan.mjs (scanner ao vivo)
// nunca o importa, então expor a série inteira não vaza look-ahead pro
// caminho de produção.
export function loadSeries(symbol, timeframe) {
  const key = `${symbol}:${timeframe}`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(getDataDir(), `${symbol}_${timeframe}.json`);
  let series = [];
  let issues;
  if (fs.existsSync(file)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      // Antes: o erro de parse estourava a cada passo do replay (o cache só
      // era preenchido depois do parse) e era engolido pelo try/catch por
      // timeframe do scanAsset — run inteiro sem aquele dado, sem sinal no
      // relatório. Agora vira problema registrado, uma vez só.
      issues = [{ severity: 'error', type: 'invalid_json', symbol, timeframe, count: 1, samples: [{ at: null, detail: err.message }] }];
    }
    if (!issues) {
      // Fora do try do parse de propósito (revisão do pacote 1): um defeito
      // do validador não pode ser relatado como "JSON inválido" — mandaria o
      // usuário baixar de novo um arquivo que está certo.
      issues = validateCandleSeries(parsed, { symbol, timeframe });
      // Série que não é lista não pode seguir adiante: sliceClosedAsOf
      // quebraria a cada passo. O problema já está registrado em `issues`.
      if (Array.isArray(parsed)) series = parsed;
    }
  } else {
    console.warn(`[backtestMarketDataProvider] sem dado para ${symbol} ${timeframe} (esperado em ${file}) — rode scripts/fetch-backtest-data.mjs`);
    issues = [{ severity: 'error', type: 'missing_file', symbol, timeframe, count: 1, samples: [{ at: null, file }] }];
  }
  integrityIssues.set(key, issues);
  cache.set(key, series);
  return series;
}

export async function fetchCandles(symbol, timeframe, limit) {
  const series = loadSeries(symbol, timeframe);
  return sliceClosedAsOf(series, simNow(), limit);
}

// There's no tick data in a candle-only backtest — runBacktest deliberately
// never drives priceCheckActiveOpsInner (the only caller of this function in
// scanner.js), so reaching this is a real bug, not a degraded path. Throwing
// loudly surfaces that immediately instead of silently faking a price.
export async function fetchCurrentPrice(symbol) {
  throw new Error(`fetchCurrentPrice(${symbol}): não disponível em modo backtest — priceCheckActiveOps não roda no runBacktest`);
}
