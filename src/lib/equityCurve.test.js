import { describe, it, expect } from 'vitest';
import { ZERO_COST, calcRealizedR, calcRealizedPnlPct, summarizeOps } from './tradeMetrics.js';
import {
  simulateEquityCurve,
  compoundReturnCurve,
  DEFAULT_INITIAL_CAPITAL,
  DEFAULT_RISK_PCT,
} from './equityCurve.js';

// Same base BUY fixture as tradeMetrics.test.js: risk = 5 (entry 100, stop
// 95), tp1 = +1.5R (107.5), tp2 = +3R (115), 50/50 split.
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

describe('simulateEquityCurve — dimensionamento simples', () => {
  it('1 operação, -1R bruto: riskDollars=100, pnlDollars=-100, capital 10000→9900', () => {
    const op = makeOp({ id: 'op1', exit_price: 95 });
    const sim = simulateEquityCurve([op], { initialCapital: 10000, riskPct: 1, costModel: ZERO_COST });
    expect(sim.curve).toHaveLength(1);
    expect(sim.curve[0].sized).toBe(true);
    expect(sim.curve[0].r).toBeCloseTo(-1.0);
    expect(sim.curve[0].capitalBefore).toBe(10000);
    expect(sim.curve[0].riskDollars).toBeCloseTo(100);
    expect(sim.curve[0].pnlDollars).toBeCloseTo(-100);
    expect(sim.curve[0].capitalAfter).toBeCloseTo(9900);
    expect(sim.finalCapital).toBeCloseTo(9900);
    expect(sim.totalReturnPct).toBeCloseTo(-1);
  });

  it('usa os defaults exportados quando options é omitido', () => {
    const op = makeOp({ id: 'op1', exit_price: 95 });
    const sim = simulateEquityCurve([op], { costModel: ZERO_COST });
    expect(sim.initialCapital).toBe(DEFAULT_INITIAL_CAPITAL);
    expect(sim.riskPct).toBe(DEFAULT_RISK_PCT);
  });
});

describe('simulateEquityCurve — composição ao longo de várias operações', () => {
  it('cada capitalAfter é capitalBefore × (1 + R·riscoFração), acumulado passo a passo', () => {
    // op1: TP2 com parcial = +2.25R; op2: stop cheio = -1R; op3: TP1+breakeven = +0.75R
    const op1 = makeOp({ id: 'op1', status: 'TP2_HIT', tp1_hit: true, exit_price: 115, closed_at: '2026-07-10T00:00:00.000Z' });
    const op2 = makeOp({ id: 'op2', exit_price: 95, closed_at: '2026-07-11T00:00:00.000Z' });
    const op3 = makeOp({ id: 'op3', tp1_hit: true, current_stop: 100, exit_price: 100, closed_at: '2026-07-12T00:00:00.000Z' });

    const sim = simulateEquityCurve([op1, op2, op3], { initialCapital: 10000, riskPct: 1, costModel: ZERO_COST });
    const riskFraction = 0.01;

    expect(sim.curve[0].r).toBeCloseTo(2.25);
    const capital1 = 10000 * (1 + 2.25 * riskFraction);
    expect(sim.curve[0].capitalAfter).toBeCloseTo(capital1);

    expect(sim.curve[1].r).toBeCloseTo(-1.0);
    const capital2 = capital1 * (1 + -1.0 * riskFraction);
    expect(sim.curve[1].capitalBefore).toBeCloseTo(capital1);
    expect(sim.curve[1].capitalAfter).toBeCloseTo(capital2);

    expect(sim.curve[2].r).toBeCloseTo(0.75);
    const capital3 = capital2 * (1 + 0.75 * riskFraction);
    expect(sim.curve[2].capitalBefore).toBeCloseTo(capital2);
    expect(sim.curve[2].capitalAfter).toBeCloseTo(capital3);

    expect(sim.finalCapital).toBeCloseTo(capital3);
  });
});

