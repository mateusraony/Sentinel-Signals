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

export function analyzeReport(report, { iterations = 1000, rand = Math.random } = {}) {
  const intervals = buildTradeIntervals(report.overall.curve);
  const n = intervals.length;
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

  const fromMs = report.range?.fromMs;
  const toMs = report.range?.toMs;
  // Checagem explícita de tipo (não truthy) -- fromMs=0 é um epoch válido,
  // "0 && toMs" o trataria incorretamente como ausente.
  const hasRange = typeof fromMs === 'number' && typeof toMs === 'number';
  const permutation = hasRange
    ? permutationTest(intervals, fromMs, toMs, { iterations, rand })
    : null;

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
    deff,
    nEff,
    permutation,
  };
}

export function formatMarkdown(result) {
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
    '',
    `DEFF (design effect) = ${fmt(result.deff)} — N efetivo = ${fmt(result.nEff)} (de N=${result.n} nominal)`,
    '',
  ];
  if (result.permutation) {
    const p = result.permutation;
    lines.push(
      `Teste de permutação (deslocamento circular por símbolo, ${p ? '1000' : ''} réplicas): `
      + `DEFF real=${fmt(p.realDeff)} vs. nulo média=${fmt(p.nullMean)} `
      + `[p5=${fmt(p.nullP5)}, p95=${fmt(p.nullP95)}], p-valor=${p.pValue.toFixed(4)}`,
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
