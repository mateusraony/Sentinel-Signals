import { describe, it, expect } from 'vitest';
import { FIB_RULES, planFibEntry, stepFibExit } from './fibEntry.js';

const M15 = 15 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 0, 0); // alinhado em 4h

// Vela de 15m a partir de [open, high, low, close]; índice i a partir de T0.
const candle = (i, [o, h, l, c]) => ({ openTime: T0 + i * M15, closeTime: T0 + (i + 1) * M15 - 1, open: o, high: h, low: l, close: c, isClosed: true });

// Histórico pré-sinal: 33 velas (1 para o true range + 32 de perna). Perna de
// compra limpa: mínima 100 na vela 5, máxima 110 na vela 30, velas de range 1.
function buyHistory() {
  const rows = [];
  for (let i = 0; i < 33; i += 1) {
    let mid;
    if (i <= 5) mid = 104 - i * 0.7; // desce até perto de 100
    else mid = 100.5 + ((i - 6) * 8.5) / 23; // sobe até 109 na vela 29
    if (i > 30) mid = 109.5; // fica perto do topo, acima de E
    rows.push(candle(i, [mid, mid + 0.3, mid - 0.3, mid]));
  }
  rows[5] = candle(5, [100.5, 101, 100, 100.5]); // L = 100
  rows[30] = candle(30, [109.5, 110, 109, 109.5]); // H = 110
  return rows;
}
const SIGNAL_CLOSE = T0 + 33 * M15 - 1;

function plan(candles, nowMs, direction = 'BUY') {
  return planFibEntry({ candles15m: candles, direction, signalCloseMs: SIGNAL_CLOSE, nowMs });
}

describe('FIB_RULES — pré-registro travado (item 267)', () => {
  it('constantes congeladas', () => {
    expect(FIB_RULES).toEqual({
      barMs: M15, anchorBars: 32, atrBars: 14, minLegAtr: 1.0, entryRetrace: 0.618,
      fillPenetrationAtr: 0.02, stopBufferAtr: 0.1, tp1Ext: 1.272, tp2Ext: 1.618, maxWaitBars: 15,
    });
    expect(Object.isFrozen(FIB_RULES)).toBe(true);
  });
});

