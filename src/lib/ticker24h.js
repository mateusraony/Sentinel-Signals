/**
 * Leitura da resposta crua do ticker 24h da Binance (item 279). Módulo próprio
 * de propósito: o provider de mercado (que o motor importa) usa só isto, sem
 * puxar código de exibição (`priceChange24h.js`/`priceProximity.js`, que são
 * só do painel).
 */
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Campo ausente ou inválido vira null, nunca NaN. */
export function parse24hStats(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    lastPrice: num(data.lastPrice),
    closeTime: num(data.closeTime),
    priceChange: num(data.priceChange),
    priceChangePercent: num(data.priceChangePercent),
    highPrice: num(data.highPrice),
    lowPrice: num(data.lowPrice),
    volume: num(data.volume),
    quoteVolume: num(data.quoteVolume),
  };
}
