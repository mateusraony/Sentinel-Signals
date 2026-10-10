// Moeda determinística para a entrada aleatória do backtest — docs/known-risks.md
// item 264. Só é usada com `pineConfig.randomEntryEnabled` ligado, chave que
// existe SOMENTE em scripts/backtestPineConfig.js (tripwire em
// randomEntryTripwire.test.js). Nunca alcança o painel nem o cron.
//
// Por que hash de (seed, símbolo, horário da vela) e não um gerador com estado:
// - CAUSAL por construção: a decisão da vela T depende só do horário de T,
//   nunca de preço nem de vela futura;
// - REPRODUZÍVEL: a mesma seed dá exatamente os mesmos sinais, em qualquer
//   ordem de processamento dos ativos e em qualquer número de passadas sobre
//   a mesma vela (o cron e o replay reavaliam a última vela fechada várias
//   vezes — um gerador com estado sortearia de novo a cada passada).

// PRNG mulberry32 — mesma função de scripts/backtest-correlation-check.mjs,
// copiada aqui porque src/lib/ não importa de scripts/.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32 bits: transforma a chave textual numa seed inteira.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Decide se a vela gera uma entrada aleatória e de que lado.
 * @param {{ seed: number, symbol: string, candleTime: string|number, prob: number }} args
 * @returns {'BUY'|'SELL'|null} null na maioria das velas (probabilidade 1 − prob)
 */
export function randomEntryDecision({ seed, symbol, candleTime, prob }) {
  if (!(prob > 0)) return null;
  const rand = mulberry32(hashString(`${seed}|${symbol}|${candleTime}`));
  if (!(rand() < prob)) return null;
  return rand() < 0.5 ? 'BUY' : 'SELL';
}
