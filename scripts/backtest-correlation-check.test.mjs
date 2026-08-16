import { describe, it, expect } from 'vitest';
import {
  mulberry32,
  buildTradeIntervals,
  findOverlapClusters,
  clusterRobustStdErr,
  naiveStdErr,
  designEffect,
  effectiveN,
  circularShiftBySymbol,
  permutationTest,
  analyzeReport,
} from './backtest-correlation-check.mjs';

describe('mulberry32', () => {
  it('é determinístico para o mesmo seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });

  it('produz valores em [0,1)', () => {
    const rand = mulberry32(1);
    for (let i = 0; i < 100; i += 1) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('buildTradeIntervals', () => {
  it('extrai symbol/open/close/r de overall.curve', () => {
    const curve = [
      { r: 0.5, op: { symbol: 'BTCUSDT', created_date: '2026-01-01T00:00:00Z', closed_at: '2026-01-02T00:00:00Z' } },
      { r: -1, op: { symbol: 'ETHUSDT', created_date: '2026-01-03T00:00:00Z', closed_at: '2026-01-04T00:00:00Z' } },
    ];
    const intervals = buildTradeIntervals(curve);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toMatchObject({ symbol: 'BTCUSDT', r: 0.5 });
    expect(intervals[0].close).toBeGreaterThan(intervals[0].open);
  });

  it('exclui operações sem r numérico ou sem timestamps (ainda abertas no corte)', () => {
    const curve = [
      { r: 0.5, op: { symbol: 'BTCUSDT', created_date: '2026-01-01T00:00:00Z', closed_at: '2026-01-02T00:00:00Z' } },
      { r: null, op: { symbol: 'ETHUSDT', created_date: '2026-01-03T00:00:00Z' } },
    ];
    expect(buildTradeIntervals(curve)).toHaveLength(1);
  });
});

describe('findOverlapClusters', () => {
  it('operações sem sobreposição viram clusters singleton', () => {
    const intervals = [
      { symbol: 'A', open: 0, close: 10 },
      { symbol: 'B', open: 20, close: 30 },
      { symbol: 'C', open: 40, close: 50 },
    ];
    const clusters = findOverlapClusters(intervals);
    expect(clusters).toHaveLength(3);
    expect(clusters.every((c) => c.length === 1)).toBe(true);
  });

  it('duas operações de símbolos diferentes que se sobrepõem viram 1 cluster', () => {
    const intervals = [
      { symbol: 'A', open: 0, close: 10 },
      { symbol: 'B', open: 5, close: 15 },
    ];
    const clusters = findOverlapClusters(intervals);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual([0, 1]);
  });

  it('transitividade: A-B se sobrepõem, B-C se sobrepõem, A-C não — ainda assim 1 cluster só', () => {
    const intervals = [
      { symbol: 'A', open: 0, close: 10 },
      { symbol: 'B', open: 5, close: 20 },
      { symbol: 'C', open: 15, close: 25 },
    ];
    const clusters = findOverlapClusters(intervals);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('mesmo símbolo sobreposto NUNCA existe na prática, mas não seria unido mesmo que existisse', () => {
    const intervals = [
      { symbol: 'A', open: 0, close: 10 },
      { symbol: 'A', open: 5, close: 15 },
    ];
    const clusters = findOverlapClusters(intervals);
    expect(clusters).toHaveLength(2);
  });

  it('dois componentes desconexos ficam separados', () => {
    const intervals = [
      { symbol: 'A', open: 0, close: 10 },
      { symbol: 'B', open: 5, close: 15 },
      { symbol: 'C', open: 100, close: 110 },
      { symbol: 'D', open: 105, close: 120 },
    ];
    const clusters = findOverlapClusters(intervals).map((c) => c.slice().sort());
    expect(clusters).toHaveLength(2);
    expect(clusters).toContainEqual([0, 1]);
    expect(clusters).toContainEqual([2, 3]);
  });
});

describe('naiveStdErr / clusterRobustStdErr', () => {
  it('com todo cluster de tamanho 1, o erro-padrão em cluster reduz ao erro-padrão ingênuo (s/sqrt(n))', () => {
    const values = [1, 2, 3, 4, 5, -1, -2, 0.5];
    const singletonClusters = values.map((_, i) => [i]);
    const naive = naiveStdErr(values);
    const clustered = clusterRobustStdErr(values, singletonClusters);
    expect(clustered).toBeCloseTo(naive, 10);
  });

  it('com G=1 (um único cluster) a fórmula é indefinida (soma de resíduos é sempre zero) — devolve null, nunca 0', () => {
    // Um cluster só implica SE=0 na fórmula CR1 pura (falsa certeza perfeita)
    // -- devolve null explicitamente em vez de fingir confiança que não
    // existe, mesma convenção de sample_too_small do resto do projeto.
    const values = [1, 1, 1, -1, -1, -1];
    const oneCluster = [[0, 1, 2, 3, 4, 5]];
    expect(clusterRobustStdErr(values, oneCluster)).toBeNull();
  });

  it('exemplo à mão: 2 clusters de tamanho 2, valores conhecidos, mais largo que o erro-padrão ingênuo', () => {
    // valores: [2, 2, -2, -2], média=0, resíduos=[2,2,-2,-2]
    // clusters [[0,1],[2,3]]: soma por cluster = [4, -4], soma dos quadrados = 32
    // G=2, correção G/(G-1)=2, N=4 -> var = 2*32/16 = 4 -> SE = 2
    const values = [2, 2, -2, -2];
    const clusters = [[0, 1], [2, 3]];
    const clustered = clusterRobustStdErr(values, clusters);
    expect(clustered).toBeCloseTo(2, 10);
    expect(clustered).toBeGreaterThan(naiveStdErr(values));
  });

  it('retorna null com menos de 2 valores', () => {
    expect(naiveStdErr([1])).toBeNull();
    expect(clusterRobustStdErr([1], [[0]])).toBeNull();
  });
});

describe('designEffect / effectiveN', () => {
  it('DEFF=1 quando erro-padrão em cluster == ingênuo (sem correlação)', () => {
    expect(designEffect(0.1, 0.1)).toBeCloseTo(1, 10);
  });

  it('DEFF>1 quando cluster aumenta o erro-padrão, e N efetivo cai proporcionalmente', () => {
    const deff = designEffect(0.1, 0.2); // SE dobrou -> variância 4x -> DEFF=4
    expect(deff).toBeCloseTo(4, 10);
    expect(effectiveN(100, deff)).toBeCloseTo(25, 10);
  });

  it('effectiveN sem DEFF (null) devolve o N nominal', () => {
    expect(effectiveN(50, null)).toBe(50);
  });
});

describe('circularShiftBySymbol', () => {
  it('preserva a duração e o espaçamento relativo das operações de cada símbolo', () => {
    const intervals = [
      { symbol: 'A', open: 1000, close: 2000, r: 0.5 },
      { symbol: 'A', open: 3000, close: 3500, r: -0.3 },
    ];
    const rand = mulberry32(7);
    const shifted = circularShiftBySymbol(intervals, 0, 10000, rand);
    expect(shifted[0].close - shifted[0].open).toBeCloseTo(intervals[0].close - intervals[0].open, 6);
    expect(shifted[1].close - shifted[1].open).toBeCloseTo(intervals[1].close - intervals[1].open, 6);
    // mesmo offset aplicado às duas operações do símbolo A (mesmo espaçamento relativo, módulo wraparound)
    const gapOriginal = intervals[1].open - intervals[0].open;
    const gapShifted = (shifted[1].open - shifted[0].open + 10000) % 10000;
    expect(gapShifted).toBeCloseTo(((gapOriginal % 10000) + 10000) % 10000, 6);
  });

  it('mantém os timestamps dentro do range [fromMs, toMs)', () => {
    const intervals = [{ symbol: 'A', open: 500, close: 900, r: 0.1 }];
    const rand = () => 0.999999;
    const shifted = circularShiftBySymbol(intervals, 0, 1000, rand);
    expect(shifted[0].open).toBeGreaterThanOrEqual(0);
    expect(shifted[0].open).toBeLessThan(1000);
  });
});

describe('permutationTest', () => {
  it('com correlação real forte (clusters sempre no mesmo sinal, por construção), DEFF real excede a maioria do nulo', () => {
    // 6 pares de operações; dentro de cada par (símbolos diferentes), o R é IDÊNTICO e as janelas
    // sempre se sobrepõem nas mesmas posições relativas -- correlação real, não artefato de duração.
    const intervals = [];
    for (let i = 0; i < 6; i += 1) {
      const base = i * 1000;
      const r = i % 2 === 0 ? 1 : -1;
      intervals.push({ symbol: `SYM${i}_A`, open: base, close: base + 100, r });
      intervals.push({ symbol: `SYM${i}_B`, open: base + 10, close: base + 110, r });
    }
    const rand = mulberry32(123);
    const result = permutationTest(intervals, 0, 6000, { iterations: 200, rand });
    expect(result.realDeff).toBeGreaterThan(1);
    expect(result.pValue).toBeLessThan(0.2);
  });

  it('sem nenhuma sobreposição entre símbolos, DEFF real fica em 1 (sem clusters compostos)', () => {
    const intervals = [
      { symbol: 'A', open: 0, close: 10, r: 1 },
      { symbol: 'B', open: 1000, close: 1010, r: -1 },
      { symbol: 'C', open: 2000, close: 2010, r: 0.5 },
    ];
    const rand = mulberry32(1);
    const result = permutationTest(intervals, 0, 3000, { iterations: 50, rand });
    expect(result.realDeff).toBeCloseTo(1, 6);
  });
});

describe('analyzeReport', () => {
  it('roda de ponta a ponta num relatório sintético e devolve todos os campos', () => {
    const report = {
      trialLabel: 'synthetic-test',
      range: { fromMs: 0, toMs: 10000 },
      overall: {
        curve: [
          { r: 0.5, op: { symbol: 'BTCUSDT', created_date: new Date(0).toISOString(), closed_at: new Date(1000).toISOString() } },
          { r: -0.3, op: { symbol: 'ETHUSDT', created_date: new Date(500).toISOString(), closed_at: new Date(1500).toISOString() } },
          { r: 0.8, op: { symbol: 'SOLUSDT', created_date: new Date(5000).toISOString(), closed_at: new Date(6000).toISOString() } },
        ],
      },
    };
    const result = analyzeReport(report, { iterations: 50, rand: mulberry32(9) });
    expect(result.n).toBe(3);
    expect(result.g).toBe(2); // BTCUSDT+ETHUSDT se sobrepõem, SOLUSDT sozinho
    expect(result.naiveSE).not.toBeNull();
    expect(result.clusteredSE).not.toBeNull();
    expect(result.deff).not.toBeNull();
    // Com G=2 (poucos clusters), CR1 pode subestimar OU superestimar em
    // amostra pequena -- não é garantido nEff <= n aqui (ver item da
    // permutação abaixo pra por que G baixo não é confiável sozinho).
    expect(Number.isFinite(result.nEff)).toBe(true);
    expect(result.nEff).toBeGreaterThan(0);
    expect(result.permutation).not.toBeNull();
    expect(result.clusterCountLow).toBe(true); // G=2 < 20
  });
});
