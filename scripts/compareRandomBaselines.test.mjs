// docs/known-risks.md item 267 — comparação pareada por seed.
import { describe, it, expect } from 'vitest';
import { signTestP, compareRandomBaselines, formatComparisonMarkdown } from './compareRandomBaselines.mjs';

const summary = (values, { fib = false, commit = 'c'.repeat(40), from = '2025-10-10' } = {}) => ({
  comparable: true,
  fibEntry: fib,
  commitSha: commit,
  window: { from, to: '2026-10-10' },
  seeds: values.map((v, i) => ({ seed: i + 1, n: 30, expectancyR: v, grossExpectancyR: v + 0.05 })),
});

describe('signTestP — teste do sinal exato bicaudal (valores de tabela)', () => {
  it('casos conhecidos', () => {
    expect(signTestP(10, 10)).toBeCloseTo(2 / 1024, 12);
    expect(signTestP(5, 10)).toBe(1);
    expect(signTestP(0, 0)).toBe(1);
    // 30 de 40: p ≈ 0,00222
    expect(signTestP(30, 40)).toBeCloseTo(0.002221, 5);
  });
});

describe('compareRandomBaselines', () => {
  const base = Array.from({ length: 40 }, (_, i) => -0.1 + i * 0.005);

  it('Fibonacci melhor em quase todas as seeds → fib_melhor', () => {
    const r = compareRandomBaselines(summary(base), summary(base.map((v, i) => v + (i < 35 ? 0.1 : -0.1)), { fib: true }));
    expect(r.comparable).toBe(true);
    expect(r.net.fibBetter).toBe(35);
    expect(r.verdict).toBe('fib_melhor');
    expect(formatComparisonMarkdown(r)).toMatch(/foram melhores/);
  });

  it('metade melhor, metade pior → sem diferença', () => {
    const r = compareRandomBaselines(summary(base), summary(base.map((v, i) => v + (i % 2 ? 0.1 : -0.1)), { fib: true }));
    expect(r.verdict).toBe('sem_diferenca');
  });

  it('recusa ordem trocada, janela diferente, commit diferente e seeds diferentes', () => {
    expect(compareRandomBaselines(summary(base, { fib: true }), summary(base, { fib: true })).comparable).toBe(false);
    expect(compareRandomBaselines(summary(base), summary(base, { fib: true, from: '2024-07-27' })).comparable).toBe(false);
    expect(compareRandomBaselines(summary(base), summary(base, { fib: true, commit: 'd'.repeat(40) })).comparable).toBe(false);
    expect(compareRandomBaselines(summary(base), summary(base.slice(1), { fib: true })).comparable).toBe(false);
    expect(compareRandomBaselines({ comparable: false }, summary(base, { fib: true })).comparable).toBe(false);
  });
});
