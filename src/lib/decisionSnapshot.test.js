// Fase 1 — Explainability V2. Builders puros, sem I/O: dado o mesmo escopo
// que scanner.js já tem numa rejeição de entrada, produzem o `facts{}`
// numérico que hoje é calculado e descartado (ver cabeçalho do módulo).
import { describe, it, expect } from 'vitest';
import {
  DECISION, DATA_STATUS, buildRegimeSnapshot, buildTrendReversedSnapshot,
  buildAwaitingTp1Snapshot, buildPreTp1BreakevenSnapshot, buildPreTp1TrailingSnapshot,
  buildRunnerTrailingSnapshot, buildRunnerRfManagedSnapshot,
} from './decisionSnapshot.js';

const AGORA = '2026-09-17T12:00:00.000Z';

describe('buildRegimeSnapshot', () => {
  const tier = { tier: 'T2', adxMinVal: 22, chopMaxVal: 58 };

  it('reprovado só por ADX — facts numéricos sobrevivem, regra ADX falha e CHOP passa', () => {
    const snap = buildRegimeSnapshot({
      regime: { ok: false, adxOk: false, chopOk: true },
      tfData: { tier, adx: { adx: 14.2 }, chop: 40.1, lastCandleTime: '2026-09-17T08:00:00.000Z' },
      detail: 'adx',
      executor: 'cron',
      evaluatedAt: AGORA,
    });
    expect(snap.decision).toBe(DECISION.ENTRY_BLOCKED);
    expect(snap.reason_code).toBe('regime_rejected');
    expect(snap.reason_detail).toBe('adx');
    expect(snap.facts).toEqual({ adx: 14.2, adx_min: 22, chop: 40.1, chop_max: 58, tier: 'T2' });
    expect(snap.rules).toEqual([
      { id: 'ADX', pass: false, fact_keys: ['adx', 'adx_min'] },
      { id: 'CHOP', pass: true, fact_keys: ['chop', 'chop_max'] },
    ]);
    expect(snap.data_status).toBe(DATA_STATUS.LIVE);
    expect(snap.executor).toBe('cron');
    expect(snap.evaluated_at).toBe(AGORA);
    expect(snap.market_time).toBe('2026-09-17T08:00:00.000Z');
  });

  it('reprovado só por Chop', () => {
    const snap = buildRegimeSnapshot({
      regime: { ok: false, adxOk: true, chopOk: false },
      tfData: { tier, adx: { adx: 30 }, chop: 63.5 },
      detail: 'chop',
    });
    expect(snap.rules).toEqual([
      { id: 'ADX', pass: true, fact_keys: ['adx', 'adx_min'] },
      { id: 'CHOP', pass: false, fact_keys: ['chop', 'chop_max'] },
    ]);
  });

  it('reprovado pelos dois gates ao mesmo tempo', () => {
    const snap = buildRegimeSnapshot({
      regime: { ok: false, adxOk: false, chopOk: false },
      tfData: { tier, adx: { adx: 10 }, chop: 70 },
      detail: 'adx_chop',
    });
    expect(snap.reason_detail).toBe('adx_chop');
    expect(snap.rules.every((r) => r.pass === false)).toBe(true);
  });

  it('fail-closed: sem tier/adx/chop no escopo, nunca inventa um valor — vira UNKNOWN', () => {
    const snap = buildRegimeSnapshot({
      regime: { ok: true, adxOk: true, chopOk: true },
      tfData: {},
      detail: null,
    });
    expect(snap.facts).toEqual({ adx: null, adx_min: null, chop: null, chop_max: null, tier: null });
    expect(snap.data_status).toBe(DATA_STATUS.UNKNOWN);
  });

  it('operação legada / tfData ausente não lança', () => {
    expect(() => buildRegimeSnapshot({ regime: {}, tfData: null })).not.toThrow();
  });
});

