// Fase 1 — Explainability V2. explainDecision() compõe com signalStatus.js
// (headline/why já fail-closed lá) e adiciona `evidence` a partir de
// decision_snapshot.facts. O caso mais importante é o primeiro: ausência de
// decision_snapshot nunca pode lançar nem inventar um número.
import { describe, it, expect } from 'vitest';
import { explainDecision, explainOperationDecision } from './decisionExplanation.js';

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

// Fase 3 — gestão de TradeOperation ativa (HOLDING/PROTECTED).
describe('explainOperationDecision — fail-closed (sem decision_snapshot)', () => {
  it('operação legada/sem decision_snapshot nunca lança e cai no fallback', () => {
    const out = explainOperationDecision({ status: 'SIGNAL_CONFIRMED' });
    expect(out.headline).toBe('Monitorando');
    expect(out.evidence).toBeNull();
    expect(out.technical).toBeNull();
    expect(out.userAction).toMatch(/Nada a fazer/);
  });

  it('entidade nula/indefinida nunca lança', () => {
    expect(() => explainOperationDecision(null)).not.toThrow();
    expect(() => explainOperationDecision(undefined)).not.toThrow();
  });

  it('reason_code desconhecido (versão futura do motor) cai no fallback, não quebra', () => {
    const out = explainOperationDecision({
      decision_snapshot: { decision: 'HOLDING', reason_code: 'algo_novo_do_futuro', facts: {}, data_status: 'LIVE' },
    });
    expect(out.headline).toBe('Monitorando');
    expect(out.evidence).toBeNull();
  });
});

describe('explainOperationDecision — awaiting_tp1', () => {
  it('formata distância até TP1 e stop', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'awaiting_tp1', facts: { distance_to_tp1: 10, distance_to_stop: 5 },
        data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('Monitorando');
    expect(out.evidence).toBe('Medido: faltam 10 até o TP1, 5 de folga até o stop.');
  });
});

describe('explainOperationDecision — pré-TP1 breakeven', () => {
  it('armado mas não disparado', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'pre_tp1_protection_armed_not_triggered',
        facts: { favorable_move: 0.8, required_move: 2 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: movimento favorável 0.8, necessário 2 para acionar.');
  });

  it('disparado — inclui stop antes/depois', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'PROTECTED', reason_code: 'breakeven_triggered',
        facts: { favorable_move: 2.1, required_move: 2, stop_before: 95, stop_after: 100 }, data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('Proteção aumentada');
    expect(out.evidence).toBe('Medido: movimento favorável 2.1, necessário 2 para acionar. Stop foi de 95 para 100.');
  });
});

describe('explainOperationDecision — pré-TP1 trailing', () => {
  it('dormente sem MFE ainda (favorable_move null) não inventa um valor', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'pre_tp1_trailing_dormant',
        facts: { favorable_move: null, required_move: 2 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: ainda sem movimento favorável registrado — necessário 2 para a trilha começar.');
  });

  it('avançado — inclui stop antes/depois', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'PROTECTED', reason_code: 'pre_tp1_trailing_advanced',
        facts: { favorable_move: 5, required_move: 2, stop_before: 95, stop_after: 100 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: movimento favorável 5, gatilho da trilha em 2. Stop foi de 95 para 100.');
  });
});

describe('explainOperationDecision — runner pós-TP1', () => {
  it('runner_rf_managed com TP2 ativo', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'runner_rf_managed',
        facts: { distance_to_stop: 10, distance_to_tp2: 30 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: 10 de folga até o stop, faltam 30 até o TP2.');
  });

  it('runner_rf_managed com TP2 desligado', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'runner_rf_managed',
        facts: { distance_to_stop: 10, distance_to_tp2: null }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: 10 de folga até o stop.');
  });

  it('runner_trailing_dormant', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'runner_trailing_dormant',
        facts: { stop_before: 100, stop_after: 100 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: stop mantido em 100.');
  });

  it('runner_trailing_advanced', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'PROTECTED', reason_code: 'runner_trailing_advanced',
        facts: { stop_before: 100, stop_after: 104 }, data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('Runner ativo — proteção aumentada');
    expect(out.evidence).toBe('Medido: stop foi de 100 para 104.');
  });
});

describe('explainOperationDecision — data_status não-LIVE nunca vira evidência favorável', () => {
  it('UNKNOWN esconde a evidência e avisa', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'awaiting_tp1', facts: { distance_to_tp1: null, distance_to_stop: null },
        data_status: 'UNKNOWN',
      },
    });
    expect(out.evidence).toBeNull();
    expect(out.warnings.length).toBe(1);
  });
});
