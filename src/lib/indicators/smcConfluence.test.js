import { describe, it, expect } from 'vitest';
import { calculateSmcSignalStrength, SMC_SCORE_DEFAULTS } from './smcConfluence.js';

function baseArgs(overrides = {}) {
  return {
    structureType: 'BOS',
    signalType: 'BUY',
    rf1hDirection: 0,
    emaTrend: 'neutral',
    volumeData: null,
    alignmentResult: null,
    pdZone: null,
    sweepConfirmed: null,
    weights: {},
    ...overrides,
  };
}

describe('calculateSmcSignalStrength — componentes isolados', () => {
  it('BOS sozinho conta só o peso base de estrutura', () => {
    const r = calculateSmcSignalStrength(baseArgs());
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight);
    expect(r.reasons).toContain(`Estrutura 1H: BOS (+${SMC_SCORE_DEFAULTS.structureWeight})`);
  });

  it('CHoCH soma o bônus além do peso base de estrutura', () => {
    const r = calculateSmcSignalStrength(baseArgs({ structureType: 'CHoCH' }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight + SMC_SCORE_DEFAULTS.chochBonus);
    expect(r.reasons).toContain(`Bônus CHoCH (+${SMC_SCORE_DEFAULTS.chochBonus})`);
  });

  it('EMA alinhada (BUY + bullish) soma o peso de EMA', () => {
    const r = calculateSmcSignalStrength(baseArgs({ emaTrend: 'bullish' }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight + SMC_SCORE_DEFAULTS.emaWeight);
  });

  it('EMA desalinhada (BUY + bearish) não soma nada', () => {
    const r = calculateSmcSignalStrength(baseArgs({ emaTrend: 'bearish' }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight);
  });

  it('Range Filter 1h alinhado (BUY + direction 1) soma o peso de RF', () => {
    const r = calculateSmcSignalStrength(baseArgs({ rf1hDirection: 1 }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight + SMC_SCORE_DEFAULTS.rfWeight);
  });

  it('SELL usa o lado oposto de EMA/RF', () => {
    const r = calculateSmcSignalStrength(baseArgs({
      signalType: 'SELL', emaTrend: 'bearish', rf1hDirection: -1,
    }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight + SMC_SCORE_DEFAULTS.emaWeight + SMC_SCORE_DEFAULTS.rfWeight);
  });

  it('volume acima da média soma o peso de volume', () => {
    const r = calculateSmcSignalStrength(baseArgs({ volumeData: { current: 100, ma: 50 } }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight + SMC_SCORE_DEFAULTS.volumeWeight);
  });

  it('volume abaixo da média não soma nada', () => {
    const r = calculateSmcSignalStrength(baseArgs({ volumeData: { current: 30, ma: 50 } }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight);
  });

  it('alinhamento multi-timeframe completo soma o peso cheio', () => {
    const r = calculateSmcSignalStrength(baseArgs({
      alignmentResult: { alignment: 'aligned', direction: 'bullish' },
    }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight + SMC_SCORE_DEFAULTS.alignmentWeight);
  });

  it('alinhamento parcial soma metade do peso (arredondado)', () => {
    const r = calculateSmcSignalStrength(baseArgs({
      alignmentResult: { alignment: 'partially_aligned', direction: 'bullish' },
    }));
    expect(r.score).toBe(Math.round(SMC_SCORE_DEFAULTS.structureWeight + SMC_SCORE_DEFAULTS.alignmentWeight / 2));
  });

  it('alinhamento na direção contrária não soma nada', () => {
    const r = calculateSmcSignalStrength(baseArgs({
      alignmentResult: { alignment: 'aligned', direction: 'bearish' },
    }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight);
  });

  it('sweepConfirmed=null (desconhecido na emissão do sinal 1h) não soma nada', () => {
    const r = calculateSmcSignalStrength(baseArgs({ sweepConfirmed: null }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight);
  });

  it('sweepConfirmed=true (resolvido na confirmação 5m) soma o peso de sweep', () => {
    const r = calculateSmcSignalStrength(baseArgs({ sweepConfirmed: true }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight + SMC_SCORE_DEFAULTS.sweepWeight);
  });

  it('sweepConfirmed=false não soma nada (diferente de null, mas também não confirma)', () => {
    const r = calculateSmcSignalStrength(baseArgs({ sweepConfirmed: false }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight);
  });
});

describe('calculateSmcSignalStrength — limite 0-100 e pesos configuráveis', () => {
  it('nunca ultrapassa 100 mesmo somando todos os componentes', () => {
    const r = calculateSmcSignalStrength(baseArgs({
      structureType: 'CHoCH',
      emaTrend: 'bullish',
      rf1hDirection: 1,
      volumeData: { current: 100, ma: 50 },
      alignmentResult: { alignment: 'aligned', direction: 'bullish' },
      sweepConfirmed: true,
    }));
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBe(100); // soma default = 15+10+20+15+15+15+10 = 100
  });

  it('pesos parcialmente sobrescritos caem no default para as chaves ausentes', () => {
    const r = calculateSmcSignalStrength(baseArgs({
      weights: { structureWeight: 30 },
    }));
    expect(r.score).toBe(30);
  });

  it('peso explicitamente undefined (chave de config ainda não setada) usa o default, não zera', () => {
    const r = calculateSmcSignalStrength(baseArgs({
      weights: { structureWeight: undefined, emaWeight: undefined },
      emaTrend: 'bullish',
    }));
    expect(r.score).toBe(SMC_SCORE_DEFAULTS.structureWeight + SMC_SCORE_DEFAULTS.emaWeight);
  });
});

describe('calculateSmcSignalStrength — classificação strength/priority', () => {
  it('score baixo (só estrutura BOS) classifica como weak/low', () => {
    const r = calculateSmcSignalStrength(baseArgs());
    expect(r.strength).toBe('weak');
    expect(r.priority).toBe('low');
  });

  it('score médio (>=40) classifica como moderate/medium', () => {
    const r = calculateSmcSignalStrength(baseArgs({
      structureType: 'CHoCH', emaTrend: 'bullish', rf1hDirection: 1,
    })); // 15+10+20+15 = 60
    expect(r.score).toBe(60);
    expect(r.strength).toBe('moderate');
    expect(r.priority).toBe('medium');
  });

  it('score alto (>=70) classifica como strong/high', () => {
    const r = calculateSmcSignalStrength(baseArgs({
      structureType: 'CHoCH', emaTrend: 'bullish', rf1hDirection: 1,
      volumeData: { current: 100, ma: 50 },
    })); // 15+10+20+15+15 = 75
    expect(r.score).toBe(75);
    expect(r.strength).toBe('strong');
    expect(r.priority).toBe('high');
  });
});
