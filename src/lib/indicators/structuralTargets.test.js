import { describe, it, expect } from 'vitest';
import { TARGET_RULES, fibLevels, swingLevels, resolveTarget } from './structuralTargets.js';

const M15 = 15 * 60 * 1000;
const H4 = 4 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 0, 0);

const c15 = (i, [o, h, l, c]) => ({ openTime: T0 + i * M15, closeTime: T0 + (i + 1) * M15 - 1, open: o, high: h, low: l, close: c, isClosed: true });
const c4h = (i, high, low) => ({ openTime: T0 + i * H4, closeTime: T0 + (i + 1) * H4 - 1, open: (high + low) / 2, high, low, close: (high + low) / 2, isClosed: true });

// Mesma perna de compra limpa de fibEntry.test.js: L = 100 (vela 5), H = 110 (vela 30).
function buyLeg() {
  const rows = [];
  for (let i = 0; i < 33; i += 1) {
    let mid;
    if (i <= 5) mid = 104 - i * 0.7;
    else mid = 100.5 + ((i - 6) * 8.5) / 23;
    if (i > 30) mid = 109.5;
    rows.push(c15(i, [mid, mid + 0.3, mid - 0.3, mid]));
  }
  rows[5] = c15(5, [100.5, 101, 100, 100.5]);
  rows[30] = c15(30, [109.5, 110, 109, 109.5]);
  return rows;
}
const SIGNAL_CLOSE = T0 + 33 * M15 - 1;

describe('TARGET_RULES — pré-registro travado (item 281)', () => {
  it('constantes congeladas', () => {
    expect(TARGET_RULES).toEqual({
      modes: ['r_multiple', 'fib_ext_15m', 'swing_4h'],
      nearPolicies: ['literal', 'min_r_fallback', 'next_level'],
      minTargetR: 0.5,
      fibLadder: [1.272, 1.618, 2.0, 2.618],
      fibFetch15m: 200,
      swingPivotBars: 5,
      swingLookback4h: 150,
      swingFetch4h: 160,
      tp2FallbackMult: 2,
    });
    expect(Object.isFrozen(TARGET_RULES)).toBe(true);
    expect(Object.isFrozen(TARGET_RULES.modes)).toBe(true);
    expect(Object.isFrozen(TARGET_RULES.nearPolicies)).toBe(true);
    expect(Object.isFrozen(TARGET_RULES.fibLadder)).toBe(true);
  });
});

describe('fibLevels — a mesma perna do item 267', () => {
  it('compra: escada medida da origem (L + ext×Δ)', () => {
    const t = fibLevels({ candles15m: buyLeg(), direction: 'BUY', signalCloseMs: SIGNAL_CLOSE });
    expect(t.levels.map((v) => +v.toFixed(6))).toEqual([112.72, 116.18, 120, 126.18]);
    expect(t.leg).toMatchObject({ origin: 100, extreme: 110 });
  });

  it('velas depois do sinal não mudam os níveis (causal)', () => {
    const rows = buyLeg();
    const later = [...rows, c15(33, [109, 130, 90, 120]), c15(34, [120, 140, 80, 100])];
    const a = fibLevels({ candles15m: rows, direction: 'BUY', signalCloseMs: SIGNAL_CLOSE });
    expect(fibLevels({ candles15m: later, direction: 'BUY', signalCloseMs: SIGNAL_CLOSE })).toEqual(a);
  });

  it('sem histórico suficiente: motivo, sem níveis', () => {
    const t = fibLevels({ candles15m: buyLeg().slice(10), direction: 'BUY', signalCloseMs: SIGNAL_CLOSE });
    expect(t.levels).toBeUndefined();
    expect(t).toMatchObject({ reason: 'fib_insufficient_data:short_or_misaligned_history', dataProblem: true });
  });
});

// 4h: 30 velas planas em 100±1, pivôs de máxima 108 (vela 8) e 104 (vela 16), pivô de mínima 92 (vela 22).
function swingSeries() {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push(c4h(i, 101, 99));
  rows[8] = c4h(8, 108, 99);
  rows[16] = c4h(16, 104, 99);
  rows[22] = c4h(22, 97, 92);
  return rows;
}
const NOW_AFTER = T0 + 30 * H4;

