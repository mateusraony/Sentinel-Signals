import { describe, it, expect } from 'vitest';
import {
  analyzeOps, analyzeReport, arbitrationOutcomeKey, enumeratePeriods,
  exitReasonKey, holdHours, opsFromReport, periodKey, sideKey, tierKey,
} from './backtestAnalysis.js';
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

describe('eixos de verificação — lado, tier e aviso de oposição', () => {
  // Vencedor de VENDA espelhado: entrada 100, stop 105 (risco 5), tp1 92.5,
  // tp2 85. Não dá para reaproveitar `winOp` trocando só o `side` — o R é
  // assinado pelo lado (`tradeMetrics.js:206`), então um vencedor de compra
  // com side SELL vira perdedor de -2.25R. Aqui: 0.5·(92.5−100) + 0.5·(85−100)
  // = −11.25, invertido pelo sinal = +11.25 sobre risco 5 = +2.25R.
  const sellWin = (overrides = {}) => makeOp({
    side: 'SELL', status: 'TP2_HIT', tp1_hit: true,
    initial_stop: 105, current_stop: 105, tp1: 92.5, tp2: 85, exit_price: 85,
    ...overrides,
  });

  const carteira = [
    makeOp({ id: 'b3a', side: 'BUY', tier: 'T3' }), // -1R
    makeOp({ id: 'b3b', side: 'BUY', tier: 'T3' }), // -1R
    sellWin({ id: 's3a', tier: 'T3' }), // +2.25R
    sellWin({ id: 's1a', tier: 'T1' }), // +2.25R
  ];

  it('as contribuições somam a expectância em TODOS os eixos novos', () => {
    const a = analyzeOps(carteira, { costModel: ZERO_COST });
    for (const eixo of ['bySide', 'byTier', 'bySideTier', 'byArbitration']) {
      const soma = a[eixo].reduce((acc, b) => acc + b.contributionR, 0);
      expect(soma, `eixo ${eixo}`).toBeCloseTo(a.expectancyR, 10);
    }
  });

  it('separa BUY de SELL', () => {
    const a = analyzeOps(carteira, { costModel: ZERO_COST });
    const buy = a.bySide.find((b) => b.side === 'BUY');
    const sell = a.bySide.find((b) => b.side === 'SELL');
    expect(buy.count).toBe(2);
    expect(buy.avgR).toBeCloseTo(-1);
    expect(sell.count).toBe(2);
    expect(sell.avgR).toBeCloseTo(2.25);
  });

  it('cruza lado × tier — é o corte que os eixos isolados não dão', () => {
    const a = analyzeOps(carteira, { costModel: ZERO_COST });
    const buyT3 = a.bySideTier.find((b) => b.key === 'BUY T3');
    expect(buyT3.count).toBe(2);
    expect(buyT3.avgR).toBeCloseTo(-1);
    expect(buyT3.side).toBe('BUY');
    expect(buyT3.tier).toBe('T3');
    // T3 sozinho mistura o BUY ruim com o SELL bom e esconde o efeito.
    const t3 = a.byTier.find((b) => b.tier === 'T3');
    expect(t3.count).toBe(3);
    expect(t3.avgR).toBeCloseTo((-1 - 1 + 2.25) / 3);
  });

  // A armadilha: op da cascata SMC não recebe `tier` quando smcTierEnabled está
  // desligado (default), e `tier_time_stop_bars` cai em 96 — o MESMO valor de
  // T3. Inferir tier daí produziria uma tabela de aparência completa e errada.
  it('operação sem tier vai para balde próprio e NUNCA é inferida como T3', () => {
    const semTier = makeOp({ id: 'smc', side: 'BUY', tier_time_stop_bars: 96 });
    delete semTier.tier;
    const a = analyzeOps([...carteira, semTier], { costModel: ZERO_COST });

    expect(tierKey(semTier)).toBe('SEM_TIER');
    const t3 = a.byTier.find((b) => b.tier === 'T3');
    expect(t3.count).toBe(3); // as 3 originais, não 4
    const sem = a.byTier.find((b) => b.tier === 'SEM_TIER');
    expect(sem.count).toBe(1);
    expect(a.bySideTier.find((b) => b.key === 'BUY SEM_TIER').count).toBe(1);
  });

  it('lado ausente ou inválido também vira balde próprio', () => {
    expect(sideKey({ side: 'LONG' })).toBe('UNKNOWN');
    expect(sideKey({})).toBe('UNKNOWN');
    expect(sideKey(null)).toBe('UNKNOWN');
  });

  it('separa por resultado de arbitragem, lido do campo persistido', () => {
    const avisada = makeOp({ id: 'aviso', arbitration_outcome: 'correction_warning', confidence_penalty_total: 15 });
    const a = analyzeOps([...carteira, avisada], { costModel: ZERO_COST });
    expect(arbitrationOutcomeKey(avisada)).toBe('correction_warning');
    expect(arbitrationOutcomeKey(carteira[0])).toBe('SEM_ARBITRAGEM');
    expect(a.byArbitration.find((b) => b.key === 'correction_warning').count).toBe(1);
    expect(a.byArbitration.find((b) => b.key === 'SEM_ARBITRAGEM').count).toBe(4);
  });

  // Regressão do achado externo (Codex, PR #94): a versão anterior inferia
  // "recebeu aviso" de `confidence_penalty_total > 0`. Mas a penalidade vem de
  // `arbOppositeScorePenalty ?? 15`, configurável para 0, e `critical_opposite`
  // em modo log-only não penaliza. Nos dois casos a operação FOI avisada e a
  // soma fica zero — o proxy classificava errado, em silêncio.
  it('operação avisada com penalidade ZERO ainda é contada como avisada', () => {
    const penalidadeZero = makeOp({
      id: 'pen0', arbitration_outcome: 'correction_warning', confidence_penalty_total: 0,
    });
    const criticoLogOnly = makeOp({
      id: 'crit', arbitration_outcome: 'critical_opposite', confidence_penalty_total: 0,
    });
    const a = analyzeOps([penalidadeZero, criticoLogOnly], { costModel: ZERO_COST });

    expect(arbitrationOutcomeKey(penalidadeZero)).toBe('correction_warning');
    expect(arbitrationOutcomeKey(criticoLogOnly)).toBe('critical_opposite');
    expect(a.byArbitration.find((b) => b.key === 'SEM_ARBITRAGEM')).toBeUndefined();
    expect(a.byArbitration).toHaveLength(2);
  });

  it('outcome ausente, vazio ou não-string vira SEM_ARBITRAGEM', () => {
    expect(arbitrationOutcomeKey({})).toBe('SEM_ARBITRAGEM');
    expect(arbitrationOutcomeKey({ arbitration_outcome: '' })).toBe('SEM_ARBITRAGEM');
    expect(arbitrationOutcomeKey({ arbitration_outcome: 42 })).toBe('SEM_ARBITRAGEM');
    expect(arbitrationOutcomeKey(null)).toBe('SEM_ARBITRAGEM');
  });
});

