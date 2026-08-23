#!/usr/bin/env node
// Diagnóstico de correlação entre operações de símbolos diferentes num
// relatório de backtest — docs/known-risks.md item 96 (a checagem original
// era um artefato; esta é a versão desenhada corretamente, com pesquisa de
// comunidade: Cameron & Miller para erro-padrão em cluster, e a literatura
// de "overlapping returns" de Richardson & Smith 1991 / Lo & MacKinlay 1988
// como o análogo direto deste problema).
//
// Pergunta que isto responde: TODO IC95 já calculado neste projeto trata
// cada operação como amostra independente. Ativos cripto compartilham beta
// forte com BTC — se operações de símbolos diferentes que estiveram abertas
// ao mesmo tempo tendem a se mover juntas, o N "efetivo" por trás de cada IC
// é menor que o N nominal, e os intervalos são mais estreitos do que
// deveriam. Este script mede isso, sem mudar nenhum IC95 já publicado —
// puramente diagnóstico, não toca backtestEngine.js/pineConfig.
//
// Método (2 componentes complementares):
//   1. Erro-padrão em cluster (Cameron-Miller CR1), com clusters definidos
//      como componentes conectados do grafo de sobreposição temporal entre
//      operações de símbolos DIFERENTES (não por dia — duração de operação é
//      variável, um balde de calendário fatiaria uma operação longa de forma
//      arbitrária; sobreposição real é o que a literatura de "overlapping
//      returns" usa). `assetActiveOps` garante 1 operação ativa por ativo,
//      então todo cluster é necessariamente entre símbolos diferentes.
//   2. Teste de permutação por deslocamento circular por símbolo: desloca a
//      série inteira de cada símbolo por um offset aleatório (preserva
//      100% do comportamento real do símbolo — duração, taxa de acerto,
//      cadência — só quebra o alinhamento de calendário entre símbolos).
//      Serve de validação cruzada do método 1, que sozinho é pouco confiável
//      com poucos clusters (regra prática da literatura: G < ~20).
//
// Limitação deliberada: o IC em cluster usa z=1,96 (não t-Student), mesma
// convenção do resto do projeto (Bonferroni em backtest-trial-registry.mjs
// também usa z) — com G baixo isso pode subestimar a incerteza levemente
// a mais; por isso G é sempre reportado e sinalizado quando baixo, e o
// teste de permutação (que não depende de G para ser válido) é a validação
// primária nesse regime.
//
// Uso:
//   node scripts/backtest-correlation-check.mjs --report <path> [--iterations N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// PRNG seedável (mulberry32) — sem dependência nova, mesmo espírito do
// Acklam em backtest-trial-registry.mjs. Só usado para o teste de
// permutação; determinístico quando um seed é passado (testes).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Extrai {symbol, open, close, r} de report.overall.curve. `overall.curve`
// só contém operações FECHADAS (stillOpenAtCutoff fica de fora), então
// created_date/closed_at estão sempre presentes — confirmado contra 3
// relatórios reais antes de escrever isto.
export function buildTradeIntervals(curve) {
  return curve
    .filter((c) => typeof c.r === 'number' && c.op?.created_date && c.op?.closed_at)
    .map((c) => ({
      symbol: c.op.symbol,
      open: new Date(c.op.created_date).getTime(),
      close: new Date(c.op.closed_at).getTime(),
      r: c.r,
    }));
}

function intervalsOverlap(a, b) {
  return a.open < b.close && b.open < a.close;
}

// Componentes conectados do grafo de sobreposição (union-find), restrito a
// arestas entre símbolos DIFERENTES — duas operações do MESMO símbolo nunca
// coexistem (invariante `assetActiveOps`), então essa restrição nunca
// exclui nada na prática; é só para deixar a intenção explícita.
export function findOverlapClusters(intervals) {
  const n = intervals.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(x, y) { const rx = find(x); const ry = find(y); if (rx !== ry) parent[rx] = ry; }

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (intervals[i].symbol === intervals[j].symbol) continue;
      if (intervalsOverlap(intervals[i], intervals[j])) union(i, j);
    }
  }

  const clusters = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }
  return [...clusters.values()];
}

