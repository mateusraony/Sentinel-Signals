// Item 291: "A história deste trade" e o timeframe do aviso (aba Histórico). O que se prova: os passos saem na ordem que aconteceram e só com dado
// que existe (operação legada nunca vira "undefined"/"NaN"/horário inventado), o resultado bate com a fonte única (`tradeMetrics`), o texto é neutro
// (descreve, não prevê nem opina), e o timeframe do AVISO (4h/1h) não se confunde com o de EXECUÇÃO (15m/5m) — a causa do filtro 1H/4H/1D que
// não mostrava nenhuma operação nova.
import { describe, it, expect } from 'vitest';
import {
  GAVE_BACK_MIN_R, opSignalTimeframe, timeframeChipLabel, elapsedLabel, buildTradeStory,
} from './tradeStory.js';
import { calcRealizedPnlPct, calcRealizedR } from './tradeMetrics.js';
import { formatPrice } from './priceProximity.js';

const fmt = (iso) => `T(${String(iso).slice(0, 10)})`;
const p = (v) => `$${formatPrice(v)}`;
const textos = (steps) => steps.map((s) => s.text);
const keys = (steps) => steps.map((s) => s.key);

const BUY_STOP_APOS_TP1 = {
  side: 'BUY', status: 'STOP_HIT', timeframe: '15m', signal_timeframe: '4h',
  entry_price: 100, initial_stop: 95, current_stop: 100, tp1: 107.5, tp2: 115, exit_price: 100,
  partial_percent: 50, tp1_hit: true, tp1_hit_at: '2026-11-02T10:00:00Z', tp1_hit_price: 107.5,
  stop_hit_at: '2026-11-03T02:00:00Z', closed_at: '2026-11-03T02:00:00Z', created_date: '2026-11-01T12:00:00Z',
  mfe_r: 2.4, mae_r: -0.3, bars_to_mfe: 3,
};
const SELL_TP2 = {
  side: 'SELL', status: 'TP2_HIT', timeframe: '15m', signal_timeframe: '4h',
  entry_price: 100, initial_stop: 105, current_stop: 105, tp1: 92.5, tp2: 85, exit_price: 85,
  partial_percent: 50, tp1_hit: true, tp1_hit_at: '2026-11-02T10:00:00Z', tp2_hit: true, tp2_hit_at: '2026-11-04T10:00:00Z',
  closed_at: '2026-11-04T10:00:00Z', created_date: '2026-11-01T12:00:00Z',
};
const TIME_STOP = { side: 'BUY', status: 'CLOSED', closed_reason: 'TIME_STOP', timeframe: '15m', entry_price: 100, initial_stop: 95, current_stop: 95, exit_price: 101, closed_at: '2026-11-05T00:00:00Z', created_date: '2026-11-01T00:00:00Z' };
const LEGADA_MINIMA = { symbol: 'BTCUSDT', side: 'BUY', status: 'STOP_HIT', entry_price: 100, initial_stop: 95, exit_price: 95, created_date: '2026-10-01T00:00:00Z', closed_at: '2026-10-02T00:00:00Z' };

describe('opSignalTimeframe — o timeframe do AVISO, não o de execução', () => {
  it('usa signal_timeframe quando existe (4h na cascata RF, 1h na SMC)', () => {
    expect(opSignalTimeframe({ signal_timeframe: '4h', timeframe: '15m' })).toBe('4h');
    expect(opSignalTimeframe({ signal_timeframe: '1H', timeframe: '5m' })).toBe('1h');
  });
  it('operação legada de 15m/5m (sem signal_timeframe) veio da cascata 4h→15m', () => {
    expect(opSignalTimeframe({ timeframe: '15m' })).toBe('4h');
    expect(opSignalTimeframe({ timeframe: '5m' })).toBe('4h');
  });
  it('operação anterior à cascata: o timeframe dela já era o do aviso', () => {
    expect(opSignalTimeframe({ timeframe: '1h' })).toBe('1h');
    expect(opSignalTimeframe({ timeframe: '1d' })).toBe('1d');
  });
  it('sem nenhum dado: null; entrada ruim não lança', () => {
    for (const x of [null, undefined, {}, { timeframe: '' }, { signal_timeframe: '  ' }, 7, 'x']) expect(opSignalTimeframe(x)).toBeNull();
  });
});