describe('planFibEntry — perna, níveis e statuses', () => {
  it('perna de compra: níveis E/S/TP1/TP2 a partir de L=100 e H=110', () => {
    const r = plan(buyHistory(), SIGNAL_CLOSE);
    expect(r.status).toBe('pending');
    expect(r.leg.origin).toBe(100);
    expect(r.leg.extreme).toBe(110);
    expect(r.entry).toBeCloseTo(110 - 0.618 * 10, 10);
    expect(r.tp1).toBeCloseTo(100 + 1.272 * 10, 10);
    expect(r.tp2).toBeCloseTo(100 + 1.618 * 10, 10);
    expect(r.stop).toBeCloseTo(100 - 0.1 * r.atr, 10);
    expect(r.atr).toBeGreaterThan(0);
  });

  it('preenche quando a ÚLTIMA vela fechada passa E − 0,02×ATR, sempre ao preço E', () => {
    const hist = buyHistory();
    const base = plan(hist, SIGNAL_CLOSE);
    const fill = candle(33, [108, 108.2, base.entry - 0.05, 104.5]);
    const r = plan([...hist, fill], fill.closeTime);
    expect(r.status).toBe('filled');
    expect(r.entry).toBeCloseTo(base.entry, 10);
    expect(r.fillCandleOpenMs).toBe(fill.openTime);
    // Abertura entre E e o stop (gap): continua E — conservador, mantém a geometria de risco.
    const gapFill = candle(33, [103.5, 104, 103, 103.8]);
    expect(plan([...hist, gapFill], gapFill.closeTime).entry).toBeCloseTo(base.entry, 10);
  });

  it('abertura já além do stop → gap_through_stop, sem operação (nunca stop do lado errado)', () => {
    const hist = buyHistory();
    const base = plan(hist, SIGNAL_CLOSE);
    const through = candle(33, [base.stop - 0.5, base.stop - 0.2, base.stop - 1, base.stop - 0.4]);
    const r = plan([...hist, through], through.closeTime);
    expect(r.status).toBe('gap_through_stop');
    expect(r.fillCandleOpenMs).toBeUndefined();
  });

  it('toque sem penetração não preenche', () => {
    const hist = buyHistory();
    const base = plan(hist, SIGNAL_CLOSE);
    const touch = candle(33, [108, 108.2, base.entry - 0.01 * base.atr, 107]);
    expect(plan([...hist, touch], touch.closeTime).status).toBe('pending');
  });

  it('preenchimento numa vela que NÃO é a última vira fill_missed (nunca entra no passado)', () => {
    const hist = buyHistory();
    const base = plan(hist, SIGNAL_CLOSE);
    const fill = candle(33, [108, 108.2, base.entry - 0.05, 104.5]);
    const after = candle(34, [104.5, 105, 104, 104.8]);
    expect(plan([...hist, fill, after], after.closeTime).status).toBe('fill_missed');
  });

  it('a máxima chega no TP1 antes de preencher → ran_away (mesma vela também conta como ran_away)', () => {
    const hist = buyHistory();
    const base = plan(hist, SIGNAL_CLOSE);
    const runner = candle(33, [110, base.tp1 + 0.1, 109.5, 112]);
    expect(plan([...hist, runner], runner.closeTime).status).toBe('ran_away');
    const both = candle(33, [110, base.tp1 + 0.1, base.entry - 1, 108]);
    expect(plan([...hist, both], both.closeTime).status).toBe('ran_away');
  });

  it('15 velas sem preencher → expired', () => {
    const hist = buyHistory();
    const wait = Array.from({ length: 15 }, (_, k) => candle(33 + k, [109.5, 109.8, 109.2, 109.5]));
    expect(plan([...hist, ...wait.slice(0, 14)], wait[13].closeTime).status).toBe('pending');
    expect(plan([...hist, ...wait], wait[14].closeTime).status).toBe('expired');
  });

  it('nível já negociado entre H e o sinal → already_retraced', () => {
    const hist = buyHistory();
    const base = plan(hist, SIGNAL_CLOSE);
    hist[31] = candle(31, [109, 109.2, base.entry - 0.1, 105]);
    expect(plan(hist, SIGNAL_CLOSE).status).toBe('already_retraced');
  });

  it('perna menor que 1×ATR → no_leg; mínima na última vela → no_leg', () => {
    // Queda até a vela 31; a 32ª (última) sobe só um pouco: perna depois da mínima < 1×ATR.
    const shortLeg = Array.from({ length: 33 }, (_, i) => candle(i, [200 - i, 200.5 - i, 199.5 - i, 200 - i]));
    shortLeg[32] = candle(32, [168.6, 168.8, 168.5, 168.7]);
    const r = plan(shortLeg, SIGNAL_CLOSE);
    expect(r.status).toBe('no_leg');
    expect(r.reason).toBe('leg_below_min_atr');
    const falling = Array.from({ length: 33 }, (_, i) => candle(i, [200 - i, 200.5 - i, 199.5 - i, 200 - i]));
    expect(plan(falling, SIGNAL_CLOSE).reason).toBe('no_candle_after_origin');
  });

  it('histórico curto ou desalinhado do sinal → insufficient_data', () => {
    const hist = buyHistory();
    expect(plan(hist.slice(2), SIGNAL_CLOSE).status).toBe('insufficient_data');
    expect(plan(hist.slice(0, -1), SIGNAL_CLOSE).status).toBe('insufficient_data');
  });

  it('venda é o espelho da compra', () => {
    const mirror = buyHistory().map((c) => ({ ...c, open: 300 - c.open, high: 300 - c.low, low: 300 - c.high, close: 300 - c.close }));
    const r = plan(mirror, SIGNAL_CLOSE, 'SELL');
    const b = plan(buyHistory(), SIGNAL_CLOSE, 'BUY');
    expect(r.status).toBe('pending');
    expect(r.entry).toBeCloseTo(300 - b.entry, 10);
    expect(r.stop).toBeCloseTo(300 - b.stop, 10);
    expect(r.tp1).toBeCloseTo(300 - b.tp1, 10);
    expect(r.tp2).toBeCloseTo(300 - b.tp2, 10);
  });

  it('causal: com a série inteira ou cortada em nowMs, a resposta é a mesma', () => {
    const hist = buyHistory();
    const base = plan(hist, SIGNAL_CLOSE);
    const future = [
      candle(33, [109.5, 109.8, 109.2, 109.5]),
      candle(34, [108, 108.2, base.entry - 0.05, 104.5]),
      candle(35, [104.5, 130, 104, 129]),
    ];
    const all = [...hist, ...future];
    for (let k = 0; k <= future.length; k += 1) {
      const nowMs = k === 0 ? SIGNAL_CLOSE : future[k - 1].closeTime;
      expect(plan(all, nowMs)).toEqual(plan(all.filter((c) => c.closeTime <= nowMs), nowMs));
    }
  });
});

