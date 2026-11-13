import { describe, it, expect } from 'vitest';
import { stopOutcomeIfHit, formatSignedR, ZERO_BAND_PCT } from './stopGuarantee.js';
import { calcRealizedPnlPct, calcRealizedR, ZERO_COST } from './tradeMetrics.js';

// O caso real que motivou o item 303: QNT/USDT, venda, stop já além da entrada.
const qnt = (overrides = {}) => ({
  id: 'qnt', symbol: 'QNTUSDT', side: 'SELL', status: 'SIGNAL_CONFIRMED',
  entry_price: 180.56, initial_stop: 199.4, current_stop: 171.6, tp1: 152.3, tp2: 124.04,
  partial_percent: 50, runner_percent: 50,
  ...overrides,
});

describe('stopOutcomeIfHit — quanto a operação fecha se bater no stop agora', () => {
  it('venda com stop ALÉM da entrada: lucro protegido de +4,96% (≈ +0,48R)', () => {
    const out = stopOutcomeIfHit(qnt());
    expect(out.kind).toBe('profit');
    expect(out.pct).toBeCloseTo(((180.56 - 171.6) / 180.56) * 100, 10);
    expect(out.pct.toFixed(2)).toBe('4.96');
    expect(out.r).toBeCloseTo((180.56 - 171.6) / (199.4 - 180.56), 10);
    expect(out.r.toFixed(2)).toBe('0.48');
    expect(out.stop).toBe(171.6);
    expect(out.includesTp1).toBe(false);
    expect(out.tp1SharePct).toBeNull();
  });

  it('venda com o stop ainda no valor inicial: perda de −1,00R', () => {
    const out = stopOutcomeIfHit(qnt({ current_stop: 199.4 }));
    expect(out.kind).toBe('loss');
    expect(out.pct).toBeCloseTo(-((199.4 - 180.56) / 180.56) * 100, 10);
    expect(out.r).toBeCloseTo(-1, 10);
  });

  it('compra espelha o sinal: stop acima da entrada é lucro, abaixo é perda', () => {
    const buy = { side: 'BUY', status: 'SIGNAL_CONFIRMED', entry_price: 100, initial_stop: 95, tp1: 107.5, tp2: 115 };
    const locked = stopOutcomeIfHit({ ...buy, current_stop: 102 });
    expect(locked.kind).toBe('profit');
    expect(locked.pct).toBeCloseTo(2, 10);
    expect(locked.r).toBeCloseTo(0.4, 10);
    const risk = stopOutcomeIfHit({ ...buy, current_stop: 97 });
    expect(risk.kind).toBe('loss');
    expect(risk.pct).toBeCloseTo(-3, 10);
    expect(risk.r).toBeCloseTo(-0.6, 10);
  });

  it('stop exatamente na entrada = zero a zero (nunca "+0,00%" como lucro)', () => {
    const out = stopOutcomeIfHit(qnt({ current_stop: 180.56 }));
    expect(out.kind).toBe('zero');
    expect(out.pct).toBe(0);
    expect(out.r).toBe(0);
  });

  it('ruído de ponto flutuante dentro da faixa mínima continua zero a zero', () => {
    const out = stopOutcomeIfHit(qnt({ current_stop: 180.56 * (1 - (ZERO_BAND_PCT / 100) * 0.5) }));
    expect(out.kind).toBe('zero');
    // …e logo acima da faixa já é lucro (a faixa não engole ganho real)
    expect(stopOutcomeIfHit(qnt({ current_stop: 180.56 * (1 - (ZERO_BAND_PCT / 100) * 3) })).kind).toBe('profit');
  });

  it('runner (TP1 já batido) soma a parcela realizada: stop na entrada NÃO é zero a zero', () => {
    const out = stopOutcomeIfHit(qnt({ status: 'RUNNER_ACTIVE', tp1_hit: true, tp1_hit_price: 152.3, current_stop: 180.56 }));
    expect(out.kind).toBe('profit');
    // 50% × (180,56 − 152,30) + 50% × 0
    expect(out.pct).toBeCloseTo((0.5 * (180.56 - 152.3) / 180.56) * 100, 10);
    expect(out.includesTp1).toBe(true);
    expect(out.tp1SharePct).toBe(50);
  });

  it('runner respeita o peso congelado na operação (partial_percent), não 50% fixo', () => {
    const out = stopOutcomeIfHit(qnt({
      status: 'RUNNER_ACTIVE', tp1_hit: true, tp1_hit_price: 152.3, current_stop: 170, partial_percent: 30, runner_percent: 70,
    }));
    const expected = ((0.3 * (180.56 - 152.3) + 0.7 * (180.56 - 170)) / 180.56) * 100;
    expect(out.pct).toBeCloseTo(expected, 10);
    expect(out.tp1SharePct).toBe(30);
  });

  it('é a MESMA conta do Histórico: igual a calcRealizedPnlPct/R bruto da operação fechada no stop', () => {
    const op = qnt({ status: 'RUNNER_ACTIVE', tp1_hit: true, tp1_hit_price: 152.3, current_stop: 165 });
    const closed = { ...op, status: 'STOP_HIT', exit_price: 165 };
    const out = stopOutcomeIfHit(op);
    expect(out.pct).toBe(calcRealizedPnlPct(closed, ZERO_COST));
    expect(out.r).toBe(calcRealizedR(closed, ZERO_COST));
  });

  it('usa o stop ATUAL mesmo que a operação carregue um exit_price antigo', () => {
    const out = stopOutcomeIfHit(qnt({ exit_price: 150 }));
    expect(out.pct.toFixed(2)).toBe('4.96');
  });

  it('sem initial_stop (operação legada): devolve o % e R nulo', () => {
    const out = stopOutcomeIfHit(qnt({ initial_stop: null }));
    expect(out.pct.toFixed(2)).toBe('4.96');
    expect(out.r).toBeNull();
  });

  it('não inventa nada: operação fechada, lado desconhecido ou preço ruim devolvem null', () => {
    expect(stopOutcomeIfHit(null)).toBeNull();
    expect(stopOutcomeIfHit('x')).toBeNull();
    for (const status of ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED', undefined]) {
      expect(stopOutcomeIfHit(qnt({ status }))).toBeNull();
    }
    expect(stopOutcomeIfHit(qnt({ side: undefined }))).toBeNull();
    expect(stopOutcomeIfHit(qnt({ side: 'LONG' }))).toBeNull();
    for (const bad of [null, undefined, NaN, 0, -1, '171.6', Infinity]) {
      expect(stopOutcomeIfHit(qnt({ current_stop: bad }))).toBeNull();
      expect(stopOutcomeIfHit(qnt({ entry_price: bad }))).toBeNull();
    }
  });

  it('não muda a operação recebida', () => {
    const op = Object.freeze(qnt());
    stopOutcomeIfHit(op);
    expect(op.status).toBe('SIGNAL_CONFIRMED');
    expect('exit_price' in op).toBe(false);
  });
});

describe('formatSignedR — mesma escrita de número do painel', () => {
  it('sinal explícito só no positivo, duas casas', () => {
    expect(formatSignedR(0.4756)).toBe('+0.48R');
    expect(formatSignedR(-1)).toBe('-1.00R');
    expect(formatSignedR(0)).toBe('0.00R');
  });

  it('sem número, sem texto', () => {
    for (const bad of [null, undefined, NaN, Infinity, '0.5']) expect(formatSignedR(bad)).toBeNull();
  });
});
