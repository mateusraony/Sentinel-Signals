import { describe, it, expect } from 'vitest';
import { analyzeOps, analyzeReport, exitReasonKey, holdHours, opsFromReport } from './backtestAnalysis.js';
import { DEFAULT_COST_MODEL, ZERO_COST, calcCostR, summarizeOps } from './tradeMetrics.js';

// Mesma base do tradeMetrics.test.js: risco = 5 (entrada 100, stop 95),
// tp1 = +1.5R (107.5), tp2 = +3R (115), 50/50. Todo valor esperado abaixo sai
// dessas contas à mão.
function makeOp(overrides = {}) {
  return {
    id: 'op1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    status: 'STOP_HIT',
    entry_price: 100,
    initial_stop: 95,
    current_stop: 95,
    exit_price: 95,
    tp1: 107.5,
    tp2: 115,
    tp1_hit: false,
    partial_percent: 50,
    runner_percent: 50,
    candle_close_time: '2026-07-16T08:00:00.000Z',
    closed_at: '2026-07-16T12:00:00.000Z',
    created_date: '2026-07-16T08:00:00.000Z',
    ...overrides,
  };
}

const winOp = (overrides = {}) => makeOp({ status: 'TP2_HIT', tp1_hit: true, exit_price: 115, ...overrides });

describe('exitReasonKey', () => {
  it('separa Time Stop de Chop Exit — os dois são status CLOSED', () => {
    expect(exitReasonKey(makeOp({ status: 'CLOSED', closed_reason: 'TIME_STOP' }))).toBe('CLOSED:TIME_STOP');
    expect(exitReasonKey(makeOp({ status: 'CLOSED', closed_reason: 'CHOP_EXIT' }))).toBe('CLOSED:CHOP_EXIT');
  });

  it('mantém o status puro quando não há closed_reason', () => {
    expect(exitReasonKey(makeOp({ status: 'STOP_HIT' }))).toBe('STOP_HIT');
    expect(exitReasonKey(makeOp({ status: 'CLOSED' }))).toBe('CLOSED');
    expect(exitReasonKey({})).toBe('UNKNOWN');
  });
});

describe('holdHours', () => {
  it('mede da referência de entrada até o fechamento', () => {
    expect(holdHours(makeOp())).toBe(4);
  });

  it('prefere o candle de entrada real ao created_date', () => {
    const op = makeOp({
      created_date: '2026-07-16T00:00:00.000Z',
      entry_candle_time_15m: '2026-07-16T10:00:00.000Z',
    });
    expect(holdHours(op)).toBe(2);
  });

  it('devolve null (nunca 0) quando falta timestamp ou a ordem é impossível', () => {
    expect(holdHours({ status: 'STOP_HIT' })).toBeNull();
    expect(holdHours(makeOp({ closed_at: '2026-07-16T04:00:00.000Z' }))).toBeNull();
  });
});