describe('simulateEquityCurve — drawdown real diverge do drawdown ingênuo', () => {
  it('ganho grande cedo infla a base do próximo drawdown (compounding), diferente da soma % simples', () => {
    // R multiples: +5R, depois três -1R seguidos. pnlPct correspondente
    // (risk=5% do preço de entrada) seria +25%, -5%, -5%, -5% — a soma
    // ingênua (summarizeOps.cumulativePct) teria drawdown = 15 (25→10).
    const opWin = makeOp({ id: 'win', status: 'TP2_HIT', exit_price: 125, closed_at: '2026-07-01T00:00:00.000Z' });
    // (125-100)/5 = 5R
    const opLoss1 = makeOp({ id: 'l1', exit_price: 95, closed_at: '2026-07-02T00:00:00.000Z' });
    const opLoss2 = makeOp({ id: 'l2', exit_price: 95, closed_at: '2026-07-03T00:00:00.000Z' });
    const opLoss3 = makeOp({ id: 'l3', exit_price: 95, closed_at: '2026-07-04T00:00:00.000Z' });
    const ops = [opWin, opLoss1, opLoss2, opLoss3];

    expect(calcRealizedR(opWin, ZERO_COST)).toBeCloseTo(5);

    const naiveDrawdownPct = 15; // hand-computed acima (25 → 20 → 15 → 10)
    const sim = simulateEquityCurve(ops, { initialCapital: 10000, riskPct: 1, costModel: ZERO_COST });

    // Real (compounding): pico sobe pra 10500 depois do +5R, e as perdas
    // seguintes são 1% de um capital MAIOR, mas o pico também é maior — o
    // drawdown percentual real fica bem abaixo do ingênuo.
    expect(sim.maxDrawdownPct).toBeLessThan(naiveDrawdownPct / 2);
    expect(sim.maxDrawdownPct).toBeCloseTo(2.9704668, 3);
  });
});

describe('simulateEquityCurve — conta zerada', () => {
  it('capital some (gap through do stop, riskPct=100%): trava em 0 e para de compor', () => {
    const opGap = makeOp({ id: 'gap', exit_price: 92, closed_at: '2026-07-01T00:00:00.000Z' }); // -1.6R
    const opAfter = makeOp({ id: 'after', exit_price: 95, closed_at: '2026-07-02T00:00:00.000Z' });

    const sim = simulateEquityCurve([opGap, opAfter], { initialCapital: 1000, riskPct: 100, costModel: ZERO_COST });

    expect(sim.curve[0].sized).toBe(true);
    expect(sim.curve[0].capitalAfter).toBe(0);
    expect(sim.accountBlown).toBe(true);

    expect(sim.curve[1].sized).toBe(false);
    expect(sim.curve[1].reason).toBe('account_blown');
    expect(sim.curve[1].capitalBefore).toBe(0);
    expect(sim.curve[1].capitalAfter).toBe(0);

    expect(sim.finalCapital).toBe(0);
    expect(sim.totalReturnPct).toBeCloseTo(-100);
  });
});

describe('simulateEquityCurve — TP1 + runner', () => {
  it('TP1 então breakeven (+0.75R): pnlDollars = R × capitalBefore × riscoFração', () => {
    const op = makeOp({ tp1_hit: true, current_stop: 100, exit_price: 100 });
    const sim = simulateEquityCurve([op], { initialCapital: 10000, riskPct: 1, costModel: ZERO_COST });
    expect(sim.curve[0].r).toBeCloseTo(0.75);
    expect(sim.curve[0].pnlDollars).toBeCloseTo(0.75 * 10000 * 0.01);
    expect(sim.curve[0].capitalAfter).toBeCloseTo(10075);
  });

  it('runner trailed acima da entrada (+1.15R): mesma fórmula', () => {
    const op = makeOp({ tp1_hit: true, current_stop: 104, exit_price: 104 });
    const sim = simulateEquityCurve([op], { initialCapital: 10000, riskPct: 1, costModel: ZERO_COST });
    expect(sim.curve[0].r).toBeCloseTo(1.15);
    expect(sim.curve[0].pnlDollars).toBeCloseTo(1.15 * 10000 * 0.01);
  });
});

