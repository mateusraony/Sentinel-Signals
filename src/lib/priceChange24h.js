import { num, usablePrice, formatSignedPct } from './priceProximity.js';

/**
 * Variação de 24h para o painel (item 279, PR-D). A Binance Futures devolve
 * preço, variação e horário na MESMA resposta do `/fapi/v1/ticker/24hr`
 * (`lastPrice`, `priceChangePercent`, `closeTime` — confirmado pelo usuário no
 * navegador, 2026-10-18; a leitura crua fica em `ticker24h.js`). Antes o
 * cartão juntava o fechamento da vela (AssetState) com a % de outra fonte e de
 * outro instante, sem rótulo.
 *
 * 📈/📉 são reservados para movimento de preço (docs/notification-vocabulary.md).
 */
const STALE_MS = 3 * 60_000;

/** Cor por tom — uma tabela só para cartão, comparador e faixa do topo. */
export const CHANGE_TONE_COLOR = Object.freeze({ up: '#00ff80', down: '#ff1478', flat: 'rgba(255,255,255,0.4)', none: 'rgba(255,255,255,0.4)' });

const UNAVAILABLE = Object.freeze({ available: false, icon: '', signed: '', tone: 'none', pct: null, price: null, closeTime: null, stale: true });

/**
 * Frescor: `fetchedAt` (ms, ex.: `dataUpdatedAt` do TanStack) mede pelo relógio
 * do próprio navegador — comparar `closeTime` (relógio da Binance) com o relógio
 * local erraria com o PC adiantado/atrasado. Sem `fetchedAt`, cai no
 * `closeTime`. `isError` (última busca falhou) também conta como desatualizado,
 * mesmo padrão de `useLivePrice`.
 *
 * @param {object|null|undefined} stats  resultado de `parse24hStats`
 * @param {number} now
 * @param {{ fetchedAt?: number, isError?: boolean, isLoading?: boolean, source?: string }} [options]
 * @returns {{ available: boolean, icon: string, signed: string, text: string,
 *   tone: 'up'|'down'|'flat'|'none', pct: number|null, price: number|null,
 *   closeTime: number|null, stale: boolean }}
 */
export function describeChange24h(stats, now, { fetchedAt, isError = false, isLoading = false, source = 'Futures' } = {}) {
  const pct = num(stats?.priceChangePercent);
  if (pct === null) {
    // Carregando não é falha: texto próprio, para não alarmar à toa.
    return { ...UNAVAILABLE, text: isLoading && !isError ? '% 24h carregando…' : '% 24h indisponível' };
  }
  const closeTime = num(stats?.closeTime);
  const icon = pct > 0 ? '📈' : pct < 0 ? '📉' : '';
  const signed = formatSignedPct(pct);
  const ref = num(fetchedAt) ?? closeTime;
  return {
    available: true,
    icon,
    signed,
    text: `${icon ? `${icon} ` : ''}${signed} em 24h · ${source}`,
    tone: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat',
    pct,
    price: usablePrice(stats?.lastPrice),
    closeTime,
    stale: isError || ref === null || !Number.isFinite(now) || now - ref > STALE_MS,
  };
}

/** Opções de `describeChange24h` a partir do resultado de um `useQuery`. */
export function queryChangeOptions(query) {
  return { fetchedAt: query?.dataUpdatedAt, isError: query?.isError, isLoading: query?.isPending };
}

/**
 * Regra única de exibição (cartão, comparador, faixa do topo): preço do ticker
 * só quando fresco — mesmo instante da %; senão o fechamento da vela, marcado
 * como tal (`isCandle`), e a % antiga vira "% 24h desatualizado" em vez de
 * aparecer ao lado de um preço de outro instante. Ticker com % mas sem preço
 * utilizável também não é "fresco": a % não tem um preço do mesmo instante para
 * acompanhar (achado do Codex, PR #505).
 */
export function resolvePriceDisplay(change, candleClose) {
  const fresh = change.available && !change.stale && change.price !== null;
  const tickerPrice = fresh ? change.price : null;
  let pctText = change.text;
  if (change.available && !fresh) pctText = change.stale ? '% 24h desatualizado' : '% 24h indisponível';
  return {
    price: tickerPrice ?? usablePrice(candleClose),
    isCandle: tickerPrice === null,
    pctText,
    tone: fresh ? change.tone : 'none',
    fresh,
  };
}