describe('periodKey / byPeriod — estabilidade temporal', () => {
  it('agrupa por ano-trimestre UTC do fechamento', () => {
    expect(periodKey(makeOp({ closed_at: '2026-01-31T23:59:59.000Z' }))).toBe('2026-Q1');
    expect(periodKey(makeOp({ closed_at: '2026-04-01T00:00:00.000Z' }))).toBe('2026-Q2');
    expect(periodKey(makeOp({ closed_at: '2025-12-31T23:00:00.000Z' }))).toBe('2025-Q4');
    expect(periodKey({})).toBe('UNKNOWN');
    expect(periodKey(makeOp({ closed_at: 'não é data', updated_date: null, created_date: null }))).toBe('UNKNOWN');
  });

  const spread = [
    makeOp({ id: 'q1a', closed_at: '2026-01-10T12:00:00.000Z' }),
    makeOp({ id: 'q1b', closed_at: '2026-02-10T12:00:00.000Z' }),
    winOp({ id: 'q2a', closed_at: '2026-04-10T12:00:00.000Z' }),
    winOp({ id: 'q3a', closed_at: '2026-07-10T12:00:00.000Z' }),
  ];

  it('as contribuições por período somam a expectância geral', () => {
    const analysis = analyzeOps(spread, { costModel: ZERO_COST });
    const soma = analysis.byPeriod.reduce((acc, b) => acc + b.contributionR, 0);
    expect(soma).toBeCloseTo(analysis.expectancyR, 10);
  });

  it('sai em ordem CRONOLÓGICA, não por contribuição — a sequência é a informação', () => {
    const analysis = analyzeOps(spread, { costModel: ZERO_COST });
    expect(analysis.byPeriod.map((b) => b.period)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3']);
    // O pior trimestre é o primeiro da série, não é o que a ordenação escolheu:
    // se estivesse ordenado por contribuição, 2026-Q1 viria primeiro por acaso.
    // Este par prova que a ordem é temporal — inverter os dados não muda a saída.
    const invertido = analyzeOps([...spread].reverse(), { costModel: ZERO_COST });
    expect(invertido.byPeriod.map((b) => b.period)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3']);
  });

  it('positivePeriodsShare mede concentração — resultado de um trimestre só não é estratégia', () => {
    const analysis = analyzeOps(spread, { costModel: ZERO_COST });
    // Q1 negativo (2 stops), Q2 e Q3 positivos (1 TP2 cada) = 2 de 3.
    expect(analysis.positivePeriodsShare).toBeCloseTo(2 / 3);
    expect(analyzeOps([], { costModel: ZERO_COST }).positivePeriodsShare).toBeNull();
  });

  it('enumeratePeriods cobre a janela pedida, inclusive trimestres sem operação', () => {
    expect(enumeratePeriods(Date.parse('2025-02-10T00:00:00Z'), Date.parse('2025-11-20T00:00:00Z')))
      .toEqual(['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4']);
    expect(enumeratePeriods(Date.parse('2025-12-31T23:00:00Z'), Date.parse('2026-01-01T01:00:00Z')))
      .toEqual(['2025-Q4', '2026-Q1']);
    expect(enumeratePeriods(NaN, 1)).toEqual([]);
    expect(enumeratePeriods(1000, 500)).toEqual([]);
  });

  // Regressão do achado externo (Codex, PR #91): antes desta correção,
  // `byPeriod` só continha os trimestres COM operação, então concentração
  // máxima — tudo num único trimestre lucrativo — lia como "100% dos
  // trimestres positivos", ou seja, estabilidade perfeita. É o oposto exato do
  // que a métrica existe para detectar.
  it('concentração num único trimestre NÃO lê como estabilidade', () => {
    const tudoNoQ2 = [
      winOp({ id: 'a', closed_at: '2026-04-05T12:00:00.000Z' }),
      winOp({ id: 'b', closed_at: '2026-05-05T12:00:00.000Z' }),
      winOp({ id: 'c', closed_at: '2026-06-05T12:00:00.000Z' }),
    ];
    const rangeMs = { fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2026-12-31T00:00:00Z') };
    const analysis = analyzeOps(tudoNoQ2, { costModel: ZERO_COST, rangeMs });

    // A primeira métrica, sozinha, diria "tudo perfeito".
    expect(analysis.positivePeriodsShare).toBe(1);
    // A segunda denuncia: operou em 1 de 4 trimestres da janela.
    expect(analysis.activePeriods).toBe(1);
    expect(analysis.totalPeriods).toBe(4);
    expect(analysis.activePeriodsShare).toBeCloseTo(0.25);
    // E os trimestres vazios aparecem na tabela em vez de sumirem.
    expect(analysis.byPeriod.map((b) => b.period)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
    expect(analysis.byPeriod.filter((b) => b.count === 0)).toHaveLength(3);
  });

  it('sem rangeMs, activePeriodsShare é null — nunca um número inventado', () => {
    const analysis = analyzeOps([winOp({ closed_at: '2026-04-05T12:00:00.000Z' })], { costModel: ZERO_COST });
    expect(analysis.activePeriodsShare).toBeNull();
    expect(analysis.activePeriods).toBe(1);
    expect(analysis.totalPeriods).toBe(1);
  });

  it('trimestres vazios não entram no denominador de positivePeriodsShare', () => {
    // 2 trimestres com operação (1 positivo, 1 negativo) numa janela de 4.
    const ops = [
      makeOp({ id: 'perda', closed_at: '2026-01-15T12:00:00.000Z' }),
      winOp({ id: 'ganho', closed_at: '2026-07-15T12:00:00.000Z' }),
    ];
    const rangeMs = { fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2026-12-31T00:00:00Z') };
    const analysis = analyzeOps(ops, { costModel: ZERO_COST, rangeMs });
    expect(analysis.positivePeriodsShare).toBeCloseTo(0.5); // 1 de 2 que operaram
    expect(analysis.activePeriodsShare).toBeCloseTo(0.5); // 2 de 4 da janela
  });

  it('analyzeReport passa a janela do relatório para a análise', () => {
    const relatorio = {
      range: { fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2026-12-31T00:00:00Z') },
      costs: { model: { ...DEFAULT_COST_MODEL, applied: true } },
      overall: { curve: [{ op: winOp({ closed_at: '2026-04-05T12:00:00.000Z' }) }] },
    };
    const analysis = analyzeReport(relatorio);
    expect(analysis.totalPeriods).toBe(4);
    expect(analysis.activePeriodsShare).toBeCloseTo(0.25);
  });

  it('conta operações e resultados por trimestre', () => {
    const analysis = analyzeOps(spread, { costModel: ZERO_COST });
    const q1 = analysis.byPeriod.find((b) => b.period === '2026-Q1');
    expect(q1.count).toBe(2);
    expect(q1.losses).toBe(2);
    expect(q1.avgR).toBeCloseTo(-1);
  });
});

describe('analyzeOps — atribuição do runner (geometria de saída)', () => {
  // Sobre a base: TP1 = +1.5R. Fechar 100% ali = +1.5R sempre.
  // Runner até o TP2 (115): 0.5·1.5 + 0.5·3 = +2.25R  → runner rendeu +0.75R.
  // Runner estopado no breakeven (100): 0.5·1.5 + 0 = +0.75R → runner custou -0.75R.
  const runnerAoTp2 = (o = {}) => makeOp({ status: 'TP2_HIT', tp1_hit: true, exit_price: 115, ...o });
  const runnerNoBreakeven = (o = {}) => makeOp({ tp1_hit: true, current_stop: 100, exit_price: 100, ...o });

  it('a atribuição é EXATAMENTE a diferença entre os dois cenários brutos', () => {
    const { runner } = analyzeOps([runnerAoTp2({ id: 'a' }), runnerNoBreakeven({ id: 'b' }), makeOp({ id: 'c' })]);
    expect(runner.avgContributionR)
      .toBeCloseTo(runner.grossExpectancyR - runner.grossExpectancyRAtTp1, 12);
  });

  it('mede o custo real do runner: um ganha 0.75R, outro perde 0.75R, sobra 0 em 3 ops', () => {
    const { runner } = analyzeOps([runnerAoTp2({ id: 'a' }), runnerNoBreakeven({ id: 'b' }), makeOp({ id: 'c' })]);
    expect(runner.totalContributionR).toBeCloseTo(0, 12);
    expect(runner.opsWithTp1).toBe(2);
    expect(runner.reachedTp2).toBe(1);
    expect(runner.betterAtTp1).toBe(1);
    expect(runner.worseAtTp1).toBe(1);
  });

  it('runner que só perde: atribuição negativa e denominador do conjunto TODO', () => {
    // 2 estopadas no breakeven (-0.75R cada) + 2 que nunca chegaram ao TP1.
    const ops = [
      runnerNoBreakeven({ id: 'a' }), runnerNoBreakeven({ id: 'b' }),
      makeOp({ id: 'c' }), makeOp({ id: 'd' }),
    ];
    const { runner } = analyzeOps(ops);
    expect(runner.totalContributionR).toBeCloseTo(-1.5, 12);
    // -1.5 / 4 operações contadas (não / 2, que é o subconjunto com TP1) — é
    // isso que a torna somável com expectancyR.
    expect(runner.avgContributionR).toBeCloseTo(-0.375, 12);
  });

  it('é imune ao modelo de custo — sempre bruto contra bruto', () => {
    const ops = [runnerNoBreakeven({ id: 'a' }), makeOp({ id: 'b' })];
    const comCusto = analyzeOps(ops, { costModel: DEFAULT_COST_MODEL }).runner;
    const semCusto = analyzeOps(ops, { costModel: ZERO_COST }).runner;
    expect(comCusto.avgContributionR).toBeCloseTo(semCusto.avgContributionR, 12);
    expect(comCusto.grossExpectancyR).toBeCloseTo(semCusto.grossExpectancyR, 12);
  });

  it('operação que nunca atingiu TP1 não entra na conta', () => {
    const { runner } = analyzeOps([makeOp({ id: 'a' }), makeOp({ id: 'b' })]);
    expect(runner.opsWithTp1).toBe(0);
    expect(runner.totalContributionR).toBe(0);
  });

  it('TP1 irrecuperável degrada para "não avaliável" em vez de sumir da expectância', () => {
    const corrompida = makeOp({ id: 'x', tp1_hit: true, tp1: null, tp1_hit_price: null, exit_price: 100 });
    const { runner } = analyzeOps([corrompida, makeOp({ id: 'y' })]);
    expect(runner.opsWithTp1).toBe(0);
    expect(runner.totalContributionR).toBeCloseTo(0, 12);
    // A operação continua contando na expectância bruta — só não é atribuída.
    expect(runner.grossExpectancyR).toBeCloseTo(runner.grossExpectancyRAtTp1, 12);
  });

  it('não lança em conjunto vazio', () => {
    expect(analyzeOps([]).runner.opsWithTp1).toBe(0);
    expect(analyzeOps([]).runner.avgContributionR).toBeNull();
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
    expect(cost.avgBoundariesCrossed).toBeCloseTo(1);
    expect(cost.opsWithFunding).toBe(1);
    expect(cost.fundingCharged).toBe(true);
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
    expect(cost.avgBoundariesCrossed).toBe(0);
  });

  it('taxa de funding zero: fronteira atravessada não vira operação que pagou', () => {
    // Achado da revisão externa (Codex, PR #88): countFundingSettlements conta
    // geometria e não conhece o modelo de custo, então um run --no-costs
    // reportava operações "que pagaram funding" com custo zero. calcTradeCost
    // já gateava pela taxa; este módulo não gateava.
    const op = makeOp({
      candle_close_time: '2026-07-16T07:00:00.000Z',
      created_date: '2026-07-16T07:00:00.000Z',
      closed_at: '2026-07-17T01:00:00.000Z', // cruza 08:00, 16:00 e 00:00
    });
    const semCusto = analyzeOps([op], { costModel: ZERO_COST }).cost;
    expect(semCusto.avgBoundariesCrossed).toBe(3); // geometria continua medida
    expect(semCusto.opsWithFunding).toBe(0); // mas ninguém pagou
    expect(semCusto.fundingCharged).toBe(false);
    expect(semCusto.avgFundingR).toBe(0);

    const comCusto = analyzeOps([op], { costModel: DEFAULT_COST_MODEL }).cost;
    expect(comCusto.avgBoundariesCrossed).toBe(3);
    expect(comCusto.opsWithFunding).toBe(1);
    expect(comCusto.fundingCharged).toBe(true);
  });

  it('taxa de funding zerada isoladamente (custo de taxa ligado) também não cobra', () => {
    const { cost } = analyzeOps([makeOp({ closed_at: '2026-07-24T08:00:00.000Z' })], {
      costModel: { ...DEFAULT_COST_MODEL, fundingBpsPer8h: 0 },
    });
    expect(cost.avgBoundariesCrossed).toBe(24);
    expect(cost.opsWithFunding).toBe(0);
    expect(cost.avgFundingR).toBe(0);
    expect(cost.avgCostR).toBeGreaterThan(0); // taxa e slippage seguem cobrados
  });

  it('run --no-costs: custo zero em todos os componentes, sem divisão por zero', () => {
    const { cost, costModel } = analyzeOps([makeOp()], { costModel: ZERO_COST });
    expect(cost.avgCostR).toBe(0);
    expect(cost.feeShare).toBeNull();
    expect(cost.fundingShare).toBeNull();
    expect(costModel.feeBpsEntry).toBe(0);
  });

  // Codex review (PR #252, P2) — quando funding vira RECEITA (short coletando
  // com série real, item 131), esconder só a fatia negativa não basta: as
  // outras passam a ser divididas por um total líquido reduzido e estouram
  // 100% (ex.: taxa 143%). Não é decomposição — suprime o conjunto inteiro.
  it('funding como receita suprime TODAS as shares, não só a negativa', () => {
    const sell = makeOp({
      symbol: 'BTCUSDT', side: 'SELL', initial_stop: 105, tp1: 92.5, tp2: 85,
      exit_price: 105, closed_at: '2026-07-24T08:00:00.000Z',
    });
    // Série real cobrindo as 24 fronteiras, taxa positiva => o SELL recebe.
    const series = { BTCUSDT: [] };
    const start = Date.parse(sell.candle_close_time ?? sell.created_date);
    for (let i = 1; i <= 24; i++) {
      series.BTCUSDT.push({ calcTime: start + i * 8 * 60 * 60 * 1000, rate: 0.0004 });
    }
    const { cost } = analyzeOps([sell], {
      costModel: { ...DEFAULT_COST_MODEL, fundingSeries: series },
    });
    expect(cost.avgFundingR).toBeLessThan(0); // receita, confirmando o cenário
    expect(cost.fundingShare).toBeNull();
    expect(cost.feeShare).toBeNull();
    expect(cost.slippageShare).toBeNull();
    // ...e os valores em R continuam exatos, que é o ponto de suprimir só a %
    expect(Number.isFinite(cost.avgFeeR)).toBe(true);
    expect(Number.isFinite(cost.avgCostR)).toBe(true);
  });

  // Codex review (PR #252, P2) — "atravessou fronteira" != "pagou funding".
  it('opsWithFunding conta liquidações aplicadas, não fronteiras de calendário', () => {
    const op = makeOp({ symbol: 'BTCUSDT', closed_at: '2026-07-24T08:00:00.000Z' });
    // Série presente mas vazia para o símbolo => cai na constante e cobra.
    const { cost } = analyzeOps([op], {
      costModel: { ...DEFAULT_COST_MODEL, fundingSeries: { OUTRO: [{ calcTime: 1, rate: 0.1 }] } },
    });
    expect(cost.avgBoundariesCrossed).toBe(24);
    expect(cost.opsWithFunding).toBe(1);
    // Símbolo sem série caiu na constante — o relatório NÃO pode se dizer
    // "funding real" nesse caso, senão descreveria uma mistura.
    expect(cost.opsWithIncompleteFunding).toBe(1);
    expect(cost.fundingModel).toBe('mixed');
  });

  it('série com lacuna marca fundingModel mixed e conta a operação afetada', () => {
    const op = makeOp({ symbol: 'BTCUSDT', closed_at: '2026-07-24T08:00:00.000Z' });
    const start = Date.parse(op.candle_close_time ?? op.created_date);
    // 24 fronteiras esperadas, série com só 2 => lacuna.
    const gappy = { BTCUSDT: [
      { calcTime: start + 8 * 60 * 60 * 1000, rate: 0.0001 },
      { calcTime: start + 16 * 60 * 60 * 1000, rate: 0.0001 },
    ] };
    const { cost } = analyzeOps([op], {
      costModel: { ...DEFAULT_COST_MODEL, fundingSeries: gappy },
    });
    expect(cost.opsWithIncompleteFunding).toBe(1);
    expect(cost.fundingModel).toBe('mixed');
    // e cobra a constante, nunca o valor furado
    expect(cost.avgFundingR).toBeGreaterThan(0);
  });

  it('funding com posição longa domina a taxa — o caso que motivou a decomposição', () => {
    // 8 dias em posição = 24 fronteiras de 8h. É o Time Stop da cascata RF
    // (48 barras de 4h), não as "poucas horas" que a pesquisa do item 44
    // assumiu ao classificar funding como custo de segunda ordem.
    const op = makeOp({ closed_at: '2026-07-24T08:00:00.000Z' });
    const { cost } = analyzeOps([op], { costModel: DEFAULT_COST_MODEL });
    expect(cost.avgBoundariesCrossed).toBe(24);
    expect(cost.fundingShare).toBeGreaterThan(cost.feeShare);
  });
});

// known-risks item 47.2 — o motor não deve ser aprovado só porque poucas
// operações excepcionais compensaram o resto. ZERO_COST em todos os testes
// pra isolar os valores de R do modelo de custo (já coberto em outro bloco).
describe('analyzeOps — concentração do resultado (item 47.2)', () => {
  // R = (exit_price - 100) / 5 (risco), tp1_hit:false em todas (100% no exit).
  // symbols distintos pra também exercitar largestSymbol; mesmo closed_at/
  // side em todas pra largestPeriod/largestSide terem um balde só (contribui
  // exatamente sumRTotal, fácil de conferir à mão).
  function concentrationOps() {
    return [
      makeOp({ id: 'a', symbol: 'BTCUSDT', exit_price: 110 }), // R=2.0
      makeOp({ id: 'b', symbol: 'BTCUSDT', exit_price: 108 }), // R=1.6
      makeOp({ id: 'c', symbol: 'ETHUSDT', exit_price: 102.5 }), // R=0.5
      makeOp({ id: 'd', symbol: 'SOLUSDT', exit_price: 95 }), // R=-1.0
      makeOp({ id: 'e', symbol: 'XRPUSDT', exit_price: 85 }), // R=-3.0
      makeOp({ id: 'f', symbol: 'ADAUSDT', exit_price: 100.5 }), // R=0.1
      makeOp({ id: 'g', symbol: 'DOGEUSDT', exit_price: 99.5 }), // R=-0.1
    ];
  }

  it('top5/top10 somam os N melhores R, não os N mais recentes', () => {
    const { concentration, expectancyR, rCounted } = analyzeOps(concentrationOps(), { costModel: ZERO_COST });
    expect(rCounted).toBe(7);
    expect(expectancyR).toBeCloseTo(0.1 / 7, 6); // sumRTotal = 0.1, 7 ops
    // 5 maiores: 2.0+1.6+0.5+0.1-0.1 = 4.1 (não a soma das 5 primeiras da lista)
    expect(concentration.top5ContributionR).toBeCloseTo(4.1, 6);
    // 10 pedidos, só 7 existem — soma tudo, share = 100% do total.
    expect(concentration.top10ContributionR).toBeCloseTo(0.1, 6);
    expect(concentration.top10Share).toBeCloseTo(1.0, 6);
  });

  it('largestSymbol aponta o símbolo de maior |contribuição|, não o de mais operações', () => {
    const { concentration } = analyzeOps(concentrationOps(), { costModel: ZERO_COST });
    // BTCUSDT: (2.0+1.6)/7 ≈ 0.514 — maior em módulo que XRPUSDT sozinho (-3.0/7 ≈ -0.429).
    expect(concentration.largestSymbol.key).toBe('BTCUSDT');
    expect(concentration.largestSymbol.contributionR).toBeCloseTo(3.6 / 7, 6);
  });

  it('largestPeriod/largestSide — balde único (mesmo closed_at/side) contribui a expectância inteira', () => {
    const { concentration, expectancyR } = analyzeOps(concentrationOps(), { costModel: ZERO_COST });
    // Um balde só contendo TODAS as 7 operações — sua contribuição é
    // exatamente a expectância geral (sumR / rCountedTotal), a mesma
    // propriedade aditiva que o resto do módulo garante.
    expect(concentration.largestPeriod.contributionR).toBeCloseTo(expectancyR, 6);
    expect(concentration.largestSide.key).toBe('BUY');
    expect(concentration.largestSide.contributionR).toBeCloseTo(expectancyR, 6);
  });

  it('sem operações com R, share vira null em vez de dividir por zero', () => {
    const { concentration } = analyzeOps([], { costModel: ZERO_COST });
    expect(concentration.top5ContributionR).toBe(0);
    expect(concentration.top5Share).toBeNull();
    expect(concentration.largestSymbol).toBeNull();
  });
});

// known-risks item 47.2 — mfe_r/mae_r são lidos direto do campo já persistido
// pelo scanner (candle-resolution), não recalculados aqui.
describe('analyzeOps — excursão máxima MFE/MAE (item 47.2)', () => {
  it('agrega mfe_r/mae_r/bars_to_tp1/bars_to_stop e a taxa de "ficou positiva antes de parar"', () => {
    const ops = [
      makeOp({ id: 'a', status: 'TP2_HIT', tp1_hit: true, mfe_r: 1.5, mae_r: -0.3, bars_to_tp1: 2 }),
      makeOp({ id: 'b', status: 'STOP_HIT', mfe_r: 0.8, mae_r: -0.6, bars_to_stop: 3 }),
      makeOp({ id: 'c', status: 'STOP_HIT', mfe_r: -0.1, mae_r: -1.0, bars_to_stop: 1 }),
    ];
    const { excursion } = analyzeOps(ops, { costModel: ZERO_COST });
    expect(excursion.counted).toBe(3);
    expect(excursion.avgMfeR).toBeCloseTo((1.5 + 0.8 - 0.1) / 3, 6);
    expect(excursion.medianMfeR).toBeCloseTo(0.8, 6);
    expect(excursion.avgMaeR).toBeCloseTo((-0.3 - 0.6 - 1.0) / 3, 6);
    expect(excursion.avgBarsToTp1).toBeCloseTo(2, 6);
    expect(excursion.avgBarsToStop).toBeCloseTo(2, 6); // (3+1)/2
    expect(excursion.stoppedCount).toBe(2);
    // Só op 'b' parou depois de ter ficado favorável (mfe_r>0); 'c' nunca chegou a ficar positiva.
    expect(excursion.stoppedAfterProfitCount).toBe(1);
    expect(excursion.stoppedAfterProfitShare).toBeCloseTo(0.5, 6);
  });

  it('operações sem mfe_r/mae_r (anteriores a este campo) não quebram a agregação', () => {
    // makeOp() default já é STOP_HIT (fixture padrão do arquivo) — cobre o
    // caso real: uma op antiga sem os campos novos ainda conta em
    // stoppedCount, só não em stoppedAfterProfitCount (mfe_r ausente).
    const { excursion } = analyzeOps([makeOp()], { costModel: ZERO_COST });
    expect(excursion.counted).toBe(0);
    expect(excursion.avgMfeR).toBeNull();
    expect(excursion.stoppedCount).toBe(1);
    expect(excursion.stoppedAfterProfitCount).toBe(0);
    expect(excursion.stoppedAfterProfitShare).toBe(0);
  });

  it('sem NENHUMA operação, stoppedAfterProfitShare vira null em vez de dividir por zero', () => {
    const { excursion } = analyzeOps([], { costModel: ZERO_COST });
    expect(excursion.stoppedCount).toBe(0);
    expect(excursion.stoppedAfterProfitShare).toBeNull();
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
