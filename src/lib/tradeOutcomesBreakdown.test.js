// Item 293: "Como terminaram" (aba Histórico). O que se prova: cada operação FECHADA cai em exatamente UMA categoria (a soma das categorias é o total),
// a classificação usa o resultado da fonte única (`classifyOutcome`) e não regra própria, "encerrada à mão" ganha de qualquer status (o resultado não é do
// motor), operação sem resultado calculável não vira ganho nem perda, e as cores seguem `outcomeColor`. Texto neutro: descreve, não prevê.
import { describe, it, expect } from 'vitest';
import {
  OUTCOME_KIND, OUTCOME_META, classifyClosedOp, buildOutcomeBreakdown,
} from './tradeOutcomesBreakdown.js';
import { classifyOutcome } from './tradeMetrics.js';
import { outcomeColor } from './outcomeColor.js';

const T = '2026-11-01T12:00:00Z';
// Base: compra a 100, stop inicial 95 (1R = 5). Abertura e encerramento no mesmo instante: sem funding, só taxa + deslizamento (≈ 0,024R).
const base = { side: 'BUY', entry_price: 100, initial_stop: 95, tp1: 107.5, tp2: 115, partial_percent: 50, created_date: T, closed_at: T };

const TP2 = { ...base, status: 'TP2_HIT', tp1_hit: true, tp1_hit_price: 107.5, tp2_hit: true, exit_price: 115 };
const TP1_FULL = { ...base, status: 'CLOSED', closed_reason: 'TP1_FULL', partial_percent: 100, tp1_hit: true, tp1_hit_price: 107.5, exit_price: 107.5 };
const STOP_WIN = { ...base, status: 'STOP_HIT', tp1_hit: true, tp1_hit_price: 107.5, exit_price: 100 }; // parcela no TP1 + resto no zero → +0,75R bruto
const STOP_BE = { ...base, status: 'STOP_HIT', exit_price: 100 }; // zero a zero: só custos (≈ −0,024R, dentro da faixa de ±0,05R)
const STOP_LOSS = { ...base, status: 'STOP_HIT', exit_price: 95 };
const INVALIDATED = { ...base, status: 'INVALIDATED', exit_price: 98 };
const INVALIDATION_CLOSED = { ...base, status: 'CLOSED', closed_reason: 'INVALIDATION', exit_price: 98 };
const TIME_STOP = { ...base, status: 'CLOSED', closed_reason: 'TIME_STOP', exit_price: 101 };
const CHOP_EXIT = { ...base, status: 'CLOSED', closed_reason: 'CHOP_EXIT', exit_price: 99 };
const MANUAL_CLOSE = { ...base, status: 'CLOSED', closed_reason: 'Encerrado manualmente', exit_price: 101 };
const OTHER_NO_REASON = { ...base, status: 'CLOSED', exit_price: 101 };