describe('stepFibExit — gestão em velas de 15m', () => {
  const baseOp = (over = {}) => ({
    side: 'BUY', status: 'SIGNAL_CONFIRMED', entry_price: 104, current_stop: 99.9, initial_stop: 99.9,
    tp1: 112.7, tp2: 116.2, tp1_hit: false, tp2_hit: false, tp2_cap_disabled: false,
    fib_fill_candle_open_ms: T0, fib_fill_candle_close_ms: T0 + M15 - 1, tier_time_stop_bars: 48, ...over,
  });
  const at = (i) => T0 + (i + 1) * M15 - 1;

  it('vela do preenchimento só checa o stop (alvo ignorado)', () => {
    const r = stepFibExit(baseOp(), [candle(0, [105, 113, 103.5, 112])], { nowMs: at(0) });
    expect(r.status).toBe('SIGNAL_CONFIRMED');
    expect(r.patch.fib_last_exit_candle_open_ms).toBe(T0);
    const s = stepFibExit(baseOp(), [candle(0, [105, 106, 99, 100])], { nowMs: at(0) });
    expect(s.status).toBe('STOP_HIT');
    expect(s.patch.exit_price).toBe(99.9);
  });

  it('stop e TP1 na mesma vela: stop vence e marca exit_ambiguous', () => {
    const op = baseOp({ fib_last_exit_candle_open_ms: T0 });
    const r = stepFibExit(op, [candle(1, [104, 113, 99, 100])], { nowMs: at(1) });
    expect(r.status).toBe('STOP_HIT');
    expect(r.patch.exit_ambiguous).toBe(true);
  });

  it('abertura além do stop sai pela abertura (gap)', () => {
    const op = baseOp({ fib_last_exit_candle_open_ms: T0 });
    const r = stepFibExit(op, [candle(1, [98, 98.5, 97, 98])], { nowMs: at(1) });
    expect(r.patch.exit_price).toBe(98);
    expect(r.patch.fib_gap_exit).toBe(true);
  });

  it('TP1 → runner com stop na entrada; a própria vela do TP1 não reavalia breakeven nem TP2', () => {
    const op = baseOp({ fib_last_exit_candle_open_ms: T0 });
    // Vela 1 bate TP1 E desce abaixo da entrada depois (ordem desconhecida) e até TP2.
    const r = stepFibExit(op, [candle(1, [105, 117, 104.5, 110])], { nowMs: at(1) });
    expect(r.status).toBe('RUNNER_ACTIVE');
    expect(r.patch.current_stop).toBe(104);
    expect(r.patch.tp1_hit).toBe(true);
    expect(r.patch.fib_tp1_candle_open_ms).toBe(T0 + M15);
    // Vela seguinte volta à entrada → breakeven.
    const next = stepFibExit({ ...op, ...r.patch }, [candle(2, [110, 111, 103.9, 104])], { nowMs: at(2) });
    expect(next.status).toBe('STOP_HIT');
    expect(next.patch.exit_price).toBe(104);
    // Ou vai ao TP2.
    const win = stepFibExit({ ...op, ...r.patch }, [candle(2, [110, 116.5, 109, 116])], { nowMs: at(2) });
    expect(win.status).toBe('TP2_HIT');
    expect(win.patch.exit_price).toBe(116.2);
  });

  it('time stop só antes do TP1, no fechamento da 1ª vela que alcança o prazo', () => {
    const op = baseOp({ fib_last_exit_candle_open_ms: T0, tier_time_stop_bars: 1 }); // 1 vela de 4h = 16 de 15m
    const candles = Array.from({ length: 16 }, (_, k) => candle(1 + k, [104, 105, 103.5, 104.5]));
    const r = stepFibExit(op, candles, { nowMs: at(16) });
    expect(r.status).toBe('CLOSED');
    expect(r.patch.closed_reason).toBe('TIME_STOP');
    expect(r.patch.exit_price).toBe(104.5);
    expect(r.patch.fib_last_exit_candle_open_ms).toBe(T0 + 16 * M15);
  });

  it('buraco nas velas é detectado (nunca pula vela em silêncio)', () => {
    const op = baseOp({ fib_last_exit_candle_open_ms: T0 });
    const r = stepFibExit(op, [candle(3, [104, 105, 103.5, 104.5])], { nowMs: at(3) });
    expect(r.gap).toBe(true);
    expect(r.patch).toBeNull();
  });

  it('sem vela nova: nada a fazer; vela ainda aberta é ignorada', () => {
    const op = baseOp({ fib_last_exit_candle_open_ms: T0 });
    expect(stepFibExit(op, [candle(0, [104, 105, 103.5, 104.5])], { nowMs: at(0) }).patch).toBeNull();
    expect(stepFibExit(op, [candle(1, [104, 120, 90, 104.5])], { nowMs: at(1) - 1 }).patch).toBeNull();
  });
});
