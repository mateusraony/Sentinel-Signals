import { describe, it, expect } from 'vitest';
import {
  EMPTY_FILTERS, PERIOD_OPTIONS, countActiveFilters, periodRange, itemSide, applyTradeFilters,
  summarizeActiveOps, describeActiveSummary,
} from './tradesOverview.js';

const NOW = new Date(2026, 10, 14, 15, 30, 0).getTime(); // 14/11/2026 15:30 no fuso do processo (sábado)
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();

const op = (overrides = {}) => ({
  id: 'op', symbol: 'QNTUSDT', side: 'SELL', status: 'SIGNAL_CONFIRMED', timeframe: '15m', signal_timeframe: '4h',
  entry_price: 180, initial_stop: 200, current_stop: 170, tp1: 150, tp2: 120, created_date: at(2026, 11, 14, 9),
  ...overrides,
});
const signal = (overrides = {}) => ({
  id: 'sig', symbol: 'BTCUSDT', signal_type: 'BUY', timeframe: '1h', created_date: at(2026, 11, 14, 10), ...overrides,
});

describe('countActiveFilters', () => {
  it('nenhum filtro = 0; cada filtro ligado conta 1', () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
    expect(countActiveFilters({ ...EMPTY_FILTERS, search: 'btc' })).toBe(1);
    expect(countActiveFilters({ search: 'btc', timeframe: '4h', side: 'SELL', period: 'week' })).toBe(4);
  });

  it('busca só com espaço, valor ausente ou filtros nulos não contam', () => {
    expect(countActiveFilters({ ...EMPTY_FILTERS, search: '   ' })).toBe(0);
    expect(countActiveFilters({})).toBe(0);
    expect(countActiveFilters(null)).toBe(0);
    expect(countActiveFilters({ search: 42, timeframe: undefined, side: null, period: '' })).toBe(0);
  });
});

describe('periodRange', () => {
  it('"Todo o período" e valor desconhecido não recortam', () => {
    expect(periodRange('all', NOW)).toBeNull();
    expect(periodRange('qualquer', NOW)).toBeNull();
    expect(periodRange(undefined, NOW)).toBeNull();
  });

  it('hoje = do início ao fim do dia de "agora"', () => {
    const r = periodRange('today', NOW);
    expect(r.from).toEqual(new Date(2026, 10, 14, 0, 0, 0, 0));
    expect(r.to).toEqual(new Date(2026, 10, 14, 23, 59, 59, 999));
  });

  it('mês e mês passado', () => {
    expect(periodRange('month', NOW).from).toEqual(new Date(2026, 10, 1, 0, 0, 0, 0));
    expect(periodRange('month', NOW).to).toEqual(new Date(2026, 10, 30, 23, 59, 59, 999));
    expect(periodRange('last_month', NOW).from).toEqual(new Date(2026, 9, 1, 0, 0, 0, 0));
    expect(periodRange('last_month', NOW).to).toEqual(new Date(2026, 9, 31, 23, 59, 59, 999));
  });

  it('trimestre e ano', () => {
    expect(periodRange('quarter', NOW).from).toEqual(new Date(2026, 9, 1, 0, 0, 0, 0));
    expect(periodRange('quarter', NOW).to).toEqual(new Date(2026, 11, 31, 23, 59, 59, 999));
    expect(periodRange('year', NOW).from).toEqual(new Date(2026, 0, 1, 0, 0, 0, 0));
    expect(periodRange('year', NOW).to).toEqual(new Date(2026, 11, 31, 23, 59, 59, 999));
  });

  it('semana: 7 dias que contêm "agora"', () => {
    const r = periodRange('week', NOW);
    expect(r.from.getTime()).toBeLessThanOrEqual(NOW);
    expect(r.to.getTime()).toBeGreaterThanOrEqual(NOW);
    expect(Math.round((r.to.getTime() - r.from.getTime()) / 86400000)).toBe(7);
  });

  it('toda opção do seletor tem um recorte (menos "Todo o período") e rótulo em português', () => {
    expect(PERIOD_OPTIONS[0]).toEqual({ id: 'all', label: 'Todo o período' });
    for (const option of PERIOD_OPTIONS.slice(1)) {
      expect(periodRange(option.id, NOW), option.id).not.toBeNull();
      expect(option.label.length).toBeGreaterThan(2);
    }
    expect(new Set(PERIOD_OPTIONS.map((o) => o.id)).size).toBe(PERIOD_OPTIONS.length);
  });
});

