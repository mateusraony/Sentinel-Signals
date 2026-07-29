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
  ZERO_COST,
  calcTradeCost,
  calcCostR,
  calcRAtTp1,
  countFundingSettlements,
  countFundingSettlementsByLeg,
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
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(-1.0);
    expect(calcRealizedPnlPct(op, ZERO_COST)).toBeCloseTo(-5);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('LOSS');
  });

  it('TP2 with partial: 0.5·7.5 + 0.5·15 = +2.25R, +11.25%', () => {
    const op = makeOp({ status: 'TP2_HIT', tp1_hit: true, exit_price: 115 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(2.25);
    expect(calcRealizedPnlPct(op, ZERO_COST)).toBeCloseTo(11.25);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('WIN');
  });

  it('the item-22 case — TP1 then breakeven stop: +0.75R is a WIN, not BE', () => {
    const op = makeOp({ tp1_hit: true, current_stop: 100, exit_price: 100 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(0.75); // 0.5 · 1.5R banked at TP1
    expect(calcRealizedPnlPct(op, ZERO_COST)).toBeCloseTo(3.75);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('WIN');
  });

  it('runner trailed above entry: 0.5·7.5 + 0.5·4 = +1.15R', () => {
    const op = makeOp({ tp1_hit: true, current_stop: 104, exit_price: 104 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(1.15);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('WIN');
  });

  it('gap through the stop (manual/spot exit below the level): loss deeper than -1R', () => {
    const op = makeOp({ exit_price: 92 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(-1.6);
    expect(calcRealizedPnlPct(op, ZERO_COST)).toBeCloseTo(-8);
  });
});

describe('calcRealizedR — SELL mirrors the sign', () => {
  function makeSell(overrides = {}) {
    return makeOp({ side: 'SELL', initial_stop: 105, current_stop: 105, tp1: 92.5, tp2: 85, ...overrides });
  }

  it('TP1 then breakeven stop: +0.75R WIN', () => {
    const op = makeSell({ tp1_hit: true, current_stop: 100, exit_price: 100 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(0.75); // 0.5 · (100 - 92.5)/5
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('WIN');
  });

  it('full stop: -1R, -5%', () => {
    const op = makeSell({ exit_price: 105 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(-1.0);
    expect(calcRealizedPnlPct(op, ZERO_COST)).toBeCloseTo(-5);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('LOSS');
  });
});

describe('calcRAtTp1 — o contrafactual "fechou tudo no TP1"', () => {
  it('BUY: (107.5 - 100) / 5 = +1.5R, independente de onde o runner saiu', () => {
    // Mesma op, três desfechos MUITO diferentes do runner — o R no TP1 é o
    // mesmo nos três, porque só depende de entrada/stop/TP1. É isso que torna
    // a atribuição do runner uma subtração limpa.
    for (const exit of [100, 104, 115]) {
      expect(calcRAtTp1(makeOp({ tp1_hit: true, exit_price: exit }))).toBeCloseTo(1.5);
    }
  });

  it('SELL espelha o sinal: (100 - 92.5) / 5 = +1.5R, nunca negativo', () => {
    const op = makeOp({ side: 'SELL', initial_stop: 105, tp1: 92.5, tp2: 85, tp1_hit: true, exit_price: 100 });
    expect(calcRAtTp1(op)).toBeCloseTo(1.5);
  });

  it('quantifica o runner: BUY parado no breakeven perdeu 0.75R por deixar correr', () => {
    // Bruto contra bruto — a ÚNICA comparação honesta (misturar líquido com
    // bruto infla o resultado a favor da hipótese, ver known-risks item 46).
    const op = makeOp({ tp1_hit: true, current_stop: 100, exit_price: 100 });
    expect(calcRealizedR(op, ZERO_COST) - calcRAtTp1(op)).toBeCloseTo(-0.75);
  });

  it('quando o runner PAGA, a atribuição é positiva (TP2 = +0.75R sobre o TP1)', () => {
    const op = makeOp({ status: 'TP2_HIT', tp1_hit: true, exit_price: 115 });
    expect(calcRealizedR(op, ZERO_COST) - calcRAtTp1(op)).toBeCloseTo(0.75);
  });

  it('op que nunca atingiu TP1 não entra na conta', () => {
    expect(calcRAtTp1(makeOp({ exit_price: 95 }))).toBeNull();
  });

  it('risco zero, stop ausente ou TP1 irrecuperável devolvem null sem lançar', () => {
    expect(calcRAtTp1(makeOp({ tp1_hit: true, initial_stop: 100, exit_price: 100 }))).toBeNull();
    expect(calcRAtTp1(makeOp({ tp1_hit: true, initial_stop: undefined, exit_price: 100 }))).toBeNull();
    expect(calcRAtTp1(makeOp({ tp1_hit: true, tp1: null, tp1_hit_price: null, exit_price: 100 }))).toBeNull();
    expect(calcRAtTp1(null)).toBeNull();
  });
});

describe('classifyOutcome — result decides, never the status', () => {
  it('a profitable INVALIDATED is a WIN', () => {
    const op = makeOp({ status: 'INVALIDATED', exit_price: 101 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(0.2);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('WIN');
  });

  it('an INVALIDATED inside the epsilon band is BE', () => {
    const op = makeOp({ status: 'INVALIDATED', exit_price: 100.1 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(0.02);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('BE'); // |0.02| ≤ 0.05R
  });

  it('open op is OPEN, everything null', () => {
    const op = makeOp({ status: 'RUNNER_ACTIVE' });
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('OPEN');
    expect(getExitPrice(op)).toBe(null);
    expect(calcRealizedPnlPct(op, ZERO_COST)).toBe(null);
    expect(calcRealizedR(op, ZERO_COST)).toBe(null);
  });

  it('no entry_price at all → UNKNOWN', () => {
    const op = makeOp({ entry_price: null, exit_price: 95 });
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('UNKNOWN');
  });

  it('a manually edited exit_price is respected, partial weighting included', () => {
    const op = makeOp({
      tp1_hit: true, exit_price: 110, closed_reason: 'Alterado manualmente',
    });
    // 0.5·7.5 + 0.5·10 = 8.75 → +1.75R
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(1.75);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('WIN');
  });
});

describe('legacy/corrupted docs degrade instead of disappearing', () => {
  it('zero risk (stop === entry): R null, classification falls back to PnL%', () => {
    const op = makeOp({ initial_stop: 100, exit_price: 103 });
    expect(calcRealizedR(op, ZERO_COST)).toBe(null);
    expect(calcRealizedPnlPct(op, ZERO_COST)).toBeCloseTo(3);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('WIN');
  });

  it('missing initial_stop: same PnL% fallback', () => {
    const op = makeOp({ initial_stop: undefined, exit_price: 95 });
    expect(calcRealizedR(op, ZERO_COST)).toBe(null);
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('LOSS');
  });

  it('missing partial_percent defaults to 50/50; custom split honoured', () => {
    const base = { tp1_hit: true, current_stop: 100, exit_price: 100 };
    const legacy = makeOp({ ...base, partial_percent: undefined, runner_percent: undefined });
    expect(calcRealizedR(legacy, ZERO_COST)).toBeCloseTo(0.75);
    const thirty = makeOp({ ...base, partial_percent: 30, runner_percent: 70 });
    expect(calcRealizedR(thirty, ZERO_COST)).toBeCloseTo(0.3 * 1.5); // 0.45
    expect(getWeights(thirty)).toEqual({ partial: 0.3, runner: 0.7 });
  });

  it('corrupted weights: runner is always the complement of partial', () => {
    expect(getWeights(makeOp({ partial_percent: 60, runner_percent: 60 })))
      .toEqual({ partial: 0.6, runner: 0.4 });
  });

  it('tp1_hit without any recoverable TP1 price degrades to 100% at exit', () => {
    const op = makeOp({ tp1_hit: true, tp1: null, tp1_hit_price: null, exit_price: 100 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(0); // no banked leg recoverable
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('BE');
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
    const s = summarizeOps(ops, { costModel: ZERO_COST });
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
    expect(summarizeOps(ops, { costModel: ZERO_COST }).curve.map((p) => p.op.id)).toEqual(['early-close', 'late-close']);
    expect(summarizeOps(ops, { sortBy: 'created', costModel: ZERO_COST }).curve.map((p) => p.op.id)).toEqual(['late-close', 'early-close']);
  });

  it('empty list yields zeros and nulls, never NaN', () => {
    const s = summarizeOps([], { costModel: ZERO_COST });
    expect(s.total).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.totalPnlPct).toBe(0);
    expect(s.expectancyR).toBe(null);
    expect(s.profitFactor).toBe(null);
    expect(s.maxDrawdownPct).toBe(0);
  });

  it('profitFactor is null (render ∞) when there are no losses', () => {
    const s = summarizeOps([makeOp({ status: 'TP2_HIT', tp1_hit: true, exit_price: 115 })], { costModel: ZERO_COST });
    expect(s.profitFactor).toBe(null);
    expect(s.wins).toBe(1);
  });

  it('UNKNOWN ops are counted separately and excluded from the denominators', () => {
    const s = summarizeOps([
      makeOp({ exit_price: 95 }),
      makeOp({ id: 'broken', entry_price: null }),
    ], { costModel: ZERO_COST });
    expect(s.total).toBe(2);
    expect(s.counted).toBe(1);
    expect(s.unknown).toBe(1);
    expect(s.winRate).toBe(0); // 0 wins / 1 counted
  });
});

// Fase 5 (docs/known-risks.md item 44) — custo real descontado por padrão.
// Fixture base: entry 100, stop 95 (risco = 5), tp1 107.5, 50/50.
// Custo default = (5 + 1) bps na entrada + (5 + 1) bps na saída = 6 bps/lado.
describe('custo de transação (Fase 5)', () => {
  it('calcTradeCost: 2 fills sem parcial, cobrando cada perna no preço do próprio fill', () => {
    const op = makeOp({ exit_price: 95, closed_at: '2026-07-16T09:00:00.000Z' });
    const c = calcTradeCost(op);
    // entrada: 100 × 0.0006 = 0.06 | saída: 95 × 0.0006 = 0.057
    expect(c.fills).toBe(2);
    expect(c.entryCost).toBeCloseTo(0.06, 6);
    expect(c.exitCost).toBeCloseTo(0.057, 6);
    expect(c.fundingCost).toBe(0); // 08:00→09:00 não cruza fronteira de 8h
    expect(c.total).toBeCloseTo(0.117, 6);
  });

  it('calcTradeCost: 3 fills com parcial no TP1, cada perna no seu preço', () => {
    const op = makeOp({
      status: 'TP2_HIT', tp1_hit: true, exit_price: 115, closed_at: '2026-07-16T09:00:00.000Z',
    });
    const c = calcTradeCost(op);
    // saída: (0.5×107.5 + 0.5×115) × 0.0006 = 111.25 × 0.0006 = 0.06675
    expect(c.fills).toBe(3);
    expect(c.exitCost).toBeCloseTo(0.06675, 6);
    expect(c.total).toBeCloseTo(0.06 + 0.06675, 6);
  });

  it('o custo é sempre CONTRA o trader, em BUY e em SELL', () => {
    const buy = makeOp({ exit_price: 95, closed_at: '2026-07-16T09:00:00.000Z' });
    const sell = makeOp({
      side: 'SELL', entry_price: 100, initial_stop: 105, exit_price: 105,
      closed_at: '2026-07-16T09:00:00.000Z',
    });
    // Nos dois casos o R líquido é PIOR que o bruto (custo nunca ajuda).
    expect(calcRealizedR(buy)).toBeLessThan(calcRealizedR(buy, ZERO_COST));
    expect(calcRealizedR(sell)).toBeLessThan(calcRealizedR(sell, ZERO_COST));
    expect(calcTradeCost(buy).total).toBeGreaterThan(0);
    expect(calcTradeCost(sell).total).toBeGreaterThan(0);
  });

  it('uma operação marginalmente vencedora vira LOSS por causa do custo', () => {
    // Ganho bruto de 0.10 em preço (0.02R); custo ≈ 0.12 -> resultado negativo.
    const op = makeOp({ exit_price: 100.1, closed_at: '2026-07-16T09:00:00.000Z' });
    expect(classifyOutcome(op, { costModel: ZERO_COST })).toBe('BE'); // 0.02R bruto
    expect(calcRealizedR(op)).toBeLessThan(0);
    expect(calcRealizedPnlPct(op)).toBeLessThan(0);
  });

  it('ZERO_COST reproduz exatamente os números brutos', () => {
    const op = makeOp({ exit_price: 95 });
    expect(calcRealizedR(op, ZERO_COST)).toBeCloseTo(-1.0);
    expect(calcTradeCost(op, ZERO_COST).total).toBe(0);
  });

  it('calcCostR expressa o custo em múltiplos do risco inicial', () => {
    const op = makeOp({ exit_price: 95, closed_at: '2026-07-16T09:00:00.000Z' });
    // custo 0.117 / risco 5 = 0.0234R
    expect(calcCostR(op)).toBeCloseTo(0.0234, 6);
    // Risco menor (stop mais apertado) => MESMO custo pesa mais em R.
    const tight = makeOp({ initial_stop: 99.5, exit_price: 99.5, closed_at: '2026-07-16T09:00:00.000Z' });
    expect(calcCostR(tight)).toBeGreaterThan(calcCostR(op) * 5);
  });

  it('funding conta fronteiras de 8h cruzadas, não duração', () => {
    const noCross = makeOp({
      candle_close_time: '2026-07-16T09:00:00.000Z', closed_at: '2026-07-16T15:59:00.000Z',
    });
    expect(countFundingSettlements(noCross)).toBe(0); // ~7h dentro da mesma janela

    const oneCross = makeOp({
      candle_close_time: '2026-07-16T07:59:00.000Z', closed_at: '2026-07-16T08:01:00.000Z',
    });
    expect(countFundingSettlements(oneCross)).toBe(1); // 2 minutos, mas cruza 08:00

    const threeCrosses = makeOp({
      candle_close_time: '2026-07-16T07:00:00.000Z', closed_at: '2026-07-17T01:00:00.000Z',
    });
    expect(countFundingSettlements(threeCrosses)).toBe(3); // 08, 16, 00
  });

  it('funding entra no custo total proporcional às fronteiras cruzadas', () => {
    const op = makeOp({
      exit_price: 95,
      candle_close_time: '2026-07-16T07:00:00.000Z', closed_at: '2026-07-17T01:00:00.000Z',
    });
    const c = calcTradeCost(op);
    expect(c.fundingSettlements).toBe(3);
    expect(c.fundingCost).toBeCloseTo(3 * 0.0001 * 100, 6); // 0.03
  });

  // known-risks item 47.2 — funding pós-TP1 só cobra a fração do runner, não
  // o notional cheio. Mesmas 3 fronteiras do teste acima (08, 16, 00), mas
  // agora com TP1 batido no meio da janela (16:00) — 1 fronteira antes
  // (08:00, 100% do notional) e 2 depois (16:00 e 00:00, só os 50% do
  // runner, partial_percent=50 default do fixture).
  describe('funding ponderado pela fração pós-TP1 (item 47.2)', () => {
    it('countFundingSettlementsByLeg divide corretamente em beforeTp1/afterTp1', () => {
      const op = makeOp({
        tp1_hit: true, tp1_hit_at: '2026-07-16T15:00:00.000Z',
        candle_close_time: '2026-07-16T07:00:00.000Z', closed_at: '2026-07-17T01:00:00.000Z',
      });
      expect(countFundingSettlementsByLeg(op)).toEqual({ beforeTp1: 1, afterTp1: 2 });
    });

    it('sem tp1_hit, todas as fronteiras ficam em beforeTp1 (comportamento idêntico a antes do split)', () => {
      const op = makeOp({
        candle_close_time: '2026-07-16T07:00:00.000Z', closed_at: '2026-07-17T01:00:00.000Z',
      });
      expect(countFundingSettlementsByLeg(op)).toEqual({ beforeTp1: 3, afterTp1: 0 });
    });

    it('calcTradeCost cobra menos funding numa op com parcial do que uma idêntica sem TP1', () => {
      const withoutTp1 = makeOp({
        exit_price: 95,
        candle_close_time: '2026-07-16T07:00:00.000Z', closed_at: '2026-07-17T01:00:00.000Z',
      });
      const withTp1 = makeOp({
        status: 'TP2_HIT', tp1_hit: true, tp1_hit_at: '2026-07-16T15:00:00.000Z', exit_price: 115,
        candle_close_time: '2026-07-16T07:00:00.000Z', closed_at: '2026-07-17T01:00:00.000Z',
      });
      const costWithout = calcTradeCost(withoutTp1);
      const costWith = calcTradeCost(withTp1);
      // 1 fronteira a 100% (100) + 2 a 50% (50 cada) = 200 de notional-fronteira,
      // contra 3 fronteiras a 100% (300) sem parcial — 2/3 do funding.
      expect(costWith.fundingCost).toBeCloseTo(costWithout.fundingCost * (2 / 3), 6);
      expect(costWith.fundingSettlements).toBe(3); // contagem de fronteiras não muda, só o peso
    });
  });
});

describe('gate de amostra (Fase 5)', () => {
  const winOp = (i) => makeOp({
    id: `w${i}`, status: 'TP2_HIT', exit_price: 115,
    closed_at: `2026-07-16T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
  });

  it('poucas operações -> inconclusivo por tamanho de amostra', () => {
    const s = summarizeOps([winOp(1), winOp(2), winOp(3)], { costModel: ZERO_COST });
    expect(s.counted).toBe(3);
    expect(s.conclusive).toBe(false);
    expect(s.inconclusiveReason).toBe('sample_too_small');
  });

  it('a fronteira de minTrades é respeitada (29 inconclusivo, 30 avaliável)', () => {
    const ops29 = Array.from({ length: 29 }, (_, i) => winOp(i));
    const ops30 = Array.from({ length: 30 }, (_, i) => winOp(i));
    expect(summarizeOps(ops29, { costModel: ZERO_COST }).inconclusiveReason).toBe('sample_too_small');
    // Com 30 resultados idênticos o desvio é 0 -> IC não cruza zero -> conclusivo.
    const s30 = summarizeOps(ops30, { costModel: ZERO_COST });
    expect(s30.counted).toBe(30);
    expect(s30.conclusive).toBe(true);
  });

  it('amostra suficiente mas IC cruzando zero continua inconclusivo', () => {
    // Metade ganha 1R (saída 105), metade perde 1R (saída 95): média ~0 com
    // dispersão alta — exatamente o caso em que um win rate de 50% parece
    // informativo e não é.
    const ops = Array.from({ length: 40 }, (_, i) => (i % 2 === 0
      ? makeOp({ id: `w${i}`, status: 'TP2_HIT', exit_price: 105, closed_at: `2026-07-16T12:00:${String(i).padStart(2, '0')}.000Z` })
      : makeOp({ id: `l${i}`, exit_price: 95, closed_at: `2026-07-16T12:00:${String(i).padStart(2, '0')}.000Z` })));
    const s = summarizeOps(ops, { costModel: ZERO_COST });
    expect(s.counted).toBe(40);
    expect(s.expectancyRCI95[0]).toBeLessThan(0);
    expect(s.conclusive).toBe(false);
    expect(s.inconclusiveReason).toBe('ci_straddles_zero');
  });

  it('minTrades é configurável', () => {
    const s = summarizeOps([winOp(1), winOp(2), winOp(3)], { costModel: ZERO_COST, minTrades: 2 });
    expect(s.inconclusiveReason).not.toBe('sample_too_small');
    expect(s.minTrades).toBe(2);
  });

  it('summarizeOps reporta custo agregado e a expectância BRUTA lado a lado', () => {
    const ops = [makeOp({ exit_price: 95, closed_at: '2026-07-16T09:00:00.000Z' })];
    const s = summarizeOps(ops);
    expect(s.avgCostR).toBeCloseTo(0.0234, 5);
    expect(s.totalCostPct).toBeCloseTo(0.117, 5);
    // A bruta ignora o custo; a líquida é pior exatamente pelo custo.
    expect(s.grossExpectancyR).toBeCloseTo(-1.0, 5);
    expect(s.expectancyR).toBeCloseTo(-1.0 - 0.0234, 5);
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
