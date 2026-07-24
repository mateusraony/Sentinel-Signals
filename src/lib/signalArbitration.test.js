import { describe, it, expect } from 'vitest';
import { classifyCascadeRelation, planSignalArbitration, CASCADE_RANK, ARBITRATION_VERSION } from './signalArbitration.js';

describe('classifyCascadeRelation', () => {
  it('mesma cascata, mesma direção -> same/same', () => {
    const r = classifyCascadeRelation('4h_15m', 'BUY', { cascade: '4h_15m', side: 'BUY' });
    expect(r).toEqual({ direction: 'same', tfRelation: 'same' });
  });

  it('cascata candidata maior (4h_15m) que a ativa (1h_5m), mesma direção -> same/larger', () => {
    const r = classifyCascadeRelation('4h_15m', 'BUY', { cascade: '1h_5m', side: 'BUY' });
    expect(r).toEqual({ direction: 'same', tfRelation: 'larger' });
  });

  it('cascata candidata menor (1h_5m) que a ativa (4h_15m), mesma direção -> same/smaller', () => {
    const r = classifyCascadeRelation('1h_5m', 'BUY', { cascade: '4h_15m', side: 'BUY' });
    expect(r).toEqual({ direction: 'same', tfRelation: 'smaller' });
  });

  it('direção oposta é detectada independentemente do timeframe', () => {
    const r = classifyCascadeRelation('4h_15m', 'SELL', { cascade: '1h_5m', side: 'BUY' });
    expect(r.direction).toBe('opposite');
    expect(r.tfRelation).toBe('larger');
  });

  it('cascade ausente/desconhecida no activeOp cai em tfRelation "same" (default seguro)', () => {
    const r = classifyCascadeRelation('4h_15m', 'BUY', { cascade: undefined, side: 'BUY' });
    expect(r.tfRelation).toBe('same');
  });

  it('CASCADE_RANK reflete 1h_5m < 4h_15m', () => {
    expect(CASCADE_RANK['1h_5m']).toBeLessThan(CASCADE_RANK['4h_15m']);
  });
});

describe('planSignalArbitration — interruptor e casos degenerados', () => {
  it('arbEnabled:false sempre retorna no_change/arb_disabled, mesmo com score alto', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 100,
      activeOp: { cascade: '1h_5m', side: 'BUY' },
      pineConfig: { arbEnabled: false },
    });
    expect(r.outcome).toBe('no_change');
    expect(r.action).toBe('none');
    expect(r.reason).toBe('arb_disabled');
  });

  it('sem operação ativa retorna no_change/no_active_op', () => {
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 90, activeOp: null });
    expect(r.outcome).toBe('no_change');
    expect(r.reason).toBe('no_active_op');
  });

  it('ARBITRATION_VERSION é um inteiro estável (contrato para logs/testes de correlação)', () => {
    expect(Number.isInteger(ARBITRATION_VERSION)).toBe(true);
  });
});

describe('planSignalArbitration — mesma direção, candidato de timeframe maior (Estágio A: promoção pendente)', () => {
  const activeOp = { cascade: '1h_5m', side: 'BUY', score: 60 };

  it('score >= arbPromoteMinScore -> promotion_pending/start_promotion_pending (NUNCA promove direto)', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 80, activeOp,
      pineConfig: { arbPromoteMinScore: 75, arbReinforceMinScore: 50 },
    });
    expect(r.outcome).toBe('promotion_pending');
    expect(r.action).toBe('start_promotion_pending');
  });

  it('score exatamente no limiar de promoção também inicia o pendente (>=, não >)', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 75, activeOp,
      pineConfig: { arbPromoteMinScore: 75, arbReinforceMinScore: 50 },
    });
    expect(r.outcome).toBe('promotion_pending');
  });

  it('score entre reinforceMin e promoteMin -> reinforcement_accepted, nunca abre/promove', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 60, activeOp,
      pineConfig: { arbPromoteMinScore: 75, arbReinforceMinScore: 50 },
    });
    expect(r.outcome).toBe('reinforcement_accepted');
    expect(r.action).toBe('none');
  });

  it('score abaixo de reinforceMin -> reinforcement_rejected', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 30, activeOp,
      pineConfig: { arbPromoteMinScore: 75, arbReinforceMinScore: 50 },
    });
    expect(r.outcome).toBe('reinforcement_rejected');
    expect(r.action).toBe('none');
  });

  it('promotion_status já CONFIRMED não reinicia o ciclo, mesmo com score alto (idempotência)', () => {
    const confirmed = { ...activeOp, promotion_status: 'CONFIRMED' };
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 95, activeOp: confirmed,
      pineConfig: { arbPromoteMinScore: 75 },
    });
    expect(r.outcome).toBe('no_change');
    expect(r.reason).toBe('already_promoted');
  });

  it('promotion_status já PENDING_15M não reinicia o ciclo com um novo candidato (dedup)', () => {
    const pending = { ...activeOp, promotion_status: 'PENDING_15M' };
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 95, activeOp: pending,
      pineConfig: { arbPromoteMinScore: 75 },
    });
    expect(r.outcome).toBe('no_change');
    expect(r.reason).toBe('already_pending');
  });

  it('promotion_status EXPIRED permite um NOVO ciclo (não fica travado para sempre)', () => {
    const expired = { ...activeOp, promotion_status: 'EXPIRED' };
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 80, activeOp: expired,
      pineConfig: { arbPromoteMinScore: 75 },
    });
    expect(r.outcome).toBe('promotion_pending');
  });

  it('promotion_status REJECTED permite um NOVO ciclo', () => {
    const rejected = { ...activeOp, promotion_status: 'REJECTED' };
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 80, activeOp: rejected,
      pineConfig: { arbPromoteMinScore: 75 },
    });
    expect(r.outcome).toBe('promotion_pending');
  });

  it('usa os defaults (75/50) quando pineConfig não define os limiares', () => {
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 75, activeOp });
    expect(r.outcome).toBe('promotion_pending');
  });
});