describe('analyzeOps — decomposição aditiva (a propriedade central)', () => {
  const ops = [
    makeOp({ id: 'a', status: 'STOP_HIT' }),
    makeOp({ id: 'b', status: 'STOP_HIT', symbol: 'ETHUSDT' }),
    winOp({ id: 'c' }),
    makeOp({ id: 'd', status: 'CLOSED', closed_reason: 'TIME_STOP', exit_price: 98, symbol: 'ETHUSDT' }),
  ];

  it('as contribuições por motivo de saída somam EXATAMENTE a expectância geral', () => {
    const analysis = analyzeOps(ops, { costModel: ZERO_COST });
    const soma = analysis.byExitReason.reduce((acc, b) => acc + b.contributionR, 0);
    expect(soma).toBeCloseTo(analysis.expectancyR, 10);
  });

  it('as contribuições por símbolo também somam a expectância geral', () => {
    const analysis = analyzeOps(ops, { costModel: ZERO_COST });
    const soma = analysis.bySymbol.reduce((acc, b) => acc + b.contributionR, 0);
    expect(soma).toBeCloseTo(analysis.expectancyR, 10);
  });

  it('a expectância bate com a que summarizeOps reporta para o mesmo conjunto', () => {
    const analysis = analyzeOps(ops, { costModel: DEFAULT_COST_MODEL });
    const resumo = summarizeOps(ops, { costModel: DEFAULT_COST_MODEL });
    expect(analysis.expectancyR).toBeCloseTo(resumo.expectancyR, 10);
    expect(analysis.rCounted).toBe(resumo.rCounted);
  });

  it('ordena pior contribuição primeiro — a primeira linha é a fonte do prejuízo', () => {
    const analysis = analyzeOps(ops, { costModel: ZERO_COST });
    expect(analysis.byExitReason[0].key).toBe('STOP_HIT');
    expect(analysis.byExitReason[0].contributionR).toBeLessThan(0);
    expect(analysis.byExitReason.at(-1).key).toBe('TP2_HIT');
  });

  it('contributionR usa o denominador do conjunto TODO, não o do balde', () => {
    // STOP_HIT: 2 operações a -1R = -2R somados, sobre 4 operações = -0.5R.
    // avgR do balde é -1R. Os dois números coexistem de propósito: o primeiro
    // é comparável entre baldes, o segundo não.
    const analysis = analyzeOps(ops, { costModel: ZERO_COST });
    const stop = analysis.byExitReason.find((b) => b.key === 'STOP_HIT');
    expect(stop.avgR).toBeCloseTo(-1);
    expect(stop.contributionR).toBeCloseTo(-0.5);
    expect(stop.count).toBe(2);
    expect(stop.share).toBeCloseTo(0.5);
  });
});

describe('analyzeOps — buckets', () => {
  it('agrupa por motivo de saída com contagem de resultado correta', () => {
    const analysis = analyzeOps([
      makeOp({ id: 'a' }),
      winOp({ id: 'b' }),
      makeOp({ id: 'c', status: 'CLOSED', closed_reason: 'CHOP_EXIT', exit_price: 99 }),
    ], { costModel: ZERO_COST });

    const chop = analysis.byExitReason.find((b) => b.key === 'CLOSED:CHOP_EXIT');
    expect(chop.status).toBe('CLOSED');
    expect(chop.closedReason).toBe('CHOP_EXIT');
    expect(chop.losses).toBe(1);
    expect(analysis.byExitReason.find((b) => b.key === 'TP2_HIT').wins).toBe(1);
  });

  it('registra tempo médio em posição por balde', () => {
    const analysis = analyzeOps([
      makeOp({ id: 'a', closed_at: '2026-07-16T10:00:00.000Z' }), // 2h
      makeOp({ id: 'b', closed_at: '2026-07-16T14:00:00.000Z' }), // 6h
    ], { costModel: ZERO_COST });
    expect(analysis.byExitReason[0].avgHoldHours).toBeCloseTo(4);
    expect(analysis.holdHours.median).toBeCloseTo(4);
    expect(analysis.holdHours.min).toBeCloseTo(2);
    expect(analysis.holdHours.max).toBeCloseTo(6);
  });

  it('ignora operações abertas e não conta como zero as sem R calculável', () => {
    const analysis = analyzeOps([
      makeOp({ id: 'aberta', status: 'RUNNER_ACTIVE' }),
      makeOp({ id: 'sem-risco', initial_stop: 100 }), // risco zero -> R indefinido
      makeOp({ id: 'ok' }),
    ], { costModel: ZERO_COST });

    expect(analysis.totalClosed).toBe(2);
    expect(analysis.rCounted).toBe(1);
    const stop = analysis.byExitReason.find((b) => b.key === 'STOP_HIT');
    expect(stop.count).toBe(2);
    expect(stop.rCount).toBe(1);
    expect(stop.avgR).toBeCloseTo(-1);
  });

  it('não lança em entrada vazia ou inválida', () => {
    expect(analyzeOps([]).totalClosed).toBe(0);
    expect(analyzeOps(null).expectancyR).toBeNull();
    expect(analyzeOps([]).holdHours.median).toBeNull();
    expect(analyzeOps([]).cost.avgCostR).toBeNull();
  });
});

