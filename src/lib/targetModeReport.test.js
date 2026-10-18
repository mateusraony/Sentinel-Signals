import { describe, it, expect } from 'vitest';
import { summarizeTargets, checkArmProvenance } from './targetModeReport.js';

const op = (o) => ({ target_mode: 'swing_4h', target_near_policy: 'min_r_fallback', status: 'SIGNAL_CONFIRMED', ...o });

describe('summarizeTargets (item 281)', () => {
  it('conta base do alvo, motivo do fallback, distância do TP1 e saídas', () => {
    const r = summarizeTargets({
      targetMode: 'swing_4h',
      targetNearPolicy: 'min_r_fallback',
      ops: [
        op({ target_basis: 'SWING_4H', rr_at_entry_target: 0.8, target_first_level_r: 0.8, status: 'TP2_HIT', tp1_hit: true }),
        op({ target_basis: 'R_MULTIPLE_FALLBACK', target_fallback_reason: 'target_below_min_r', target_first_level_r: 0.2, status: 'STOP_HIT', tp1_hit: false, side: 'BUY', entry_price: 100, exit_price: 96 }),
        op({ target_basis: 'SWING_4H', rr_at_entry_target: 0.6, status: 'STOP_HIT', tp1_hit: false, side: 'SELL', entry_price: 100, current_stop: 98 }), // sem exit_price: usa o stop (trailing)
        op({ target_basis: 'R_MULTIPLE_FALLBACK', target_fallback_reason: 'no_level_beyond_entry', status: 'CLOSED', closed_reason: 'TIME_STOP' }),
        op({ target_basis: 'SWING_4H', rr_at_entry_target: 1.2, target_first_level_r: 0.3, status: 'STOP_HIT', tp1_hit: true }),
        { id: 'sem_braço', status: 'TP2_HIT' }, // operação sem target_mode (fora do braço) não conta
      ],
    });
    expect(r).toEqual({
      targetMode: 'swing_4h', targetNearPolicy: 'min_r_fallback', ops: 5,
      byBasis: { SWING_4H: 3, R_MULTIPLE_FALLBACK: 2 },
      fallbackReasons: { target_below_min_r: 1, no_level_beyond_entry: 1 },
      fallbackRate: 0.4, inconclusiveByFallback: false,
      medianTp1R: 0.8, medianFirstLevelR: 0.3, firstLevelBelowMinR: 2,
      closedOps: 5, exits: { stopBeforeTp1Loss: 1, stopBeforeTp1Profit: 1, stopAfterTp1: 1, tp2: 1, timeStop: 1, other: 0 },
      tp1Rate: 0.4,
      note: 'indicatorAttribution deste relatório usa os alvos do controle (1,5R/3R)',
    });
  });

  it('operação aberta no aquecimento (fora da janela avaliada) não conta', () => {
    const r = summarizeTargets({
      fromMs: Date.parse('2026-02-01T00:00:00Z'), toMs: Date.parse('2026-03-01T00:00:00Z'),
      ops: [
        op({ target_basis: 'SWING_4H', created_date: '2026-01-15T00:00:00Z' }),
        op({ target_basis: 'R_MULTIPLE_FALLBACK', target_fallback_reason: 'x', created_date: '2026-02-10T00:00:00Z' }),
      ],
    });
    expect(r).toMatchObject({ ops: 1, byBasis: { R_MULTIPLE_FALLBACK: 1 } });
  });

  it('mais da metade no fallback marca a janela como inconclusiva; sem operação, nulos', () => {
    const many = [1, 2, 3].map(() => op({ target_basis: 'R_MULTIPLE_FALLBACK', target_fallback_reason: 'target_below_min_r' }));
    expect(summarizeTargets({ ops: [...many, op({ target_basis: 'SWING_4H' })] }).inconclusiveByFallback).toBe(true);
    expect(summarizeTargets({ ops: [] })).toMatchObject({ ops: 0, fallbackRate: null, inconclusiveByFallback: null, medianTp1R: null });
  });
});

describe('checkArmProvenance (item 281)', () => {
  const base = { minScore: 50, tp1R: 1.5, targetMode: 'r_multiple', targetNearPolicy: 'literal' };
  const report = (pineConfig, trialArgs = '--symbols BTCUSDT --from a --to b') => ({ trialArgs, reproducibility: { pineConfig } });

  it('aceita braço que difere do controle só nas duas chaves de alvo', () => {
    expect(checkArmProvenance(report(base), report({ ...base, targetMode: 'swing_4h', targetNearPolicy: 'next_level' })))
      .toEqual({ ok: true, errors: [] });
  });

  it('recusa outra chave diferente, controle com alvo estrutural, braço sem alvo e SMC ligado', () => {
    const r = checkArmProvenance(
      report({ ...base, targetMode: 'fib_ext_15m' }),
      report({ ...base, tp1R: 2 }, '--symbols BTCUSDT --smc BTCUSDT'),
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      'controle com targetMode fib_ext_15m',
      'braço com targetMode r_multiple',
      'config difere fora das chaves de alvo: tp1R',
      'cascata SMC ligada (o pré-registro fixa smc vazio)',
    ]);
  });

  it('--smc vazio não conta como ligado; relatório sem config é recusado', () => {
    expect(checkArmProvenance(report(base, '--smc --from a'), report({ ...base, targetMode: 'swing_4h' })).ok).toBe(true);
    expect(checkArmProvenance({}, report(base)).ok).toBe(false);
  });
});