describe('classifyClosedOp — a categoria de cada operação fechada', () => {
  it.each([
    ['TP2_HIT → alvo final', TP2, OUTCOME_KIND.TP2],
    ['CLOSED/TP1_FULL → TP1 fechou tudo', TP1_FULL, OUTCOME_KIND.TP1_FULL],
    ['STOP_HIT com resultado de lucro → stop com lucro', STOP_WIN, OUTCOME_KIND.STOP_WIN],
    ['STOP_HIT perto de zero depois dos custos → zero a zero', STOP_BE, OUTCOME_KIND.STOP_BE],
    ['STOP_HIT com perda → stop com perda', STOP_LOSS, OUTCOME_KIND.STOP_LOSS],
    ['INVALIDATED → invalidada', INVALIDATED, OUTCOME_KIND.INVALIDATED],
    ['CLOSED/INVALIDATION → invalidada (mesma categoria)', INVALIDATION_CLOSED, OUTCOME_KIND.INVALIDATED],
    ['CLOSED/TIME_STOP → tempo esgotado', TIME_STOP, OUTCOME_KIND.TIME_STOP],
    ['CLOSED/CHOP_EXIT → mercado sem direção', CHOP_EXIT, OUTCOME_KIND.CHOP_EXIT],
    ['CLOSED à mão → encerrada à mão', MANUAL_CLOSE, OUTCOME_KIND.MANUAL],
    ['CLOSED sem motivo → outras', OTHER_NO_REASON, OUTCOME_KIND.OTHER],
  ])('%s', (_nome, op, esperado) => {
    expect(classifyClosedOp(op)).toBe(esperado);
  });

  it('as três variantes de stop usam o resultado da fonte única (classifyOutcome), não a heurística do TP1', () => {
    expect(classifyOutcome(STOP_WIN)).toBe('WIN');
    expect(classifyOutcome(STOP_BE)).toBe('BE');
    expect(classifyOutcome(STOP_LOSS)).toBe('LOSS');
    // Mesmo status e MESMO tp1_hit: o que decide é o resultado realizado. Um stop depois do TP1 pode ser lucro, zero ou perda.
    const stopAposTp1Perda = { ...STOP_WIN, exit_price: 90, partial_percent: 10 }; // 10% no TP1 (+0,15R) e 90% saindo −1,8R → −1,65R, perda
    expect(classifyOutcome(stopAposTp1Perda)).toBe('LOSS');
    expect(classifyClosedOp(stopAposTp1Perda)).toBe(OUTCOME_KIND.STOP_LOSS);
  });

  it('encerrada à mão ganha de qualquer status e de qualquer closed_reason (o resultado não é do motor)', () => {
    for (const closed_reason of ['Encerrado manualmente', 'Alterado manualmente', 'Invalidado manualmente']) {
      expect(classifyClosedOp({ ...STOP_LOSS, closed_reason })).toBe(OUTCOME_KIND.MANUAL);
      expect(classifyClosedOp({ ...TP2, closed_reason })).toBe(OUTCOME_KIND.MANUAL);
      expect(classifyClosedOp({ ...INVALIDATED, closed_reason })).toBe(OUTCOME_KIND.MANUAL);
    }
    // marca estruturada (decision_snapshot.executor) também vale
    expect(classifyClosedOp({ ...STOP_LOSS, decision_snapshot: { executor: 'manual' } })).toBe(OUTCOME_KIND.MANUAL);
  });

  it('simulação manual / retroativa / recuperada continuam sendo classificadas pela SAÍDA (a proveniência vira aviso à parte)', () => {
    for (const source of ['manual', 'backfill', 'recovery']) {
      expect(classifyClosedOp({ ...STOP_LOSS, source })).toBe(OUTCOME_KIND.STOP_LOSS);
      expect(classifyClosedOp({ ...TP2, source })).toBe(OUTCOME_KIND.TP2);
    }
  });

  it('sem resultado calculável: "outras", nunca ganho nem perda inventados', () => {
    const { entry_price: _e, ...semEntrada } = STOP_LOSS;
    expect(classifyOutcome(semEntrada)).toBe('UNKNOWN');
    expect(classifyClosedOp(semEntrada)).toBe(OUTCOME_KIND.OTHER);
  });

  it('motivo de encerramento desconhecido ou status estranho: "outras"', () => {
    expect(classifyClosedOp({ ...base, status: 'CLOSED', closed_reason: 'ALGO_NOVO', exit_price: 101 })).toBe(OUTCOME_KIND.OTHER);
    expect(classifyClosedOp({ ...base, status: 'CLOSED', closed_reason: null, exit_price: 101 })).toBe(OUTCOME_KIND.OTHER);
  });

  it('operação aberta ou entrada inválida: null (não é "terminou")', () => {
    expect(classifyClosedOp({ ...base, status: 'RUNNER_ACTIVE' })).toBeNull();
    expect(classifyClosedOp({ ...base, status: 'SIGNAL_CONFIRMED' })).toBeNull();
    for (const x of [null, undefined, 7, 'x', true, []]) expect(classifyClosedOp(x)).toBeNull();
  });
});

