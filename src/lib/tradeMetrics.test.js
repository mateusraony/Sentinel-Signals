import { describe, it, expect } from 'vitest';
import {
  isClosedOp,
  getClosedAt,
  getExitPrice,
  getTp1Price,
  getWeights,
  calcRealizedPnlPct,
  calcRealizedR,
  classifyOutcome,
  summarizeOps,
} from './tradeMetrics.js';

// Base BUY fixture: risk = 5 (entry 100, stop 95), tp1 = +1.5R (107.5),
// tp2 = +3R (115), 50/50 split — every expected value below is hand-computed
// from these numbers.
function makeOp(overrides = {}) {
  return {
    id: 'op1',
    side: 'BUY',
    status: 'STOP_HIT',
    entry_price: 100,
    initial_stop: 95,
    current_stop: 95,
    tp1: 107.5,
    tp2: 115,
    tp1_hit: false,
    partial_percent: 50,
    runner_percent: 50,
    closed_at: '2026-07-16T12:00:00.000Z',
    created_date: '2026-07-16T08:00:00.000Z',
    ...overrides,
  };
}

describe('calcRealizedR / calcRealizedPnlPct — BUY', () => {
  it('full stop without partial: -1R, -5%', () => {
    const op = makeOp({ exit_price: 95 });
    expect(calcRealizedR(op)).toBeCloseTo(-1.0);
    expect(calcRealizedPnlPct(op)).toBeCloseTo(-5);
    expect(classifyOutcome(op)).toBe('LOSS');
  });

  it('TP2 with partial: 0.5·7.5 + 0.5·15 = +2.25R, +11.25%', () => {
    const op = makeOp({ status: 'TP2_HIT', tp1_hit: true, exit_price: 115 });
    expect(calcRealizedR(op)).toBeCloseTo(2.25);
    expect(calcRealizedPnlPct(op)).toBeCloseTo(11.25);
    expect(classifyOutcome(op)).toBe('WIN');
  });

  it('the item-22 case — TP1 then breakeven stop: +0.75R is a WIN, not BE', () => {
    const op = makeOp({ tp1_hit: true, current_stop: 100, exit_price: 100 });
    expect(calcRealizedR(op)).toBeCloseTo(0.75); // 0.5 · 1.5R banked at TP1
    expect(calcRealizedPnlPct(op)).toBeCloseTo(3.75);
    expect(classifyOutcome(op)).toBe('WIN');
  });

  it('runner trailed above entry: 0.5·7.5 + 0.5·4 = +1.15R', () => {
    const op = makeOp({ tp1_hit: true, current_stop: 104, exit_price: 104 });
    expect(calcRealizedR(op)).toBeCloseTo(1.15);
    expect(classifyOutcome(op)).toBe('WIN');
  });

  it('gap through the stop (manual/spot exit below the level): loss deeper than -1R', () => {
    const op = makeOp({ exit_price: 92 });
    expect(calcRealizedR(op)).toBeCloseTo(-1.6);
    expect(calcRealizedPnlPct(op)).toBeCloseTo(-8);
  });
});

describe('calcRealizedR — SELL mirrors the sign', () => {
  function makeSell(overrides = {}) {
    return makeOp({ side: 'SELL', initial_stop: 105, current_stop: 105, tp1: 92.5, tp2: 85, ...overrides });
  }

  it('TP1 then breakeven stop: +0.75R WIN', () => {
    const op = makeSell({ tp1_hit: true, current_stop: 100, exit_price: 100 });
    expect(calcRealizedR(op)).toBeCloseTo(0.75); // 0.5 · (100 - 92.5)/5
    expect(classifyOutcome(op)).toBe('WIN');
  });

  it('full stop: -1R, -5%', () => {
    const op = makeSell({ exit_price: 105 });
    expect(calcRealizedR(op)).toBeCloseTo(-1.0);
    expect(calcRealizedPnlPct(op)).toBeCloseTo(-5);
    expect(classifyOutcome(op)).toBe('LOSS');
  });
});

