/**
 * priceProximity — matemática de EXIBIÇÃO da distância entre o preço ao vivo
 * e os níveis de uma operação (entrada / stop / TP1 / TP2).
 *
 * ⚠️ DISPLAY-ONLY, por desenho:
 * - Nada aqui alimenta decisão de trading. O motor (`src/lib/scanner.js`) segue
 *   sendo a ÚNICA fonte de transição de estado (`.claude/rules/trading-engine.md`);
 *   este módulo nunca é importado por ele.
 * - Não lê nem escreve Firestore/RTDB, não conhece `status` de operação e não
 *   decide se um nível "foi atingido" — só descreve a geometria entre dois
 *   números que o componente já tem em mãos.
 *
 * Existe para tirar a matemática de dentro do JSX de `src/pages/Trades.jsx`,
 * onde ela não era testável e tinha dois defeitos reais: marcadores sem clamp
 * (um stop com trailing além da entrada renderizava fora da barra) e a barra
 * inteira sumindo quando faltava um único campo.
 */

/** Coerção defensiva: RTDB pode devolver número serializado como string. */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Preço utilizável para exibição/percentual: finito e estritamente positivo. */
export function usablePrice(value) {
  const parsed = num(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

const clamp = (v) => Math.max(0, Math.min(100, v));

/**
 * Formatação canônica de preço do painel.
 *
 * Antes existiam duas escalas divergentes no MESMO card (`Trades.jsx` mostrava
 * 50 como "50.0000" enquanto `TradeCard.jsx` mostrava "50.00"). Esta é a única
 * escala; os dois arquivos importam daqui.
 */
export function formatPrice(price) {
  const parsed = num(price);
  if (parsed === null) return '—';
  if (parsed === 0) return '0.00';
  const abs = Math.abs(parsed);
  if (abs >= 1000) return parsed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 100) return parsed.toFixed(2);
  if (abs >= 1) return parsed.toFixed(4);
  if (abs >= 0.01) return parsed.toFixed(5);
  if (abs >= 0.0001) return parsed.toFixed(6);
  return parsed.toFixed(8);
}

/**
 * Idade de uma cotação, em texto curto. Existe porque `formatBackfillLag`
 * (`src/lib/backfillDetection.js`) tem granularidade de minuto — bom para o
 * atraso de um backfill, cego para uma cotação que atualiza a cada 30s.
 */
export function formatQuoteAge(ms) {
  const parsed = num(ms);
  if (parsed === null || parsed < 0) return null;
  const seconds = Math.floor(parsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Percentual assinado com sinal explícito no positivo ("+1.20%"). */
export function formatSignedPct(pct, digits = 2) {
  const parsed = num(pct);
  if (parsed === null) return '—';
  return `${parsed > 0 ? '+' : ''}${parsed.toFixed(digits)}%`;
}

/**
 * Variação percentual de `from` até `to` (quanto o preço precisa andar, em %,
 * para sair de `from` e chegar em `to`). Positivo = `to` está acima.
 */
export function pctDelta(from, to) {
  const a = usablePrice(from);
  const b = usablePrice(to);
  if (a === null || b === null) return null;
  return ((b - a) / a) * 100;
}

/** Níveis de uma operação, na ordem em que aparecem no card. */
export const LEVEL_DEFS = Object.freeze([
  Object.freeze({ key: 'stop', field: 'current_stop', label: 'Stop' }),
  Object.freeze({ key: 'entry', field: 'entry_price', label: 'Entrada' }),
  Object.freeze({ key: 'tp1', field: 'tp1', label: 'TP1' }),
  Object.freeze({ key: 'tp2', field: 'tp2', label: 'TP2' }),
]);

/**
 * Descreve, para exibição, onde o preço ao vivo está em relação aos níveis.
 *
 * Degrada por nível: cada campo ausente/inválido simplesmente não entra na
 * lista — nunca derruba os demais. Sem preço ao vivo, os níveis ainda voltam
 * (com `pct: null`), para o card continuar mostrando os valores.
 *
 * @returns {{ side: 'BUY'|'SELL', currentPrice: number|null,
 *             levels: Array<{key:string,label:string,price:number,pct:number|null,
 *                            absPct:number|null,position:'above'|'below'|'at'|null,
 *                            isNearest:boolean}>,
 *             nearestKey: string|null, unrealizedPct: number|null }}
 */
export function describeProximity(op, currentPrice) {
  const side = op?.side === 'SELL' ? 'SELL' : 'BUY';
  const price = usablePrice(currentPrice);

  const levels = [];
  for (const def of LEVEL_DEFS) {
    const value = usablePrice(op?.[def.field]);
    if (value === null) continue;
    const pct = price === null ? null : pctDelta(price, value);
    levels.push({
      key: def.key,
      label: def.label,
      price: value,
      pct,
      absPct: pct === null ? null : Math.abs(pct),
      position: price === null ? null : value > price ? 'above' : value < price ? 'below' : 'at',
      isNearest: false,
    });
  }

  let nearest = null;
  for (const level of levels) {
    if (level.absPct === null) continue;
    if (nearest === null || level.absPct < nearest.absPct) nearest = level;
  }
  if (nearest) nearest.isNearest = true;

  // Resultado BRUTO (sem custos de taxa/funding — quem contabiliza custo é
  // src/lib/tradeMetrics.js, e só para operação já fechada).
  const entry = usablePrice(op?.entry_price);
  const unrealizedPct = price === null || entry === null
    ? null
    : (side === 'BUY' ? (price - entry) / entry : (entry - price) / entry) * 100;

  return { side, currentPrice: price, levels, nearestKey: nearest?.key ?? null, unrealizedPct };
}

/**
 * Geometria da barra risco/retorno, em % da largura (0–100), já com clamp.
 *
 * O intervalo vem do min/max REAIS dos quatro níveis, não de `stop`/`tp2` fixos
 * por lado: com trailing pré-TP1 ligado o stop pode ultrapassar a entrada, e a
 * fórmula antiga produzia posições negativas nesse caso.
 *
 * @returns {null | { isBuy: boolean, low: number, high: number, range: number,
 *                    positions: Record<'stop'|'entry'|'tp1'|'tp2', number>,
 *                    segments: Array<{key:string,from:number,to:number}>,
 *                    currentPct: number|null, currentOutOfRange: boolean }}
 */
export function rrGeometry(op, currentPrice) {
  const stop = usablePrice(op?.current_stop);
  const entry = usablePrice(op?.entry_price);
  const tp1 = usablePrice(op?.tp1);
  const tp2 = usablePrice(op?.tp2);
  if (stop === null || entry === null || tp1 === null || tp2 === null) return null;

  const values = [stop, entry, tp1, tp2];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = high - low;
  if (range <= 0) return null;

  const pos = (v) => clamp(((v - low) / range) * 100);
  const positions = { stop: pos(stop), entry: pos(entry), tp1: pos(tp1), tp2: pos(tp2) };

  const price = usablePrice(currentPrice);
  const currentPct = price === null ? null : pos(price);
  const currentOutOfRange = price !== null && (price < low || price > high);

  const segment = (key, a, b) => ({ key, from: Math.min(a, b), to: Math.max(a, b) });

  return {
    isBuy: op?.side !== 'SELL',
    low,
    high,
    range,
    positions,
    segments: [
      segment('risk', positions.stop, positions.entry),
      segment('tp1', positions.entry, positions.tp1),
      segment('tp2', positions.tp1, positions.tp2),
    ],
    currentPct,
    currentOutOfRange,
  };
}
