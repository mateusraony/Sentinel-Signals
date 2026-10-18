// docs/known-risks.md item 281 — o pré-registro (docs/experiments/targets-prereg.json)
// e as regras do código (structuralTargets.js) não podem divergir: o JSON é o
// que foi registrado antes de qualquer rodada; o código é o que roda.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TARGET_RULES } from './indicators/structuralTargets.js';

const prereg = JSON.parse(readFileSync(new URL('../../docs/experiments/targets-prereg.json', import.meta.url), 'utf-8'));

describe('pré-registro do teste dos alvos (item 281)', () => {
  it('as regras do JSON são as do código', () => {
    expect(prereg.rules).toEqual({
      minTargetR: TARGET_RULES.minTargetR,
      fibLadder: [...TARGET_RULES.fibLadder],
      swingPivotBars: TARGET_RULES.swingPivotBars,
      swingLookback4h: TARGET_RULES.swingLookback4h,
      tp2FallbackMult: TARGET_RULES.tp2FallbackMult,
    });
  });

  it('6 braços = 2 modos estruturais × 3 políticas; família de 6 com Bonferroni', () => {
    const combos = prereg.arms.map((a) => `${a.targetMode}/${a.targetNearPolicy}`).sort();
    const expected = TARGET_RULES.modes.filter((m) => m !== 'r_multiple')
      .flatMap((m) => TARGET_RULES.nearPolicies.map((p) => `${m}/${p}`)).sort();
    expect(combos).toEqual(expected);
    expect(prereg.analysis.familySize).toBe(prereg.arms.length);
    expect(prereg.analysis.alphaPerComparison).toBeCloseTo(0.05 / 6, 6);
    expect(prereg.control).toEqual({ targetMode: 'r_multiple' });
  });

  it('janelas: W1/W2 decidem (7 símbolos), W0 replica fora do período já usado no motor', () => {
    expect(prereg.windows.map((w) => [w.label, w.role, w.from, w.to])).toEqual([
      ['W1', 'decide', '2025-10-10', '2026-10-10'],
      ['W2', 'decide', '2024-07-27', '2025-07-27'],
      ['W0', 'replicate', '2021-07-27', '2022-07-27'],
    ]);
    expect(prereg.windows[0].symbols).toHaveLength(7);
    expect(prereg.windows[2].symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'FETUSDT', 'PAXGUSDT']);
  });
});