describe('analyzeOps — decomposição do custo', () => {
  it('taxa + slippage + funding reconstroem o custo total em R', () => {
    const ops = [makeOp({ id: 'a' }), winOp({ id: 'b' }), makeOp({ id: 'c', closed_at: '2026-07-20T12:00:00.000Z' })];
    const { cost } = analyzeOps(ops, { costModel: DEFAULT_COST_MODEL });
    expect(cost.avgFeeR + cost.avgSlippageR + cost.avgFundingR).toBeCloseTo(cost.avgCostR, 12);
    expect(cost.feeShare + cost.slippageShare + cost.fundingShare).toBeCloseTo(1, 12);
  });

  it('a decomposição bate com calcCostR operação a operação', () => {
    // Abre 08:00, fecha 20:00 UTC: atravessa a fronteira das 16:00 e só ela.
    // Abrir ÀS 08:00 não paga a liquidação das 08:00 — ela ocorre no instante
    // da abertura, e countFundingSettlements conta fronteiras cruzadas, não
    // decorridas. 1 bp sobre entrada 100 = 0.01 em preço, sobre risco 5 =
    // 0.002 R.
    const op = makeOp({ closed_at: '2026-07-16T20:00:00.000Z' });
    const { cost } = analyzeOps([op], { costModel: DEFAULT_COST_MODEL });
    expect(cost.avgCostR).toBeCloseTo(calcCostR(op, DEFAULT_COST_MODEL), 12);
    expect(cost.avgFundingR).toBeCloseTo(0.002, 12);
    expect(cost.avgFundingSettlements).toBeCloseTo(1);
    expect(cost.opsWithFunding).toBe(1);
  });

  it('posição que não cruza fronteira de 8h não paga funding', () => {
    const op = makeOp({
      candle_close_time: '2026-07-16T09:00:00.000Z',
      created_date: '2026-07-16T09:00:00.000Z',
      closed_at: '2026-07-16T15:00:00.000Z',
    });
    const { cost } = analyzeOps([op], { costModel: DEFAULT_COST_MODEL });
    expect(cost.avgFundingR).toBe(0);
    expect(cost.fundingShare).toBe(0);
    expect(cost.opsWithFunding).toBe(0);
  });

  it('run --no-costs: custo zero em todos os componentes, sem divisão por zero', () => {
    const { cost, costModel } = analyzeOps([makeOp()], { costModel: ZERO_COST });
    expect(cost.avgCostR).toBe(0);
    expect(cost.feeShare).toBeNull();
    expect(cost.fundingShare).toBeNull();
    expect(costModel.feeBpsEntry).toBe(0);
  });

  it('funding com posição longa domina a taxa — o caso que motivou a decomposição', () => {
    // 8 dias em posição = 24 fronteiras de 8h. É o Time Stop da cascata RF
    // (48 barras de 4h), não as "poucas horas" que a pesquisa do item 44
    // assumiu ao classificar funding como custo de segunda ordem.
    const op = makeOp({ closed_at: '2026-07-24T08:00:00.000Z' });
    const { cost } = analyzeOps([op], { costModel: DEFAULT_COST_MODEL });
    expect(cost.avgFundingSettlements).toBe(24);
    expect(cost.fundingShare).toBeGreaterThan(cost.feeShare);
  });
});

describe('opsFromReport / analyzeReport', () => {
  const report = {
    costs: { model: { ...DEFAULT_COST_MODEL, applied: true } },
    overall: {
      curve: [
        { op: makeOp({ id: 'a' }), r: -1 },
        { op: winOp({ id: 'b' }), r: 2.25 },
      ],
    },
  };

  it('extrai as operações do curve do artifact', () => {
    expect(opsFromReport(report).map((op) => op.id)).toEqual(['a', 'b']);
  });

  it('erro explícito quando recebe o resumo do job (curve removido)', () => {
    expect(() => opsFromReport({ overall: { total: 2 } })).toThrow(/overall\.curve/);
  });

  it('reusa o modelo de custo ecoado pelo próprio relatório', () => {
    const analysis = analyzeReport(report);
    expect(analysis.costModel.feeBpsEntry).toBe(5);
    expect(analysis.totalClosed).toBe(2);
  });

  it('um relatório --no-costs continua sendo lido como custo zero', () => {
    const semCusto = { ...report, costs: { model: { ...ZERO_COST, applied: false } } };
    expect(analyzeReport(semCusto).cost.avgCostR).toBe(0);
  });
});
