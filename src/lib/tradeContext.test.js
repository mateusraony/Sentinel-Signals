// Item 292: "O que o sistema via e como o trade se formou" (aba Histórico). O que se prova: cada linha só existe quando o dado existe (operação legada
// nunca vira "undefined"/"NaN"/"0/100"/duração inventada), "a favor/contra" respeita o lado, o plano sai em R a partir dos PREÇOS, a duração só usa
// carimbo de encerramento conhecido, e o resultado fecha a conta: bruto − custos = líquido e TP1 + restante = bruto — tudo vindo da fonte única
// (`tradeMetrics`), sem recalcular regra própria. Texto neutro: descreve, não prevê nem opina.
import { describe, it, expect } from 'vitest';
import {
  CANDLE_PATTERN_LABEL, buildEntryContext, buildPlanVsActual, buildResultBreakdown, costModelNote,
} from './tradeContext.js';
import {
  DEFAULT_COST_MODEL, ZERO_COST, calcRealizedPnlPct, calcRealizedR, calcCostR,
} from './tradeMetrics.js';
import { AGREEMENT_HINT } from './ruleAgreement.js';

const byKey = (rows, key) => rows.find((r) => r.key === key);
const keysOf = (rows) => rows.map((r) => r.key);
const allText = (rows) => rows.map((r) => `${r.label} ${r.value} ${r.hint ?? ''}`).join(' | ');

const BUY_STOP_APOS_TP1 = {
  side: 'BUY', status: 'STOP_HIT', timeframe: '15m', signal_timeframe: '4h',
  entry_price: 100, initial_stop: 95, current_stop: 100, tp1: 107.5, tp2: 115, exit_price: 100,
  partial_percent: 50, tp1_hit: true, tp1_hit_at: '2026-11-02T10:00:00Z', tp1_hit_price: 107.5,
  stop_hit_at: '2026-11-03T02:00:00Z', closed_at: '2026-11-03T02:00:00Z', created_date: '2026-11-01T12:00:00Z',
};
const SELL_TP2 = {
  side: 'SELL', status: 'TP2_HIT', timeframe: '15m', signal_timeframe: '4h',
  entry_price: 100, initial_stop: 105, current_stop: 105, tp1: 92.5, tp2: 85, exit_price: 85,
  partial_percent: 50, tp1_hit: true, tp1_hit_at: '2026-11-02T10:00:00Z', tp1_hit_price: 92.5, tp2_hit: true, tp2_hit_at: '2026-11-04T10:00:00Z',
  closed_at: '2026-11-04T10:00:00Z', created_date: '2026-11-01T12:00:00Z',
};
const TIME_STOP = {
  side: 'BUY', status: 'CLOSED', closed_reason: 'TIME_STOP', timeframe: '15m', signal_timeframe: '4h',
  entry_price: 100, initial_stop: 95, current_stop: 95, tp1: 107.5, tp2: 115, exit_price: 101,
  closed_at: '2026-11-05T00:00:00Z', created_date: '2026-11-01T00:00:00Z',
};
const LEGADA_MINIMA = {
  symbol: 'BTCUSDT', side: 'BUY', status: 'STOP_HIT', entry_price: 100, initial_stop: 95, exit_price: 95,
  created_date: '2026-10-01T00:00:00Z', closed_at: '2026-10-02T00:00:00Z',
};

