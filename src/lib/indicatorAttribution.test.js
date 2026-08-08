import { describe, it, expect } from 'vitest';
import { buildShadowOp, simulateShadowOutcome } from './indicatorAttribution';

// BUY: entry 100, atrValue 2, tier atrStopMult 2.0 -> risk 4 -> initialStop 96
// tp1R 1.5 -> tp1 = 100 + 4*1.5 = 106; tp2R 3.0 -> tp2 = 100 + 4*3 = 112
function makeBuySnapshot(overrides = {}) {
  return {
    direction: 'BUY',
    entry_price_ref: 100,
    atr_value: 2,
    tier_atr_stop_mult: 2.0,
    tier_time_stop_bars: 4,
    ...overrides,
  };
}

function candle({ high, low, close }) {
  return { openTime: '2026-01-01T00:00:00Z', closeTime: '2026-01-01T04:00:00Z', high, low, close };
}

describe('buildShadowOp', () => {
  it('replica a fórmula de buildTradeOpData (entry/stop/TP1/TP2) — BUY', () => {
    const shadow = buildShadowOp(makeBuySnapshot(), { tp1R: 1.5, runnerEnabled: true });
    expect(shadow.initialStop).toBe(96);
    expect(shadow.tp1).toBe(106);
    expect(shadow.tp2).toBe(112);
    expect(shadow.tp1R).toBe(1.5);
    expect(shadow.tp2R).toBe(3.0);
  });

  it('replica a fórmula — SELL', () => {
    const shadow = buildShadowOp(makeBuySnapshot({ direction: 'SELL' }), { tp1R: 1.5 });
    expect(shadow.initialStop).toBe(104);
    expect(shadow.tp1).toBe(94);
    expect(shadow.tp2).toBe(88);
  });

  it('runnerEnabled default true (mesma convenção de buildTradeOpData/pineConfig)', () => {
    expect(buildShadowOp(makeBuySnapshot(), {}).runnerEnabled).toBe(true);
    expect(buildShadowOp(makeBuySnapshot(), { runnerEnabled: false }).runnerEnabled).toBe(false);
  });
});

describe('simulateShadowOutcome', () => {
  it('dados insuficientes (sem candles futuros) -> insufficient_data', () => {
    const shadow = buildShadowOp(makeBuySnapshot(), {});
    const result = simulateShadowOutcome(shadow, []);
    expect(result.outcome).toBe('insufficient_data');
    expect(result.rResult).toBeNull();
  });

  it('STOP_HIT pré-TP1 -> rResult exatamente -1R (risco fixo por construção)', () => {
    const shadow = buildShadowOp(makeBuySnapshot(), {});
    const result = simulateShadowOutcome(shadow, [candle({ high: 101, low: 95, close: 96 })]);
    expect(result.outcome).toBe('STOP_HIT');
    expect(result.exitReason).toBe('STOP_HIT');
    expect(result.rResult).toBe(-1);
    expect(result.barsToExit).toBe(1);
  });

  it('TP1 toca, runner ligado -> vira RUNNER_ACTIVE (não fecha), stop vai pro breakeven; TP2 fecha em +tp2R', () => {
    const shadow = buildShadowOp(makeBuySnapshot(), { tp1R: 1.5, runnerEnabled: true });
    const result = simulateShadowOutcome(shadow, [
      candle({ high: 106, low: 99, close: 106 }), // toca TP1
      candle({ high: 112, low: 105, close: 112 }), // toca TP2
    ]);
    expect(result.outcome).toBe('TP2_HIT');
    expect(result.rResult).toBe(3.0);
    expect(result.barsToExit).toBe(2);
  });

  it('TP1 toca, runnerEnabled false -> fecha TERMINAL em +tp1R (TP1_FULL)', () => {
    const shadow = buildShadowOp(makeBuySnapshot(), { tp1R: 1.5, runnerEnabled: false });
    const result = simulateShadowOutcome(shadow, [candle({ high: 106, low: 99, close: 106 })]);
    expect(result.outcome).toBe('CLOSED');
    expect(result.exitReason).toBe('TP1_FULL');
    expect(result.rResult).toBe(1.5);
  });

  it('ambiguidade no mesmo candle (stop E tp1 tocados) -> política "stop vence" (mesma de resolveCandleExit)', () => {
    const shadow = buildShadowOp(makeBuySnapshot(), { tp1R: 1.5 });
    // candle com low <= 96 (stop) E high >= 106 (tp1) no mesmo candle
    const result = simulateShadowOutcome(shadow, [candle({ high: 107, low: 95, close: 100 })]);
    expect(result.outcome).toBe('STOP_HIT');
  });

  it('Time Stop fecha depois de N barras sem TP1 (N = tier_time_stop_bars)', () => {
    const shadow = buildShadowOp(makeBuySnapshot({ tier_time_stop_bars: 2 }), {});
    const flat = candle({ high: 101, low: 99, close: 100 });
    const result = simulateShadowOutcome(shadow, [flat, flat]);
    expect(result.outcome).toBe('CLOSED');
    expect(result.exitReason).toBe('TIME_STOP');
    expect(result.barsToExit).toBe(2);
  });

  it('runner nunca regride o stop (trailing monotônico) — STOP_HIT pós-TP1 nunca abaixo do breakeven', () => {
    const shadow = buildShadowOp(makeBuySnapshot(), { tp1R: 1.5, runnerEnabled: true, trailAtrMult: 2.0 });
    const result = simulateShadowOutcome(shadow, [
      candle({ high: 106, low: 99, close: 106 }), // toca TP1, stop -> breakeven (100)
      candle({ high: 108, low: 101, close: 108 }), // sobe, trail avança
      candle({ high: 108, low: 99, close: 101 }), // recua — nunca deveria bater abaixo do stop já avançado no candle anterior
    ]);
    // trail depois do candle 2: max(100, 108 - 2*2) = max(100, 104) = 104
    // candle 3: low 99 <= 104 -> STOP_HIT no stop armazenado (104), nunca no breakeven (100) nem abaixo
    expect(result.outcome).toBe('STOP_HIT');
    expect(result.rResult).toBeGreaterThan(0); // fechou com lucro, nunca regrediu abaixo do breakeven
  });

  it('sem exit até os candles acabarem -> STILL_OPEN_AT_CUTOFF, sem forçar fechamento', () => {
    const shadow = buildShadowOp(makeBuySnapshot({ tier_time_stop_bars: 100 }), {});
    const flat = candle({ high: 101, low: 99, close: 100 });
    const result = simulateShadowOutcome(shadow, [flat, flat]);
    expect(result.outcome).toBe('STILL_OPEN_AT_CUTOFF');
    expect(result.rResult).toBeNull();
  });

  it('MFE/MAE acompanham a excursão em R, base de risco fixa (não o stop corrente)', () => {
    const shadow = buildShadowOp(makeBuySnapshot(), { tp1R: 1.5, runnerEnabled: true });
    const result = simulateShadowOutcome(shadow, [
      candle({ high: 103, low: 94, close: 100 }), // MFE (103-100)/4=0.75R, MAE (94-100)/4=-1.5R
    ]);
    // MAE -1.5R já cruzaria o stop (-1R) — então este candle na verdade bate STOP_HIT
    // (stop vence sobre MAE); ainda assim mfeR/maeR do candle-corrente ficam gravados.
    expect(result.outcome).toBe('STOP_HIT');
    expect(result.maeR).toBeLessThanOrEqual(-1);
  });
});
