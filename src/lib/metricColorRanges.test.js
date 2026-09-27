import { describe, it, expect } from 'vitest';
import { drawdownColor, winRateColor, profitFactorColor, profitFactorLabel, metricGlow } from './metricColorRanges.js';

describe('drawdownColor', () => {
  it('acima de 15% é vermelho', () => {
    expect(drawdownColor(15.1)).toBe('#ff1478');
  });
  it('entre 8% e 15% é laranja', () => {
    expect(drawdownColor(8.1)).toBe('#ff9f43');
    expect(drawdownColor(15)).toBe('#ff9f43');
  });
  it('8% ou menos é verde', () => {
    expect(drawdownColor(8)).toBe('#00ff80');
    expect(drawdownColor(0)).toBe('#00ff80');
  });
});

describe('winRateColor', () => {
  it('50% ou mais é verde', () => {
    expect(winRateColor(50)).toBe('#00ff80');
    expect(winRateColor(75)).toBe('#00ff80');
  });
  it('abaixo de 50% é laranja', () => {
    expect(winRateColor(49.9)).toBe('#ff9f43');
    expect(winRateColor(0)).toBe('#ff9f43');
  });
});

describe('profitFactorColor', () => {
  it('pf >= 1.5 é verde (Saudável)', () => {
    expect(profitFactorColor(1.5)).toBe('#00ff80');
    expect(profitFactorColor(3)).toBe('#00ff80');
  });
  it('1 <= pf < 1.5 é laranja (Marginal)', () => {
    expect(profitFactorColor(1)).toBe('#ff9f43');
    expect(profitFactorColor(1.49)).toBe('#ff9f43');
  });
  it('pf < 1 é vermelho (Baixo)', () => {
    expect(profitFactorColor(0.99)).toBe('#ff1478');
    expect(profitFactorColor(0)).toBe('#ff1478');
  });
  it('pf null com vitórias (só ganhos, nenhuma perda) é verde', () => {
    expect(profitFactorColor(null, true)).toBe('#00ff80');
  });
  it('pf null sem vitórias (amostra só com empates) é vermelho', () => {
    expect(profitFactorColor(null, false)).toBe('#ff1478');
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
    expect(metricGlow('#00ff80')).toBe('rgba(0,255,128,0.4)');
    expect(metricGlow('#ff9f43')).toBe('rgba(255,159,67,0.4)');
    expect(metricGlow('#ff1478')).toBe('rgba(255,20,120,0.4)');
  });
});
