// Resumo da referência "mesmas saídas, entradas aleatórias" — docs/known-risks.md
// item 264. Parte pura, sem trabalho no carregamento (lição do item 166); o
// CLI é scripts/random-baseline-summary.mjs.
//
// Pergunta: a entrada da Range Filter vale mais que entrar ao acaso com as
// MESMAS saídas, no mesmo período, símbolos e custo? Método padrão da
// literatura (Basso/Van Tharp; detrending de Aronson): rodar N seeds de
// entrada aleatória e ver em que percentil da distribuição o controle (R0)
// cai. p empírico unicaudal = (1 + nº de seeds com expectância ≥ R0) / (N + 1)
// — o "+1" conta o próprio R0 como uma das realizações possíveis sob a
// hipótese nula (forma padrão de p de permutação/Monte Carlo, nunca zero).
// Consequência prática: o menor p possível é 1/(N+1); com o limiar
// pré-registrado de 0,025 é preciso N ≥ 39.
//
// "Comprar e segurar" entra só como CONTEXTO descritivo: é retorno de
// carteira com 100% investido, não R por operação com 1% de risco — os dois
// números não são comparáveis diretamente, e o resumo diz isso.
import { checkComparable } from './compareBacktestReports.mjs';

const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

// Percentil com interpolação linear (mesma convenção do numpy padrão).
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function distribution(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return { n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
  return { n, mean, sd, min: xs[0], p5: quantile(xs, 0.05), p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: xs[n - 1] };
}

// Posição do controle na distribuição aleatória. `higherIsBetter` decide o
// sentido do p (expectância: maior é melhor; drawdown: menor é melhor).
export function rankAgainst(controlValue, randomValues, { higherIsBetter = true } = {}) {
  const xs = randomValues.filter((v) => Number.isFinite(v));
  if (!Number.isFinite(controlValue) || !xs.length) return null;
  const better = (a, b) => (higherIsBetter ? a > b : a < b);
  const atLeastAsGood = xs.filter((v) => !better(controlValue, v)).length; // seeds iguais ou melhores que o controle
  const worse = xs.filter((v) => better(controlValue, v)).length;
  const ties = xs.length - worse - xs.filter((v) => better(v, controlValue)).length;
  return {
    // Fração das seeds que o controle supera (empate conta meio).
    percentile: (worse + ties / 2) / xs.length,
    pEmpirical: (1 + atLeastAsGood) / (xs.length + 1),
    minPossibleP: 1 / (xs.length + 1),
  };
}

function metricsOf(report) {
  const o = report.overall ?? {};
  return {
    trialLabel: report.trialLabel ?? null,
    seed: report.reproducibility?.pineConfig?.randomEntrySeed ?? null,
    n: report.costs?.countedTrades ?? o.counted ?? null,
    expectancyR: report.costs?.netExpectancyR ?? o.expectancyR ?? null,
    sdR: o.expectancyRSd ?? null,
    profitFactor: o.profitFactor ?? null,
    winRate: o.winRate ?? null,
    equityReturnPct: report.equityCurve?.totalReturnPct ?? null,
    equityMaxDrawdownPct: report.equityCurve?.maxDrawdownPct ?? null,
  };
}

// Cesto de peso igual: cada símbolo normalizado a 1 no primeiro fechamento da
// janela, valor da carteira = média dos normalizados; só os instantes em que
// TODOS os símbolos têm vela (símbolo listado no meio da janela entra quando
// começa — reportado em `lateSymbols`).
export function buyAndHold(seriesBySymbol, { fromMs, toMs }) {
  const symbols = Object.keys(seriesBySymbol);
  if (!symbols.length) return null;
  const byTime = new Map();
  const firstClose = {};
  const lateSymbols = [];
  for (const sym of symbols) {
    const inWindow = (seriesBySymbol[sym] || []).filter((c) => c.closeTime >= fromMs && c.closeTime <= toMs && Number.isFinite(c.close));
    if (!inWindow.length) continue;
    firstClose[sym] = inWindow[0].close;
    if (inWindow[0].closeTime > fromMs + 24 * 60 * 60 * 1000) lateSymbols.push(sym);
    for (const c of inWindow) {
      if (!byTime.has(c.closeTime)) byTime.set(c.closeTime, {});
      byTime.get(c.closeTime)[sym] = c.close / firstClose[sym];
    }
  }
  const used = Object.keys(firstClose);
  if (!used.length) return null;
  const path = [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, vals]) => {
      const present = used.filter((s) => vals[s] != null);
      return present.length ? present.reduce((a, s) => a + vals[s], 0) / present.length : null;
    })
    .filter((v) => v != null);
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of path) {
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  return {
    symbols: used.length,
    totalReturnPct: round((path[path.length - 1] - 1) * 100, 2),
    maxDrawdownPct: round(maxDd * 100, 2),
    lateSymbols,
  };
}

