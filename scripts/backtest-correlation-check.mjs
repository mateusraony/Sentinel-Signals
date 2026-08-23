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

// Codex review, PR #239: uma réplica de `circularShiftBySymbol` pode
// "atravessar" o limite [fromMs, toMs) -- uma operação cujo `close`
// deslocado ultrapassa `toMs` continua, no círculo, ocupando também
// [fromMs, close-rangeMs). `intervalsOverlap` sozinho não enxerga essa
// continuação (compara só a posição linear canônica), perdendo
// sobreposições reais com operações perto do início da janela. Ladrilha a
// posição de `b` em {-rangeMs, 0, +rangeMs} antes de comparar -- como a
// duração de qualquer operação é sempre << rangeMs (a janela do replay
// inteiro), 1 período pra cada lado basta (mesmo argumento do "1 vizinho de
// cada lado" usado em problemas de intervalo circular). `rangeMs` ausente
// preserva o comportamento linear de sempre (usado pelas intervals REAIS,
// nunca deslocadas, onde não existe fronteira circular pra atravessar).
function intervalsOverlapCircular(a, b, rangeMs) {
  if (rangeMs == null) return intervalsOverlap(a, b);
  for (const delta of [0, -rangeMs, rangeMs]) {
    if (a.open < b.close + delta && (b.open + delta) < a.close) return true;
  }
  return false;
}

// Componentes conectados do grafo de sobreposição (union-find), restrito a
// arestas entre símbolos DIFERENTES — duas operações do MESMO símbolo nunca
// coexistem (invariante `assetActiveOps`), então essa restrição nunca
// exclui nada na prática; é só para deixar a intenção explícita.
// `rangeMs` opcional (ver `intervalsOverlapCircular` acima) — só o
// deslocamento circular de `circularShiftBySymbol` precisa dele.
export function findOverlapClusters(intervals, rangeMs = null) {
  const n = intervals.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(x, y) { const rx = find(x); const ry = find(y); if (rx !== ry) parent[rx] = ry; }

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (intervals[i].symbol === intervals[j].symbol) continue;
      if (intervalsOverlapCircular(intervals[i], intervals[j], rangeMs)) union(i, j);
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

// Log-gama via aproximação de Lanczos (g=7, coeficientes padrão da
// literatura -- precisão de ponto-flutuante double em todo o domínio
// positivo, reflexão de Euler pra x<0.5). Única dependência de
// incompleteBeta abaixo; sem depender de nenhuma lib externa.
function logGamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xm1 = x - 1;
  let a = c[0];
  const t = xm1 + g + 0.5;
  for (let i = 1; i < g + 2; i += 1) a += c[i] / (xm1 + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm1 + 0.5) * Math.log(t) - t + Math.log(a);
}

// Fração contínua de Lentz pra função beta incompleta (Numerical Recipes
// 6.4) -- converge rápido pra x < (a+1)/(a+b+2) (o chamador garante isso
// escolhendo o lado certo da simetria I_x(a,b) = 1 - I_(1-x)(b,a)).
function betaContinuedFraction(x, a, b) {
  const MAX_ITER = 200;
  const EPS = 3e-16;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

// Função beta incompleta regularizada I_x(a,b), 0<=x<=1, a,b>0.
function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(logBt);
  if (x < (a + 1) / (a + b + 2)) return (bt * betaContinuedFraction(x, a, b)) / a;
  return 1 - (bt * betaContinuedFraction(1 - x, b, a)) / b;
}

// Valor crítico bicaudal (alpha=0.05) da t-Student para `df` graus de
// liberdade, EXATO (a menos de erro de ponto-flutuante) para qualquer df,
// via a relação padrão entre a CDF de t e a função beta incompleta
// regularizada: para t>0, F(t) = 1 - 1/2·I_x(df/2, 1/2), x = df/(df+t²).
// Achar t tal que F(t)=0,975 equivale a achar x tal que I_x(df/2,1/2)=0,05
// (busca binária monotônica -- I_x é estritamente crescente em x), depois
// t = √(df·(1-x)/x).
//
// Substitui a expansão de Cornish-Fisher usada antes (assintótica, nunca
// exatamente certa pra nenhum df finito): a review externa (Codex, PR
// #239) encontrou o mesmo padrão de erro em df=1 (5ª rodada, ~11,30 vs o
// exato 12,706), depois em df=2 (8ª rodada, ~4,2706 vs 4,3027) e depois em
// df=3 (10ª rodada, ~3,1786 vs 3,1824) -- cada rodada resolvia UM df, mas
// o próximo df sempre teria o mesmo problema em menor grau, porque a
// aproximação nunca CONVERGE pro valor exato em df finito nenhum. A
// fórmula fechada acima fecha a classe inteira do achado de uma vez, não
// mais um df por rodada. Testada contra valores tabelados conhecidos
// (df=1,2,3,4,5,10,23,30) e contra a convergência pra z=1,96 quando
// df→∞ em backtest-correlation-check.test.mjs.
export function studentTCritical95(df) {
  if (!Number.isInteger(df) || df < 1) {
    throw new RangeError(`studentTCritical95: df deve ser inteiro >= 1, recebeu ${df}`);
  }
  const a = df / 2;
  const b = 0.5;
  const target = 0.05;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(mid, a, b) < target) lo = mid; else hi = mid;
  }
  const x = (lo + hi) / 2;
  return Math.sqrt((df * (1 - x)) / x);
}

