// Agenda 4d, parte 2 (addendum 18 do item 285): "o BTC depois da divulgação". Contas à mão; o que importa: a referência é a vela que TERMINA na divulgação (sem
// deslocar 1 vela), horizonte cuja vela ainda não fechou fica vazio, buraco no dado nunca vira número e o sinal é só fato.
import { describe, it, expect } from 'vitest';
import { HORIZONS_MIN, WINDOW_CANDLES, parseKlines, afterRelease, formatMove, horizonLabel, movesCount, lastMove } from './btcAfterRelease';

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 6, 13, 30); // Payroll de 06/11 (13:30 UTC)

/** Velas paradas em 100 de -1 min (referência) até +59 min, com o fechamento trocado nos minutos relativos pedidos. */
function candles(closes = {}) {
  return Array.from({ length: WINDOW_CANDLES }, (_, i) => {
    const rel = i - 1;
    const c = closes[rel] ?? 100;
    return { t: T0 + rel * MIN, o: 100, h: Math.max(100, c), l: Math.min(100, c), c };
  });
}
const FULL = { 4: 101, 29: 99, 59: 102 }; // +5 min = +1%, +30 min = -1%, +60 min = +2%

describe('afterRelease', () => {
  it('horizontes em 5, 30 e 60 min contra o fechamento da vela que termina na divulgação (contas à mão)', () => {
    expect(HORIZONS_MIN).toEqual([5, 30, 60]);
    const r = afterRelease(candles(FULL), T0, T0 + 61 * MIN);
    expect(r.moves[5]).toBeCloseTo(1, 10);
    expect(r.moves[30]).toBeCloseTo(-1, 10);
    expect(r.moves[60]).toBeCloseTo(2, 10);
  });

  it('sem deslocar a janela em 1 vela: a vela que ABRE na divulgação não é a referência', () => {
    const c = candles(FULL).map((v) => (v.t === T0 ? { ...v, c: 500, h: 500 } : v)); // vela que abre em T0
    expect(afterRelease(c, T0, T0 + 61 * MIN).moves[5]).toBeCloseTo(1, 10);
    const semDeslocar = candles(FULL).map((v) => (v.t === T0 - MIN ? { ...v, c: 50, l: 50 } : v)); // a referência de verdade
    expect(afterRelease(semDeslocar, T0, T0 + 61 * MIN).moves[5]).toBeCloseTo((101 / 50 - 1) * 100, 6);
  });

  it('só mostra o horizonte cuja vela JÁ fechou (divulgação de 12 min atrás: só o de 5 min)', () => {
    const r = afterRelease(candles(FULL), T0, T0 + 12 * MIN);
    expect(r.moves[5]).toBeCloseTo(1, 10);
    expect(r.moves[30]).toBeNull();
    expect(r.moves[60]).toBeNull();
    expect(afterRelease(candles(FULL), T0, T0 + 5 * MIN).moves[5]).not.toBeNull(); // fecha exatamente em +5 min
    expect(afterRelease(candles(FULL), T0, T0 + 5 * MIN - 1).moves[5]).toBeNull();
    expect(afterRelease(candles(FULL), T0, T0 + 30 * MIN).moves[30]).not.toBeNull();
    expect(afterRelease(candles(FULL), T0, T0 + 30 * MIN - 1).moves[30]).toBeNull();
  });

  it('vela faltando = só aquele horizonte vazio (nunca completa com a vizinha); sem a referência não há conta', () => {
    const semUma = candles(FULL).filter((v) => v.t !== T0 + 29 * MIN);
    const r = afterRelease(semUma, T0, T0 + 61 * MIN);
    expect(r.moves[30]).toBeNull();
    expect(r.moves[5]).toBeCloseTo(1, 10);
    expect(r.moves[60]).toBeCloseTo(2, 10);
    expect(afterRelease(candles(FULL).filter((v) => v.t !== T0 - MIN), T0, T0 + 61 * MIN)).toBeNull();
    expect(afterRelease([], T0, T0 + 61 * MIN)).toBeNull();
    expect(afterRelease(null, T0, T0 + 61 * MIN)).toBeNull();
  });
});

describe('formatação', () => {
  it('sinal só como fato, vírgula e duas casas; zero sem sinal; sem número = traço', () => {
    expect(formatMove(0.1234)).toBe('+0,12%');
    expect(formatMove(-0.5449)).toBe('-0,54%');
    expect(formatMove(0)).toBe('0,00%');
    expect(formatMove(-0.004)).toBe('0,00%');
    expect(formatMove(2)).toBe('+2,00%');
    expect(formatMove(null)).toBe('—');
    expect(formatMove(Number.NaN)).toBe('—');
    expect(horizonLabel(5)).toBe('5 min');
    expect(horizonLabel(60)).toBe('1 h');
  });
  it('contagem e "o horizonte mais longo que já tem número"', () => {
    expect(movesCount({ 5: 1, 30: null, 60: null })).toBe(1);
    expect(movesCount({ 5: null, 30: null, 60: null })).toBe(0);
    expect(movesCount(null)).toBe(0);
    expect(lastMove({ 5: 0.2, 30: -0.3, 60: null })).toEqual({ n: 30, label: '30 min', text: '-0,30%' });
    expect(lastMove({ 5: 0.2, 30: -0.3, 60: -0.54 })).toEqual({ n: 60, label: '1 h', text: '-0,54%' });
    expect(lastMove({ 5: null, 30: null, 60: null })).toBeNull();
  });
});

describe('parseKlines', () => {
  const row = (t, o, h, l, c) => [t, String(o), String(h), String(l), String(c), '1', t + 59999];
  it('lê as velas, em ordem, como números', () => {
    expect(parseKlines(JSON.stringify([row(2 * MIN, 2, 3, 1, 2), row(MIN, 1, 2, 1, 2)]))).toEqual([{ t: MIN, o: 1, h: 2, l: 1, c: 2 }, { t: 2 * MIN, o: 2, h: 3, l: 1, c: 2 }]);
  });
  it('recusa o que não serve', () => {
    for (const bad of ['{}', 'lixo', JSON.stringify([[1, 2]]), JSON.stringify([row(MIN, 1, 2, 1, 'x')]), JSON.stringify([row(MIN, 1, 1, 2, 1)]), JSON.stringify([row(MIN, 0, 1, 1, 1)])]) {
      expect(parseKlines(bad), bad).toBeNull();
    }
  });
});