describe('timeframeChipLabel', () => {
  it('"4H → 15M" quando o aviso e a execução diferem', () => {
    expect(timeframeChipLabel({ signal_timeframe: '4h', timeframe: '15m' })).toBe('4H → 15M');
    expect(timeframeChipLabel({ timeframe: '15m' })).toBe('4H → 15M'); // legada
    expect(timeframeChipLabel({ signal_timeframe: '1h', timeframe: '5m' })).toBe('1H → 5M');
  });
  it('só o timeframe quando são o mesmo; null sem dado', () => {
    expect(timeframeChipLabel({ timeframe: '1h' })).toBe('1H');
    expect(timeframeChipLabel({ signal_timeframe: '4h', timeframe: '4h' })).toBe('4H');
    expect(timeframeChipLabel({})).toBeNull();
    expect(timeframeChipLabel(null)).toBeNull();
  });
});

describe('elapsedLabel — as barras de bars_to_* são do timeframe do aviso', () => {
  it('4h por barra (padrão) e 1h por barra na SMC', () => {
    expect(elapsedLabel(0, '4h')).toBe('menos de 1 h');
    expect(elapsedLabel(3, '4h')).toBe('~12 h');
    expect(elapsedLabel(3, null)).toBe('~12 h'); // legada: 4h
    expect(elapsedLabel(5, '1h')).toBe('~5 h');
    expect(elapsedLabel(12, '4h')).toBe('~2 dias');
  });
  it('dado ausente ou inválido: null', () => {
    for (const x of [null, undefined, NaN, -1, '3']) expect(elapsedLabel(x, '4h')).toBeNull();
  });
});

describe('buildTradeStory — compra que bateu o TP1 e saiu no stop movido', () => {
  const steps = buildTradeStory(BUY_STOP_APOS_TP1, { fmt });
  it('passos na ordem em que aconteceram', () => {
    expect(keys(steps)).toEqual(['opened', 'path', 'tp1', 'stop_moved', 'exit', 'result']);
  });
  it('abriu: lado, preço, horário do sinal e a ponte aviso → entrada', () => {
    expect(steps[0].text).toBe(`📍 Abriu uma operação de compra a ${p(100)} (sinal de T(2026-11-01)) (aviso do gráfico de 4H, confirmado no de 15M).`);
  });
  it('caminho: melhor e pior ponto, quando veio o melhor (3 barras de 4h = ~12 h) e quanto o resultado ficou abaixo dele', () => {
    expect(steps[1].text).toMatch(/^No caminho, chegou a \+2\.40R a favor e a -0\.30R contra \(o melhor ponto veio ~12 h depois da entrada\); o resultado final \([+-]\d\.\d{2}R\) ficou \d\.\d{2}R abaixo desse melhor ponto\.$/);
  });
  it('TP1: preço, horário e o que foi realizado', () => {
    expect(steps[2].text).toBe(`🎯 Bateu o TP1 (${p(107.5)}) em T(2026-11-02) e realizou 50% da posição, deixando o resto correndo.`);
  });
  it('stop movido: de onde para onde, e que acompanhou o preço (compra: subiu)', () => {
    expect(steps[3].text).toBe(`O stop saiu de ${p(95)} (inicial) para ${p(100)} (último valor), acompanhando o preço a favor da posição.`);
  });
  it('saída e resultado batem com a fonte única de métricas', () => {
    expect(steps[4].text).toBe(`🛑 Saiu pelo stop a ${p(100)} em T(2026-11-03).`);
    const pnl = calcRealizedPnlPct(BUY_STOP_APOS_TP1);
    const r = calcRealizedR(BUY_STOP_APOS_TP1);
    expect(steps[5].text).toBe(`Resultado final: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% (${r >= 0 ? '+' : ''}${r.toFixed(2)}R).`);
  });
});

describe('buildTradeStory — venda que bateu o TP2', () => {
  const steps = buildTradeStory(SELL_TP2, { fmt });
  it('TP1 e TP2 contados; sem frase de stop movido (inicial = atual) e sem passo de saída duplicado', () => {
    expect(keys(steps)).toEqual(['opened', 'tp1', 'tp2', 'result']);
    expect(steps[0].text).toContain('de venda');
    expect(steps[2].text).toBe(`🏆 Bateu o TP2 (${p(85)}) em T(2026-11-04).`);
  });
  it('venda com stop que DESCE é a favor; que sobe não é', () => {
    const desce = buildTradeStory({ ...SELL_TP2, current_stop: 100 }, { fmt }).find((s) => s.key === 'stop_moved');
    expect(desce.text).toContain('acompanhando o preço a favor da posição');
    const sobe = buildTradeStory({ ...SELL_TP2, current_stop: 108 }, { fmt }).find((s) => s.key === 'stop_moved');
    expect(sobe.text).not.toContain('a favor');
  });
});

