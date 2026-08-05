import { describe, it, expect } from 'vitest';
import { runQuickBacktest } from './quickBacktest';
import { goldenCandles } from './indicators/__fixtures__/candles.js';
import { isClosedOp } from './tradeMetrics';

const META = { symbol: 'BTCUSDT', timeframe: '4h' };

describe('runQuickBacktest', () => {
  it('rejeita candles insuficientes com erro claro', () => {
    expect(() => runQuickBacktest(goldenCandles(20), {}, META)).toThrow(/Candles insuficientes/);
  });

  it('produz operações fechadas em formato reaproveitável por tradeMetrics.js', () => {
    const candles = goldenCandles(500);
    const { ops, stillOpen } = runQuickBacktest(candles, {
      rfPeriod: 20, rfMult: 3.5, atrMult: 2, tp1R: 1.5, tp1QtyPercent: 50, minScore: 75, atrLen: 14,
    }, META);

    expect(Array.isArray(ops)).toBe(true);
    // Sanity real: sem isso, os asserts abaixo passariam trivialmente com
    // um array vazio e não provariam que a simulação realmente abre trade.
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(isClosedOp(op)).toBe(true);
      expect(['BUY', 'SELL']).toContain(op.side);
      expect(Number.isFinite(op.entry_price)).toBe(true);
      expect(Number.isFinite(op.initial_stop)).toBe(true);
      expect(Number.isFinite(op.exit_price)).toBe(true);
      expect(['STOP_HIT', 'TP2_HIT']).toContain(op.status);
      // Entradas em ordem cronológica não-decrescente (uma posição por vez).
    }
    for (let i = 1; i < ops.length; i++) {
      expect(new Date(ops[i].created_date).getTime()).toBeGreaterThanOrEqual(new Date(ops[i - 1].closed_at).getTime());
    }
    if (stillOpen) {
      expect(['BUY', 'SELL']).toContain(stillOpen.side);
    }
  });

  it('score mínimo mais alto nunca abre mais operações que um mais baixo (mesmo candles/parâmetros)', () => {
    const candles = goldenCandles(500);
    const base = { rfPeriod: 20, rfMult: 3.5, atrMult: 2, tp1R: 1.5, tp1QtyPercent: 50, atrLen: 14 };
    const lenient = runQuickBacktest(candles, { ...base, minScore: 50 }, META);
    const strict = runQuickBacktest(candles, { ...base, minScore: 95 }, META);
    expect(strict.ops.length).toBeLessThanOrEqual(lenient.ops.length);
  });
});
