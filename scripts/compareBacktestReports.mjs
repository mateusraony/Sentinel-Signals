// Comparação de DOIS relatórios de backtest (controle × variante) —
// docs/known-risks.md item 263. Parte pura, sem trabalho no carregamento
// (lição do item 166); o CLI é scripts/compare-backtest-reports.mjs.
//
// Até aqui toda comparação entre runs (itens 103, 104, 115, 132) foi feita
// com script avulso, nunca commitado — cada rodada refazia a conta à mão.
// Este módulo versiona os dois métodos que já foram usados:
//
// 1. PAREADO (item 115): casa as operações dos dois runs pelo `op.id`
//    (determinístico: símbolo + timeframe + lado + cascata + candle do
//    sinal) e mede a diferença de R operação a operação. É o teste mais
//    forte quando a variante só muda COMO uma operação termina (ex.: a
//    saída por RF). Os clusters de sobreposição temporal vêm dos DOIS braços
//    (duas operações ficam no mesmo cluster se coexistiram em qualquer um
//    deles — a duração pode mudar com a variante), e o IC usa o erro-padrão
//    robusto a cluster com t(G−1).
// 2. NÃO PAREADO (item 132): quando a variante muda QUAIS operações existem
//    (ex.: desligar o trailing pré-TP1 libera o ativo em outro momento), o
//    pareado só cobre as casadas. Aí a comparação é entre as expectâncias de
//    cada braço. O erro-padrão da DIFERENÇA não supõe braços independentes
//    (review do Codex, PR #479: os dois braços dividem o calendário e a
//    covariância pode ter qualquer sinal — negativa quando um braço ocupa a
//    vaga do ativo em outro momento — e omitir −2Cov podia estreitar o IC).
//    Os clusters são CONJUNTOS: operações que coexistiram no tempo, em
//    qualquer braço, e a mesma operação nos dois braços caem no mesmo
//    cluster, e o CR1 da diferença das médias soma as contribuições dos dois
//    braços DENTRO de cada cluster — a covariância entra na conta.
//
// O que este módulo recusa (nunca compara "por cima"): relatório com
// `dataIntegrity.valid !== true`, janelas diferentes, símbolos diferentes,
// modelos de custo diferentes (cada `r` já é líquido do custo do próprio
// run), IDs de operação duplicados num mesmo relatório e — salvo
// `allowCommitMismatch` — commits diferentes (o motor mudou entre os runs, a
// diferença deixa de ser só a da variante).
import {
  buildTradeIntervals,
  findOverlapClusters,
  clusterRobustStdErr,
  naiveStdErr,
  studentTCritical95,
  clusterSignFlipTest,
} from './backtest-correlation-check.mjs';
import { bonferroniZ } from './backtest-trial-registry.mjs';

const EPS = 1e-12;
const MAX_CHANGED_SAMPLES = 10;
const MIN_RELIABLE_CLUSTERS = 20;