describe('planSignalArbitration — mesma direção, candidato de timeframe menor (continuidade)', () => {
  it('score suficiente: nunca abre operação, nunca promove — só confirma continuidade', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({ candidateCascade: '1h_5m', candidateSide: 'BUY', candidateScore: 60, activeOp, pineConfig: { arbReinforceMinScore: 50 } });
    expect(r.outcome).toBe('continuation_confirmation');
    expect(r.action).toBe('none');
  });

  it('score abaixo do piso de gestão -> candidate_below_arbitration_threshold, não confirma continuidade', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({ candidateCascade: '1h_5m', candidateSide: 'BUY', candidateScore: 20, activeOp, pineConfig: { arbReinforceMinScore: 50 } });
    expect(r.outcome).toBe('candidate_below_arbitration_threshold');
    expect(r.action).toBe('none');
  });
});

describe('planSignalArbitration — mesma cascata, mesma direção', () => {
  it('reinforcement_accepted independente do score (não é um candidato de gestão cross-cascade)', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 10, activeOp });
    expect(r.outcome).toBe('reinforcement_accepted');
    expect(r.action).toBe('none');
  });
});

describe('planSignalArbitration — direção oposta, candidato de timeframe menor (correção)', () => {
  const activeOp = { cascade: '4h_15m', side: 'BUY' };

  it('score suficiente: reduz confiança, nunca fecha sozinho, sempre loga warn', () => {
    const r = planSignalArbitration({
      candidateCascade: '1h_5m', candidateSide: 'SELL', candidateScore: 90, activeOp,
      pineConfig: { arbOppositeScorePenalty: 20, arbReinforceMinScore: 50 },
    });
    expect(r.outcome).toBe('correction_warning');
    expect(r.action).toBe('reduce_confidence');
    expect(r.logLevel).toBe('warn');
    expect(r.scorePenalty).toBe(20);
  });

  it('score abaixo do piso de gestão -> candidate_below_arbitration_threshold, não reduz confiança', () => {
    const r = planSignalArbitration({
      candidateCascade: '1h_5m', candidateSide: 'SELL', candidateScore: 20, activeOp,
      pineConfig: { arbReinforceMinScore: 50 },
    });
    expect(r.outcome).toBe('candidate_below_arbitration_threshold');
    expect(r.action).toBe('none');
  });
});

describe('planSignalArbitration — direção oposta, candidato de timeframe maior (risco crítico)', () => {
  const activeOp = { cascade: '1h_5m', side: 'BUY' };

  it('por padrão (arbInvalidateOnOppositeMajor=false) só alerta, nunca promove nem invalida', () => {
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 90, activeOp });
    expect(r.outcome).toBe('critical_opposite');
    expect(r.action).toBe('none');
    expect(r.logLevel).toBe('warn');
  });

  it('NÃO é bloqueado pelo piso de gestão (arbReinforceMinScore) — sempre alerta mesmo com score baixo', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 5, activeOp,
      pineConfig: { arbReinforceMinScore: 50 },
    });
    expect(r.outcome).toBe('critical_opposite');
    expect(r.logLevel).toBe('warn');
  });

  it('com arbInvalidateOnOppositeMajor=true, avalia invalidar', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 90, activeOp,
      pineConfig: { arbInvalidateOnOppositeMajor: true },
    });
    expect(r.outcome).toBe('critical_opposite');
    expect(r.action).toBe('invalidate');
  });

  it('com uma promoção pendente, cancela o pendente (reject_pending_promotion) em vez de invalidar', () => {
    const pending = { ...activeOp, promotion_status: 'PENDING_15M' };
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 90, activeOp: pending });
    expect(r.outcome).toBe('critical_opposite');
    expect(r.action).toBe('reject_pending_promotion');
  });

  it('nunca promove mesmo com score de candidato altíssimo', () => {
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 100, activeOp });
    expect(r.outcome).not.toBe('promotion_pending');
    expect(r.action).not.toBe('start_promotion_pending');
  });
});

describe('planSignalArbitration — mesma cascata, direção oposta', () => {
  it('score suficiente: trata como correção (reduce_confidence), não como crítico', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 90, activeOp, pineConfig: { arbReinforceMinScore: 50 } });
    expect(r.outcome).toBe('correction_warning');
    expect(r.action).toBe('reduce_confidence');
  });

  it('score abaixo do piso -> candidate_below_arbitration_threshold', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 10, activeOp, pineConfig: { arbReinforceMinScore: 50 } });
    expect(r.outcome).toBe('candidate_below_arbitration_threshold');
  });
});

describe('planSignalArbitration — direction/tfRelation sempre presentes na resposta (observabilidade)', () => {
  it('inclui direction e tfRelation mesmo em outcomes de "none"', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({ candidateCascade: '1h_5m', candidateSide: 'BUY', candidateScore: 60, activeOp });
    expect(r.direction).toBe('same');
    expect(r.tfRelation).toBe('smaller');
  });

  it('direction/tfRelation são null quando não há operação ativa', () => {
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 60, activeOp: null });
    expect(r.direction).toBeNull();
    expect(r.tfRelation).toBeNull();
  });
});
