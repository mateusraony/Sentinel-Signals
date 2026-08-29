// Node adapter for the retroactive backfill check (docs/known-risks.md item
// 137) — the './marketDataProvider' redirect target for scanner.js in
// scripts/build-backfill.mjs. A THIRD variant alongside the two that already
// exist for this same import slot:
//   - scripts/adminMarketDataProvider.js: live scan, always "the latest N
//     candles", no historical range support.
//   - scripts/backtestMarketDataProvider.js: reads MONTHS of history from
//     local JSON files pre-downloaded by fetch-backtest-data.mjs.
// This one fetches a BOUNDED recent window (src/lib/backfillDetection.js:
// BACKFILL_LOOKBACK_DAYS, 60 days) directly from Binance Spot REST — same
// host as adminMarketDataProvider.js (data-api.binance.vision, reachable
// from GitHub Actions runners; fapi.binance.com 451s from US datacenters) —
// via pagination, then serves it through the SAME sliceClosedAsOf/simNow
// windowing backtestMarketDataProvider.js uses. scanAsset/persistScanResults
// (driven by backtestEngine.js:runBacktest) need zero changes to run against
// it — same principle as the other two redirect targets.
import { fetchWithRetry } from '../src/lib/httpRetry.js';
import { sliceClosedAsOf, simNow } from '../src/lib/backtestEngine.js';

const BINANCE_BASE_URL = 'https://data-api.binance.vision/api/v3';

// Provenance stamped onto every TradeOperation/SignalEvent created while this
// provider is the active redirect target — mirrors the cron's Spot path
// (same host, same data), consistent with the other two providers.
export const MARKET_SOURCE = 'spot';
export const DATA_EXCHANGE = 'binance';
export const EXECUTOR = 'cron';

const TIMEFRAME_MAP = { '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
const MAX_KLINES_PER_CALL = 1000;

function normalizeCandles(rawCandles) {
  return rawCandles.map((candle) => ({
    openTime: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
    closeTime: candle[6],
    // Irrelevante na prática — sliceClosedAsOf (backtestEngine.js) sobrescreve
    // isClosed:true incondicionalmente em tudo que devolve, e é ela (não este
    // valor) quem decide o corte causal contra o relógio simulado. Mantido
    // por consistência com os outros dois provedores deste mesmo slot.
    isClosed: true,
  }));
}

// Pagina PARA TRÁS a partir de toMs até cobrir fromMs — a Binance devolve no
// máximo 1000 velas por chamada, e uma janela de 60 dias em 15m (~5760
// candles) ultrapassa isso. O guard de 50 páginas é só uma rede de segurança
// contra um bug de paginação que nunca convirja (a janela real é sempre
// curta — BACKFILL_LOOKBACK_DAYS — nunca deveria chegar perto disso).
async function fetchHistoricalCandles(symbol, timeframe, fromMs, toMs) {
  const interval = TIMEFRAME_MAP[timeframe];
  if (!interval) throw new Error(`Timeframe inválido: ${timeframe}. Válidos: ${Object.keys(TIMEFRAME_MAP).join(', ')}`);

  const pages = [];
  let endTime = toMs;
  for (let page = 0; page < 50; page++) {
    const url = `${BINANCE_BASE_URL}/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&startTime=${fromMs}&endTime=${endTime}&limit=${MAX_KLINES_PER_CALL}`;
    const response = await fetchWithRetry(url, { context: `${symbol} ${timeframe} backfill` });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Binance API error (${response.status}) ao buscar histórico de ${symbol} ${timeframe}: ${errorText}`);
    }
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) break;
    pages.push(...data);
    const earliest = data[0][0];
    if (earliest <= fromMs || data.length < MAX_KLINES_PER_CALL) break;
    endTime = earliest - 1;
  }

  // Dedup (páginas adjacentes podem se sobrepor em 1 vela no limite) + ordem
  // ascendente — pré-condição obrigatória de sliceClosedAsOf.
  const byOpenTime = new Map(pages.map((c) => [c[0], c]));
  const sorted = [...byOpenTime.values()].sort((a, b) => a[0] - b[0]);
  return normalizeCandles(sorted);
}

// Cacheia a PROMISE (não só o valor resolvido) — scanAsset busca várias
// timeframes em paralelo por ativo; sem isto, chamadas concorrentes para o
// mesmo symbol+timeframe disparariam fetches duplicados à Binance.
const cache = new Map();

function loadSeries(symbol, timeframe, fromMs, toMs) {
  const key = `${symbol}:${timeframe}`;
  if (!cache.has(key)) {
    cache.set(key, fetchHistoricalCandles(symbol, timeframe, fromMs, toMs));
  }
  return cache.get(key);
}

// Definida pelo orquestrador (scripts/run-backfill-check.mjs) ANTES de cada
// runBacktest — mesmo padrão de configuração tardia do BACKTEST_DATA_DIR em
// backtestMarketDataProvider.js (o import graph inteiro já foi avaliado
// antes do main() rodar). Limpa o cache a cada novo ativo/janela.
let activeWindow = null;
export function setBackfillWindow(fromMs, toMs) {
  activeWindow = { fromMs, toMs };
  cache.clear();
}

export async function fetchCandles(symbol, timeframe, limit) {
  if (!activeWindow) {
    throw new Error('backfillMarketDataProvider.fetchCandles chamado sem setBackfillWindow — orquestrador não configurou a janela do replay');
  }
  const series = await loadSeries(symbol, timeframe, activeWindow.fromMs, activeWindow.toMs);
  return sliceClosedAsOf(series, simNow(), limit);
}

// Não há dado de tick numa janela histórica — runBacktest deliberadamente
// nunca aciona priceCheckActiveOpsInner (único chamador desta função em
// scanner.js), então chegar aqui é bug real, não caminho degradado. Mesmo
// contrato de backtestMarketDataProvider.js.
export async function fetchCurrentPrice(symbol) {
  throw new Error(`fetchCurrentPrice(${symbol}): não disponível no backfill — priceCheckActiveOps não roda dentro de runBacktest`);
}