describe('classifyOutcome — result decides, never the status', () => {
  it('a profitable INVALIDATED is a WIN', () => {
    const op = makeOp({ status: 'INVALIDATED', exit_price: 101 });
    expect(calcRealizedR(op)).toBeCloseTo(0.2);
    expect(classifyOutcome(op)).toBe('WIN');
  });

  it('an INVALIDATED inside the epsilon band is BE', () => {
    const op = makeOp({ status: 'INVALIDATED', exit_price: 100.1 });
    expect(calcRealizedR(op)).toBeCloseTo(0.02);
    expect(classifyOutcome(op)).toBe('BE'); // |0.02| ≤ 0.05R
  });

  it('open op is OPEN, everything null', () => {
    const op = makeOp({ status: 'RUNNER_ACTIVE' });
    expect(classifyOutcome(op)).toBe('OPEN');
    expect(getExitPrice(op)).toBe(null);
    expect(calcRealizedPnlPct(op)).toBe(null);
    expect(calcRealizedR(op)).toBe(null);
  });

  it('no entry_price at all → UNKNOWN', () => {
    const op = makeOp({ entry_price: null, exit_price: 95 });
    expect(classifyOutcome(op)).toBe('UNKNOWN');
  });

  it('a manually edited exit_price is respected, partial weighting included', () => {
    const op = makeOp({
      tp1_hit: true, exit_price: 110, closed_reason: 'Alterado manualmente',
    });
    // 0.5·7.5 + 0.5·10 = 8.75 → +1.75R
    expect(calcRealizedR(op)).toBeCloseTo(1.75);
    expect(classifyOutcome(op)).toBe('WIN');
  });
});

describe('legacy/corrupted docs degrade instead of disappearing', () => {
  it('zero risk (stop === entry): R null, classification falls back to PnL%', () => {
    const op = makeOp({ initial_stop: 100, exit_price: 103 });
    expect(calcRealizedR(op)).toBe(null);
    expect(calcRealizedPnlPct(op)).toBeCloseTo(3);
    expect(classifyOutcome(op)).toBe('WIN');
  });

  it('missing initial_stop: same PnL% fallback', () => {
    const op = makeOp({ initial_stop: undefined, exit_price: 95 });
    expect(calcRealizedR(op)).toBe(null);
    expect(classifyOutcome(op)).toBe('LOSS');
  });

  it('missing partial_percent defaults to 50/50; custom split honoured', () => {
    const base = { tp1_hit: true, current_stop: 100, exit_price: 100 };
    const legacy = makeOp({ ...base, partial_percent: undefined, runner_percent: undefined });
    expect(calcRealizedR(legacy)).toBeCloseTo(0.75);
    const thirty = makeOp({ ...base, partial_percent: 30, runner_percent: 70 });
    expect(calcRealizedR(thirty)).toBeCloseTo(0.3 * 1.5); // 0.45
    expect(getWeights(thirty)).toEqual({ partial: 0.3, runner: 0.7 });
  });

  it('corrupted weights: runner is always the complement of partial', () => {
    expect(getWeights(makeOp({ partial_percent: 60, runner_percent: 60 })))
      .toEqual({ partial: 0.6, runner: 0.4 });
  });

  it('tp1_hit without any recoverable TP1 price degrades to 100% at exit', () => {
    const op = makeOp({ tp1_hit: true, tp1: null, tp1_hit_price: null, exit_price: 100 });
    expect(calcRealizedR(op)).toBeCloseTo(0); // no banked leg recoverable
    expect(classifyOutcome(op)).toBe('BE');
  });

  it('getTp1Price prefers tp1_hit_price, falls back to tp1', () => {
    expect(getTp1Price(makeOp({ tp1_hit_price: 107 }))).toBe(107);
    expect(getTp1Price(makeOp())).toBe(107.5);
  });
});

describe('getExitPrice — legacy fallbacks by status (no exit_price persisted)', () => {
  it('TP2_HIT falls back to tp2', () => {
    expect(getExitPrice(makeOp({ status: 'TP2_HIT' }))).toBe(115);
  });

  it('STOP_HIT falls back to current_stop, including post-TP1 breakeven', () => {
    expect(getExitPrice(makeOp())).toBe(95);
    expect(getExitPrice(makeOp({ tp1_hit: true, current_stop: 100 }))).toBe(100);
  });

  it('CLOSED/INVALIDATED fall back to current_stop', () => {
    expect(getExitPrice(makeOp({ status: 'CLOSED' }))).toBe(95);
    expect(getExitPrice(makeOp({ status: 'INVALIDATED', current_stop: 101 }))).toBe(101);
  });
});

