import { describe, it, expect } from 'vitest';
import { summarizeFibEntry } from './fibEntryReport.js';

const sig = (id, extra = {}) => ({ id, dedup_key: id, timeframe: '4h', source: 'range_filter', candle_time: '2026-01-10T00:00:00.000Z', ...extra });
const op = (id, extra = {}) => ({ id: `trade_${id}`, exit_mode: 'FIB_FIXED', entry_price: 100, initial_stop: 99, fib_bars_waited: 2, ...extra });

describe('summarizeFibEntry — contagem por sinal e saídas (item 267)', () => {
  it('cada sinal cai em um balde: filled se a operação existe, senão o último motivo', () => {
    const r = summarizeFibEntry({
      signals: [
        sig('a'), sig('b', { last_rejection_reason: 'fib_expired' }), sig('c', { last_rejection_reason: 'fib_fill_missed' }),
        sig('d'), sig('x', { source: 'rsi' }), sig('old', { candle_time: '2025-01-01T00:00:00.000Z' }),
      ],
      ops: [op('a', { status: 'TP2_HIT', tp1_hit: true }), op('c', { status: 'STOP_HIT' })],
      fromMs: Date.parse('2026-01-01'), toMs: Date.parse('2026-02-01'),
    });
    // 'c' tem operação → filled, mesmo com fib_fill_missed gravado depois.
    expect(r.byStatus).toEqual({ filled: 2, fib_expired: 1, no_retry: 1 });
    expect(r.signals).toBe(4);
    expect(r.fillRate).toBe(0.5);
  });

  it('saídas por motivo, empates, gaps e tamanho do stop', () => {
    const r = summarizeFibEntry({
      signals: [],
      ops: [
        op('1', { status: 'STOP_HIT', exit_ambiguous: true }),
        op('2', { status: 'STOP_HIT', tp1_hit: true, fib_gap_exit: true }),
        op('3', { status: 'TP2_HIT', tp1_hit: true }),
        op('4', { status: 'CLOSED', closed_reason: 'TIME_STOP' }),
        op('5', { status: 'SIGNAL_CONFIRMED' }),
        { id: 'trade_z', exit_mode: 'HYBRID_RF_ATR', status: 'STOP_HIT', entry_price: 100, initial_stop: 90 },
      ],
    });
    expect(r.ops).toBe(5);
    expect(r.closedOps).toBe(4);
    expect(r.exits).toEqual({ stopBeforeTp1: 1, breakevenAfterTp1: 1, tp2: 1, timeStop: 1, other: 0 });
    expect(r.tp1Rate).toBe(0.5);
    expect(r.exitAmbiguous).toBe(1);
    expect(r.gapExits).toBe(1);
    expect(r.avgStopDistancePct).toBeCloseTo(1, 10);
    expect(r.avgBarsWaited).toBe(2);
  });
});