describe('buildTrendReversedSnapshot', () => {
  it('sinal de compra (1) contra tendência agora vendedora (-1)', () => {
    const snap = buildTrendReversedSnapshot({
      currentDirection: -1, signalDirection: 1, detail: 'now_down', executor: 'browser', evaluatedAt: AGORA,
    });
    expect(snap.decision).toBe(DECISION.ENTRY_BLOCKED);
    expect(snap.reason_code).toBe('trend_reversed');
    expect(snap.reason_detail).toBe('now_down');
    expect(snap.facts).toEqual({ current_direction: -1, signal_direction: 1 });
    expect(snap.data_status).toBe(DATA_STATUS.LIVE);
  });

  it('fail-closed: direção ausente vira UNKNOWN, nunca LIVE inventado', () => {
    const snap = buildTrendReversedSnapshot({ currentDirection: null, signalDirection: 1 });
    expect(snap.data_status).toBe(DATA_STATUS.UNKNOWN);
    expect(snap.facts).toEqual({ current_direction: null, signal_direction: 1 });
  });
});

// Fase 3 — gestão de TradeOperation ativa (HOLDING/PROTECTED). A decisão
// PROTECTED-vs-HOLDING nestes builders é sempre `stopAfter !== stopBefore` —
// uma comparação de dois números que scanner.js já calculou, nunca uma
// reconstrução do critério interno de opExitRules.js.
describe('buildAwaitingTp1Snapshot', () => {
  it('BUY: distância até TP1 e até o stop, sempre positivas quando a favor', () => {
    const snap = buildAwaitingTp1Snapshot({ closePrice: 100, stop: 95, tp1: 110, isBuy: true, executor: 'cron', evaluatedAt: AGORA });
    expect(snap.decision).toBe(DECISION.HOLDING);
    expect(snap.reason_code).toBe('awaiting_tp1');
    expect(snap.facts).toEqual({ distance_to_tp1: 10, distance_to_stop: 5 });
    expect(snap.data_status).toBe(DATA_STATUS.LIVE);
  });

  it('SELL: mesma convenção de sinal, invertida', () => {
    const snap = buildAwaitingTp1Snapshot({ closePrice: 100, stop: 105, tp1: 90, isBuy: false });
    expect(snap.facts).toEqual({ distance_to_tp1: 10, distance_to_stop: 5 });
  });

  it('fail-closed: preço ausente vira UNKNOWN', () => {
    const snap = buildAwaitingTp1Snapshot({ closePrice: null, stop: 95, tp1: 110, isBuy: true });
    expect(snap.data_status).toBe(DATA_STATUS.UNKNOWN);
  });
});

describe('buildPreTp1BreakevenSnapshot', () => {
  const common = { isBuy: true, entry: 100, closePrice: 102, atrValue: 2, triggerAtrMult: 1.0, evaluatedAt: AGORA };

  it('armado mas não disparado — stop não mudou', () => {
    const snap = buildPreTp1BreakevenSnapshot({ ...common, stopBefore: 95, stopAfter: 95 });
    expect(snap.decision).toBe(DECISION.HOLDING);
    expect(snap.reason_code).toBe('pre_tp1_protection_armed_not_triggered');
    expect(snap.facts.favorable_move).toBe(2);
    expect(snap.facts.required_move).toBe(2);
    expect(snap.facts.stop_before).toBe(95);
    expect(snap.facts.stop_after).toBe(95);
  });

  it('disparado — stop saltou para a entrada', () => {
    const snap = buildPreTp1BreakevenSnapshot({ ...common, closePrice: 103, stopBefore: 95, stopAfter: 100 });
    expect(snap.decision).toBe(DECISION.PROTECTED);
    expect(snap.reason_code).toBe('breakeven_triggered');
    expect(snap.facts.stop_after).toBe(100);
  });

  it('SELL espelha a convenção de sinal', () => {
    const snap = buildPreTp1BreakevenSnapshot({
      isBuy: false, entry: 100, closePrice: 97, atrValue: 2, triggerAtrMult: 1.0, stopBefore: 105, stopAfter: 100,
    });
    expect(snap.facts.favorable_move).toBe(3);
    expect(snap.decision).toBe(DECISION.PROTECTED);
  });

  it('fail-closed: ATR ausente vira UNKNOWN mas ainda decide por comparação de stop', () => {
    const snap = buildPreTp1BreakevenSnapshot({ isBuy: true, entry: 100, closePrice: 102, atrValue: null, triggerAtrMult: 1.0, stopBefore: 95, stopAfter: 95 });
    expect(snap.data_status).toBe(DATA_STATUS.UNKNOWN);
    expect(snap.decision).toBe(DECISION.HOLDING);
  });
});