/**
 * @param {object} control relatório R0 (entrada da RF)
 * @param {object[]} randoms relatórios do braço aleatório (uma seed cada)
 * @param {{ alpha?: number, seriesBySymbol?: Record<string, Array<object>> }} [options]
 */
export function summarizeRandomBaseline(control, randoms, { alpha = 0.025, seriesBySymbol } = {}) {
  const errors = [];
  const warnings = [];
  if (control?.reproducibility?.pineConfig?.randomEntryEnabled === true) {
    errors.push('o controle tem randomEntryEnabled ligado — o R0 tem que ser a entrada da RF');
  }
  const seeds = new Set();
  randoms.forEach((r, i) => {
    const pc = r?.reproducibility?.pineConfig;
    const label = r?.trialLabel ?? `relatório aleatório #${i + 1}`;
    if (pc?.randomEntryEnabled !== true) errors.push(`${label}: randomEntryEnabled não está ligado`);
    if (pc && seeds.has(pc.randomEntrySeed)) errors.push(`${label}: seed ${pc.randomEntrySeed} repetida`);
    if (pc) seeds.add(pc.randomEntrySeed);
    const { errors: e, warnings: w } = checkComparable(control, r);
    errors.push(...e.map((m) => `${label}: ${m}`));
    warnings.push(...w.map((m) => `${label}: ${m}`));
  });
  if (randoms.length < 2) errors.push('são necessárias pelo menos 2 seeds aleatórias');
  const minPossibleP = 1 / (randoms.length + 1);
  if (randoms.length >= 2 && minPossibleP > alpha) {
    errors.push(`com ${randoms.length} seeds o menor p possível é ${minPossibleP.toFixed(4)}, acima do limiar ${alpha} — a regra nunca poderia dar positivo; use pelo menos ${Math.ceil(1 / alpha - 1)} seeds`);
  }
  const uniqueWarnings = [...new Set(warnings)];
  if (errors.length) return { comparable: false, errors, warnings: uniqueWarnings };

  const c = metricsOf(control);
  const rs = randoms.map(metricsOf);
  const expectancy = rankAgainst(c.expectancyR, rs.map((r) => r.expectancyR));
  let verdict;
  if (!expectancy) verdict = 'nao_calculavel';
  else if (expectancy.pEmpirical <= alpha) verdict = 'entrada_melhor_que_aleatoria';
  else if (expectancy.percentile <= alpha) verdict = 'entrada_pior_que_aleatoria';
  else verdict = 'indistinguivel_do_aleatorio';

  const range = control.range ?? {};
  return {
    comparable: true,
    errors,
    warnings: uniqueWarnings,
    alpha,
    window: { from: range.from ?? null, to: range.to ?? null },
    control: c,
    randomSeeds: rs.length,
    random: {
      expectancyR: distribution(rs.map((r) => r.expectancyR)),
      sdR: distribution(rs.map((r) => r.sdR)),
      equityMaxDrawdownPct: distribution(rs.map((r) => r.equityMaxDrawdownPct)),
      n: distribution(rs.map((r) => r.n)),
    },
    rank: {
      expectancyR: expectancy,
      sdR: rankAgainst(c.sdR, rs.map((r) => r.sdR), { higherIsBetter: false }),
      equityMaxDrawdownPct: rankAgainst(c.equityMaxDrawdownPct, rs.map((r) => r.equityMaxDrawdownPct), { higherIsBetter: false }),
    },
    verdict,
    buyAndHold: seriesBySymbol ? buyAndHold(seriesBySymbol, { fromMs: range.fromMs, toMs: range.toMs }) : null,
    seeds: rs.map((r) => ({ seed: r.seed, n: r.n, expectancyR: r.expectancyR })).sort((a, b) => a.seed - b.seed),
  };
}

