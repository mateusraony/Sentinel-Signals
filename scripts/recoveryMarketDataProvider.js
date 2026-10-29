// Replay de recuperação (docs/known-risks.md item 288) — o alvo do redirecionamento
// './marketDataProvider' do scanner.js no bundle da recuperação. Diferente dos outros 3
// provedores deste slot:
//  - TODAS as velas são baixadas ANTES do relógio simulado ligar (preloadSeries) e conferidas
//    (sem buraco, chegando até o fim da janela). Durante o replay nada vai à rede: vela que
//    não foi pré-carregada é erro, nunca busca escondida.
//  - Entrega as velas como o AO VIVO vê (sliceLikeLive: limite − 1 fechadas, item 287).
//  - Mesma origem e procedência do cron ao vivo (Binance Spot, data-api.binance.vision).
import { simNow } from '../src/lib/backtestEngine.js';
import { sliceLikeLive, fingerprint } from '../src/lib/recovery/recoveryReplay.js';
import { fetchHistoricalCandles } from './backfillMarketDataProvider.js';

export const MARKET_SOURCE = 'spot';
export const DATA_EXCHANGE = 'binance';
export const EXECUTOR = 'cron';

const store = new Map(); // `${SYMBOL}:${tf}` -> velas em ordem crescente
const key = (symbol, timeframe) => `${String(symbol).toUpperCase()}:${timeframe}`;

/** Baixa (ou recebe pronta) a série de um símbolo/timeframe e guarda. Chamar com o relógio REAL. */
export async function preloadSeries(symbol, timeframe, fromMs, toMs, fetchImpl = fetchHistoricalCandles) {
  const series = await fetchImpl(symbol, timeframe, fromMs, toMs);
  store.set(key(symbol, timeframe), series);
  return series;
}

export function clearSeries() {
  store.clear();
}

/** Impressão digital de todas as velas carregadas — o modo aplicar confere que usa as MESMAS. */
export function seriesFingerprint() {
  const entries = [...store.entries()].sort(([a], [b]) => a.localeCompare(b));
  return fingerprint(entries.map(([k, s]) => [k, s.map((c) => [c.openTime, c.open, c.high, c.low, c.close])]));
}

export function exportSeries() {
  return Object.fromEntries([...store.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function importSeries(obj) {
  store.clear();
  for (const [k, s] of Object.entries(obj || {})) store.set(k, s);
}

export async function fetchCandles(symbol, timeframe, limit) {
  const series = store.get(key(symbol, timeframe));
  if (!series) throw new Error(`recuperação: velas de ${symbol} ${timeframe} não foram pré-carregadas`);
  return sliceLikeLive(series, simNow(), limit);
}

// O replay nunca roda o price-check (runBacktest não chama priceCheckActiveOps).
export async function fetchCurrentPrice(symbol) {
  throw new Error(`fetchCurrentPrice(${symbol}): não existe no replay de recuperação`);
}
