/**
 * Node/GitHub Actions counterpart to src/lib/marketDataProvider.js.
 *
 * The browser version talks to Binance Futures (fapi.binance.com) now that
 * the panel operates on Futures data. The 24/7 cron stays on Binance Spot
 * (data-api.binance.vision) because fapi.binance.com returns 451 for any US
 * datacenter IP (where GitHub Actions runners live), and there's no public
 * Futures mirror equivalent to data-api.binance.vision. See
 * docs/known-risks.md for the accepted consequence: the panel (Futures) and
 * the cron (Spot) can disagree slightly on price/signals when both are
 * active — this file preserves the cron's original Spot-only behavior.
 */

const BINANCE_BASE_URL = 'https://data-api.binance.vision/api/v3';

// Provenance stamped onto every TradeOperation/SignalEvent created while this
// provider is the active './marketDataProvider' redirect target (cron). See
// src/lib/marketDataProvider.js for the browser-side counterpart.
export const MARKET_SOURCE = 'spot';
export const DATA_EXCHANGE = 'binance';
export const EXECUTOR = 'cron';

const TIMEFRAME_MAP = {
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

const MIN_CANDLES = 100;

export async function fetchCandles(symbol, timeframe, limit = MIN_CANDLES) {
  const interval = TIMEFRAME_MAP[timeframe];
  if (!interval) {
    throw new Error(`Timeframe inválido: ${timeframe}. Válidos: ${Object.keys(TIMEFRAME_MAP).join(', ')}`);
  }

  const url = `${BINANCE_BASE_URL}/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Binance API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Nenhum dado retornado para ${symbol} ${timeframe}`);
  }

  return normalizeCandles(data);
}

function normalizeCandles(rawCandles) {
  return rawCandles.map(candle => ({
    openTime: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
    closeTime: candle[6],
    isClosed: Date.now() > candle[6],
  }));
}

export async function fetchCurrentPrice(symbol) {
  const url = `${BINANCE_BASE_URL}/ticker/price?symbol=${symbol.toUpperCase()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Erro ao buscar preço de ${symbol}`);
  }

  const data = await response.json();
  return parseFloat(data.price);
}

export async function validateSymbol(symbol) {
  const url = `${BINANCE_BASE_URL}/ticker/price?symbol=${symbol.toUpperCase()}`;
  const response = await fetch(url);
  return response.ok;
}

export async function fetch24hStats(symbol) {
  const url = `${BINANCE_BASE_URL}/ticker/24hr?symbol=${symbol.toUpperCase()}`;
  const response = await fetch(url);

  if (!response.ok) return null;

  const data = await response.json();
  return {
    priceChange: parseFloat(data.priceChange),
    priceChangePercent: parseFloat(data.priceChangePercent),
    highPrice: parseFloat(data.highPrice),
    lowPrice: parseFloat(data.lowPrice),
    volume: parseFloat(data.volume),
    quoteVolume: parseFloat(data.quoteVolume),
  };
}