describe('buildEntryContext — o que o sistema via na entrada', () => {
  it('tendências 1D/4H/1H em frase, "a favor/contra" conforme o lado (BUY)', () => {
    const rows = buildEntryContext({ side: 'BUY', tf_1d_direction: 1, tf_4h_direction: 1, tf_1h_direction: -1 });
    expect(byKey(rows, 'trends').value).toBe('1D alta (a favor) · 4H alta (a favor) · 1H baixa (contra)');
  });
  it('no SELL a relação se inverte', () => {
    const rows = buildEntryContext({ side: 'SELL', tf_1d_direction: 1, tf_4h_direction: 1, tf_1h_direction: -1 });
    expect(byKey(rows, 'trends').value).toBe('1D alta (contra) · 4H alta (contra) · 1H baixa (a favor)');
  });
  it('lado desconhecido: diz a tendência, mas não afirma a favor/contra', () => {
    const rows = buildEntryContext({ tf_1d_direction: 1, tf_4h_direction: -1 });
    expect(byKey(rows, 'trends').value).toBe('1D alta · 4H baixa');
  });
  it('0, ausente, texto ou NaN = sem leitura: o timeframe sai da frase; sem nenhum, sem linha', () => {
    const parcial = buildEntryContext({ side: 'BUY', tf_1d_direction: 0, tf_4h_direction: 1, tf_1h_direction: null });
    expect(byKey(parcial, 'trends').value).toBe('4H alta (a favor)');
    const nenhuma = buildEntryContext({ side: 'BUY', tf_1d_direction: 0, tf_4h_direction: '1', tf_1h_direction: NaN });
    expect(byKey(nenhuma, 'trends')).toBeUndefined();
  });

  it('regras alinhadas: 🧩 N/100 com o aviso de que não é chance de acerto', () => {
    const row = byKey(buildEntryContext({ entry_score: 85 }), 'agreement');
    expect(row.value).toBe('🧩 85/100');
    expect(row.hint).toBe(AGREEMENT_HINT);
    expect(row.hint).toMatch(/não é chance de acerto/);
  });
  it('sem entry_score cai para o score antigo; score 0 ou inválido = sem dado (nunca "0/100")', () => {
    expect(byKey(buildEntryContext({ score: 70 }), 'agreement').value).toBe('🧩 70/100');
    for (const op of [{ entry_score: 0 }, { score: 0 }, { entry_score: NaN }, { entry_score: '85' }, {}]) {
      expect(byKey(buildEntryContext(op), 'agreement')).toBeUndefined();
    }
  });

  it('tier, ADX e Choppiness com os nomes simples e a dica do que "maior" significa', () => {
    const rows = buildEntryContext({ tier: 't2', adx_at_entry: 28.43, chop_at_entry: 45.2 });
    expect(byKey(rows, 'tier').value).toBe('T2');
    expect(byKey(rows, 'adx')).toMatchObject({ value: '28.4', hint: 'Quanto maior, mais forte era a tendência.' });
    expect(byKey(rows, 'chop')).toMatchObject({ value: '45.2', hint: 'Quanto maior, mais o preço andava de lado.' });
  });
  it('tier vazio e ADX/Chop nulos, NaN ou texto são omitidos', () => {
    const rows = buildEntryContext({ tier: '  ', adx_at_entry: null, chop_at_entry: NaN });
    expect(keysOf(rows)).toEqual([]);
    expect(keysOf(buildEntryContext({ adx_at_entry: '28', chop_at_entry: undefined }))).toEqual([]);
  });

  it('padrão de vela: os 6 do schema têm rótulo; desconhecido ou nulo é omitido', () => {
    for (const [code, label] of Object.entries(CANDLE_PATTERN_LABEL)) {
      expect(byKey(buildEntryContext({ entry_candle_pattern: code }), 'pattern').value).toBe(label);
    }
    expect(Object.keys(CANDLE_PATTERN_LABEL)).toHaveLength(6);
    expect(byKey(buildEntryContext({ entry_candle_pattern: 'doji' }), 'pattern')).toBeUndefined();
    expect(byKey(buildEntryContext({ entry_candle_pattern: null }), 'pattern')).toBeUndefined();
  });

  it('estrutura SMC: só "a favor" e "contra"; unavailable e nulo são omitidos', () => {
    expect(byKey(buildEntryContext({ smc_alignment_at_entry: 'aligned' }), 'smc').value).toBe('a favor da operação');
    expect(byKey(buildEntryContext({ smc_alignment_at_entry: 'against' }), 'smc').value).toBe('contra a operação');
    for (const v of ['unavailable', null, 'x']) expect(byKey(buildEntryContext({ smc_alignment_at_entry: v }), 'smc')).toBeUndefined();
  });

  it('ordem fixa das linhas e nada de "undefined"/"NaN" mesmo com a operação cheia', () => {
    const rows = buildEntryContext({
      side: 'BUY', tf_1d_direction: 1, tf_4h_direction: 1, tf_1h_direction: 1, entry_score: 80, tier: 'T1',
      adx_at_entry: 30, chop_at_entry: 40, entry_candle_pattern: 'hammer', smc_alignment_at_entry: 'aligned',
    });
    expect(keysOf(rows)).toEqual(['trends', 'agreement', 'tier', 'adx', 'chop', 'pattern', 'smc']);
    expect(allText(rows)).not.toMatch(/undefined|NaN|null/);
  });

  it('operação legada mínima e entradas ruins: lista vazia, sem lançar', () => {
    expect(buildEntryContext(LEGADA_MINIMA)).toEqual([]);
    for (const x of [null, undefined, 7, 'x', true]) expect(buildEntryContext(x)).toEqual([]);
  });

  it('texto neutro: descreve o que foi medido, não prevê nem promete', () => {
    const rows = buildEntryContext({
      side: 'BUY', tf_1d_direction: 1, tf_4h_direction: 1, tf_1h_direction: 1, entry_score: 90, tier: 'T3',
      adx_at_entry: 35, chop_at_entry: 30, entry_candle_pattern: 'bullish_engulfing', smc_alignment_at_entry: 'aligned',
    });
    expect(allText(rows)).not.toMatch(/vai (subir|cair)|probabilidade|garant|certeza|deveria|recomend/i);
  });
});

