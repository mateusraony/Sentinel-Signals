/**
 * Geometria da trilha do cartão de operação (aba Trades, docs/known-risks.md item 303).
 *
 * A trilha antiga (`rrGeometry`, `priceProximity.js`) pintava stop↔entrada SEMPRE de rosa: com o stop já além da entrada
 * aquela faixa é lucro protegido, e o rosa por cima do verde virava uma mancha olivácea. Também não mostrava o stop inicial,
 * então "o stop subiu" não aparecia em lugar nenhum. Aqui cada faixa tem UM sentido e o stop inicial entra como marcador.
 *
 * Só geometria: lê preços da operação e devolve posições em % (0–100). Não lê `status`, não decide nada e não é usado pelo motor.
 */
import { stopPosture } from './priceProximity.js';

const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const clamp = (v) => Math.max(0, Math.min(100, v));
const sameLevel = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6;

/**
 * @param {object} op
 * @param {number|null|undefined} currentPrice
 * @param {{ profitToRight?: boolean }} [opts] `true` (padrão): o lado do lucro fica SEMPRE à direita — numa venda o eixo de preço
 *   é espelhado (preço maior à esquerda). `false`: eixo de preço fixo (menor à esquerda), como a trilha antiga.
 * @returns {null | {
 *   isBuy: boolean, flipped: boolean, posture: 'risk'|'breakeven'|'locked'|null,
 *   markers: Array<{ key: string, price: number, pos: number }>,  // key: 'initialStop'|'stop'|'entry'|'tp1'|'tp2'
 *   zones: Array<{ key: string, from: number, to: number }>,      // key: 'riskRemoved'|'risk'|'locked'|'reward'
 *   pricePos: number|null, priceOutOfRange: boolean,
 * }}
 */
export function buildTradeRail(op, currentPrice, { profitToRight = true } = {}) {
  const stop = isPrice(op?.current_stop) ? op.current_stop : null;
  const entry = isPrice(op?.entry_price) ? op.entry_price : null;
  const tp1 = isPrice(op?.tp1) ? op.tp1 : null;
  const tp2 = isPrice(op?.tp2) ? op.tp2 : null;
  if (stop === null || entry === null || tp1 === null || tp2 === null) return null;

  const isBuy = op?.side !== 'SELL';
  // "Melhor para a posição": mais alto na compra, mais baixo na venda.
  const better = (a, b) => (isBuy ? a > b : a < b);

  // O stop inicial só entra se estiver do lado do risco (pior que a entrada) e for diferente do stop atual — senão é o mesmo
  // marcador duas vezes, ou um dado estranho (edição manual) que a trilha não deve interpretar.
  const rawInitial = isPrice(op?.initial_stop) ? op.initial_stop : null;
  const initialStop = rawInitial !== null && better(entry, rawInitial) && !sameLevel(rawInitial, stop) ? rawInitial : null;

  const values = [stop, entry, tp1, tp2, ...(initialStop !== null ? [initialStop] : [])];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = high - low;
  if (!(range > 0)) return null;

  const flipped = profitToRight && !isBuy;
  const pos = (v) => {
    const pct = clamp(((v - low) / range) * 100);
    return flipped ? 100 - pct : pct;
  };

  const posture = stopPosture(op);
  const zone = (key, a, b) => {
    const from = Math.min(pos(a), pos(b));
    const to = Math.max(pos(a), pos(b));
    return to > from ? { key, from, to } : null;
  };

  const zones = [];
  // 1) Risco que já saiu da mesa: do stop inicial até onde o risco começa hoje (o stop atual, ou a entrada se já não há risco).
  if (initialStop !== null && better(stop, initialStop)) {
    zones.push(zone('riskRemoved', initialStop, posture === 'risk' ? stop : entry));
  }
  // 2) Risco ainda em jogo.
  if (posture === 'risk') zones.push(zone('risk', stop, entry));
  // 3) Lucro já protegido pelo stop (nunca além do TP2).
  const lockedEnd = posture === 'locked' ? (better(stop, tp2) ? tp2 : stop) : entry;
  if (posture === 'locked') zones.push(zone('locked', entry, lockedEnd));
  // 4) O que ainda falta buscar.
  zones.push(zone('reward', lockedEnd, tp2));

  const markers = [
    ...(initialStop !== null ? [{ key: 'initialStop', price: initialStop, pos: pos(initialStop) }] : []),
    { key: 'stop', price: stop, pos: pos(stop) },
    { key: 'entry', price: entry, pos: pos(entry) },
    { key: 'tp1', price: tp1, pos: pos(tp1) },
    { key: 'tp2', price: tp2, pos: pos(tp2) },
  ];

  const price = isPrice(currentPrice) ? currentPrice : null;
  return {
    isBuy,
    flipped,
    posture,
    markers,
    zones: zones.filter(Boolean),
    pricePos: price === null ? null : pos(price),
    priceOutOfRange: price !== null && (price < low || price > high),
  };
}

/**
 * Distribui os nomes dos marcadores em linhas, para nenhum nome ficar por cima de outro.
 *
 * A largura de cada nome é ESTIMADA (`charPct` = % da trilha por caractere, calibrado para o cartão mais estreito, no celular);
 * em cartão mais largo sobra espaço, nunca falta. Nome que passaria da borda é encostado nela em vez de cortado.
 *
 * @param {Array<{ key: string, pos: number, text: string }>} items
 * @param {{ charPct?: number, gapPct?: number }} [opts]
 * @returns {{ rows: number, labels: Array<{ key: string, pos: number, text: string, row: number, left: number, width: number,
 *   anchor: string }> }} `anchor`: 'start' | 'center' | 'end'
 */
export function layoutRailLabels(items, { charPct = 1.9, gapPct = 1.5 } = {}) {
  const sorted = [...items]
    .filter((item) => item && typeof item.text === 'string' && item.text && Number.isFinite(item.pos))
    .sort((a, b) => a.pos - b.pos);
  const rowEnds = [];
  const labels = sorted.map((item) => {
    const width = Math.min(100, [...item.text].length * charPct);
    const left = Math.max(0, Math.min(100 - width, item.pos - width / 2));
    let row = rowEnds.findIndex((end) => end + gapPct <= left);
    if (row === -1) { row = rowEnds.length; rowEnds.push(0); }
    rowEnds[row] = left + width;
    // Como o componente deve ancorar o texto: centrado no marcador, ou encostado na borda quando centrar passaria dela.
    const anchor = item.pos - width / 2 < 0 ? 'start' : item.pos + width / 2 > 100 ? 'end' : 'center';
    return { key: item.key, pos: item.pos, text: item.text, row, left, width, anchor };
  });
  return { rows: rowEnds.length, labels };
}
