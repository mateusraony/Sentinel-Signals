// Ícone do token (pedido do usuário, 11/11/2026: "o símbolo original de cada token, assim fica profissional"). Parte PURA: do símbolo do par ao token e à cor da
// bolinha com a inicial para os tokens que não têm logo. O componente que desenha mora em `src/components/TokenIcon.jsx`.

// Moedas de cotação, da mais longa para a mais curta que termina igual (USDT antes de USD).
const QUOTES = ['FDUSD', 'USDT', 'USDC', 'BUSD', 'TUSD', 'USD'];

/**
 * O token por trás de um símbolo: "BTCUSDT", "BTC/USDT", "btc-usdt" e "BTC" dão "BTC". Tira a moeda de cotação (só se sobrar algo: "USDT" continua "USDT")
 * e o multiplicador da Binance ("1000PEPE" → "PEPE", mas "1INCH" fica). Não trata pares cotados em cripto ("ETHBTC"): isso devolve "ETHBTC", sem logo.
 * @param {unknown} symbol
 * @returns {string | null} o ticker em maiúsculas, ou null se não há nada que se aproveite
 */
export function baseAsset(symbol) {
  if (typeof symbol !== 'string') return null;
  let s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  for (const q of QUOTES) {
    if (s.length > q.length && s.endsWith(q)) { s = s.slice(0, -q.length); break; }
  }
  s = s.replace(/^(?:1000000|1000|1M)(?=[A-Z])/, '');
  return s || null;
}

/** Cor estável de uma bolinha de token sem logo (matiz pelo texto do ticker, escura: a letra branca por cima passa de 4,5:1). */
export function monogramColor(ticker) {
  let h = 0;
  for (const ch of String(ticker)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 34%)`;
}
