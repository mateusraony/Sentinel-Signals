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

const DATA_DIR = process.env.BACKTEST_DATA_DIR || path.join('scripts', '__fixtures__', 'backtest');
const cache = new Map();

function loadSeries(symbol, timeframe) {
  const key = `${symbol}:${timeframe}`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(DATA_DIR, `${symbol}_${timeframe}.json`);
  let series = [];
  if (fs.existsSync(file)) {
    series = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } else {
    console.warn(`[backtestMarketDataProvider] sem dado para ${symbol} ${timeframe} (esperado em ${file}) — rode scripts/fetch-backtest-data.mjs`);
  }
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
