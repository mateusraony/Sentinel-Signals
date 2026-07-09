/**
 * Choppiness Index — mesma fórmula do Pine v13.2:
 *   100 * log10( sum(TR, n) / (highest(high,n) - lowest(low,n)) ) / log10(n)
 * Valores altos (~100) = mercado lateralizado; valores baixos (~0) = tendência forte.
 */
import { calculateTRSeries } from './atr';

export function calculateChoppiness(candles, length = 14) {
  const n = candles.length;
  if (n < length) return 50;

  const tr = calculateTRSeries(candles);
  const trSum = tr.slice(-length).reduce((a, b) => a + b, 0);
  const highest = Math.max(...candles.slice(-length).map((c) => c.high));
  const lowest = Math.min(...candles.slice(-length).map((c) => c.low));
  const range = highest - lowest;

  if (range <= 0) return 50;
  return (100 * Math.log10(trSum / range)) / Math.log10(length);
}