// Erro-padrão em cluster (Cameron-Miller CR1) para a média simples de
// `values`, dado um particionamento em `clusters` (arrays de índices).
// Reduz exatamente à fórmula padrão (s/sqrt(n)) quando todo cluster tem
// tamanho 1 — conferido em backtest-correlation-check.test.mjs.
export function clusterRobustStdErr(values, clusters) {
  const n = values.length;
  const g = clusters.length;
  // Com G=1, a soma de TODOS os resíduos é zero por construção (resíduo =
  // valor - média) — a fórmula CR1 sempre daria SE=0, implicando certeza
  // perfeita, o oposto do que "1 cluster só" deveria significar. Não dá
  // pra estimar variância com 1 cluster — devolve null (indefinido) em vez
  // de um zero enganoso, mesma convenção de "sample_too_small" do resto do
  // projeto (nunca finge confiança que não existe).
  if (n < 2 || g < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const residuals = values.map((v) => v - mean);
  const clusterSumsSq = clusters.reduce((acc, cluster) => {
    const sum = cluster.reduce((a, idx) => a + residuals[idx], 0);
    return acc + sum * sum;
  }, 0);
  const dfCorrection = g / (g - 1);
  const variance = (dfCorrection * clusterSumsSq) / (n * n);
  return Math.sqrt(variance);
}

export function naiveStdErr(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance / n);
}

