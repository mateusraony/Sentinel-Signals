// docs/known-risks.md item 263 — comparador controle × variante. Relatórios
// sintéticos com valores calculados à mão; o caso real (teste0910206 ×
// teste0910206-fix: 115 casadas, 6 diferentes, ΔR −0,0154) foi conferido no
// CLI, fora do teste (os relatórios não ficam no repositório).
import { describe, it, expect } from 'vitest';
import {
  parseSymbolsFromTrialArgs,
  checkComparable,
  mergeClusterings,
  pairedComparison,
  unpairedComparison,
  compareReports,
  formatComparisonMarkdown,
} from './compareBacktestReports.mjs';
import { bonferroniZ } from './backtest-trial-registry.mjs';
import { mulberry32 } from './backtest-correlation-check.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const SYMBOLS = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'];

// Operação i: aberta no dia 2i, fechada no dia 2i+1 — nenhuma sobreposição
// entre operações, então cada uma é um cluster próprio (G = n).
function op(i, r, { symbol = SYMBOLS[i % SYMBOLS.length], closeDay = 2 * i + 1, status = 'STOP_HIT', id = `op${i}` } = {}) {
  return {
    r,
    op: {
      id, symbol, status,
      created_date: new Date(T0 + 2 * i * DAY).toISOString(),
      closed_at: new Date(T0 + closeDay * DAY).toISOString(),
    },
  };
}

function report(curve, { label = 'x', commit = 'a'.repeat(40), symbols = SYMBOLS, valid = true, fromMs = T0, toMs = T0 + 400 * DAY } = {}) {
  return {
    trialLabel: label,
    trialArgs: `--symbols ${symbols.join(',')} --from x --to y --trial-label ${label}`,
    range: { fromMs, toMs },
    dataIntegrity: { valid },
    reproducibility: { commitSha: commit },
    overall: { curve, expectancyR: null, winRate: 50, profitFactor: 1 },
    equityCurve: { riskPct: 1, maxDrawdownPct: 3, totalReturnPct: -1 },
  };
}

const opts = { iterations: 200, rand: mulberry32(7) };

describe('parseSymbolsFromTrialArgs', () => {
  it('lê --symbols ordenado; sem a flag devolve null', () => {
    expect(parseSymbolsFromTrialArgs('--from x --symbols ETHUSDT,BTCUSDT --out y')).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(parseSymbolsFromTrialArgs('--from x')).toBeNull();
    expect(parseSymbolsFromTrialArgs(undefined)).toBeNull();
  });
});

describe('mergeClusterings', () => {
  it('junta índices ligados em QUALQUER um dos particionamentos', () => {
    const merged = mergeClusterings(4, [[0, 1], [2], [3]], [[0], [1, 2], [3]]);
    expect(merged.map((c) => [...c].sort()).sort()).toEqual([[0, 1, 2], [3]]);
  });
});

describe('pairedComparison', () => {
  it('pareado exato: 1 de 4 operações muda −0,5R → ΔR médio −0,125, SE em cluster 0,125 (à mão)', () => {
    const control = report([op(0, -1), op(1, 0.5), op(2, 1), op(3, -1)]);
    const variant = report([op(0, -1), op(1, 0), op(2, 1), op(3, -1)]);
    const p = pairedComparison(control, variant, opts);
    expect(p).toMatchObject({ matched: 4, identical: 3, changed: 1, onlyControl: 0, onlyVariant: 0, coversAllOps: true, g: 4, clusterCountLow: true });
    expect(p.meanDeltaR).toBeCloseTo(-0.125, 12);
    // Resíduos (0,125; −0,375; 0,125; 0,125), soma dos quadrados 0,1875,
    // CR1 = (4/3)·0,1875/16 = 0,015625 → SE 0,125.
    expect(p.clusteredSE).toBeCloseTo(0.125, 12);
    expect(p.verdict).toBe('indistinguivel_do_ruido');
    expect(p.changedSamples).toEqual([expect.objectContaining({ id: 'op1', controlR: 0.5, variantR: 0, deltaR: -0.5 })]);
  });

  it('clusters vêm dos DOIS braços: operações que só se sobrepõem na variante ficam no mesmo cluster', () => {
    const control = report([op(0, -1), op(1, 1), op(2, -1)]);
    // Na variante a op0 dura até o dia 3 e passa a coexistir com a op1 (abre no dia 2).
    const variant = report([op(0, -1, { closeDay: 3 }), op(1, 1), op(2, -1)]);
    expect(pairedComparison(control, variant, opts).g).toBe(2);
    expect(pairedComparison(control, control, opts).g).toBe(3);
  });

  it('diferença consistente com G ≥ 20 → significativa; a mesma com G < 20 → inconclusiva', () => {
    const many = (n, shift) => Array.from({ length: n }, (_, i) => op(i, (i % 2 ? 1 : -1) + shift + (i % 3) * 0.001));
    const big = pairedComparison(report(many(24, 0)), report(many(24, -0.1)), opts);
    expect(big.g).toBe(24);
    expect(big.verdict).toBe('diferenca_significativa');
    const small = pairedComparison(report(many(6, 0)), report(many(6, -0.1)), opts);
    expect(small.ci[1]).toBeLessThan(0);
    expect(small.verdict).toBe('inconclusivo_poucos_clusters');
  });
});