describe('buildPreTp1TrailingSnapshot', () => {
  const common = { isBuy: true, entry: 100, atrValue: 2, startAtrMult: 1.0, trailAtrMult: 2.5, evaluatedAt: AGORA };

  it('dormente — sem MFE ainda (favorableExtreme null), nunca trata como zero', () => {
    const snap = buildPreTp1TrailingSnapshot({ ...common, favorableExtreme: null, stopBefore: 95, stopAfter: 95 });
    expect(snap.decision).toBe(DECISION.HOLDING);
    expect(snap.reason_code).toBe('pre_tp1_trailing_dormant');
    expect(snap.facts.favorable_move).toBeNull();
    expect(snap.data_status).toBe(DATA_STATUS.LIVE);
  });

  it('dormente — MFE existe mas abaixo do gatilho', () => {
    const snap = buildPreTp1TrailingSnapshot({ ...common, favorableExtreme: 100.5, stopBefore: 95, stopAfter: 95 });
    expect(snap.reason_code).toBe('pre_tp1_trailing_dormant');
    expect(snap.facts.favorable_move).toBe(0.5);
  });

  it('avançado — stop mudou', () => {
    const snap = buildPreTp1TrailingSnapshot({ ...common, favorableExtreme: 105, stopBefore: 95, stopAfter: 100 });
    expect(snap.decision).toBe(DECISION.PROTECTED);
    expect(snap.reason_code).toBe('pre_tp1_trailing_advanced');
    expect(snap.facts.favorable_move).toBe(5);
  });

  it('fail-closed: ATR ausente vira UNKNOWN', () => {
    const snap = buildPreTp1TrailingSnapshot({ ...common, atrValue: null, favorableExtreme: 105, stopBefore: 95, stopAfter: 95 });
    expect(snap.data_status).toBe(DATA_STATUS.UNKNOWN);
  });
});

describe('buildRunnerTrailingSnapshot', () => {
  it('dormente — stop não mudou', () => {
    const snap = buildRunnerTrailingSnapshot({ stopBefore: 100, stopAfter: 100, closePrice: 108, atrValue: 3, trailMult: 2.0, evaluatedAt: AGORA });
    expect(snap.decision).toBe(DECISION.HOLDING);
    expect(snap.reason_code).toBe('runner_trailing_dormant');
  });

  it('avançado — stop subiu', () => {
    const snap = buildRunnerTrailingSnapshot({ stopBefore: 100, stopAfter: 104, closePrice: 110, atrValue: 3, trailMult: 2.0 });
    expect(snap.decision).toBe(DECISION.PROTECTED);
    expect(snap.reason_code).toBe('runner_trailing_advanced');
    expect(snap.facts.stop_before).toBe(100);
    expect(snap.facts.stop_after).toBe(104);
  });

  it('fail-closed: ATR ausente vira UNKNOWN', () => {
    const snap = buildRunnerTrailingSnapshot({ stopBefore: 100, stopAfter: 100, closePrice: 108, atrValue: null, trailMult: 2.0 });
    expect(snap.data_status).toBe(DATA_STATUS.UNKNOWN);
  });
});

describe('buildRunnerRfManagedSnapshot', () => {
  it('runner não-ATR: distância até stop e TP2', () => {
    const snap = buildRunnerRfManagedSnapshot({ closePrice: 100, stop: 90, tp2: 130, isBuy: true, evaluatedAt: AGORA });
    expect(snap.decision).toBe(DECISION.HOLDING);
    expect(snap.reason_code).toBe('runner_rf_managed');
    expect(snap.facts).toEqual({ distance_to_stop: 10, distance_to_tp2: 30 });
  });

  it('tp2 desligado (disableTp2CapEnabled) não inventa distância', () => {
    const snap = buildRunnerRfManagedSnapshot({ closePrice: 100, stop: 90, tp2: 130, tp2Disabled: true, isBuy: true });
    expect(snap.facts.distance_to_tp2).toBeNull();
  });

  it('fail-closed: preço ausente vira UNKNOWN', () => {
    const snap = buildRunnerRfManagedSnapshot({ closePrice: null, stop: 90, tp2: 130, isBuy: true });
    expect(snap.data_status).toBe(DATA_STATUS.UNKNOWN);
  });
});