describe('buildPlanVsActual — o plano contra o realizado', () => {
  it('risco previsto em % do preço e alvos em R, calculados dos PREÇOS (BUY)', () => {
    const rows = buildPlanVsActual(BUY_STOP_APOS_TP1);
    expect(byKey(rows, 'risk').value).toBe('5.00% do preço de entrada');
    expect(byKey(rows, 'targets').value).toBe('TP1 +1.50R · TP2 +3.00R');
  });
  it('no SELL os alvos também saem positivos (distância do lado certo)', () => {
    expect(byKey(buildPlanVsActual(SELL_TP2), 'targets').value).toBe('TP1 +1.50R · TP2 +3.00R');
  });
  it('sem runner (TP1 fecha tudo): só o TP1, com a frase; sem TP2', () => {
    const rows = buildPlanVsActual({ ...BUY_STOP_APOS_TP1, partial_percent: 100 });
    expect(byKey(rows, 'targets').value).toBe('TP1 +1.50R (fecha toda a posição)');
  });
  it('teto do TP2 desligado: o TP2 não é mostrado como alvo', () => {
    const rows = buildPlanVsActual({ ...BUY_STOP_APOS_TP1, tp2_cap_disabled: true });
    expect(byKey(rows, 'targets').value).toBe('TP1 +1.50R');
  });
  it('alvo do lado errado ou ausente não vira linha; sem nenhum alvo, sem a linha de alvos', () => {
    expect(byKey(buildPlanVsActual({ ...BUY_STOP_APOS_TP1, tp1: 90 }), 'targets').value).toBe('TP2 +3.00R');
    expect(byKey(buildPlanVsActual({ ...BUY_STOP_APOS_TP1, tp1: 90, tp2: 80 }), 'targets')).toBeUndefined();
    expect(byKey(buildPlanVsActual({ ...BUY_STOP_APOS_TP1, tp1: undefined, tp2: null }), 'targets')).toBeUndefined();
  });
  it('lado desconhecido: não inventa o sinal dos alvos', () => {
    expect(byKey(buildPlanVsActual({ ...BUY_STOP_APOS_TP1, side: undefined }), 'targets')).toBeUndefined();
  });
  it('stop igual à entrada ou ausente: sem risco e sem alvos (divisão por zero nunca aparece)', () => {
    for (const initial_stop of [100, undefined, 0, NaN]) {
      const rows = buildPlanVsActual({ ...BUY_STOP_APOS_TP1, initial_stop });
      expect(byKey(rows, 'risk')).toBeUndefined();
      expect(byKey(rows, 'targets')).toBeUndefined();
      expect(allText(rows)).not.toMatch(/Infinity|NaN|undefined/);
    }
  });

  it('prazo máximo: velas do timeframe do aviso e o tempo equivalente (4h e 1h)', () => {
    const r4 = buildPlanVsActual({ ...BUY_STOP_APOS_TP1, tier_time_stop_bars: 48 });
    expect(byKey(r4, 'deadline').value).toBe('48 velas de 4H (~8 dias)');
    expect(byKey(r4, 'deadline').hint).toMatch(/Time Stop/);
    const r1 = buildPlanVsActual({ ...BUY_STOP_APOS_TP1, signal_timeframe: '1h', timeframe: '5m', tier_time_stop_bars: 96 });
    expect(byKey(r1, 'deadline').value).toBe('96 velas de 1H (~4 dias)');
  });
  it('prazo ausente, zero, inválido ou de timeframe desconhecido: sem linha', () => {
    for (const bars of [undefined, null, 0, -4, NaN, '48']) {
      expect(byKey(buildPlanVsActual({ ...BUY_STOP_APOS_TP1, tier_time_stop_bars: bars }), 'deadline')).toBeUndefined();
    }
    expect(byKey(buildPlanVsActual({ ...BUY_STOP_APOS_TP1, signal_timeframe: '1d', timeframe: '1d', tier_time_stop_bars: 48 }), 'deadline')).toBeUndefined();
  });

  it('duração: da entrada ao carimbo de encerramento (STOP_HIT usa o horário do stop)', () => {
    // created_date 01/11 12:00 → stop_hit_at 03/11 02:00 = 38 h
    expect(byKey(buildPlanVsActual(BUY_STOP_APOS_TP1), 'duration').value).toBe('~38 h');
    // o horário de mercado do stop vence o de detecção: 02/11 22:00 = 34 h
    const real = { ...BUY_STOP_APOS_TP1, stop_hit_real_time: '2026-11-02T22:00:00Z' };
    expect(byKey(buildPlanVsActual(real), 'duration').value).toBe('~34 h');
  });
  it('carimbo ruim na frente não esconde o próximo válido (cai para o seguinte)', () => {
    const op = { ...BUY_STOP_APOS_TP1, stop_hit_real_time: 'lixo' }; // cai para stop_hit_at → 38 h
    expect(byKey(buildPlanVsActual(op), 'duration').value).toBe('~38 h');
    const semStop = { ...BUY_STOP_APOS_TP1, stop_hit_real_time: 'lixo', stop_hit_at: '', closed_at_real_time: '2026-11-02T12:00:00Z' }; // 24 h
    expect(byKey(buildPlanVsActual(semStop), 'duration').value).toBe('~24 h');
  });
  it('a entrada vem do candle de entrada quando existe (não do horário do sinal)', () => {
    const op = { ...BUY_STOP_APOS_TP1, entry_candle_time_15m: '2026-11-01T20:00:00Z' }; // → 03/11 02:00 = 30 h
    expect(byKey(buildPlanVsActual(op), 'duration').value).toBe('~30 h');
  });
  it('outros encerramentos usam closed_at_real_time ?? closed_at, nunca o horário do stop', () => {
    // SELL_TP2: 01/11 12:00 → 04/11 10:00 = 70 h ≈ 3 dias
    expect(byKey(buildPlanVsActual(SELL_TP2), 'duration').value).toBe('~3 dias');
    const comStopFantasma = { ...SELL_TP2, stop_hit_at: '2026-11-01T13:00:00Z' };
    expect(byKey(buildPlanVsActual(comStopFantasma), 'duration').value).toBe('~3 dias');
    const real = { ...SELL_TP2, closed_at_real_time: '2026-11-03T12:00:00Z' }; // 48 h
    expect(byKey(buildPlanVsActual(real), 'duration').value).toBe('~2 dias');
  });
  it('Time Stop sem prazo gravado: mostra o risco e a duração, sem inventar o prazo', () => {
    const rows = buildPlanVsActual(TIME_STOP);
    expect(keysOf(rows)).toEqual(['risk', 'targets', 'duration']);
    expect(byKey(rows, 'duration').value).toBe('~4 dias');
  });
  it('sem carimbo de encerramento conhecido a duração não existe (updated_date/created_date não valem)', () => {
    const { closed_at: _c, stop_hit_at: _s, ...semCarimbo } = BUY_STOP_APOS_TP1;
    const rows = buildPlanVsActual({ ...semCarimbo, updated_date: '2026-11-03T02:00:00Z' });
    expect(byKey(rows, 'duration')).toBeUndefined();
  });
  it('carimbo inválido, anterior à entrada ou operação aberta: sem duração', () => {
    for (const closed_at of ['não é data', '', null]) {
      const op = { ...TIME_STOP, closed_at };
      expect(byKey(buildPlanVsActual(op), 'duration')).toBeUndefined();
    }
    expect(byKey(buildPlanVsActual({ ...TIME_STOP, closed_at: '2026-10-31T00:00:00Z' }), 'duration')).toBeUndefined();
    expect(byKey(buildPlanVsActual({ ...TIME_STOP, status: 'RUNNER_ACTIVE' }), 'duration')).toBeUndefined();
  });

  it('entradas ruins não lançam e não geram texto quebrado', () => {
    for (const x of [null, undefined, 7, 'x']) expect(buildPlanVsActual(x)).toEqual([]);
    expect(allText(buildPlanVsActual(LEGADA_MINIMA))).not.toMatch(/undefined|NaN|Infinity/);
  });
});

