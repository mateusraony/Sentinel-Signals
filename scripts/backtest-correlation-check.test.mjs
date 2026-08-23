import { describe, it, expect } from 'vitest';
import {
  mulberry32,
  buildTradeIntervals,
  findOverlapClusters,
  clusterRobustStdErr,
  naiveStdErr,
  designEffect,
  effectiveN,
  studentTCritical95,
  circularShiftBySymbol,
  permutationTest,
  clusterSignFlipTest,
  analyzeReport,
  formatMarkdown,
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

  // Codex review, PR #239: uma operação deslocada por circularShiftBySymbol
  // pode "vazar" pra depois de toMs (close > toMs) -- no círculo, ela
  // também ocupa [fromMs, close-rangeMs). Sem `rangeMs`, essa sobreposição
  // com uma operação perto do INÍCIO da janela é invisível.
  it('rangeMs opcional: sobreposição circular só é detectada quando passada', () => {
    // A "vaza" 20ms além de toMs=1000 (representa [970,1000) U [0,20) no
    // círculo); B fica perto do início (10-20) -- só se sobrepõem se o
    // vazamento de A for considerado.
    const intervals = [
      { symbol: 'A', open: 970, close: 1020 },
      { symbol: 'B', open: 10, close: 20 },
    ];
    expect(findOverlapClusters(intervals)).toHaveLength(2); // sem rangeMs: não enxerga o vazamento
    const circular = findOverlapClusters(intervals, 1000);
    expect(circular).toHaveLength(1); // com rangeMs: A e B se sobrepõem via o vazamento
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

  // Codex review, PR #239 (6ª rodada): quando os resíduos DENTRO de cada
  // cluster se cancelam exatamente (soma=0 em todo cluster), a fórmula CR1
  // dá SE=0 de verdade -- um valor ESTIMÁVEL (real, ainda que degenerado),
  // diferente do G=1 acima (onde SE=0 é sempre falso, por construção da
  // fórmula). designEffect precisa distinguir esse 0 real de um null.
  it('resíduos que se cancelam em todo cluster dão SE=0 real (não confundir com G=1)', () => {
    // valores: [1,-1,2,-2], média=0, resíduos=[1,-1,2,-2]
    // clusters [[0,1],[2,3]]: soma por cluster = [0, 0] -- cancela em cada um
    const values = [1, -1, 2, -2];
    const clusters = [[0, 1], [2, 3]];
    expect(clusterRobustStdErr(values, clusters)).toBe(0);
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

  // Codex review, PR #239 (6ª rodada): erro-padrão em cluster LEGITIMAMENTE
  // zero (resíduos de cada cluster somam exatamente zero) é um DEFF
  // estimável (0), não "faltando" -- a checagem antiga (`!clusteredSE`)
  // confundia os dois e devolvia null, que os chamadores fabricavam como 1.
  it('clusteredSE==0 é um DEFF real (0), não null/ausente', () => {
    expect(designEffect(0.1, 0)).toBe(0);
  });

  it('naiveSE==0 (todos os R idênticos) continua null -- divisão por zero genuína', () => {
    expect(designEffect(0, 0.1)).toBeNull();
    expect(designEffect(0, 0)).toBeNull();
  });

  it('null/undefined em qualquer lado continua null', () => {
    expect(designEffect(null, 0.1)).toBeNull();
    expect(designEffect(0.1, null)).toBeNull();
  });
});

describe('studentTCritical95', () => {
  it('bate com valores tabelados conhecidos (df=2,3,4,5,10,23,30)', () => {
    // Tabela t bicaudal, alpha=0.05 -- valores padrão de qualquer livro-texto.
    expect(studentTCritical95(2)).toBeCloseTo(4.303, 1); // maior erro da expansão fora de df=1, ~0.03
    expect(studentTCritical95(3)).toBeCloseTo(3.182, 2);
    expect(studentTCritical95(4)).toBeCloseTo(2.776, 2);
    expect(studentTCritical95(5)).toBeCloseTo(2.571, 2);
    expect(studentTCritical95(10)).toBeCloseTo(2.228, 2);
    expect(studentTCritical95(23)).toBeCloseTo(2.069, 2); // item 103, docs/known-risks.md
    expect(studentTCritical95(30)).toBeCloseTo(2.042, 2);
  });

  // Codex review, PR #239 (5ª rodada): a expansão de Cornish-Fisher é
  // assintótica e diverge de verdade só em df=1 (~11,30 vs o exato 12,706,
  // erro que já muda veredito perto da borda) -- G=2 clusters (o mínimo
  // não-trivial de erro-padrão em cluster) não é caso exótico. df=1 usa o
  // fechamento exato de Cauchy(0,1) em vez da expansão; df>=2 já bate com
  // a tabela acima com folga.
  it('df=1 usa o valor EXATO de Cauchy(0,1), não a aproximação assintótica', () => {
    expect(studentTCritical95(1)).toBeCloseTo(12.706, 3);
  });

  it('converge para z=1,96 conforme df cresce (t-Student -> normal)', () => {
    expect(studentTCritical95(1000)).toBeCloseTo(1.9623, 2);
  });

  it('é sempre >= z=1,96 (mais conservador que a normal em amostra finita)', () => {
    for (const df of [1, 5, 10, 23, 30, 100]) {
      expect(studentTCritical95(df)).toBeGreaterThanOrEqual(1.959963984540054);
    }
  });

  it('rejeita df não inteiro ou < 1', () => {
    expect(() => studentTCritical95(0)).toThrow(RangeError);
    expect(() => studentTCritical95(-1)).toThrow(RangeError);
    expect(() => studentTCritical95(2.5)).toThrow(RangeError);
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

  it('mantém open dentro do range [fromMs, toMs) mesmo perto do limite', () => {
    const intervals = [{ symbol: 'A', open: 500, close: 900, r: 0.1 }];
    const rand = () => 0.999999;
    const shifted = circularShiftBySymbol(intervals, 0, 1000, rand);
    expect(shifted[0].open).toBeGreaterThanOrEqual(0);
    expect(shifted[0].open).toBeLessThan(1000);
  });

  // Codex review, PR #239: a versão anterior dobrava `close` de forma
  // independente de `open`, podendo inverter (close < open) quando só um
  // dos dois cruzava toMs. `close` NUNCA é dobrado agora -- pode ultrapassar
  // toMs (vazamento pro início, ver findOverlapClusters/rangeMs), mas nunca
  // fica menor que `open`.
  it('close nunca fica menor que open, mesmo quando a operação vaza além de toMs', () => {
    const intervals = [{ symbol: 'A', open: 0, close: 50, r: 0.1 }];
    const rand = () => 0.97; // offset=970 -- open desloca pra 970, close (970+50=1020) vaza além de toMs=1000
    const shifted = circularShiftBySymbol(intervals, 0, 1000, rand);
    expect(shifted[0].open).toBe(970);
    expect(shifted[0].close).toBe(1020);
    expect(shifted[0].close).toBeGreaterThan(shifted[0].open);
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
    // Codex review, PR #239: réplicas cuja réplica embaralhada colapsa pra
    // g<2 (DEFF não estimável NESSA réplica) são excluídas da distribuição
    // nula, não fabricadas como 1 -- nullReplicates pode ser <= iterations.
    expect(result.nullReplicates).toBeGreaterThan(0);
    expect(result.nullReplicates).toBeLessThanOrEqual(200);
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
    expect(result.nullReplicates).toBeGreaterThan(0);
    expect(result.nullReplicates).toBeLessThanOrEqual(50);
  });

  // Codex review, PR #239 (2ª rodada): com só 2 símbolos, uma réplica cujo
  // deslocamento aleatório faz A e B se sobreporem colapsa pra g=1 --
  // cenário NORMAL (não um caso patológico raro), não só um risco teórico.
  // clusterRobustStdErr devolve null pra essa réplica; o teste antigo
  // (sem o guard) fabricava DEFF=1 no lugar. Aqui só confere que o
  // resultado nunca finge mais réplicas do que as que sobreviveram.
  it('com poucos símbolos, réplicas que colapsam pra g=1 são excluídas (nullReplicates < iterations)', () => {
    const intervals = [
      { symbol: 'A', open: 0, close: 200, r: 0.3 },
      { symbol: 'B', open: 5000, close: 5200, r: -0.2 },
    ];
    const rand = mulberry32(42);
    const result = permutationTest(intervals, 0, 6000, { iterations: 300, rand });
    expect(result.nullReplicates).toBeGreaterThan(0);
    expect(result.nullReplicates).toBeLessThan(300);
    expect(result.pValue).toBeGreaterThanOrEqual(0);
    expect(result.pValue).toBeLessThanOrEqual(1);
  });

  // Codex review, PR #239 (4ª rodada): com correlação real muito forte,
  // NENHUMA réplica embaralhada alcança o DEFF real -- p-valor "de verdade"
  // seria 0, mas um Monte Carlo finito nunca pode afirmar isso (a menor
  // probabilidade distinguível de zero com N réplicas é ~1/N). A correção
  // (excedências+1)/(N+1) garante que o p-valor NUNCA seja exatamente 0.
  it('correção de amostra finita: p-valor nunca é exatamente 0 mesmo quando nenhuma réplica alcança o DEFF real', () => {
    const intervals = [];
    for (let i = 0; i < 10; i += 1) {
      const base = i * 1000;
      const r = i % 2 === 0 ? 1 : -1;
      intervals.push({ symbol: `SYM${i}_A`, open: base, close: base + 100, r });
      intervals.push({ symbol: `SYM${i}_B`, open: base + 10, close: base + 110, r });
    }
    const rand = mulberry32(7);
    const result = permutationTest(intervals, 0, 10000, { iterations: 100, rand });
    // Confirmado por execução real: com este seed, 0 das 100 réplicas
    // alcançam o DEFF real (2.11) -- sem a correção, pValue seria 0.0000.
    expect(result.pValue).toBeCloseTo(1 / 101, 10);
  });
});

describe('clusterSignFlipTest', () => {
  it('valor exato: 4 clusters singleton com valor +1 cada -- só 2 de 16 padrões de sinal alcançam |média|=1 (p=0,125)', () => {
    // Caso calculado à mão: values=[1,1,1,1], clusters=[[0],[1],[2],[3]].
    // meanForSigns = soma(signs)/4. Só o padrão "tudo +1" (média=1) e
    // "tudo -1" (média=-1) alcançam |média|>=1 -- 2 de 2^4=16 combinações.
    const values = [1, 1, 1, 1];
    const clusters = [[0], [1], [2], [3]];
    const result = clusterSignFlipTest(values, clusters);
    expect(result.exhaustive).toBe(true);
    expect(result.replicates).toBe(16);
    expect(result.observedMean).toBeCloseTo(1, 10);
    expect(result.pValue).toBeCloseTo(2 / 16, 10);
  });

  it('sem efeito real (valores com sinais alternados somando ~zero por cluster), p-valor alto', () => {
    // 4 clusters, cada um com 2 valores que se cancelam -- média observada
    // pequena, deve estar bem dentro do miolo da distribuição nula.
    const values = [1, -0.9, 1, -1.1, 1, -0.95, 1, -1.05];
    const clusters = [[0, 1], [2, 3], [4, 5], [6, 7]];
    const result = clusterSignFlipTest(values, clusters);
    expect(result.pValue).toBeGreaterThan(0.3);
  });

  it('efeito forte e consistente em todos os clusters: p-valor baixo', () => {
    // 10 clusters, todos fortemente positivos e do mesmo tamanho -- muito
    // pouco espaço pra um padrão de sinal aleatório alcançar a mesma
    // magnitude da média observada.
    const values = Array.from({ length: 20 }, () => 1);
    const clusters = Array.from({ length: 10 }, (_, i) => [i * 2, i * 2 + 1]);
    const result = clusterSignFlipTest(values, clusters, { iterations: 5000, rand: mulberry32(7) });
    expect(result.pValue).toBeLessThan(0.05);
  });

  it('G<2 devolve null (não dá pra permutar sinal de 1 cluster só)', () => {
    expect(clusterSignFlipTest([1, 2], [[0, 1]])).toBeNull();
  });

  it('cai pra Monte Carlo (não exaustivo) quando G > exhaustiveMaxG', () => {
    const g = 25;
    const values = Array.from({ length: g }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const clusters = Array.from({ length: g }, (_, i) => [i]);
    const result = clusterSignFlipTest(values, clusters, { iterations: 300, rand: mulberry32(2), exhaustiveMaxG: 20 });
    expect(result.exhaustive).toBe(false);
    expect(result.replicates).toBe(300);
  });

  it('é determinístico com o mesmo seed (Monte Carlo)', () => {
    const g = 25;
    const values = Array.from({ length: g }, () => 1);
    const clusters = Array.from({ length: g }, (_, i) => [i]);
    const a = clusterSignFlipTest(values, clusters, { iterations: 200, rand: mulberry32(99), exhaustiveMaxG: 20 });
    const b = clusterSignFlipTest(values, clusters, { iterations: 200, rand: mulberry32(99), exhaustiveMaxG: 20 });
    expect(a.pValue).toBe(b.pValue);
  });

  // Codex review, PR #239 (4ª rodada): mesma correção de amostra finita de
  // permutationTest, aplicada ao ramo Monte Carlo daqui -- o ramo exaustivo
  // (teste acima, "valor exato") já é preciso por construção e continua
  // SEM a correção (ela deixaria o resultado exato errado).
  it('correção de amostra finita no ramo Monte Carlo: p-valor nunca é exatamente 0', () => {
    const g = 25;
    const values = Array.from({ length: g }, () => 1);
    const clusters = Array.from({ length: g }, (_, i) => [i]);
    const result = clusterSignFlipTest(values, clusters, { iterations: 200, rand: mulberry32(99), exhaustiveMaxG: 20 });
    // Confirmado por execução real: com este seed, 0 das 200 réplicas
    // alcançam |média|=1 -- sem a correção, pValue seria 0.0000.
    expect(result.pValue).toBeCloseTo(1 / 201, 10);
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
    // t(df=1) exato é 12,706 (Cauchy(0,1) -- ver studentTCritical95, PR
    // #239 5ª rodada); G=2 é o caso mínimo não-trivial pra erro-padrão em
    // cluster, não uma escolha arbitrária deste teste sintético.
    expect(result.clusteredTCritical).toBeCloseTo(12.706, 2);
    expect(result.clusteredCIStudentT).not.toBeNull();
    // IC t-Student sempre >= largo que o IC em cluster com z=1,96 (mesmo SE, crítico maior)
    const zWidth = result.clusteredCI[1] - result.clusteredCI[0];
    const tWidth = result.clusteredCIStudentT[1] - result.clusteredCIStudentT[0];
    expect(tWidth).toBeGreaterThan(zWidth);
    // G=2 é exaustivo (2^2=4 combinações de sinal).
    expect(result.effectSignFlip).not.toBeNull();
    expect(result.effectSignFlip.exhaustive).toBe(true);
    expect(result.effectSignFlip.replicates).toBe(4);
  });

  // Codex review, PR #239: com n<2 as fórmulas degeneram em números que
  // PARECEM válidos (avgClusterSize=NaN, DEFF=1/p-valor=1.0000 idênticos ao
  // fallback `?? 1` de um DEFF nulo genuíno) em vez de sinalizar amostra
  // insuficiente -- ver o guard em analyzeReport.
  it('n=0 (curve vazia) devolve insufficientData em vez de estatística inventada', () => {
    const report = { trialLabel: 'empty-test', range: { fromMs: 0, toMs: 10000 }, overall: { curve: [] } };
    const result = analyzeReport(report, { iterations: 50, rand: mulberry32(9) });
    expect(result).toEqual({ trialLabel: 'empty-test', n: 0, insufficientData: true });
    expect(formatMarkdown(result)).toContain('Dados insuficientes');
  });

  it('n=1 (uma única operação fechada) também devolve insufficientData', () => {
    const report = {
      trialLabel: 'single-trade-test',
      range: { fromMs: 0, toMs: 10000 },
      overall: {
        curve: [
          { r: 0.5, op: { symbol: 'BTCUSDT', created_date: new Date(0).toISOString(), closed_at: new Date(1000).toISOString() } },
        ],
      },
    };
    const result = analyzeReport(report, { iterations: 50, rand: mulberry32(9) });
    expect(result).toEqual({ trialLabel: 'single-trade-test', n: 1, insufficientData: true });
  });

  // Codex review, PR #239, 2ª rodada: g=1 (n>=2 mas só 1 cluster -- as 2
  // operações, de símbolos diferentes, se sobrepõem no tempo) não tem
  // variância ENTRE clusters pra estimar, mas sem o gate abaixo
  // permutationTest ainda calculava um "DEFF real=1.0000, p-valor=1.0000"
  // (o mesmo fallback `?? 1` do teste de n<2 acima, só que disparado
  // dentro de permutationTest em vez de analyzeReport).
  it('g=1 (só um cluster) não roda o teste de permutação (DEFF não seria estimável)', () => {
    const report = {
      trialLabel: 'single-cluster-test',
      range: { fromMs: 0, toMs: 10000 },
      overall: {
        curve: [
          { r: 0.5, op: { symbol: 'BTCUSDT', created_date: new Date(0).toISOString(), closed_at: new Date(2000).toISOString() } },
          { r: -0.2, op: { symbol: 'ETHUSDT', created_date: new Date(1000).toISOString(), closed_at: new Date(3000).toISOString() } },
        ],
      },
    };
    const result = analyzeReport(report, { iterations: 50, rand: mulberry32(9) });
    expect(result.n).toBe(2);
    expect(result.g).toBe(1);
    expect(result.clusteredSE).toBeNull();
    expect(result.permutation).toBeNull();
  });
});