describe('applyTradeFilters', () => {
  it('sem filtros devolve tudo, na mesma ordem', () => {
    const list = [op({ id: 'a' }), op({ id: 'b' })];
    expect(applyTradeFilters(list, EMPTY_FILTERS, { nowMs: NOW }).map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('REGRESSÃO: o filtro de gráfico usa o gráfico do AVISO (4H), não o da entrada (15M) — antes "4H" escondia todas as operações', () => {
    const cascata = op({ id: 'cascata', timeframe: '15m', signal_timeframe: '4h' });
    const smc = op({ id: 'smc', timeframe: '5m', signal_timeframe: '1h' });
    const f = (timeframe) => applyTradeFilters([cascata, smc], { ...EMPTY_FILTERS, timeframe }, { nowMs: NOW }).map((o) => o.id);
    expect(f('4h')).toEqual(['cascata']);
    expect(f('1h')).toEqual(['smc']);
    expect(f('1d')).toEqual([]);
    expect(f('all')).toEqual(['cascata', 'smc']);
  });

  it('operação legada da cascata sem signal_timeframe conta como 4H (mesma regra do Histórico)', () => {
    const legada = op({ id: 'legada', timeframe: '15m', signal_timeframe: undefined });
    expect(applyTradeFilters([legada], { ...EMPTY_FILTERS, timeframe: '4h' }, { nowMs: NOW })).toHaveLength(1);
  });

  it('aviso é filtrado pelo próprio gráfico e pelo lado em signal_type', () => {
    const avisos = [signal({ id: 's1', timeframe: '1h', signal_type: 'BUY' }), signal({ id: 's2', timeframe: '4h', signal_type: 'SELL' })];
    expect(applyTradeFilters(avisos, { ...EMPTY_FILTERS, timeframe: '4h' }, { nowMs: NOW }).map((s) => s.id)).toEqual(['s2']);
    expect(applyTradeFilters(avisos, { ...EMPTY_FILTERS, side: 'BUY' }, { nowMs: NOW }).map((s) => s.id)).toEqual(['s1']);
    expect(itemSide(avisos[1])).toBe('SELL');
    expect(itemSide({})).toBeNull();
  });

  it('lado e busca (sem diferenciar maiúscula, com espaço em volta)', () => {
    const list = [op({ id: 'q', symbol: 'QNTUSDT', side: 'SELL' }), op({ id: 'b', symbol: 'BTCUSDT', side: 'BUY' })];
    expect(applyTradeFilters(list, { ...EMPTY_FILTERS, side: 'BUY' }, { nowMs: NOW }).map((o) => o.id)).toEqual(['b']);
    expect(applyTradeFilters(list, { ...EMPTY_FILTERS, search: '  qnt ' }, { nowMs: NOW }).map((o) => o.id)).toEqual(['q']);
    expect(applyTradeFilters(list, { ...EMPTY_FILTERS, search: 'USDT' }, { nowMs: NOW })).toHaveLength(2);
    expect(applyTradeFilters(list, { ...EMPTY_FILTERS, search: 'xrp' }, { nowMs: NOW })).toEqual([]);
  });

  it('período: pela data de criação, com as bordas do dia incluídas', () => {
    const hoje = op({ id: 'hoje', created_date: new Date(2026, 10, 14, 0, 0, 0, 0).toISOString() });
    const fimDeHoje = op({ id: 'fim', created_date: new Date(2026, 10, 14, 23, 59, 59, 999).toISOString() });
    const ontem = op({ id: 'ontem', created_date: new Date(2026, 10, 13, 23, 59, 59, 999).toISOString() });
    const outubro = op({ id: 'out', created_date: at(2026, 10, 20) });
    const f = (period) => applyTradeFilters([hoje, fimDeHoje, ontem, outubro], { ...EMPTY_FILTERS, period }, { nowMs: NOW }).map((o) => o.id);
    expect(f('today')).toEqual(['hoje', 'fim']);
    expect(f('month')).toEqual(['hoje', 'fim', 'ontem']);
    expect(f('last_month')).toEqual(['out']);
    expect(f('all')).toEqual(['hoje', 'fim', 'ontem', 'out']);
  });

  it('item sem data válida só aparece quando não há recorte de período', () => {
    // Data nula vira 1970 ao ser lida (cai fora de qualquer período); texto ilegível e data ausente viram NaN — todos têm que sumir.
    for (const created_date of [null, undefined, 'lixo', '']) {
      const semData = op({ id: 'x', created_date });
      expect(applyTradeFilters([semData], EMPTY_FILTERS, { nowMs: NOW }), String(created_date)).toHaveLength(1);
      expect(applyTradeFilters([semData], { ...EMPTY_FILTERS, period: 'year' }, { nowMs: NOW }), String(created_date)).toEqual([]);
    }
  });

  it('os filtros se somam (E, não OU)', () => {
    const list = [
      op({ id: 'ok', symbol: 'QNTUSDT', side: 'SELL' }),
      op({ id: 'lado', symbol: 'QNTUSDT', side: 'BUY' }),
      op({ id: 'moeda', symbol: 'BTCUSDT', side: 'SELL' }),
      op({ id: 'grafico', symbol: 'QNTUSDT', side: 'SELL', timeframe: '5m', signal_timeframe: '1h' }),
    ];
    const out = applyTradeFilters(list, { search: 'qnt', timeframe: '4h', side: 'SELL', period: 'today' }, { nowMs: NOW });
    expect(out.map((o) => o.id)).toEqual(['ok']);
  });

  it('entrada estranha não quebra', () => {
    expect(applyTradeFilters(null, EMPTY_FILTERS)).toEqual([]);
    expect(applyTradeFilters([null, 'x', op({ id: 'a' })], EMPTY_FILTERS, { nowMs: NOW }).map((o) => o.id)).toEqual(['a']);
    expect(applyTradeFilters([op({ id: 'a' })], null, { nowMs: NOW })).toHaveLength(1);
  });
});

describe('summarizeActiveOps — o resumo do topo', () => {
  const protegida = op({ id: 'p' }); // stop 170 abaixo da entrada 180 numa venda: +10/20 = +0.50R
  const zero = op({ id: 'z', current_stop: 180 });
  const risco = op({ id: 'r', current_stop: 200 }); // -1R
  const compraRisco = { id: 'c', side: 'BUY', status: 'SIGNAL_CONFIRMED', entry_price: 100, initial_stop: 95, current_stop: 97, tp1: 107, tp2: 115 }; // -0.6R

  it('conta cada postura e soma o resultado no stop em R', () => {
    const s = summarizeActiveOps([protegida, zero, risco, compraRisco]);
    expect(s).toMatchObject({ total: 4, protectedCount: 1, zeroCount: 1, riskCount: 2, unknownCount: 0 });
    expect(s.stopSumR).toBeCloseTo(0.5 + 0 - 1 - 0.6, 10);
  });

  it('sem operação: tudo zero e nenhuma soma', () => {
    expect(summarizeActiveOps([])).toEqual({ total: 0, protectedCount: 0, zeroCount: 0, riskCount: 0, unknownCount: 0, stopSumR: null });
    expect(summarizeActiveOps(null).total).toBe(0);
  });

  it('uma operação sem stop inicial (sem R) apaga a soma — soma parcial pareceria o número da carteira', () => {
    const semR = op({ id: 'legada', initial_stop: null });
    const s = summarizeActiveOps([protegida, semR]);
    expect(s.protectedCount).toBe(2);
    expect(s.stopSumR).toBeNull();
  });

  it('operação sem stop legível vai para "sem stop legível" e também apaga a soma', () => {
    const s = summarizeActiveOps([protegida, op({ id: 'x', current_stop: null })]);
    expect(s).toMatchObject({ total: 2, protectedCount: 1, unknownCount: 1, stopSumR: null });
  });

  it('runner conta a parcela do TP1: stop na entrada depois do TP1 é lucro protegido, não zero a zero', () => {
    const runner = op({ id: 'run', status: 'RUNNER_ACTIVE', tp1_hit: true, tp1_hit_price: 150, current_stop: 180, partial_percent: 50 });
    const s = summarizeActiveOps([runner]);
    expect(s).toMatchObject({ protectedCount: 1, zeroCount: 0 });
    expect(s.stopSumR).toBeCloseTo(0.75, 10); // 50% x (180-150)/20
  });
});

describe('describeActiveSummary', () => {
  it('só as partes que existem, na ordem protegido → zero → risco', () => {
    expect(describeActiveSummary({ total: 3, protectedCount: 2, zeroCount: 0, riskCount: 1, unknownCount: 0 })).toBe('2 com lucro protegido · 1 com risco em jogo');
    expect(describeActiveSummary({ total: 2, protectedCount: 0, zeroCount: 1, riskCount: 0, unknownCount: 1 })).toBe('1 no zero a zero · 1 sem stop legível');
    expect(describeActiveSummary({ total: 1, protectedCount: 0, zeroCount: 0, riskCount: 1, unknownCount: 0 })).toBe('1 com risco em jogo');
  });

  it('sem operação, texto vazio', () => {
    expect(describeActiveSummary({ total: 0, protectedCount: 0, zeroCount: 0, riskCount: 0, unknownCount: 0 })).toBe('');
    expect(describeActiveSummary(null)).toBe('');
  });
});