describe('simulateEquityCurve — operação sem risco válido', () => {
  it('initial_stop ausente: sized=false, capital inalterado', () => {
    const op = makeOp({ initial_stop: null, exit_price: 95 });
    const sim = simulateEquityCurve([op], { initialCapital: 10000, riskPct: 1, costModel: ZERO_COST });
    expect(sim.curve[0].sized).toBe(false);
    expect(sim.curve[0].reason).toBe('unsized_no_r');
    expect(sim.curve[0].capitalAfter).toBe(10000);
    expect(sim.finalCapital).toBe(10000);
    expect(sim.unsized).toBe(1);
    expect(sim.sized).toBe(0);
  });
});

describe('simulateEquityCurve — CAGR', () => {
  it('janela curta (4h): cagrPct null, unavailableReason window_too_short', () => {
    const op = makeOp({ exit_price: 95 }); // created_date/closed_at do fixture, 4h de diferença
    const sim = simulateEquityCurve([op], { initialCapital: 10000, riskPct: 1, costModel: ZERO_COST });
    expect(sim.cagrPct).toBeNull();
    expect(sim.cagrUnavailableReason).toBe('window_too_short');
    expect(sim.totalReturnPct).toBeCloseTo(-1); // totalReturnPct continua calculado
  });

  it('janela de ~1 ano: cagrPct calculável e próximo do retorno total', () => {
    const op = makeOp({
      exit_price: 105, // (105-100)/5 = +1R
      created_date: '2025-01-01T00:00:00.000Z',
      closed_at: '2026-01-01T00:00:00.000Z',
    });
    const sim = simulateEquityCurve([op], { initialCapital: 10000, riskPct: 1, costModel: ZERO_COST });
    expect(sim.years).toBeCloseTo(1, 2);
    expect(sim.cagrUnavailableReason).toBeNull();
    // Janela ~1 ano: CAGR converge para o retorno total de uma única operação.
    expect(sim.cagrPct).toBeCloseTo(sim.totalReturnPct, 1);
  });
});

describe('simulateEquityCurve — validação de entrada', () => {
  it('initialCapital <= 0 lança', () => {
    expect(() => simulateEquityCurve([], { initialCapital: 0 })).toThrow();
    expect(() => simulateEquityCurve([], { initialCapital: -100 })).toThrow();
  });

  it('riskPct fora de (0,100] lança', () => {
    expect(() => simulateEquityCurve([], { riskPct: 0 })).toThrow();
    expect(() => simulateEquityCurve([], { riskPct: 101 })).toThrow();
    expect(() => simulateEquityCurve([], { riskPct: -1 })).toThrow();
  });
});

describe('simulateEquityCurve — custo aplicado por padrão', () => {
  it('sem costModel explícito (default), pnlDollars é pior que com ZERO_COST', () => {
    const op = makeOp({ id: 'op1', exit_price: 95 });
    const simNet = simulateEquityCurve([op], { initialCapital: 10000, riskPct: 1 }); // costModel default
    const simGross = simulateEquityCurve([op], { initialCapital: 10000, riskPct: 1, costModel: ZERO_COST });

    expect(simNet.curve[0].pnlDollars).toBeLessThan(simGross.curve[0].pnlDollars);
    // Ambos dimensionam sobre o MESMO capitalBefore (10000, 1ª operação) —
    // a diferença vem só do custo embutido em calcRealizedR.
    const rNet = calcRealizedR(op);
    const rGross = calcRealizedR(op, ZERO_COST);
    expect(simNet.curve[0].pnlDollars).toBeCloseTo(rNet * 10000 * 0.01);
    expect(simGross.curve[0].pnlDollars).toBeCloseTo(rGross * 10000 * 0.01);
  });
});

describe('simulateEquityCurve — lista vazia / sem operações fechadas', () => {
  it('lista vazia: finalCapital = initialCapital, curve vazia, sem lançar', () => {
    const sim = simulateEquityCurve([], { initialCapital: 5000, riskPct: 1 });
    expect(sim.finalCapital).toBe(5000);
    expect(sim.curve).toEqual([]);
    expect(sim.total).toBe(0);
  });

  it('operações ainda abertas são ignoradas (isClosedOp filtra)', () => {
    const op = makeOp({ status: 'RUNNER_ACTIVE' });
    const sim = simulateEquityCurve([op], { initialCapital: 5000, riskPct: 1 });
    expect(sim.curve).toEqual([]);
    expect(sim.finalCapital).toBe(5000);
  });
});

