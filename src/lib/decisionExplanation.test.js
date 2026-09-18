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
    expect(out.evidence).toBe('Medido: força do movimento (ADX) 14.2 — mínimo exigido 20 · lateralização (Chop) 40.1 — máximo permitido 58. (medido às 09:00 BRT)');
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

  // Achado de revisão independente (sentinel-trading-engine-review +
  // code-review, 2026-09-17): recordRejection() (scanner.js) só passa
  // `snapshot` para regime_rejected/trend_reversed — os outros ~8 motivos de
  // rejeição mudam `last_rejection_reason` via write-on-change SEM tocar
  // `decision_snapshot`, que fica com o valor do último motivo que era um
  // desses dois. Sem o guard de frescor, a evidência numérica descrevia um
  // motivo JÁ RESOLVIDO enquanto o chip mostrava o motivo atual — pior que
  // não mostrar nada.
  it('REGRESSÃO: evidência de um motivo RESOLVIDO não pode vazar pro motivo ATUAL', () => {
    const out = explainDecision({
      timeframe: '4h', signal_type: 'BUY',
      // Motivo ATUAL: padrão de vela não confirmou — recordRejection() nunca
      // passa snapshot para candle_pattern_rejected.
      last_rejection_reason: 'candle_pattern_rejected', last_rejection_detail: null,
      // decision_snapshot STALE: sobrou de quando o motivo era regime_rejected.
      decision_snapshot: {
        decision: 'ENTRY_BLOCKED', reason_code: 'regime_rejected', reason_detail: 'adx',
        facts: { adx: 14.2, adx_min: 20, chop: 40, chop_max: 58, tier: 'T2' },
        rules: [], evaluated_at: '2026-09-17T08:00:00.000Z', market_time: null,
        executor: 'cron', data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('A vela não confirmou');
    expect(out.evidence).toBeNull();
  });

  it('snapshot fresco (reason_code bate com last_rejection_reason) continua mostrando evidência', () => {
    const out = explainDecision({
      timeframe: '4h', signal_type: 'BUY',
      last_rejection_reason: 'regime_rejected', last_rejection_detail: 'adx',
      decision_snapshot: {
        decision: 'ENTRY_BLOCKED', reason_code: 'regime_rejected', reason_detail: 'adx',
        facts: { adx: 14.2, adx_min: 20, chop: 40, chop_max: 58, tier: 'T2' },
        rules: [], evaluated_at: '2026-09-17T08:00:00.000Z', market_time: null,
        executor: 'cron', data_status: 'LIVE',
      },
    });
    expect(out.evidence).toMatch(/ADX/);
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
    expect(out.evidence).toBe('Medido: tendência atual aponta para venda; o aviso era de compra. (medido às 09:00 BRT)');
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

// Achado de revisão independente (2026-09-17): no candle exato em que TP1
// dispara, o decision_snapshot precisa refletir isso — sem ele, a tela
// mostraria uma fase pré-TP1 numa operação que já é runner.
describe('explainOperationDecision — TP1 atingido', () => {
  it('stop moveu para a entrada', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'PROTECTED', reason_code: 'tp1_hit_stop_to_breakeven',
        facts: { stop_before: 95, stop_after: 100, tp1: 110 }, data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('TP1 atingido — proteção aumentada');
    expect(out.evidence).toBe('Medido: stop foi de 95 para 100 (entrada).');
  });

  it('stop já estava na entrada (caso raro)', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'tp1_hit_stop_unchanged',
        facts: { stop_before: 100, stop_after: 100, tp1: 110 }, data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('TP1 atingido');
    expect(out.evidence).toBe('Medido: stop mantido em 100 (já era a entrada).');
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

// Achado de revisão independente (2026-09-17): decision_snapshot só é
// regravado quando outra escrita já ia acontecer (write-on-change em
// SignalEvent, carona em mfe_r/current_stop em TradeOperation) — um
// `data_status: 'LIVE'` não garante que os fatos são da passada mais
// recente. Em vez de inventar um limiar de "desatualizado", expõe o
// horário em que os fatos foram medidos (`evaluated_at`), deixando o
// usuário julgar. Ver docs/known-risks.md item 182 (texto corrigido: a
// cadência real é "novo extremo MFE/MAE", não "novo candle").
describe('evidência mostra quando foi medida (staleness visível)', () => {
  it('SignalEvent: evaluated_at vira "(medido às HH:MM BRT)" ao final da evidência', () => {
    const out = explainDecision({
      timeframe: '4h', signal_type: 'BUY', last_rejection_reason: 'trend_reversed', last_rejection_detail: 'now_down',
      decision_snapshot: {
        decision: 'ENTRY_BLOCKED', reason_code: 'trend_reversed', reason_detail: 'now_down',
        facts: { current_direction: -1, signal_direction: 1 }, rules: [],
        evaluated_at: '2026-09-17T18:45:00.000Z', market_time: null, executor: 'browser', data_status: 'LIVE',
      },
    });
    expect(out.evidence).toMatch(/\(medido às 15:45 BRT\)$/);
  });

  it('TradeOperation: mesmo comportamento quando evaluated_at está presente', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'awaiting_tp1', facts: { distance_to_tp1: 10, distance_to_stop: 5 },
        evaluated_at: '2026-09-17T18:45:00.000Z', data_status: 'LIVE',
      },
    });
    expect(out.evidence).toMatch(/\(medido às 15:45 BRT\)$/);
  });

  it('sem evaluated_at (fixture legada) não inventa horário — evidência sem sufixo', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'awaiting_tp1', facts: { distance_to_tp1: 10, distance_to_stop: 5 },
        data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: faltam 10 até o TP1, 5 de folga até o stop.');
  });

  it('evidência null continua null — não gruda horário em nada', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'HOLDING', reason_code: 'algo_desconhecido', facts: {},
        evaluated_at: '2026-09-17T18:45:00.000Z', data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBeNull();
  });
});

// Fase 4 — EXIT (a operação encerrou), um reason_code por ponto de
// interceptação de scanner.js.
describe('explainOperationDecision — EXIT', () => {
  it('stop_hit_pre_tp1', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'stop_hit_pre_tp1',
        facts: { stop: 98, stop_check_price: 97.5 }, data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('Stop atingido');
    expect(out.evidence).toBe('Medido: stop em 98, preço tocou 97.5.');
  });

  it('stop_hit_runner', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'stop_hit_runner',
        facts: { stop: 102 }, data_status: 'LIVE',
      },
    });
    expect(out.why).toMatch(/já protegido/);
    expect(out.evidence).toBe('Medido: stop em 102.');
  });

  it('tp2_hit', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'tp2_hit',
        facts: { tp2: 130, tp_check_price: 130.5 }, data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('TP2 atingido — operação completa');
    expect(out.evidence).toBe('Medido: TP2 em 130, preço tocou 130.5.');
  });

  it('invalidated_rf_bars_pre_tp1', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'invalidated_rf_bars_pre_tp1',
        facts: { reverse_bars: 2, invalid_rf_bars: 2 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: 2 de 2 candles necessários com o indicador contra a posição.');
  });

  it('invalidated_rf_direct_runner', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'invalidated_rf_direct_runner',
        facts: { rf_filter_value: 105, close_price: 104 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: preço 104 contra o filtro em 105.');
  });

  it('invalidated_smc_structure', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'invalidated_smc_structure',
        facts: { smc_trend: -1, signal_direction: 1 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: estrutura agora aponta para venda; a operação era de compra.');
  });

  it('chop_exit', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'chop_exit',
        facts: { chop: 63, chop_max: 58 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: lateralização (Chop) 63 — máximo permitido 58.');
  });

  it('time_stop', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'time_stop',
        facts: { bars_open: 40, time_stop_bars: 36 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: 40 de 36 candles permitidos sem atingir TP1.');
  });

  it('tp1_full_close', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'tp1_full_close',
        facts: { tp1: 110 }, data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('TP1 atingido — operação encerrada');
    expect(out.evidence).toBe('Medido: TP1 em 110.');
  });

  it('stop_hit_price_check (priceCheckActiveOpsInner — snapshot magro)', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'stop_hit_price_check',
        facts: { stop: 98, price: 97 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: stop em 98, preço ao vivo 97.');
  });

  it('tp2_hit_price_check', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'tp2_hit_price_check',
        facts: { tp2: 130, price: 131 }, data_status: 'LIVE',
      },
    });
    expect(out.evidence).toBe('Medido: TP2 em 130, preço ao vivo 131.');
  });

  it('tp1_full_close_price_check', () => {
    const out = explainOperationDecision({
      decision_snapshot: {
        decision: 'EXIT', reason_code: 'tp1_full_close_price_check',
        facts: { tp1: 110, price: 110.5 }, data_status: 'LIVE',
      },
    });
    expect(out.headline).toBe('TP1 atingido — operação encerrada');
    expect(out.evidence).toBe('Medido: TP1 em 110, preço ao vivo 110.5.');
  });

  it('manual_closed: facts vazio, sem evidência inventada', () => {
    const out = explainOperationDecision({
      decision_snapshot: { decision: 'EXIT', reason_code: 'manual_closed', facts: {}, data_status: 'LIVE' },
    });
    expect(out.headline).toBe('Encerrada manualmente');
    expect(out.evidence).toBeNull();
  });

  it('manual_invalidated: facts vazio, sem evidência inventada', () => {
    const out = explainOperationDecision({
      decision_snapshot: { decision: 'EXIT', reason_code: 'manual_invalidated', facts: {}, data_status: 'LIVE' },
    });
    expect(out.headline).toBe('Invalidada manualmente');
    expect(out.evidence).toBeNull();
  });
});

