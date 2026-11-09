// Busca das velas de 1 min do BTCUSDT em volta de uma divulgação (Agenda 4d, parte 2). Mesmo host que o painel já usa no navegador para os preços
// (Binance Futures, `src/lib/marketDataProvider.js`: o Spot `data-api.binance.vision` é só para servidor). SÓ LEITURA pública, sem chave, sem banco, sem log.
// Falha em silêncio: qualquer problema devolve null e a tela simplesmente não mostra a linha (o contexto pode parar; o Sentinel não depende dele).
import { parseKlines, WINDOW_CANDLES } from '@/lib/btcAfterRelease';

const KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines';
const MIN = 60 * 1000;

/** @param {number} t0Ms instante da divulgação (UTC, ms) @returns {Promise<{ t: number, o: number, h: number, l: number, c: number }[] | null>} */
export async function fetchBtcAfterRelease(t0Ms, { fetchImpl = typeof fetch === 'function' ? fetch : null, timeoutMs = 10000 } = {}) {
  if (!fetchImpl || !Number.isFinite(t0Ms)) return null;
  const url = `${KLINES_URL}?symbol=BTCUSDT&interval=1m&startTime=${t0Ms - MIN}&limit=${WINDOW_CANDLES}`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    if (!res || res.status < 200 || res.status >= 300) return null;
    return parseKlines(await res.text());
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