describe('compoundReturnCurve — 100% do capital realocado a cada operação', () => {
  it('1 operação: cumulativePct = pnlPct dessa operação', () => {
    const op = makeOp({ exit_price: 95 }); // -1R, -5% (ZERO_COST)
    const curve = compoundReturnCurve([op], { costModel: ZERO_COST });
    expect(curve).toHaveLength(1);
    expect(curve[0].pnlPct).toBeCloseTo(-5);
    expect(curve[0].cumulativePct).toBeCloseTo(-5);
  });

  it('compõe (multiplica), não soma: +11.25% depois -5% ≠ soma ingênua de 6.25%', () => {
    // op1: TP2 com parcial = +2.25R = +11.25%; op2: stop cheio = -1R = -5%
    const op1 = makeOp({ id: 'op1', status: 'TP2_HIT', tp1_hit: true, exit_price: 115, closed_at: '2026-07-10T00:00:00.000Z' });
    const op2 = makeOp({ id: 'op2', exit_price: 95, closed_at: '2026-07-11T00:00:00.000Z' });

    const curve = compoundReturnCurve([op1, op2], { costModel: ZERO_COST });
    expect(curve[0].pnlPct).toBeCloseTo(11.25);
    expect(curve[1].pnlPct).toBeCloseTo(-5);

    // fator = 1.1125 × 0.95 = 1.056875 → +5.6875%, não +6.25% (soma ingênua)
    const expectedCompounded = ((1 + 11.25 / 100) * (1 + -5 / 100) - 1) * 100;
    expect(expectedCompounded).toBeCloseTo(5.6875);
    expect(curve[1].cumulativePct).toBeCloseTo(expectedCompounded);

    const naiveSum = summarizeOps([op1, op2], { costModel: ZERO_COST }).totalPnlPct;
    expect(naiveSum).toBeCloseTo(6.25);
    expect(curve[1].cumulativePct).not.toBeCloseTo(naiveSum, 1);
  });

  it('operação com pnlPct não computável (sem exit_price recuperável): cumulativePct não muda', () => {
    const op1 = makeOp({ id: 'op1', exit_price: 95, closed_at: '2026-07-10T00:00:00.000Z' }); // -5%
    const op2 = makeOp({ id: 'op2', status: 'CLOSED', current_stop: undefined, exit_price: undefined, closed_at: '2026-07-11T00:00:00.000Z' });

    const curve = compoundReturnCurve([op1, op2], { costModel: ZERO_COST });
    expect(curve[0].pnlPct).toBeCloseTo(-5);
    expect(curve[1].pnlPct).toBeNull();
    expect(curve[1].cumulativePct).toBeCloseTo(curve[0].cumulativePct);
  });

  it('custo aplicado por padrão: cumulativePct sem costModel é pior que com ZERO_COST', () => {
    const op = makeOp({ exit_price: 95 });
    const curveNet = compoundReturnCurve([op]);
    const curveGross = compoundReturnCurve([op], { costModel: ZERO_COST });
    expect(curveNet[0].pnlPct).toBeLessThan(curveGross[0].pnlPct);
    expect(curveNet[0].pnlPct).toBeCloseTo(calcRealizedPnlPct(op));
    expect(curveGross[0].pnlPct).toBeCloseTo(calcRealizedPnlPct(op, ZERO_COST));
  });

  it('lista vazia: curve vazia, sem lançar', () => {
    expect(compoundReturnCurve([])).toEqual([]);
  });

  it('mesmo formato de entrada de summarizeOps().curve (op, outcome, pnlPct, cumulativePct)', () => {
    const op = makeOp({ exit_price: 95 });
    const [entry] = compoundReturnCurve([op], { costModel: ZERO_COST });
    expect(Object.keys(entry).sort()).toEqual(['cumulativePct', 'op', 'outcome', 'pnlPct'].sort());
    expect(entry.outcome).toBe('LOSS');
  });
});
