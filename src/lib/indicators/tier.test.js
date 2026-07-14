import { describe, it, expect } from 'vitest';
import { classifyTier } from './tier';

describe('classifyTier', () => {
  it('classifies below tier2 threshold as T1', () => {
    const result = classifyTier(0.5, { tier2: 0.8, tier3: 1.5 });
    expect(result.tier).toBe('T1');
    expect(result.atrStopMult).toBe(2.0);
    expect(result.timeStopBars).toBe(48);
  });

  it('classifies exactly at the tier2 threshold as T2 (boundary is inclusive)', () => {
    const result = classifyTier(0.8, { tier2: 0.8, tier3: 1.5 });
    expect(result.tier).toBe('T2');
  });

  it('classifies exactly at the tier3 threshold as T3 (boundary is inclusive)', () => {
    const result = classifyTier(1.5, { tier2: 0.8, tier3: 1.5 });
    expect(result.tier).toBe('T3');
  });

  it('classifies above tier3 threshold as T3', () => {
    const result = classifyTier(5, { tier2: 0.8, tier3: 1.5 });
    expect(result.tier).toBe('T3');
    expect(result.atrStopMult).toBe(3.0);
  });

  it('applies a timeStopBarsOverride for the matched tier only', () => {
    const result = classifyTier(0.5, { tier2: 0.8, tier3: 1.5 }, { T1: 40, T2: 70, T3: 100 });
    expect(result.tier).toBe('T1');
    expect(result.timeStopBars).toBe(40);
  });

  it('falls back to the Pine default timeStopBars when the override is absent for that tier', () => {
    const result = classifyTier(0.5, { tier2: 0.8, tier3: 1.5 }, { T2: 70 });
    expect(result.tier).toBe('T1');
    expect(result.timeStopBars).toBe(48);
  });
});