const VERDICT_TEXT = {
  entrada_melhor_que_aleatoria: '**a entrada da RF é melhor que a aleatória** (p empírico ≤ limiar)',
  entrada_pior_que_aleatoria: '**a entrada da RF é PIOR que a aleatória** (controle abaixo do percentil do limiar)',
  indistinguivel_do_aleatorio: 'a entrada da RF é **indistinguível de entrar ao acaso** nesta amostra',
  nao_calculavel: 'não calculável',
};

export function formatRandomBaselineMarkdown(s) {
  const f = (v, d = 4) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const lines = ['', '## Entrada da RF × entradas aleatórias (mesmas saídas)', ''];
  if (!s.comparable) {
    lines.push('**Resumo recusado:**', '', ...s.errors.map((e) => `- ${e}`), '');
    return lines.join('\n');
  }
  if (s.warnings.length) lines.push('Avisos:', '', ...s.warnings.map((w) => `- ${w}`), '');
  const d = s.random.expectancyR;
  const rk = s.rank.expectancyR;
  lines.push(
    `Janela ${s.window.from ?? '?'} → ${s.window.to ?? '?'} · ${s.randomSeeds} seeds aleatórias · limiar unicaudal ${s.alpha}`,
    '',
    '| | Controle (RF) | Aleatórias: média | p5 | mediana | p95 |',
    '|---|---|---|---|---|---|',
    `| Expectância (R) | ${f(s.control.expectancyR)} | ${f(d.mean)} | ${f(d.p5)} | ${f(d.p50)} | ${f(d.p95)} |`,
    `| sd(R) | ${f(s.control.sdR)} | ${f(s.random.sdR.mean)} | ${f(s.random.sdR.p5)} | ${f(s.random.sdR.p50)} | ${f(s.random.sdR.p95)} |`,
    `| Drawdown da conta (%) | ${f(s.control.equityMaxDrawdownPct, 2)} | ${f(s.random.equityMaxDrawdownPct.mean, 2)} | ${f(s.random.equityMaxDrawdownPct.p5, 2)} | ${f(s.random.equityMaxDrawdownPct.p50, 2)} | ${f(s.random.equityMaxDrawdownPct.p95, 2)} |`,
    `| Operações | ${s.control.n ?? '—'} | ${f(s.random.n.mean, 1)} | ${f(s.random.n.p5, 0)} | ${f(s.random.n.p50, 0)} | ${f(s.random.n.p95, 0)} |`,
    '',
    `Percentil do controle na expectância: **${f(rk.percentile * 100, 1)}%** · p empírico = ${f(rk.pEmpirical)} (mínimo possível ${f(rk.minPossibleP)})`,
    `Veredito: ${VERDICT_TEXT[s.verdict]}`,
    '',
  );
  if (s.buyAndHold) {
    lines.push(
      `Comprar e segurar (cesto de peso igual, ${s.buyAndHold.symbols} símbolos, só contexto): retorno ${f(s.buyAndHold.totalReturnPct, 2)}%, drawdown ${f(s.buyAndHold.maxDrawdownPct, 2)}%`
        + (s.buyAndHold.lateSymbols.length ? ` — começaram depois do início: ${s.buyAndHold.lateSymbols.join(', ')}` : ''),
      `Conta simulada do controle: retorno ${f(s.control.equityReturnPct, 2)}%, drawdown ${f(s.control.equityMaxDrawdownPct, 2)}%. `
        + 'Exposições diferentes (100% investido × 1% de risco por operação) — não compare os números diretamente.',
      '',
    );
  }
  return lines.join('\n');
}