describe('unpairedComparison', () => {
  it('z = Δ / √(SE₁² + SE₂²) com o z de Bonferroni da família', () => {
    const control = report([op(0, -1), op(1, 1), op(2, -1), op(3, 1)]);
    const variant = report([op(0, -1), op(1, 2), op(2, -1), op(3, 1)]);
    const u = unpairedComparison(control, variant, { familySize: 3 });
    expect(u.deltaR).toBeCloseTo(0.25, 12);
    expect(u.seDiff).toBeCloseTo(Math.sqrt(u.control.clusteredSE ** 2 + u.variant.clusteredSE ** 2), 12);
    expect(u.z).toBeCloseTo(u.deltaR / u.seDiff, 12);
    expect(u.zCritical).toBeCloseTo(bonferroniZ(3), 12);
    expect(u.control).toMatchObject({ n: 4, g: 4, equityMaxDrawdownPct: 3, equityRiskPct: 1 });
  });
});

describe('compareReports — recusas', () => {
  const base = [op(0, -1), op(1, 1)];

  it('relatório com dataIntegrity inválida', () => {
    const r = compareReports(report(base), report(base, { valid: false }), opts);
    expect(r.comparable).toBe(false);
    expect(r.errors.join(' ')).toMatch(/variante: dataIntegrity\.valid/);
  });

  it('janelas diferentes', () => {
    const r = compareReports(report(base), report(base, { toMs: T0 + 401 * DAY }), opts);
    expect(r.errors.join(' ')).toMatch(/janelas diferentes/);
  });

  it('símbolos diferentes', () => {
    const r = compareReports(report(base), report(base, { symbols: ['AAAUSDT'] }), opts);
    expect(r.errors.join(' ')).toMatch(/símbolos diferentes/);
  });

  it('commits diferentes: recusa por padrão, aceita com allowCommitMismatch (como aviso)', () => {
    const variant = report(base, { commit: 'b'.repeat(40) });
    expect(compareReports(report(base), variant, opts).comparable).toBe(false);
    const allowed = compareReports(report(base), variant, { ...opts, allowCommitMismatch: true });
    expect(allowed.comparable).toBe(true);
    expect(allowed.warnings.join(' ')).toMatch(/commits diferentes/);
  });

  it('op.id ausente ou duplicado', () => {
    expect(compareReports(report([op(0, 1), op(1, 1, { id: 'op0' })]), report(base), opts).errors.join(' ')).toMatch(/duplicado/);
    expect(compareReports(report([op(0, 1, { id: '' })]), report(base), opts).errors.join(' ')).toMatch(/sem op\.id/);
  });

  it('familySize inválido lança', () => {
    expect(() => compareReports(report(base), report(base), { familySize: 0 })).toThrow(RangeError);
  });

  it('o texto da recusa não traz número nenhum de resultado', () => {
    const md = formatComparisonMarkdown(compareReports(report(base), report(base, { valid: false }), opts));
    expect(md).toMatch(/Comparação recusada/);
    expect(md).not.toMatch(/ΔR médio/);
  });
});

describe('compareReports — braços com operações diferentes', () => {
  it('avisa que o pareado cobre só as casadas e mantém o não pareado sobre todas', () => {
    const control = report([op(0, -1), op(1, 1), op(2, -1)]);
    const variant = report([op(0, -1), op(1, 1), op(3, 2)]);
    const r = compareReports(control, variant, opts);
    expect(r.comparable).toBe(true);
    expect(r.paired).toMatchObject({ matched: 2, onlyControl: 1, onlyVariant: 1, coversAllOps: false });
    expect(r.warnings.join(' ')).toMatch(/leitura principal é a NÃO pareada/);
    expect(r.unpaired.control.n).toBe(3);
    expect(r.unpaired.variant.n).toBe(3);
    expect(r.unpaired.deltaR).toBeCloseTo(2 / 3 - -1 / 3, 12);
    const md = formatComparisonMarkdown(r);
    expect(md).toMatch(/Casadas: 2/);
    expect(md).toMatch(/Não pareado/);
  });
});