// notifyTP1Hit (telegram.js) chega em qualquer um destes 3 reason_code
// possíveis no momento do TP1 — explainOperationDecision já resolve
// corretamente porque olha só reason_code, agnóstico de qual fase o criou.
describe('explainOperationDecision — ambiguidade do TP1 entre 3 reason_code possíveis', () => {
  it('runner com stop movido para breakeven (Fase 3)', () => {
    const out = explainOperationDecision({
      decision_snapshot: { decision: 'PROTECTED', reason_code: 'tp1_hit_stop_to_breakeven', facts: { stop_before: 95, stop_after: 100 }, data_status: 'LIVE' },
    });
    expect(out.headline).toBe('TP1 atingido — proteção aumentada');
  });

  it('runner com stop já na entrada (Fase 3)', () => {
    const out = explainOperationDecision({
      decision_snapshot: { decision: 'HOLDING', reason_code: 'tp1_hit_stop_unchanged', facts: { stop_before: 100, stop_after: 100 }, data_status: 'LIVE' },
    });
    expect(out.headline).toBe('TP1 atingido');
  });

  it('sem runner, encerramento total (Fase 4)', () => {
    const out = explainOperationDecision({
      decision_snapshot: { decision: 'EXIT', reason_code: 'tp1_full_close', facts: { tp1: 110 }, data_status: 'LIVE' },
    });
    expect(out.headline).toBe('TP1 atingido — operação encerrada');
  });
});
