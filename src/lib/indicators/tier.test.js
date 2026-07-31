import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTier, TIER_PARAMS } from './tier';

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

// Round 3 (docs/known-risks.md item 50): TIER_PARAMS é cópia literal do Pine
// real do usuário (PineScript.jsx), não um valor calibrado à parte — este
// teste protege contra os dois arquivos divergirem silenciosamente. Lê
// PineScript.jsx como texto (mesmo padrão de goldenParity.test.js para os
// CSVs golden) em vez de importar o componente React.
describe('paridade com o Pine real do usuário (PineScript.jsx)', () => {
  const pineSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../pages/PineScript.jsx'),
    'utf8',
  );

  it('adxMinVal/chopMaxVal/atrStopMult por tier batem com os literais do Pine', () => {
    const adx = pineSource.match(/float adxMinVal\s*=\s*activeTier == 3 \? ([\d.]+) : activeTier == 2 \? ([\d.]+) : ([\d.]+)/);
    const chop = pineSource.match(/float chopMaxVal\s*=\s*activeTier == 3 \? ([\d.]+) : activeTier == 2 \? ([\d.]+) : ([\d.]+)/);
    const atr = pineSource.match(/float atrStopMult\s*=\s*activeTier == 3 \? ([\d.]+) : activeTier == 2 \? ([\d.]+) : ([\d.]+)/);
    expect(adx).not.toBeNull();
    expect(chop).not.toBeNull();
    expect(atr).not.toBeNull();

    expect(Number(adx[3])).toBe(TIER_PARAMS.T1.adxMinVal);
    expect(Number(adx[2])).toBe(TIER_PARAMS.T2.adxMinVal);
    expect(Number(adx[1])).toBe(TIER_PARAMS.T3.adxMinVal);

    expect(Number(chop[3])).toBe(TIER_PARAMS.T1.chopMaxVal);
    expect(Number(chop[2])).toBe(TIER_PARAMS.T2.chopMaxVal);
    expect(Number(chop[1])).toBe(TIER_PARAMS.T3.chopMaxVal);

    expect(Number(atr[3])).toBe(TIER_PARAMS.T1.atrStopMult);
    expect(Number(atr[2])).toBe(TIER_PARAMS.T2.atrStopMult);
    expect(Number(atr[1])).toBe(TIER_PARAMS.T3.atrStopMult);
  });

  it('timeStopT1/T2/T3 defaults batem com TIER_PARAMS.*.timeStopBars', () => {
    const t1 = pineSource.match(/timeStopT1\s*= input\.int\((\d+),/);
    const t2 = pineSource.match(/timeStopT2\s*= input\.int\((\d+),/);
    const t3 = pineSource.match(/timeStopT3\s*= input\.int\((\d+),/);
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(t3).not.toBeNull();

    expect(Number(t1[1])).toBe(TIER_PARAMS.T1.timeStopBars);
    expect(Number(t2[1])).toBe(TIER_PARAMS.T2.timeStopBars);
    expect(Number(t3[1])).toBe(TIER_PARAMS.T3.timeStopBars);
  });

  it('tier2Threshold/tier3Threshold (limiares de classificação) batem com os defaults do Pine', () => {
    const t2 = pineSource.match(/tier2Threshold = input\.float\(([\d.]+),/);
    const t3 = pineSource.match(/tier3Threshold = input\.float\(([\d.]+),/);
    expect(t2).not.toBeNull();
    expect(t3).not.toBeNull();

    // Defaults usados em todo o motor quando pineConfig não sobrescreve
    // (scanner.js: `pineConfig.tier2Threshold ?? 0.8`, `?? 1.5`).
    expect(Number(t2[1])).toBe(0.8);
    expect(Number(t3[1])).toBe(1.5);
  });
});