describe('buildOutcomeBreakdown — a contagem', () => {
  const MIX = [TP2, TP2, STOP_LOSS, STOP_LOSS, STOP_LOSS, STOP_WIN, STOP_BE, INVALIDATED, INVALIDATION_CLOSED, TIME_STOP, CHOP_EXIT, MANUAL_CLOSE, TP1_FULL, OTHER_NO_REASON];

  it('contagem por categoria, na ordem fixa, só com o que existe', () => {
    const { total, items } = buildOutcomeBreakdown(MIX);
    expect(total).toBe(14);
    expect(items.map((i) => [i.key, i.count])).toEqual([
      ['tp2', 2], ['tp1_full', 1], ['stop_win', 1], ['stop_be', 1], ['stop_loss', 3],
      ['invalidated', 2], ['time_stop', 1], ['chop_exit', 1], ['manual', 1], ['other', 1],
    ]);
  });

  it('INVARIANTE: a soma das categorias é o total e os percentuais somam 100', () => {
    const { total, items } = buildOutcomeBreakdown(MIX);
    expect(items.reduce((s, i) => s + i.count, 0)).toBe(total);
    expect(items.reduce((s, i) => s + i.pct, 0)).toBeCloseTo(100, 9);
    for (const i of items) expect(i.pct).toBeCloseTo((i.count / total) * 100, 9);
  });

  it('categoria sem nenhuma operação não aparece (nada de linha "0")', () => {
    const { items } = buildOutcomeBreakdown([STOP_LOSS, TP2]);
    expect(items.map((i) => i.key)).toEqual(['tp2', 'stop_loss']);
  });

  it('a ordem de exibição não depende da ordem das operações', () => {
    const a = buildOutcomeBreakdown([STOP_LOSS, TP2, TIME_STOP]).items.map((i) => i.key);
    const b = buildOutcomeBreakdown([TIME_STOP, TP2, STOP_LOSS]).items.map((i) => i.key);
    expect(a).toEqual(['tp2', 'stop_loss', 'time_stop']);
    expect(b).toEqual(a);
  });

  it('operações abertas e lixo no meio da lista são ignorados e não entram no total', () => {
    const { total, items } = buildOutcomeBreakdown([TP2, { ...base, status: 'RUNNER_ACTIVE' }, null, 7, {}, STOP_LOSS]);
    expect(total).toBe(2);
    expect(items.map((i) => i.key)).toEqual(['tp2', 'stop_loss']);
  });

  it('um terço: 33,3% (percentual real, não arredondado na conta)', () => {
    const { items } = buildOutcomeBreakdown([TP2, STOP_LOSS, TIME_STOP]);
    expect(items[0].pct).toBeCloseTo(33.3333333, 5);
  });

  it('lista vazia, nula ou que não é lista: total 0 e nenhum item', () => {
    for (const x of [[], null, undefined, 'x', 7, {}]) expect(buildOutcomeBreakdown(x)).toEqual({ total: 0, items: [] });
  });
});

describe('OUTCOME_META — rótulos, dicas e cores', () => {
  it('toda categoria tem rótulo e dica em português simples, e a ordem cobre todas', () => {
    for (const key of Object.values(OUTCOME_KIND)) {
      expect(OUTCOME_META[key].label.length).toBeGreaterThan(3);
      expect(OUTCOME_META[key].hint.length).toBeGreaterThan(10);
      expect(OUTCOME_META[key].color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(Object.keys(OUTCOME_META)).toEqual(Object.values(OUTCOME_KIND));
  });
  it('as cores de ganho/zero a zero/perda/invalidada são as MESMAS de outcomeColor (as duas telas não discordam)', () => {
    expect(OUTCOME_META.tp2.color).toBe(outcomeColor('TP2_HIT', 'WIN'));
    expect(OUTCOME_META.stop_win.color).toBe(outcomeColor('STOP_HIT', 'WIN'));
    expect(OUTCOME_META.stop_be.color).toBe(outcomeColor('STOP_HIT', 'BE'));
    expect(OUTCOME_META.stop_loss.color).toBe(outcomeColor('STOP_HIT', 'LOSS'));
    expect(OUTCOME_META.invalidated.color).toBe(outcomeColor('INVALIDATED', 'LOSS'));
  });
  it('texto neutro: descreve como terminou, não prevê nem promete', () => {
    const todos = Object.values(OUTCOME_META).map((m) => `${m.label} ${m.hint}`).join(' | ');
    expect(todos).not.toMatch(/vai (subir|cair)|probabilidade|garant|certeza|deveria|recomend|undefined|NaN/i);
  });
});
