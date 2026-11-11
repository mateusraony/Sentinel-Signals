import React from 'react';
import { baseAsset, monogramColor } from '@/lib/tokenIcons';

// Ícone do token (pedido do usuário, 11/11/2026: "o símbolo original de cada token, assim fica profissional"). Os logos ficam em `src/assets/tokens/<TICKER>.svg`
// (veja o README da pasta: origem, licença e como acrescentar um). Token sem logo vira uma bolinha colorida com a inicial.
// Sempre DECORATIVO: `alt` vazio, escondido do leitor de tela, e sem texto no DOM (a letra da bolinha vem do CSS `content: attr(data-letter)`), porque o nome
// do token já está escrito ao lado — assim o ícone não duplica a leitura nem atrapalha as buscas por texto.

// @ts-ignore -- `import.meta.glob` é do Vite; o jsconfig não carrega os tipos de `vite/client`
const ICON_URLS = import.meta.glob('/src/assets/tokens/*.svg', { eager: true, query: '?url', import: 'default' });

/** @type {Record<string, string>} ticker → endereço do logo (ex.: BTC → ".../BTC.svg") */
const BY_TICKER = Object.fromEntries(
  Object.entries(ICON_URLS).map(([path, url]) => [path.split('/').pop().replace(/\.svg$/, ''), /** @type {string} */ (url)]),
);

/** Os tokens que têm logo na pasta (para o teste conferir que nenhum sumiu nem entrou por engano). */
export const TOKEN_ICON_TICKERS = Object.freeze(Object.keys(BY_TICKER));

/** O token deste símbolo tem logo na pasta? (o cadastro de ativo usa isto para avisar quando só vai aparecer a bolinha com a inicial) */
export function hasTokenLogo(symbol) {
  const ticker = baseAsset(symbol);
  return Boolean(ticker && BY_TICKER[ticker]);
}

/**
 * @param {{ symbol?: unknown, size?: number, className?: string }} props `symbol` aceita "BTCUSDT", "BTC/USDT" ou "BTC"
 */
export default function TokenIcon({ symbol, size = 16, className = '' }) {
  const ticker = baseAsset(symbol);
  if (!ticker) return null;
  const url = BY_TICKER[ticker];
  if (url) {
    return (
      <img src={url} alt="" aria-hidden="true" width={size} height={size} loading="lazy" decoding="async" draggable={false} data-token={ticker}
        className={`inline-block shrink-0 rounded-full ring-1 ring-white/15 align-middle ${className}`} />
    );
  }
  return (
    <span aria-hidden="true" data-token={ticker} data-letter={ticker[0]}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.55)), background: monogramColor(ticker) }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ring-1 ring-white/15 align-middle font-mono font-bold leading-none text-white before:content-[attr(data-letter)] ${className}`} />
  );
}