describe('swingLevels — pivôs de 4h confirmados', () => {
  it('compra: pivôs de máxima; venda: pivôs de mínima', () => {
    expect(swingLevels({ candles4h: swingSeries(), direction: 'BUY', nowMs: NOW_AFTER }).levels.sort()).toEqual([104, 108]);
    expect(swingLevels({ candles4h: swingSeries(), direction: 'SELL', nowMs: NOW_AFTER }).levels).toEqual([92]);
  });

  it('pivô sem 5 velas fechadas à direita ainda não conta (não-repaint)', () => {
    const rows = swingSeries();
    rows[27] = c4h(27, 103, 99); // só 2 velas à direita
    expect(swingLevels({ candles4h: rows, direction: 'BUY', nowMs: NOW_AFTER }).levels.sort()).toEqual([104, 108]);
    const open = swingSeries().slice(0, 20);
    open[19] = { ...c4h(19, 101, 99), closeTime: NOW_AFTER + 1 }; // ainda aberta
    // vela 16 só tem 17 e 18 fechadas à direita → não é pivô ainda
    expect(swingLevels({ candles4h: open, direction: 'BUY', nowMs: T0 + 19 * H4 }).levels).toEqual([108]);
  });

  it('histórico curto: motivo', () => {
    expect(swingLevels({ candles4h: swingSeries().slice(0, 8), direction: 'BUY', nowMs: NOW_AFTER })).toMatchObject({ reason: 'swing_insufficient_data', dataProblem: true });
  });
});

describe('resolveTarget — as três políticas para alvo perto', () => {
  // Compra, entrada 100, stop 96 (risco 4). Níveis: 101 (0,25R), 103 (0,75R), 108 (2R), 95 (lado errado).
  const base = { mode: 'swing_4h', direction: 'BUY', entry: 100, stop: 96, candidate: { levels: [108, 95, 101, 103] } };

  it('literal: o primeiro nível além da entrada, mesmo perto; TP2 = o seguinte', () => {
    expect(resolveTarget({ ...base, policy: 'literal' }))
      .toEqual({ ok: true, tp1: 101, tp2: 103, basis: 'SWING_4H', reason: null, rrTarget: 0.25, firstLevelR: 0.25 });
  });

  it('min_r_fallback: primeiro nível a < 0,5R → alvo do controle', () => {
    expect(resolveTarget({ ...base, policy: 'min_r_fallback' }))
      .toEqual({ ok: false, tp1: null, tp2: null, basis: 'R_MULTIPLE_FALLBACK', reason: 'target_below_min_r', rrTarget: null, firstLevelR: 0.25 });
    expect(resolveTarget({ ...base, policy: 'min_r_fallback', candidate: { levels: [103, 108] } }))
      .toMatchObject({ ok: true, tp1: 103, tp2: 108 });
  });

  it('next_level: primeiro nível a ≥ 0,5R', () => {
    expect(resolveTarget({ ...base, policy: 'next_level' })).toMatchObject({ ok: true, tp1: 103, tp2: 108, rrTarget: 0.75, firstLevelR: 0.25 });
    expect(resolveTarget({ ...base, policy: 'next_level', candidate: { levels: [101, 101.5] } }))
      .toMatchObject({ ok: false, reason: 'no_level_at_min_r' });
  });

  it('sem nível seguinte: TP2 = entrada + 2×(TP1 − entrada)', () => {
    expect(resolveTarget({ ...base, policy: 'literal', candidate: { levels: [106] } })).toMatchObject({ tp1: 106, tp2: 112 });
  });

  it('nenhum nível além da entrada, ou candidato com motivo → controle', () => {
    expect(resolveTarget({ ...base, policy: 'literal', candidate: { levels: [95, 90] } })).toMatchObject({ ok: false, reason: 'no_level_beyond_entry' });
    expect(resolveTarget({ ...base, policy: 'literal', candidate: { reason: 'fib_no_leg' } })).toMatchObject({ ok: false, reason: 'fib_no_leg' });
  });

  it('venda é o espelho (o gate R:R não checa o lado; aqui o lado é checado)', () => {
    const sell = { mode: 'fib_ext_15m', direction: 'SELL', entry: 100, stop: 104, candidate: { levels: [99, 97, 92, 106] } };
    expect(resolveTarget({ ...sell, policy: 'literal' })).toMatchObject({ ok: true, tp1: 99, tp2: 97, basis: 'FIB_EXT_15M' });
    expect(resolveTarget({ ...sell, policy: 'next_level' })).toMatchObject({ ok: true, tp1: 97, tp2: 92 });
  });

  it('modo ou política desconhecidos → controle (nunca alvo inventado)', () => {
    expect(resolveTarget({ ...base, mode: 'topo', policy: 'literal' })).toMatchObject({ ok: false, reason: 'unknown_mode' });
    expect(resolveTarget({ ...base, policy: 'perto' })).toMatchObject({ ok: false, reason: 'unknown_policy' });
  });
});