// Codex review, PR #239 (6ª rodada): `!clusteredSE`/`!naiveSE` (checagem de
// truthy) trata um erro-padrão em cluster LEGITIMAMENTE zero (os resíduos
// de cada cluster somam exatamente zero -- raro, mas real, não "faltando")
// como se fosse ausente, devolvendo `null` -- que os chamadores (`realDeff
// = designEffect(...) ?? 1`) então fabricavam como DEFF=1. `clusteredSE`
// zero É um DEFF estimável (0, sem inflação nenhuma detectada) -- só
// `naiveSE` zero é genuinamente indefinido (todos os R idênticos, divisão
// por zero). Checagem trocada para `== null` (nullish), que `0` não aciona.
export function designEffect(naiveSE, clusteredSE) {
  if (naiveSE == null || clusteredSE == null || naiveSE === 0) return null;
  return (clusteredSE / naiveSE) ** 2;
}

// Codex review, PR #239 (7ª rodada): mesma distinção null-vs-zero de
// designEffect -- deff=0 (real, cluster sem NENHUMA inflação de variância
// detectada) não é "ausente". `n/0` é matematicamente Infinity (N efetivo
// infinito é a leitura correta de DEFF zero), não o N nominal -- devolver o
// nominal escondia o cancelamento degenerado atrás de um número comum.
export function effectiveN(n, deff) {
  if (deff == null) return n;
  if (deff === 0) return Infinity;
  return n / deff;
}

// Desloca circularmente a série de cada símbolo por um offset aleatório
// dentro de [0, rangeMs) — preserva o espaçamento/duração/resultado
// internos de cada símbolo, randomiza o alinhamento de calendário entre
// símbolos diferentes. `fromMs`/`toMs` vêm de report.range.
//
// Codex review, PR #239: a versão anterior deslocava `open` E `close`
// independentemente, cada um com seu próprio wrap-around — uma operação
// cujo `close` cruzasse `toMs` podia sair com `close` NUMERICAMENTE MENOR
// que `open` (o close "deu a volta" pro início, o open não). Isso quebra a
// invariante open<close que `intervalsOverlapCircular` (acima) assume, e
// silenciosamente faz essa operação nunca sobrepor nada. Corrigido: só
// `open` é dobrado pra dentro de [fromMs, toMs); `close` é sempre
// `open + duração`, deliberadamente SEM dobrar — pode ultrapassar `toMs`
// (representando o "vaza pro início" na volta do círculo), mas nunca
// inverte em relação ao próprio `open`. `intervalsOverlapCircular` é quem
// sabe ladrilhar esse excesso contra as outras operações.
export function circularShiftBySymbol(intervals, fromMs, toMs, rand) {
  const rangeMs = toMs - fromMs;
  const offsetBySymbol = new Map();
  for (const iv of intervals) {
    if (!offsetBySymbol.has(iv.symbol)) offsetBySymbol.set(iv.symbol, rand() * rangeMs);
  }
  return intervals.map((iv) => {
    const offset = offsetBySymbol.get(iv.symbol);
    const open = fromMs + (((iv.open - fromMs + offset) % rangeMs) + rangeMs) % rangeMs;
    return { ...iv, open, close: open + (iv.close - iv.open) };
  });
}