describe('buildResultBreakdown — bruto → custos → líquido', () => {
  it('BUY com parcial no TP1: bruto +0,75R / +3,75%; as duas partes somam o bruto', () => {
    const b = buildResultBreakdown(BUY_STOP_APOS_TP1);
    expect(b.grossR).toBeCloseTo(0.75, 9);
    expect(b.grossPct).toBeCloseTo(3.75, 9);
    expect(b.legs.map((l) => l.key)).toEqual(['tp1_leg', 'runner_leg']);
    expect(b.legs[0]).toMatchObject({ label: '50% fechado no TP1' });
    expect(b.legs[0].r).toBeCloseTo(0.75, 9);
    expect(b.legs[1]).toMatchObject({ label: '50% restante, até a saída' });
    expect(b.legs[1].r).toBeCloseTo(0, 9);
  });
  it('SELL com TP2: partes 0,75R + 1,50R = bruto 2,25R (o lado inverte o sinal)', () => {
    const b = buildResultBreakdown(SELL_TP2);
    expect(b.grossR).toBeCloseTo(2.25, 9);
    expect(b.legs[0].r).toBeCloseTo(0.75, 9);
    expect(b.legs[1].r).toBeCloseTo(1.5, 9);
  });
  it('a conta fecha: bruto − custos = líquido (em % e em R) e o líquido é o da fonte única', () => {
    for (const op of [BUY_STOP_APOS_TP1, SELL_TP2, TIME_STOP, LEGADA_MINIMA]) {
      const b = buildResultBreakdown(op);
      expect(b.netPct).toBeCloseTo(calcRealizedPnlPct(op), 12);
      expect(b.netR).toBeCloseTo(calcRealizedR(op), 12);
      expect(b.grossPct).toBeCloseTo(calcRealizedPnlPct(op, ZERO_COST), 12);
      expect(b.grossPct - b.costPct).toBeCloseTo(b.netPct, 12);
      expect(b.grossR - b.costR).toBeCloseTo(b.netR, 12);
      expect(b.costR).toBeCloseTo(calcCostR(op), 12);
      expect(b.costPct).toBeGreaterThan(0); // com o modelo padrão o custo sempre pesa contra
    }
  });
  it('as partes somam o bruto em R (invariante), com e sem parcial', () => {
    for (const op of [BUY_STOP_APOS_TP1, SELL_TP2]) {
      const b = buildResultBreakdown(op);
      const soma = b.legs.reduce((acc, l) => acc + l.r, 0);
      expect(soma).toBeCloseTo(b.grossR, 9);
    }
  });
  it('parcela diferente de 50%: os rótulos mostram a divisão real (30/70)', () => {
    const op = { ...BUY_STOP_APOS_TP1, partial_percent: 30, exit_price: 104 };
    const b = buildResultBreakdown(op);
    expect(b.legs.map((l) => l.label)).toEqual(['30% fechado no TP1', '70% restante, até a saída']);
    expect(b.legs[0].r + b.legs[1].r).toBeCloseTo(b.grossR, 9);
  });
  it('sem TP1 (Time Stop) ou com TP1 fechando tudo: sem partes, só o total', () => {
    expect(buildResultBreakdown(TIME_STOP).legs).toEqual([]);
    expect(buildResultBreakdown({ ...BUY_STOP_APOS_TP1, partial_percent: 100, exit_price: 107.5, closed_reason: 'TP1_FULL', status: 'CLOSED' }).legs).toEqual([]);
  });
  it('sem stop inicial: o resultado em % existe, mas em R não (nada inventado)', () => {
    const { initial_stop: _i, ...semStop } = LEGADA_MINIMA;
    const b = buildResultBreakdown(semStop);
    expect(b.netPct).toBeLessThan(0);
    expect(b.grossR).toBeNull();
    expect(b.costR).toBeNull();
    expect(b.netR).toBeNull();
    expect(b.legs).toEqual([]);
  });
  it('operação aberta, sem preço de saída ou entrada ruim: null', () => {
    expect(buildResultBreakdown({ ...BUY_STOP_APOS_TP1, status: 'RUNNER_ACTIVE' })).toBeNull();
    expect(buildResultBreakdown({ side: 'BUY', status: 'CLOSED', entry_price: 100 })).toBeNull();
    for (const x of [null, undefined, 7, 'x']) expect(buildResultBreakdown(x)).toBeNull();
  });
});

describe('costModelNote — as premissas vêm do mesmo modelo que calcula o líquido', () => {
  it('descreve taxa, deslizamento e funding do modelo padrão e diz que não é o extrato', () => {
    const note = costModelNote();
    expect(note).toContain('taxa 0.05% na entrada e 0.05% na saída');
    expect(note).toContain('deslizamento 0.01% por lado');
    expect(note).toContain('funding 0.01% a cada 8 h');
    expect(note).toMatch(/não são o extrato da corretora/);
    expect(note).toMatch(/nível planejado, não um preenchimento medido/);
  });
  it('se o modelo mudar, a frase muda junto (não é texto fixo)', () => {
    const original = DEFAULT_COST_MODEL.feeBpsEntry;
    try {
      DEFAULT_COST_MODEL.feeBpsEntry = 10;
      expect(costModelNote()).toContain('taxa 0.10% na entrada');
    } finally {
      DEFAULT_COST_MODEL.feeBpsEntry = original;
    }
    expect(costModelNote()).toContain('taxa 0.05% na entrada');
  });
});