describe('buildTradeStory — outras saídas', () => {
  it('encerrada por tempo esgotado usa o motivo em português simples', () => {
    const exit = buildTradeStory(TIME_STOP, { fmt }).find((s) => s.key === 'exit');
    expect(exit.text).toBe(`🔒 Encerrada: tempo esgotado, a ${p(101)} em T(2026-11-05).`);
  });
  it('invalidada sem motivo salvo ainda diz o que aconteceu', () => {
    const exit = buildTradeStory({ ...TIME_STOP, status: 'INVALIDATED', closed_reason: undefined }, { fmt }).find((s) => s.key === 'exit');
    expect(exit.text).toContain('Encerrada: sinal invalidado');
  });
  it('TP1 que fecha tudo (partial 100) diz isso, sem "deixando o resto correndo"', () => {
    const tp1 = buildTradeStory({ ...BUY_STOP_APOS_TP1, partial_percent: 100, closed_reason: 'TP1_FULL' }, { fmt }).find((s) => s.key === 'tp1');
    expect(tp1.text).toContain('fechou toda a posição');
    expect(tp1.text).not.toContain('resto correndo');
  });
  it('o resultado só é comentado como "abaixo do melhor ponto" a partir do limite', () => {
    const perto = buildTradeStory({ ...BUY_STOP_APOS_TP1, mfe_r: 0.6 }, { fmt }).find((s) => s.key === 'path');
    expect(perto.text).not.toContain('abaixo desse melhor ponto');
    expect(GAVE_BACK_MIN_R).toBe(0.25);
  });
});

describe('buildTradeStory — operação legada e entrada ruim', () => {
  it('legada mínima: só o que existe (abriu, saída, resultado); nada de caminho, TP1 ou stop movido', () => {
    const steps = buildTradeStory(LEGADA_MINIMA, { fmt });
    expect(keys(steps)).toEqual(['opened', 'exit', 'result']);
    expect(steps[0].text).toBe(`📍 Abriu uma operação de compra a ${p(100)} (sinal de T(2026-10-01)).`);
  });
  it('sem lado, sem preço e sem datas: continua uma frase inteira, sem lixo', () => {
    const steps = buildTradeStory({ status: 'CLOSED' }, { fmt });
    expect(steps[0].text).toBe('📍 Abriu uma operação.');
  });
  it('nenhuma frase carrega "undefined", "NaN", "null" ou "[object" em nenhum cenário', () => {
    const cenarios = [BUY_STOP_APOS_TP1, SELL_TP2, TIME_STOP, LEGADA_MINIMA, { status: 'CLOSED' }, { side: 'BUY', status: 'STOP_HIT', entry_price: 'x', mfe_r: NaN, bars_to_mfe: 'y', tp1_hit: true, created_date: 'ontem' }];
    for (const op of cenarios) expect(JSON.stringify(buildTradeStory(op, { fmt }))).not.toMatch(/undefined|NaN|null|\[object/);
  });
  it('data inválida não vira horário (nem "Invalid date")', () => {
    const steps = buildTradeStory({ ...BUY_STOP_APOS_TP1, created_date: 'ontem', tp1_hit_at: 'lixo', tp1_hit_real_time: undefined, stop_hit_at: null, closed_at: null }, { fmt });
    expect(JSON.stringify(steps)).not.toMatch(/Invalid|ontem|lixo/);
  });
  it('entrada que não é objeto devolve lista vazia, sem lançar', () => {
    for (const x of [null, undefined, 7, 'x']) expect(buildTradeStory(x)).toEqual([]);
  });
});

describe('texto neutro — descreve o que aconteceu, não prevê nem opina', () => {
  it('nenhuma frase fala de previsão, chance, probabilidade ou "deveria"', () => {
    const todas = [BUY_STOP_APOS_TP1, SELL_TP2, TIME_STOP, LEGADA_MINIMA].flatMap((op) => textos(buildTradeStory(op, { fmt }))).join(' ');
    expect(todas).not.toMatch(/vai (subir|cair)|probabilidade|chance|previs|deveria|erro d|culpa|MFE|MAE/i);
  });
});