// `--symbols A,B,C` de `report.trialArgs` (a linha de comando gravada pelo
// próprio run-backtest.mjs). Ordenado para a comparação não depender da
// ordem digitada. null quando não dá para saber — nunca adivinha.
export function parseSymbolsFromTrialArgs(trialArgs) {
  if (typeof trialArgs !== 'string') return null;
  const m = trialArgs.match(/(?:^|\s)--symbols\s+(\S+)/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
}

export function checkComparable(control, variant, { allowCommitMismatch = false } = {}) {
  const errors = [];
  const warnings = [];
  for (const [name, rep] of [['controle', control], ['variante', variant]]) {
    if (!rep || typeof rep !== 'object' || !Array.isArray(rep.overall?.curve)) {
      errors.push(`${name}: não parece um backtest-report.json (sem overall.curve)`);
      continue;
    }
    if (rep.dataIntegrity?.valid !== true) {
      errors.push(`${name}: dataIntegrity.valid não é true — relatório inválido não entra em comparação`);
    }
  }
  if (errors.length) return { errors, warnings };

  const rc = control.range ?? {};
  const rv = variant.range ?? {};
  if (rc.fromMs !== rv.fromMs || rc.toMs !== rv.toMs) {
    errors.push(`janelas diferentes: controle ${rc.from ?? rc.fromMs} → ${rc.to ?? rc.toMs}, variante ${rv.from ?? rv.fromMs} → ${rv.to ?? rv.toMs}`);
  }

  const sc = parseSymbolsFromTrialArgs(control.trialArgs);
  const sv = parseSymbolsFromTrialArgs(variant.trialArgs);
  if (sc && sv) {
    if (sc.join(',') !== sv.join(',')) errors.push(`símbolos diferentes: controle ${sc.join(',')}, variante ${sv.join(',')}`);
  } else {
    warnings.push('lista de símbolos não verificável (trialArgs sem --symbols em pelo menos um relatório)');
  }

  // Review do Codex (PR #479): `r` de cada operação já vem LÍQUIDO do custo
  // escolhido naquele run (`--no-costs`, `--fee-bps`, `--real-funding`...).
  // Modelos diferentes fariam a diferença de custo aparecer como efeito da
  // variante.
  const mc = control.costs?.model;
  const mv = variant.costs?.model;
  if (!mc || !mv) {
    warnings.push('modelo de custo não verificável (costs.model ausente em pelo menos um relatório)');
  } else if (JSON.stringify(mc) !== JSON.stringify(mv)) {
    errors.push(`modelos de custo diferentes: controle ${JSON.stringify(mc)}, variante ${JSON.stringify(mv)}`);
  }

  const cc = control.reproducibility?.commitSha ?? null;
  const cv = variant.reproducibility?.commitSha ?? null;
  if (!cc || !cv) {
    warnings.push('commit não verificável (reproducibility.commitSha ausente em pelo menos um relatório)');
  } else if (cc !== cv) {
    const msg = `commits diferentes: controle ${cc.slice(0, 7)}, variante ${cv.slice(0, 7)} — o motor mudou entre os runs`;
    if (allowCommitMismatch) warnings.push(`${msg} (aceito por --allow-commit-mismatch)`);
    else errors.push(`${msg}; use --allow-commit-mismatch só se a mudança de código for exatamente o que está sendo comparado`);
  }

  for (const [name, rep] of [['controle', control], ['variante', variant]]) {
    const ids = rep.overall.curve.map((c) => c?.op?.id);
    if (ids.some((id) => !id)) errors.push(`${name}: operação sem op.id em overall.curve — não dá para parear`);
    else if (new Set(ids).size !== ids.length) errors.push(`${name}: op.id duplicado em overall.curve`);
  }
  return { errors, warnings };
}

// Entradas da curva com R numérico (as que entram na expectância).
function scoredEntries(report) {
  return report.overall.curve.filter((c) => typeof c?.r === 'number' && Number.isFinite(c.r));
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function sampleSd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// Clusters de sobreposição de UM braço, em índices do array `entries`. Uma
// entrada sem intervalo calculável (sem abertura/fechamento) vira cluster
// unitário — contada à parte em `withoutInterval`, nunca descartada (sumir
// com ela mudaria a média). `tagOf(i)` prefixa o símbolo: com entradas dos
// DOIS braços, o mesmo símbolo em braços diferentes precisa poder se ligar
// (`findOverlapClusters` só liga símbolos diferentes, porque dentro de um
// braço o mesmo ativo nunca tem duas operações ao mesmo tempo).
function clustersForEntries(entries, tagOf = () => '') {
  const idx = [];
  const intervals = [];
  entries.forEach((e, i) => {
    const iv = buildTradeIntervals([e])[0];
    if (iv) { idx.push(i); intervals.push({ ...iv, symbol: `${tagOf(i)}${iv.symbol}` }); }
  });
  const clusters = findOverlapClusters(intervals).map((c) => c.map((k) => idx[k]));
  const covered = new Set(idx);
  for (let i = 0; i < entries.length; i += 1) if (!covered.has(i)) clusters.push([i]);
  return { clusters, withoutInterval: entries.length - idx.length };
}

// União de particionamentos sobre os mesmos n índices: dois índices ficam
// juntos se estão juntos em QUALQUER um deles (componentes conectados).
export function mergeClusterings(n, ...clusterings) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const clustering of clusterings) {
    for (const cluster of clustering) {
      for (let k = 1; k < cluster.length; k += 1) {
        const a = find(cluster[0]);
        const b = find(cluster[k]);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()];
}

// Veredito com a regra pré-registrada do item 263: só conta diferença se o
// IC (já no alpha de Bonferroni) excluir zero E houver G ≥ 20 clusters.
function verdictFor(ci, g) {
  if (!ci) return 'nao_calculavel';
  const excludesZero = ci[0] > 0 || ci[1] < 0;
  if (!excludesZero) return 'indistinguivel_do_ruido';
  return g >= MIN_RELIABLE_CLUSTERS ? 'diferenca_significativa' : 'inconclusivo_poucos_clusters';
}

export function pairedComparison(control, variant, { familySize = 1, iterations = 5000, rand = Math.random } = {}) {
  const alpha = 0.05 / familySize;
  const byIdVariant = new Map(scoredEntries(variant).map((e) => [e.op.id, e]));
  const controlEntries = scoredEntries(control);
  const controlIds = new Set(controlEntries.map((e) => e.op.id));
  const pairs = controlEntries.filter((e) => byIdVariant.has(e.op.id)).map((e) => [e, byIdVariant.get(e.op.id)]);
  const onlyControl = controlEntries.filter((e) => !byIdVariant.has(e.op.id)).map((e) => e.op.id);
  const onlyVariant = [...byIdVariant.keys()].filter((id) => !controlIds.has(id));

  const n = pairs.length;
  const deltas = pairs.map(([a, b]) => b.r - a.r);
  const changed = pairs
    .map(([a, b], i) => ({ id: a.op.id, symbol: a.op.symbol, controlR: a.r, variantR: b.r, deltaR: deltas[i], controlStatus: a.op.status, variantStatus: b.op.status }))
    .filter((c) => Math.abs(c.deltaR) > EPS);

  const base = {
    matched: n,
    identical: n - changed.length,
    changed: changed.length,
    onlyControl: onlyControl.length,
    onlyVariant: onlyVariant.length,
    coversAllOps: onlyControl.length === 0 && onlyVariant.length === 0,
    changedSamples: [...changed].sort((x, y) => Math.abs(y.deltaR) - Math.abs(x.deltaR)).slice(0, MAX_CHANGED_SAMPLES),
  };
  if (n < 2) return { ...base, insufficientData: true };

  const ca = clustersForEntries(pairs.map(([a]) => a));
  const cb = clustersForEntries(pairs.map(([, b]) => b));
  const clusters = mergeClusterings(n, ca.clusters, cb.clusters);
  const g = clusters.length;
  const meanDeltaR = mean(deltas);
  const clusteredSE = clusterRobustStdErr(deltas, clusters);
  const tCritical = g >= 2 ? studentTCritical95(g - 1, alpha) : null;
  const ci = clusteredSE != null && tCritical != null
    ? [meanDeltaR - tCritical * clusteredSE, meanDeltaR + tCritical * clusteredSE]
    : null;
  return {
    ...base,
    meanDeltaR,
    naiveSE: naiveStdErr(deltas),
    clusteredSE,
    g,
    clusterCountLow: g < MIN_RELIABLE_CLUSTERS,
    pairsWithoutInterval: Math.max(ca.withoutInterval, cb.withoutInterval),
    alpha,
    tCritical,
    ci,
    signFlip: clusterSignFlipTest(deltas, clusters, { iterations, rand }),
    verdict: verdictFor(ci, g),
  };
}

function armStats(report) {
  const entries = scoredEntries(report);
  const values = entries.map((e) => e.r);
  const { clusters, withoutInterval } = clustersForEntries(entries);
  const n = values.length;
  return {
    trialLabel: report.trialLabel ?? null,
    n,
    g: clusters.length,
    meanR: n > 0 ? mean(values) : null,
    sdR: sampleSd(values),
    clusteredSE: clusterRobustStdErr(values, clusters),
    withoutInterval,
    // Descritivos do próprio relatório (sem recalcular): a hipótese do
    // item 263 é sobre risco (sd, drawdown), não só sobre expectância. O
    // drawdown é o da CONTA simulada (`equityCurve`, risco fixo por
    // operação) — `overall.maxDrawdownPct` soma o % de preço de cada
    // operação, não é drawdown de conta (item 108 addendum).
    reportExpectancyR: report.overall.expectancyR ?? null,
    winRate: report.overall.winRate ?? null,
    profitFactor: report.overall.profitFactor ?? null,
    equityRiskPct: report.equityCurve?.riskPct ?? null,
    equityMaxDrawdownPct: report.equityCurve?.maxDrawdownPct ?? null,
    equityTotalReturnPct: report.equityCurve?.totalReturnPct ?? null,
  };
}

// Erro-padrão (CR1) da diferença das médias `mean(B) − mean(A)` com
// clusters CONJUNTOS dos dois braços — review do Codex, PR #479. A diferença
// é linear nas observações: cada operação de A contribui −(r − média A)/nA e
// cada uma de B contribui +(r − média B)/nB; somar as contribuições DENTRO de
// cada cluster conjunto antes de elevar ao quadrado é o que faz a
// covariância entre os braços (de qualquer sinal) entrar na variância. Com
// todo cluster unitário, reduz a √(sA²/nA + sB²/nB) (mais o fator G/(G−1)).
export function jointDiffStdErr(entriesA, entriesB) {
  const nA = entriesA.length;
  const nB = entriesB.length;
  if (nA < 1 || nB < 1) return null;
  const all = [...entriesA, ...entriesB];
  const { clusters: byTime } = clustersForEntries(all, (i) => (i < nA ? 'A:' : 'B:'));
  // A mesma operação nos dois braços é, por definição, a mesma exposição.
  const indexInA = new Map(entriesA.map((e, i) => [e.op.id, i]));
  const sameOp = entriesB
    .map((e, j) => (indexInA.has(e.op.id) ? [indexInA.get(e.op.id), nA + j] : null))
    .filter(Boolean);
  const clusters = mergeClusterings(nA + nB, byTime, sameOp);
  const g = clusters.length;
  if (g < 2) return null;
  const meanA = mean(entriesA.map((e) => e.r));
  const meanB = mean(entriesB.map((e) => e.r));
  const contribution = (i) => (i < nA ? -(all[i].r - meanA) / nA : (all[i].r - meanB) / nB);
  const sumSq = clusters.reduce((acc, c) => {
    const s = c.reduce((x, i) => x + contribution(i), 0);
    return acc + s * s;
  }, 0);
  return { se: Math.sqrt((g / (g - 1)) * sumSq), g };
}

export function unpairedComparison(control, variant, { familySize = 1 } = {}) {
  const a = armStats(control);
  const b = armStats(variant);
  const base = { control: a, variant: b };
  if (a.meanR == null || b.meanR == null || a.clusteredSE == null || b.clusteredSE == null) {
    return { ...base, insufficientData: true };
  }
  const deltaR = b.meanR - a.meanR;
  const joint = jointDiffStdErr(scoredEntries(control), scoredEntries(variant));
  if (!joint) return { ...base, insufficientData: true };
  const seDiff = joint.se;
  const tCritical = studentTCritical95(joint.g - 1, 0.05 / familySize);
  const ci = [deltaR - tCritical * seDiff, deltaR + tCritical * seDiff];
  return {
    ...base,
    deltaR,
    seDiff,
    // Só para referência: o que daria supondo braços independentes. A
    // distância entre os dois é o peso da covariância entre os braços.
    seDiffIfIndependent: Math.sqrt(a.clusteredSE ** 2 + b.clusteredSE ** 2),
    gJoint: joint.g,
    t: seDiff > 0 ? deltaR / seDiff : null,
    tCritical,
    // Comparativo (não decide nada): o z de Bonferroni da família.
    zCritical: bonferroniZ(familySize),
    ci,
    sdRatio: a.sdR ? b.sdR / a.sdR : null,
    verdict: verdictFor(ci, joint.g),
  };
}

export function compareReports(control, variant, { familySize = 1, allowCommitMismatch = false, iterations = 5000, rand = Math.random } = {}) {
  if (!Number.isInteger(familySize) || familySize < 1) {
    throw new RangeError(`familySize deve ser inteiro >= 1, recebeu ${familySize}`);
  }
  const { errors, warnings } = checkComparable(control, variant, { allowCommitMismatch });
  const labels = { control: control?.trialLabel ?? null, variant: variant?.trialLabel ?? null };
  if (errors.length) return { comparable: false, errors, warnings, labels, familySize };
  const paired = pairedComparison(control, variant, { familySize, iterations, rand });
  if (!paired.coversAllOps) {
    warnings.push(`a variante mudou quais operações existem (${paired.onlyControl} só no controle, ${paired.onlyVariant} só na variante) — o pareado cobre só as ${paired.matched} casadas; a leitura principal é a NÃO pareada`);
  }
  const unpaired = unpairedComparison(control, variant, { familySize });
  return { comparable: true, errors, warnings, labels, familySize, paired, unpaired };
}

const VERDICT_TEXT = {
  diferenca_significativa: '**diferença significativa** (IC exclui zero, G ≥ 20)',
  indistinguivel_do_ruido: 'indistinguível do ruído (IC inclui zero)',
  inconclusivo_poucos_clusters: 'IC exclui zero, mas com G < 20 — **inconclusivo** (poucos clusters para confiar no IC)',
  nao_calculavel: 'não calculável',
};

export function formatComparisonMarkdown(result) {
  const f = (v, d = 4) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const fci = (ci) => (ci ? `[${f(ci[0])}, ${f(ci[1])}]` : '—');
  const lines = ['', `## Comparação de backtests — controle \`${result.labels.control ?? '?'}\` × variante \`${result.labels.variant ?? '?'}\``, ''];
  if (!result.comparable) {
    lines.push('**Comparação recusada:**', '', ...result.errors.map((e) => `- ${e}`), '');
    if (result.warnings.length) lines.push('Avisos:', '', ...result.warnings.map((w) => `- ${w}`), '');
    return lines.join('\n');
  }
  if (result.warnings.length) lines.push('Avisos:', '', ...result.warnings.map((w) => `- ${w}`), '');
  lines.push(`Família de ${result.familySize} comparação(ões) — alpha por comparação = ${f(0.05 / result.familySize)} (Bonferroni).`, '');

  const p = result.paired;
  lines.push('### Pareado (mesma operação nos dois runs)', '',
    `Casadas: ${p.matched} (iguais: ${p.identical}, diferentes: ${p.changed}) · só no controle: ${p.onlyControl} · só na variante: ${p.onlyVariant}`, '');
  if (p.insufficientData) {
    lines.push('Dados insuficientes para estatística pareada (menos de 2 operações casadas).', '');
  } else {
    lines.push(
      `ΔR médio por operação (variante − controle): **${f(p.meanDeltaR)}R**`,
      `IC (t de Student, G−1=${p.g - 1}, crítico ${f(p.tCritical, 3)}, erro em cluster): ${fci(p.ci)}`
        + (p.clusterCountLow ? ' — **G < 20**' : ''),
      `Sign-flip por cluster: p=${p.signFlip ? f(p.signFlip.pValue) : '—'} (complemento; exato só sob simetria)`,
      `Veredito: ${VERDICT_TEXT[p.verdict]}`, '',
    );
    if (p.changedSamples.length) {
      lines.push('| Operação | Controle R (status) | Variante R (status) | ΔR |', '|---|---|---|---|',
        ...p.changedSamples.map((c) => `| ${c.id} | ${f(c.controlR)} (${c.controlStatus}) | ${f(c.variantR)} (${c.variantStatus}) | ${f(c.deltaR)} |`), '');
    }
  }

  const u = result.unpaired;
  lines.push('### Não pareado (expectância de cada braço)', '',
    '| | Controle | Variante |', '|---|---|---|',
    `| Operações (n) / clusters (G) | ${u.control.n} / ${u.control.g} | ${u.variant.n} / ${u.variant.g} |`,
    `| Expectância (R) | ${f(u.control.meanR)} | ${f(u.variant.meanR)} |`,
    `| Erro-padrão em cluster | ${f(u.control.clusteredSE)} | ${f(u.variant.clusteredSE)} |`,
    `| sd(R) | ${f(u.control.sdR)} | ${f(u.variant.sdR)} |`,
    `| Win rate | ${f(u.control.winRate, 2)} | ${f(u.variant.winRate, 2)} |`,
    `| Profit factor | ${f(u.control.profitFactor, 3)} | ${f(u.variant.profitFactor, 3)} |`,
    `| Conta simulada: retorno (%) | ${f(u.control.equityTotalReturnPct, 2)} | ${f(u.variant.equityTotalReturnPct, 2)} |`,
    `| Conta simulada: max drawdown (%) | ${f(u.control.equityMaxDrawdownPct, 2)} | ${f(u.variant.equityMaxDrawdownPct, 2)} |`, '',
    `Conta simulada = \`equityCurve\` do relatório (risco de ${u.control.equityRiskPct ?? '?'}% por operação).`, '');
  if (u.insufficientData) {
    lines.push('Dados insuficientes para a comparação não pareada.', '');
  } else {
    lines.push(
      `Δ expectância: **${f(u.deltaR)}R**, t=${f(u.t, 3)} (crítico ${f(u.tCritical, 3)}, G conjunto−1=${u.gJoint - 1}), IC ${fci(u.ci)}`
        + (u.gJoint < 20 ? ' — **G < 20**' : ''),
      `sd(R) variante/controle: ${f(u.sdRatio, 3)}×`,
      `Veredito: ${VERDICT_TEXT[u.verdict]}`,
      '',
      `Erro da diferença com clusters conjuntos dos dois braços (inclui a covariância entre eles): ${f(u.seDiff)}; `
        + `supondo braços independentes seria ${f(u.seDiffIfIndependent)}.`, '',
    );
  }
  return lines.join('\n');
}
