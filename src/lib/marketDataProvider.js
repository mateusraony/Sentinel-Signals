/**
 * Market Data Provider - Camada de abstração para dados OHLCV
 *
 * Provider principal: Binance Futures API pública (USDT-M perpetual)
 * Arquitetura preparada para adicionar outros providers.
 *
 * Notas:
 * - Binance retorna candles com timestamp de abertura em milissegundos
 * - Timezone: UTC
 * - Limite máximo por request: 1000 candles
 * - Rate limit: 2400 requests/min no fapi (suficiente para V1)
 * - Usamos fapi.binance.com (Futures) aqui porque o painel roda no navegador
 *   do usuário, que não sofre o bloqueio geográfico que afeta datacenters
 *   dos EUA. O scan agendado via GitHub Actions (que roda em datacenters
 *   dos EUA) NÃO pode usar este mesmo endpoint — fapi.binance.com retorna
 *   451 "restricted location" para esses IPs, e não existe mirror público
 *   de Futures equivalente ao data-api.binance.vision (que só cobre Spot).
 *   Por isso o cron usa scripts/adminMarketDataProvider.js (Spot) em vez
 *   deste arquivo — ver scripts/build-scan.mjs e docs/known-risks.md para
 *   a divergência aceita entre painel (Futures) e cron 24/7 (Spot).
 */

const BINANCE_BASE_URL = 'https://fapi.binance.com/fapi/v1';

// Provenance stamped onto every TradeOperation/SignalEvent created while this
// provider is the active './marketDataProvider' import (browser). Makes the
// Spot/Futures divergence already documented in docs/known-risks.md item 4
// explicit and persisted, instead of only implicit in which file ran.
export const MARKET_SOURCE = 'futures';
export const DATA_EXCHANGE = 'binance';
export const EXECUTOR = 'browser';

const TIMEFRAME_MAP = {
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

// Mínimo de candles necessários para cálculo correto dos indicadores
// Range Filter precisa de ~50 candles para estabilizar
// MACD precisa de 26+9 = 35 candles
// EMA precisa do período + buffer
const MIN_CANDLES = 100;

/**
 * Fetch OHLCV data from Binance
 * @param {string} symbol - Trading pair (e.g. 'BTCUSDT')
 * @param {string} timeframe - '1h' | '4h' | '1d'
 * @param {number} limit - Number of candles to fetch
 * @returns {Promise<Array>} Normalized candle array
 */
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

/**
 * Normalize Binance kline data to standard OHLCV format
 * Binance kline format: [openTime, open, high, low, close, volume, closeTime, ...]
 */
function normalizeCandles(rawCandles) {
  return rawCandles.map(candle => ({
    openTime: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
    closeTime: candle[6],
    isClosed: Date.now() > candle[6], // candle is closed if current time > close time
  }));
}

/**
 * Fetch current price for a symbol
 */
export async function fetchCurrentPrice(symbol) {
  const url = `${BINANCE_BASE_URL}/ticker/price?symbol=${symbol.toUpperCase()}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Erro ao buscar preço de ${symbol}`);
  }

  const data = await response.json();
  return parseFloat(data.price);
}

/**
 * Validate if a symbol exists on Binance
 */
export async function validateSymbol(symbol) {
  const url = `${BINANCE_BASE_URL}/ticker/price?symbol=${symbol.toUpperCase()}`;
  const response = await fetch(url);
  return response.ok;
}

/**
 * Fetch 24h ticker stats
 */
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

/**
 * Fetch the mark price for a Futures symbol (used for liquidation/funding
 * calculations — distinct from the last traded price returned by
 * fetchCurrentPrice, which is what indicators/signals still use today).
 */
export async function fetchMarkPrice(symbol) {
  const url = `${BINANCE_BASE_URL}/premiumIndex?symbol=${symbol.toUpperCase()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Erro ao buscar mark price de ${symbol}`);
  }

  const data = await response.json();
  return {
    markPrice: parseFloat(data.markPrice),
    lastFundingRate: parseFloat(data.lastFundingRate),
    nextFundingTime: data.nextFundingTime,
  };
}