import { describe, it, expect } from 'vitest';
import { drawdownColor, winRateColor, profitFactorColor, profitFactorLabel, metricGlow } from './metricColorRanges.js';

describe('drawdownColor', () => {
  it('acima de 15% é vermelho', () => {
    expect(drawdownColor(15.1)).toBe('#e06a5b');
  });
  it('entre 8% e 15% é laranja', () => {
    expect(drawdownColor(8.1)).toBe('#dd9a4a');
    expect(drawdownColor(15)).toBe('#dd9a4a');
  });
  it('8% ou menos é verde', () => {
    expect(drawdownColor(8)).toBe('#5db586');
    expect(drawdownColor(0)).toBe('#5db586');
  });
});

describe('winRateColor', () => {
  it('50% ou mais é verde', () => {
    expect(winRateColor(50)).toBe('#5db586');
    expect(winRateColor(75)).toBe('#5db586');
  });
  it('abaixo de 50% é laranja', () => {
    expect(winRateColor(49.9)).toBe('#dd9a4a');
    expect(winRateColor(0)).toBe('#dd9a4a');
  });
});

describe('profitFactorColor', () => {
  it('pf >= 1.5 é verde (Saudável)', () => {
    expect(profitFactorColor(1.5)).toBe('#5db586');
    expect(profitFactorColor(3)).toBe('#5db586');
  });
  it('1 <= pf < 1.5 é laranja (Marginal)', () => {
    expect(profitFactorColor(1)).toBe('#dd9a4a');
    expect(profitFactorColor(1.49)).toBe('#dd9a4a');
  });
  it('pf < 1 é vermelho (Baixo)', () => {
    expect(profitFactorColor(0.99)).toBe('#e06a5b');
    expect(profitFactorColor(0)).toBe('#e06a5b');
  });
  it('pf null com vitórias (só ganhos, nenhuma perda) é verde', () => {
    expect(profitFactorColor(null, true)).toBe('#5db586');
  });
  it('pf null sem vitórias (amostra só com empates) é vermelho', () => {
    expect(profitFactorColor(null, false)).toBe('#e06a5b');
  });
});

describe('profitFactorLabel', () => {
  it('pf >= 1.5 é "✓ Saudável"', () => {
    expect(profitFactorLabel(1.5)).toBe('✓ Saudável');
  });
  it('1 <= pf < 1.5 é "⚠ Marginal"', () => {
    expect(profitFactorLabel(1.2)).toBe('⚠ Marginal');
  });
  it('pf < 1 é "✗ Baixo"', () => {
    expect(profitFactorLabel(0.5)).toBe('✗ Baixo');
  });
  it('pf null com vitórias é "✓ Saudável"; sem vitórias é "✗ Baixo"', () => {
    expect(profitFactorLabel(null, true)).toBe('✓ Saudável');
    expect(profitFactorLabel(null, false)).toBe('✗ Baixo');
  });
});

describe('metricGlow', () => {
  it('cada uma das 3 cores retornadas pelas funções acima tem um glow correspondente', () => {
    expect(metricGlow('#5db586')).toBe('rgba(93,181,134,0.4)');
    expect(metricGlow('#dd9a4a')).toBe('rgba(221,154,74,0.4)');
    expect(metricGlow('#e06a5b')).toBe('rgba(224,106,91,0.4)');
  });
});
