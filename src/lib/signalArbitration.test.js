import { describe, it, expect } from 'vitest';
import { classifyCascadeRelation, planSignalArbitration, CASCADE_RANK } from './signalArbitration.js';

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
    expect(r).toEqual({ outcome: 'no_change', action: 'none', reason: 'arb_disabled', logLevel: 'info', scorePenalty: 0 });
  });

  it('sem operação ativa retorna no_change/no_active_op', () => {
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 90, activeOp: null });
    expect(r.outcome).toBe('no_change');
    expect(r.reason).toBe('no_active_op');
  });
});

describe('planSignalArbitration — mesma direção, candidato de timeframe maior (promoção conservadora)', () => {
  const activeOp = { cascade: '1h_5m', side: 'BUY', score: 60 };

  it('score >= arbPromoteMinScore -> promoted/promote', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 80, activeOp,
      pineConfig: { arbPromoteMinScore: 75, arbReinforceMinScore: 50 },
    });
    expect(r.outcome).toBe('promoted');
    expect(r.action).toBe('promote');
  });

  it('score exatamente no limiar de promoção também promove (>=, não >)', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 75, activeOp,
      pineConfig: { arbPromoteMinScore: 75, arbReinforceMinScore: 50 },
    });
    expect(r.outcome).toBe('promoted');
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

  it('operação já promovida não promove de novo, mesmo com score alto (idempotência)', () => {
    const alreadyPromoted = { ...activeOp, arbitration_outcome: 'promoted' };
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 95, activeOp: alreadyPromoted,
      pineConfig: { arbPromoteMinScore: 75 },
    });
    expect(r.outcome).toBe('no_change');
    expect(r.reason).toBe('already_promoted');
  });

  it('usa os defaults (75/50) quando pineConfig não define os limiares', () => {
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 75, activeOp });
    expect(r.outcome).toBe('promoted');
  });
});

describe('planSignalArbitration — mesma direção, candidato de timeframe menor (continuidade)', () => {
  it('nunca abre operação, nunca promove — só confirma continuidade', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({ candidateCascade: '1h_5m', candidateSide: 'BUY', candidateScore: 95, activeOp });
    expect(r.outcome).toBe('continuation_confirmation');
    expect(r.action).toBe('none');
  });
});

describe('planSignalArbitration — mesma cascata, mesma direção', () => {
  it('reinforcement_accepted independente do score', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'BUY', candidateScore: 10, activeOp });
    expect(r.outcome).toBe('reinforcement_accepted');
    expect(r.action).toBe('none');
  });
});

describe('planSignalArbitration — direção oposta, candidato de timeframe menor (correção)', () => {
  it('reduz confiança, nunca fecha sozinho, sempre loga warn', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({
      candidateCascade: '1h_5m', candidateSide: 'SELL', candidateScore: 90, activeOp,
      pineConfig: { arbOppositeScorePenalty: 20 },
    });
    expect(r.outcome).toBe('correction_warning');
    expect(r.action).toBe('reduce_confidence');
    expect(r.logLevel).toBe('warn');
    expect(r.scorePenalty).toBe(20);
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

  it('com arbInvalidateOnOppositeMajor=true, avalia invalidar', () => {
    const r = planSignalArbitration({
      candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 90, activeOp,
      pineConfig: { arbInvalidateOnOppositeMajor: true },
    });
    expect(r.outcome).toBe('critical_opposite');
    expect(r.action).toBe('invalidate');
  });

  it('nunca promove mesmo com score de candidato altíssimo', () => {
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 100, activeOp });
    expect(r.outcome).not.toBe('promoted');
    expect(r.action).not.toBe('promote');
  });
});

describe('planSignalArbitration — mesma cascata, direção oposta', () => {
  it('trata como correção (reduce_confidence), não como crítico', () => {
    const activeOp = { cascade: '4h_15m', side: 'BUY' };
    const r = planSignalArbitration({ candidateCascade: '4h_15m', candidateSide: 'SELL', candidateScore: 90, activeOp });
    expect(r.outcome).toBe('correction_warning');
    expect(r.action).toBe('reduce_confidence');
  });
});