// Valor crítico bicaudal (alpha=0.05) da t-Student para `df` graus de
// liberdade — expansão de Cornish-Fisher a partir do quantil normal (Fisher
// & Cornish 1960; mesma família de aproximação racional do Acklam já usada
// em backtest-trial-registry.mjs, sem depender de função gama/beta
// incompleta). Existe porque o item 103 (docs/known-risks.md) usou z=1,96
// pra "significativo" com G=24 clusters e uma review externa (Codex, PR
// #208) pegou que a referência certa pra erro-padrão em cluster com G baixo
// é t(G-1), não normal — t(23)=2,069 > z=1,96, e isso muda o veredito
// (|t| medido = 2,005 fica ABAIXO do crítico certo). Testada contra valores
// tabelados conhecidos (df=5,10,23,30) em
// backtest-correlation-check.test.mjs; erro cresce em df muito baixo (a
// expansão é assintótica) — por isso `studentTCriticalUnreliable` sinaliza
// df<10, mesmo espírito do `clusterCountLow` (G<20) já existente.
export function studentTCritical95(df) {
  if (!Number.isInteger(df) || df < 1) {
    throw new RangeError(`studentTCritical95: df deve ser inteiro >= 1, recebeu ${df}`);
  }
  const z = 1.959963984540054; // inverseNormalCDF(0.975) -- mesma constante usada no resto do arquivo
  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  const z7 = z5 * z2;
  const z9 = z7 * z2;
  const g1 = (z3 + z) / 4;
  const g2 = (5 * z5 + 16 * z3 + 3 * z) / 96;
  const g3 = (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384;
  const g4 = (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / 92160;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3 + g4 / df ** 4;
}

export function designEffect(naiveSE, clusteredSE) {
  if (!naiveSE || !clusteredSE) return null;
  return (clusteredSE / naiveSE) ** 2;
}

export function effectiveN(n, deff) {
  if (!deff) return n;
  return n / deff;
}

// Desloca circularmente a série de cada símbolo por um offset aleatório
// dentro de [0, rangeMs) — preserva o espaçamento/duração/resultado
// internos de cada símbolo, randomiza o alinhamento de calendário entre
// símbolos diferentes. `fromMs`/`toMs` vêm de report.range.
export function circularShiftBySymbol(intervals, fromMs, toMs, rand) {
  const rangeMs = toMs - fromMs;
  const offsetBySymbol = new Map();
  for (const iv of intervals) {
    if (!offsetBySymbol.has(iv.symbol)) offsetBySymbol.set(iv.symbol, rand() * rangeMs);
  }
  return intervals.map((iv) => {
    const offset = offsetBySymbol.get(iv.symbol);
    const shift = (t) => fromMs + (((t - fromMs + offset) % rangeMs) + rangeMs) % rangeMs;
    return { ...iv, open: shift(iv.open), close: shift(iv.close) };
  });
}

// Estatística-alvo do teste de permutação: DEFF real vs. distribuição nula
// de DEFF sob deslocamento circular (preserva tudo de cada símbolo, exceto
// o alinhamento de calendário com os demais). p-valor = fração de réplicas
// nulas com DEFF >= DEFF real — testa "o DEFF medido excede o que só o
// artefato de duração/seleção já produziria por acaso?".
export function permutationTest(intervals, fromMs, toMs, { iterations = 1000, rand = Math.random } = {}) {
  const values = intervals.map((iv) => iv.r);
  const naiveSE = naiveStdErr(values);
  const realClusters = findOverlapClusters(intervals);
  const realClusteredSE = clusterRobustStdErr(values, realClusters);
  const realDeff = designEffect(naiveSE, realClusteredSE) ?? 1;

  const nullDeffs = [];
  for (let i = 0; i < iterations; i += 1) {
    const shifted = circularShiftBySymbol(intervals, fromMs, toMs, rand);
    const clusters = findOverlapClusters(shifted);
    const clusteredSE = clusterRobustStdErr(values, clusters);
    nullDeffs.push(designEffect(naiveSE, clusteredSE) ?? 1);
  }
  nullDeffs.sort((a, b) => a - b);
  const pValue = nullDeffs.filter((d) => d >= realDeff).length / iterations;
  const pct = (p) => nullDeffs[Math.min(iterations - 1, Math.floor(p * iterations))];

  return {
    realDeff,
    nullMean: nullDeffs.reduce((a, b) => a + b, 0) / iterations,
    nullP5: pct(0.05),
    nullP95: pct(0.95),
    pValue,
  };
}

// Teste de randomização pro EFEITO em si (a média de `values`), não pro
// DEFF — lacuna real que `permutationTest` acima não cobre (aquele testa
// só se a estrutura de correlação medida é distinguível de artefato de
// calendário; não tem H0 sobre a média). Achado do Codex, PR #210: usar
// o p-valor de `permutationTest` como se validasse (ou invalidasse) a
// significância do efeito pareado é um erro de categoria — os dois testes
// respondem perguntas diferentes.
//
// Sob H0 ("sem efeito real"), o SINAL da contribuição de cada cluster pra
// média é permutável — inverte o sinal de TODOS os valores de um cluster
// JUNTOS (preserva a correlação intra-cluster, único jeito de não violar
// a independência assumida entre clusters), sorteia um padrão de sinais
// por cluster (Rademacher: cada cluster vira +1 ou -1), recomputa a média
// sob esse padrão, repete. Com G<=exhaustiveMaxG dá pra enumerar TODOS os
// 2^G padrões (G=20 → ~1M, ainda rápido) — p-valor EXATO, não aproximado
// por amostragem; G maior cai pra Monte Carlo com `iterations` sorteios.
// Válido pra QUALQUER G>=2 (ao contrário do erro-padrão em cluster/CR1,
// que degrada com G baixo) — é o método certo pra confirmar ou refutar
// significância quando G é baixo demais pra confiar em CR1 (ex.: G=8,
// item 104/docs/known-risks.md).
export function clusterSignFlipTest(values, clusters, { iterations = 5000, rand = Math.random, exhaustiveMaxG = 20 } = {}) {
  const g = clusters.length;
  const n = values.length;
  if (g < 2 || n < 2) return null;
  const clusterSums = clusters.map((idxs) => idxs.reduce((acc, i) => acc + values[i], 0));
  const observedMean = values.reduce((a, b) => a + b, 0) / n;
  const meanForSigns = (signs) => {
    let sum = 0;
    for (let c = 0; c < g; c += 1) sum += signs[c] * clusterSums[c];
    return sum / n;
  };

  const exhaustive = g <= exhaustiveMaxG;
  let nullMeans;
  if (exhaustive) {
    const total = 2 ** g;
    nullMeans = new Array(total);
    for (let mask = 0; mask < total; mask += 1) {
      const signs = new Array(g);
      for (let c = 0; c < g; c += 1) signs[c] = ((mask >> c) & 1) ? 1 : -1;
      nullMeans[mask] = meanForSigns(signs);
    }
  } else {
    nullMeans = new Array(iterations);
    for (let it = 0; it < iterations; it += 1) {
      const signs = new Array(g);
      for (let c = 0; c < g; c += 1) signs[c] = rand() < 0.5 ? -1 : 1;
      nullMeans[it] = meanForSigns(signs);
    }
  }

  const eps = 1e-9;
  const countGEQ = nullMeans.filter((m) => Math.abs(m) >= Math.abs(observedMean) - eps).length;
  const pValue = countGEQ / nullMeans.length;

  return { observedMean, pValue, exhaustive, replicates: nullMeans.length, g };
}

export function analyzeReport(report, { iterations = 1000, rand = Math.random } = {}) {
  const intervals = buildTradeIntervals(report.overall.curve);
  const n = intervals.length;
  // Codex review, PR #239: com n<2 (gate de amostra/regime cortou o run
  // inteiro, ou um trial-only-config sem nenhuma operação fechável) todo
  // cálculo abaixo degenera em números que PARECEM válidos sem ser --
  // avgClusterSize vira NaN (0/0), e permutationTest usa `?? 1` como
  // fallback pra SE indefinido dos dois lados (real e nulo), então
  // DEFF=1/p-valor=1.0000 sai IDÊNTICO ao de um DEFF nulo genuíno, sem
  // nenhum jeito de distinguir os dois casos no resultado. Mesmo padrão de
  // honestidade que summarizeOps já usa (INCONCLUSIVO em vez de exibir
  // métricas de aparência normal sobre amostra insuficiente) -- curto-
  // circuita ANTES de qualquer cálculo, em vez de deixar cada função pura
  // decidir sozinha o que fazer com um array vazio/unitário.
  if (n < 2) {
    return { trialLabel: report.trialLabel ?? null, n, insufficientData: true };
  }
  const values = intervals.map((iv) => iv.r);
  const clusters = findOverlapClusters(intervals);
  const g = clusters.length;
  const naiveSE = naiveStdErr(values);
  const clusteredSE = clusterRobustStdErr(values, clusters);
  const deff = designEffect(naiveSE, clusteredSE);
  const nEff = effectiveN(n, deff);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const Z95 = 1.959963984540054;
  const naiveCI = naiveSE ? [mean - Z95 * naiveSE, mean + Z95 * naiveSE] : null;
  const clusteredCI = clusteredSE ? [mean - Z95 * clusteredSE, mean + Z95 * clusteredSE] : null;
  // Referência certa pra erro-padrão em CLUSTER (não pro i.i.d. ingênuo, que
  // não tem "graus de liberdade de cluster"): t(G-1), sempre mais
  // conservadora que z=1,96 -- diferença pequena com G alto, mas decisiva
  // perto do limiar de significância com G baixo (ver comentário de
  // studentTCritical95 acima).
  const clusteredTCritical = g >= 2 ? studentTCritical95(g - 1) : null;
  const clusteredCIStudentT = (clusteredSE && clusteredTCritical)
    ? [mean - clusteredTCritical * clusteredSE, mean + clusteredTCritical * clusteredSE]
    : null;

  const fromMs = report.range?.fromMs;
  const toMs = report.range?.toMs;
  // Checagem explícita de tipo (não truthy) -- fromMs=0 é um epoch válido,
  // "0 && toMs" o trataria incorretamente como ausente.
  const hasRange = typeof fromMs === 'number' && typeof toMs === 'number';
  const permutation = hasRange
    ? permutationTest(intervals, fromMs, toMs, { iterations, rand })
    : null;
  // Teste do EFEITO em si (a média), não do DEFF -- ver comentário de
  // clusterSignFlipTest acima. Sempre computado quando g>=2, independente
  // de `hasRange` (não depende de circular-shift/calendário).
  const effectSignFlip = clusterSignFlipTest(values, clusters, { iterations, rand });

  return {
    trialLabel: report.trialLabel ?? null,
    n,
    g,
    avgClusterSize: n / g,
    clusterCountLow: g < 20,
    mean,
    naiveSE,
    naiveCI,
    clusteredSE,
    clusteredCI,
    clusteredTCritical,
    clusteredCIStudentT,
    deff,
    nEff,
    permutation,
    effectSignFlip,
  };
}

export function formatMarkdown(result) {
  if (result.insufficientData) {
    return [
      '',
      `## Correlação entre ativos — ${result.trialLabel ?? '(sem trial_label)'}`,
      '',
      `**Dados insuficientes** (N=${result.n} operações fechadas com R calculável, mínimo 2) — `
      + 'nenhuma estatística de correlação é calculável, não tente ler DEFF/p-valor de um relatório vazio ou de 1 operação.',
      '',
    ].join('\n');
  }
  const fmt = (v) => (v === null || v === undefined ? '—' : v.toFixed(4));
  const fmtCI = (ci) => (ci ? `[${fmt(ci[0])}, ${fmt(ci[1])}]` : '—');
  const lines = [
    '',
    `## Correlação entre ativos — ${result.trialLabel ?? '(sem trial_label)'}`,
    '',
    `N=${result.n}, clusters (G)=${result.g}, tamanho médio de cluster=${result.avgClusterSize.toFixed(2)}`
      + (result.clusterCountLow ? ' — **G baixo (<20), IC em cluster pouco confiável sozinho.**' : ''),
    '',
    '| Métrica | Ingênuo (i.i.d.) | Em cluster (Cameron-Miller CR1) |',
    '|---|---|---|',
    `| Erro-padrão | ${fmt(result.naiveSE)} | ${fmt(result.clusteredSE)} |`,
    `| IC95 (z=1,96) | ${fmtCI(result.naiveCI)} | ${fmtCI(result.clusteredCI)} |`,
    `| IC95 (t-Student, df=G-1=${result.g - 1}, crítico=${fmt(result.clusteredTCritical)}) | — | ${fmtCI(result.clusteredCIStudentT)} |`,
    '',
    '**Use a linha t-Student pra veredito de significância do erro em cluster** '
    + '(o t crítico é sempre >= z=1,96, mais conservador — decide o resultado '
    + 'perto do limiar quando G é baixo). A linha z=1,96 fica só pra comparação '
    + 'com o IC ingênuo, que não tem "graus de liberdade de cluster".',
    '',
    `DEFF (design effect) = ${fmt(result.deff)} — N efetivo = ${fmt(result.nEff)} (de N=${result.n} nominal)`,
    '',
  ];
  if (result.permutation) {
    const p = result.permutation;
    lines.push(
      `Teste de permutação da CORRELAÇÃO (deslocamento circular por símbolo, ${p ? '1000' : ''} réplicas) — `
      + `testa se o DEFF medido é real ou artefato de calendário, NÃO testa o efeito/média: `
      + `DEFF real=${fmt(p.realDeff)} vs. nulo média=${fmt(p.nullMean)} `
      + `[p5=${fmt(p.nullP5)}, p95=${fmt(p.nullP95)}], p-valor=${p.pValue.toFixed(4)}`,
      '',
    );
  }
  if (result.effectSignFlip) {
    const s = result.effectSignFlip;
    lines.push(
      `Teste de randomização do EFEITO (sign-flip por cluster, ${s.exhaustive ? `exaustivo, 2^${s.g}=${s.replicates} combinações` : `${s.replicates} sorteios`}) — `
      + `este SIM testa se a média observada (${fmt(s.observedMean)}) é diferente de zero: `
      + `p-valor=${s.pValue.toFixed(4)}`,
      '',
    );
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.report) {
    console.error('Uso: node scripts/backtest-correlation-check.mjs --report <path> [--iterations N]');
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  const iterations = args.iterations ? Number(args.iterations) : 1000;
  const result = analyzeReport(report, { iterations });
  console.log(formatMarkdown(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