describe('summarizeOps', () => {
  it('aggregates a known sequence with the single win-rate rule', () => {
    const ops = [
      makeOp({ id: 'a', exit_price: 95, closed_at: '2026-07-10T00:00:00Z' }), // -1R, -5%
      makeOp({ id: 'b', status: 'TP2_HIT', tp1_hit: true, exit_price: 115, closed_at: '2026-07-11T00:00:00Z' }), // +2.25R, +11.25%
      makeOp({ id: 'c', tp1_hit: true, current_stop: 100, exit_price: 100, closed_at: '2026-07-12T00:00:00Z' }), // +0.75R, +3.75%
      makeOp({ id: 'd', status: 'INVALIDATED', exit_price: 100.1, closed_at: '2026-07-13T00:00:00Z' }), // +0.02R BE
      makeOp({ id: 'e', status: 'RUNNER_ACTIVE' }), // open — ignored
    ];
    const s = summarizeOps(ops);
    expect(s.total).toBe(4);
    expect(s.counted).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.be).toBe(1);
    expect(s.winRate).toBeCloseTo(50); // 2 / (2+1+1)
    expect(s.totalPnlPct).toBeCloseTo(-5 + 11.25 + 3.75 + 0.1);
    expect(s.expectancyR).toBeCloseTo((-1 + 2.25 + 0.75 + 0.02) / 4);
    expect(s.rCounted).toBe(4);
    expect(s.profitFactor).toBeCloseTo((11.25 + 3.75 + 0.1) / 5);
    // Cumulative: -5 → +6.25 → +10 → +10.1; the only peak-to-trough is the
    // initial -5 from peak 0.
    expect(s.maxDrawdownPct).toBeCloseTo(5);
    expect(s.curve.map((p) => p.op.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('orders the curve by close time, not creation time (sortBy default)', () => {
    const ops = [
      makeOp({ id: 'late-close', created_date: '2026-07-01T00:00:00Z', closed_at: '2026-07-20T00:00:00Z', exit_price: 95 }),
      makeOp({ id: 'early-close', created_date: '2026-07-02T00:00:00Z', closed_at: '2026-07-10T00:00:00Z', exit_price: 95 }),
    ];
    expect(summarizeOps(ops).curve.map((p) => p.op.id)).toEqual(['early-close', 'late-close']);
    expect(summarizeOps(ops, { sortBy: 'created' }).curve.map((p) => p.op.id)).toEqual(['late-close', 'early-close']);
  });

  it('empty list yields zeros and nulls, never NaN', () => {
    const s = summarizeOps([]);
    expect(s.total).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.totalPnlPct).toBe(0);
    expect(s.expectancyR).toBe(null);
    expect(s.profitFactor).toBe(null);
    expect(s.maxDrawdownPct).toBe(0);
  });

  it('profitFactor is null (render ∞) when there are no losses', () => {
    const s = summarizeOps([makeOp({ status: 'TP2_HIT', tp1_hit: true, exit_price: 115 })]);
    expect(s.profitFactor).toBe(null);
    expect(s.wins).toBe(1);
  });

  it('UNKNOWN ops are counted separately and excluded from the denominators', () => {
    const s = summarizeOps([
      makeOp({ exit_price: 95 }),
      makeOp({ id: 'broken', entry_price: null }),
    ]);
    expect(s.total).toBe(2);
    expect(s.counted).toBe(1);
    expect(s.unknown).toBe(1);
    expect(s.winRate).toBe(0); // 0 wins / 1 counted
  });
});

describe('small helpers', () => {
  it('isClosedOp mirrors the terminal status list', () => {
    for (const status of ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED']) {
      expect(isClosedOp(makeOp({ status }))).toBe(true);
    }
    expect(isClosedOp(makeOp({ status: 'SIGNAL_CONFIRMED' }))).toBe(false);
    expect(isClosedOp(null)).toBe(false);
  });

  it('getClosedAt prefers closed_at, then updated_date, then created_date', () => {
    expect(getClosedAt(makeOp())).toBe('2026-07-16T12:00:00.000Z');
    expect(getClosedAt(makeOp({ closed_at: undefined, updated_date: 'u' }))).toBe('u');
    expect(getClosedAt(makeOp({ closed_at: undefined }))).toBe('2026-07-16T08:00:00.000Z');
  });
});
