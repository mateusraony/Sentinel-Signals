// Fase 1 — Explainability V2. explainDecision() compõe com signalStatus.js
// (headline/why já fail-closed lá) e adiciona `evidence` a partir de
// decision_snapshot.facts. O caso mais importante é o primeiro: ausência de
// decision_snapshot nunca pode lançar nem inventar um número.
import { describe, it, expect } from 'vitest';
import { explainDecision } from './decisionExplanation.js';

describe('explainDecision — fail-closed (sem decision_snapshot)', () => {
  it('sinal recém-chegado sem nenhum motivo salvo', () => {
    const out = explainDecision({ timeframe: '4h', created_date: new Date().toISOString() });
    expect(out.headline).toBe('Checando agora');
    expect(out.evidence).toBeNull();
    expect(out.technical).toBeNull();
    expect(out.warnings).toEqual([]);
    expect(out.userAction).toMatch(/Nada a fazer/);
  });

  it('sinal legado rejeitado por regime_rejected mas SEM decision_snapshot — categórico funciona, evidência fica null', () => {
    const out = explainDecision({
      timeframe: '4h', signal_type: 'BUY',
      last_rejection_reason: 'regime_rejected', last_rejection_detail: 'adx',
    });
    expect(out.headline).toBe('Movimento sem força');
    expect(out.evidence).toBeNull();
    expect(out.technical).toBeNull();
  });

  it('entidade nula/indefinida nunca lança', () => {
    expect(() => explainDecision(null)).not.toThrow();
    expect(() => explainDecision(undefined)).not.toThrow();
    expect(explainDecision(undefined).evidence).toBeNull();
  });

  it('sinal expirado sem motivo salvo usa o fallback dedicado, não o genérico', () => {
    const oldIso = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const out = explainDecision({ timeframe: '4h', created_date: oldIso });
    expect(out.headline).toBe('Sem detalhe salvo');
  });
});

describe('explainDecision — com decision_snapshot (regime_rejected)', () => {
  const baseSignal = { timeframe: '4h', signal_type: 'BUY', last_rejection_reason: 'regime_rejected', last_rejection_detail: 'adx' };

  it('formata ADX/Chop reais quando data_status é LIVE', () => {
    const out = explainDecision({
      ...baseSignal,
      decision_snapshot: {
        decision: 'ENTRY_BLOCKED', reason_code: 'regime_rejected', reason_detail: 'adx',
        facts: { adx: 14.2, adx_min: 20, chop: 40.1, chop_max: 58, tier: 'T2' },
        rules: [], evaluated_at: '2026-09-17T12:00:00.000Z', market_time: null,
        executor: 'cron', data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: força do movimento (ADX) 14.2 — mínimo exigido 20 · lateralização (Chop) 40.1 — máximo permitido 58.');
    expect(out.warnings).toEqual([]);
    expect(out.technical.reason_code).toBe('regime_rejected');
  });

  it('data_status UNKNOWN nunca vira evidência favorável — some e avisa', () => {
    const out = explainDecision({
      ...baseSignal,
      decision_snapshot: {
        decision: 'ENTRY_BLOCKED', reason_code: 'regime_rejected', reason_detail: 'adx',
        facts: { adx: null, adx_min: null, chop: null, chop_max: null, tier: null },
        rules: [], evaluated_at: '2026-09-17T12:00:00.000Z', market_time: null,
        executor: 'cron', data_status: 'UNKNOWN',
      },
    });
    expect(out.evidence).toBeNull();
    expect(out.warnings.length).toBe(1);
  });

  it('reason_code sem formatador conhecido (futuro) não inventa evidência', () => {
    const out = explainDecision({
      timeframe: '4h', last_rejection_reason: 'retest_pending',
      decision_snapshot: {
        decision: 'ENTRY_BLOCKED', reason_code: 'retest_pending', reason_detail: null,
        facts: { anything: 1 }, rules: [], evaluated_at: '2026-09-17T12:00:00.000Z',
        market_time: null, executor: 'cron', data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBeNull();
  });
});

describe('explainDecision — com decision_snapshot (trend_reversed)', () => {
  it('formata as duas direções em português', () => {
    const out = explainDecision({
      timeframe: '4h', signal_type: 'BUY', last_rejection_reason: 'trend_reversed', last_rejection_detail: 'now_down',
      decision_snapshot: {
        decision: 'ENTRY_BLOCKED', reason_code: 'trend_reversed', reason_detail: 'now_down',
        facts: { current_direction: -1, signal_direction: 1 }, rules: [],
        evaluated_at: '2026-09-17T12:00:00.000Z', market_time: null, executor: 'browser', data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: tendência atual aponta para venda; o aviso era de compra.');
  });
});
