// Fase 1 — Explainability V2. Builders puros, sem I/O: dado o mesmo escopo
// que scanner.js já tem numa rejeição de entrada, produzem o `facts{}`
// numérico que hoje é calculado e descartado (ver cabeçalho do módulo).
import { describe, it, expect } from 'vitest';
import {
  DECISION, DATA_STATUS, buildRegimeSnapshot, buildTrendReversedSnapshot,
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