// Estatística-alvo do teste de permutação: DEFF real vs. distribuição nula
// de DEFF sob deslocamento circular (preserva tudo de cada símbolo, exceto
// o alinhamento de calendário com os demais). p-valor = fração de réplicas
// nulas com DEFF >= DEFF real — testa "o DEFF medido excede o que só o
// artefato de duração/seleção já produziria por acaso?".
export function permutationTest(intervals, fromMs, toMs, { iterations = 1000, rand = Math.random } = {}) {
  const rangeMs = toMs - fromMs;
  const values = intervals.map((iv) => iv.r);
  const naiveSE = naiveStdErr(values);
  // Sem `rangeMs`: as intervals REAIS nunca são deslocadas, não há
  // fronteira circular pra atravessar (ver intervalsOverlapCircular acima).
  const realClusters = findOverlapClusters(intervals);
  const realClusteredSE = clusterRobustStdErr(values, realClusters);
  const realDeff = designEffect(naiveSE, realClusteredSE);
  // Codex review, PR #239 (9ª rodada): com naiveSE==0 (todos os R FECHADOS
  // idênticos — ex.: um trial degenerado onde toda operação bate o mesmo
  // stop) o DEFF do dado OBSERVADO já é indefinido por definição (0/0) —
  // `designEffect` devolve null corretamente, mas o `?? 1` de antes
  // fabricava realDeff=1 mesmo com g>=2 observado genuíno. Como g>=2 já é
  // garantido pelo chamador (analyzeReport só chama isto com g>=2), o
  // ÚNICO jeito de realDeff sair null aqui é naiveSE==0 — sai cedo, ANTES
  // de rodar qualquer réplica (nenhuma delas mudaria essa conclusão: a
  // mesma naiveSE==0 vale pra toda réplica, já que os valores de R não
  // mudam, só o alinhamento de calendário).
  if (realDeff === null) {
    return { realDeff: null, nullMean: null, nullP5: null, nullP95: null, pValue: null, nullReplicates: 0 };
  }

  // Codex review, PR #239 (2ª rodada): mesmo com a observação real tendo
  // G>=2, uma réplica individual do deslocamento circular pode colapsar
  // pra 1 cluster só (ex.: o deslocamento aleatório empilha todas as
  // operações num mesmo bloco de sobreposição) — `clusteredSE` sai `null`
  // pra ESSA réplica, e empurrar `?? 1` no lugar contaminava a
  // distribuição nula com um valor fabricado (o mesmo raciocínio do gate
  // de n<2/g<2 em analyzeReport, um nível mais fundo). Réplicas
  // indefinidas são EXCLUÍDAS da distribuição nula (nunca substituídas por
  // um valor-sentinela) — denominadores usam `nullDeffs.length` (as
  // réplicas que sobraram), não `iterations` (o nominal).
  const nullDeffs = [];
  for (let i = 0; i < iterations; i += 1) {
    const shifted = circularShiftBySymbol(intervals, fromMs, toMs, rand);
    const clusters = findOverlapClusters(shifted, rangeMs);
    const clusteredSE = clusterRobustStdErr(values, clusters);
    const deff = designEffect(naiveSE, clusteredSE);
    if (deff !== null) nullDeffs.push(deff);
  }
  if (nullDeffs.length === 0) {
    return { realDeff, nullMean: null, nullP5: null, nullP95: null, pValue: null, nullReplicates: 0 };
  }
  nullDeffs.sort((a, b) => a - b);
  // Codex review, PR #239 (4ª rodada): um p-valor de Monte Carlo com 0
  // excedências não é zero de verdade -- com N réplicas finitas, a menor
  // probabilidade que o método consegue distinguir de zero é ~1/N. A
  // correção padrão de amostra finita (Davison & Hinkley 1997, North et
  // al. 2002 -- a mesma usada por implementações de permutation test como
  // coin/scikit-learn) é (excedências+1)/(N+1): nunca deixa reportar
  // p=0.0000 (confiança perfeita que nenhuma simulação finita entrega) e
  // converge pro p-valor exato quando N→∞.
  const pValue = (nullDeffs.filter((d) => d >= realDeff).length + 1) / (nullDeffs.length + 1);
  const pct = (p) => nullDeffs[Math.min(nullDeffs.length - 1, Math.floor(p * nullDeffs.length))];

  return {
    realDeff,
    nullMean: nullDeffs.reduce((a, b) => a + b, 0) / nullDeffs.length,
    nullP5: pct(0.05),
    nullP95: pct(0.95),
    pValue,
    nullReplicates: nullDeffs.length,
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
  // Correção de amostra finita (mesmo raciocínio de permutationTest acima)
  // só se aplica ao ramo Monte Carlo -- o exaustivo (2^g <= exhaustiveMaxG)
  // enumera TODOS os padrões de sinal possíveis, então seu p-valor já é
  // exato, não uma estimativa amostrada; "corrigi-lo" o deixaria errado.
  const pValue = exhaustive
    ? countGEQ / nullMeans.length
    : (countGEQ + 1) / (nullMeans.length + 1);

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
  // Codex review, PR #239 (7ª rodada): checagem de truthy (`naiveSE ?`/
  // `clusteredSE ?`) tratava um erro-padrão LEGITIMAMENTE zero como
  // ausente, devolvendo null em vez do IC de largura zero (correto: sem
  // incerteza detectada -> IC = [média, média], não "não calculável").
  const naiveCI = naiveSE != null ? [mean - Z95 * naiveSE, mean + Z95 * naiveSE] : null;
  const clusteredCI = clusteredSE != null ? [mean - Z95 * clusteredSE, mean + Z95 * clusteredSE] : null;
  // Referência certa pra erro-padrão em CLUSTER (não pro i.i.d. ingênuo, que
  // não tem "graus de liberdade de cluster"): t(G-1), sempre mais
  // conservadora que z=1,96 -- diferença pequena com G alto, mas decisiva
  // perto do limiar de significância com G baixo (ver comentário de
  // studentTCritical95 acima).
  const clusteredTCritical = g >= 2 ? studentTCritical95(g - 1) : null;
  const clusteredCIStudentT = (clusteredSE != null && clusteredTCritical != null)
    ? [mean - clusteredTCritical * clusteredSE, mean + clusteredTCritical * clusteredSE]
    : null;

  const fromMs = report.range?.fromMs;
  const toMs = report.range?.toMs;
  // Checagem explícita de tipo (não truthy) -- fromMs=0 é um epoch válido,
  // "0 && toMs" o trataria incorretamente como ausente.
  const hasRange = typeof fromMs === 'number' && typeof toMs === 'number';
  // Codex review, PR #239: com g<2 não existe variância ENTRE clusters pra
  // estimar (mesma razão de clusterRobustStdErr devolver null, e de
  // clusteredTCritical/effectSignFlip já serem gateados por g>=2 acima) --
  // sem esse gate aqui, permutationTest's `?? 1` (fallback do DEFF real
  // indefinido) e do DEFF nulo de cada réplica embaralhada convergiam pro
  // MESMO valor 1, produzindo um "DEFF real=1.0000, p-valor=1.0000" que
  // parece uma medição válida de "sem correlação detectada" sem ser.
  const permutation = (hasRange && g >= 2)
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
    if (p.realDeff === null) {
      // Codex review, PR #239 (9ª rodada): naiveSE==0 (todos os R FECHADOS
      // idênticos) -- o DEFF do dado OBSERVADO já é indefinido (0/0), não
      // "as réplicas colapsaram" (mensagem de baixo, causa raiz diferente).
      lines.push(
        'Teste de permutação da CORRELAÇÃO — DEFF não é computável para este relatório '
        + '(todas as operações fechadas têm o mesmo R — variância zero pra clustering explicar).',
        '',
      );
    } else if (p.pValue === null) {
      lines.push(
        'Teste de permutação da CORRELAÇÃO — todas as réplicas de deslocamento circular colapsaram '
        + 'pra 1 cluster só (DEFF não estimável em nenhuma) — sem base pra distribuição nula.',
        '',
      );
    } else {
      lines.push(
        `Teste de permutação da CORRELAÇÃO (deslocamento circular por símbolo, ${p.nullReplicates} réplicas válidas) — `
        + `testa se o DEFF medido é real ou artefato de calendário, NÃO testa o efeito/média: `
        + `DEFF real=${fmt(p.realDeff)} vs. nulo média=${fmt(p.nullMean)} `
        + `[p5=${fmt(p.nullP5)}, p95=${fmt(p.nullP95)}], p-valor=${fmt(p.pValue)}`,
        '',
      );
    }
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
    console.error('Uso: node scripts/backtest-correlation-check.mjs --report <path> [--iterations N] [--seed N]');
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  const iterations = args.iterations ? Number(args.iterations) : 1000;
  // Codex review, PR #239: sem seed fixo, o teste de permutação/sign-flip
  // (Math.random() puro) dava um resultado DIFERENTE a cada rodada sobre o
  // MESMO relatório -- inofensivo enquanto era rodado sob demanda, mas
  // agora que backtest.yml publica isso como evidência de experimento em
  // TODO trial, o mesmo dado precisa reproduzir a mesma conclusão.
  // `--seed` reproduz uma rodada específica; sem ele, gera um seed novo e
  // IMPRIME (auditável mesmo sem fixar) -- fixar um valor único pra sempre
  // enviesaria o teste a uma única realização particular do embaralhamento.
  const seed = args.seed ? Number(args.seed) : (Date.now() >>> 0);
  const rand = mulberry32(seed);
  const result = analyzeReport(report, { iterations, rand });
  console.log(`Seed (\`--seed ${seed}\` reproduz esta rodada exata): ${seed}`);
  console.log(formatMarkdown(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
