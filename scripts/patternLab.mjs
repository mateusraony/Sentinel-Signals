// Laboratório de padrões, fase B1 — docs/known-risks.md item 266.
// Parte pura (sem rede, sem trabalho no carregamento — lição do item 166); o
// CLI é scripts/pattern-lab.mjs e o download é scripts/fetch-pattern-lab-data.mjs.
//
// Pergunta: algum dos 11 sinais pré-registrados (fluxo agressor, funding,
// prêmio, contratos em aberto, proporções de comprados/vendidos, e dois
// controles) PREVÊ o retorno das próximas 4h ou 24h, de forma que sobreviva a
// dados que não foram usados para achá-lo?
//
// Método (pré-registrado em docs/experiments/pattern-lab-prereg.json):
// 1. Cada sinal vira um percentil CAUSAL por ativo (posição do valor atual
//    entre os das últimas 540 velas) — compara o sinal com o próprio passado
//    recente do ativo, sem nunca olhar para frente.
// 2. Alvo: retorno log das próximas h velas dividido pela volatilidade causal
//    das últimas 180 velas.
// 3. IC = correlação de Spearman entre sinal e alvo, por ativo; IC do teste =
//    média simples entre os ativos com ≥ minRowsPerSymbol linhas (o BTC, que
//    tem mais história, não domina).
// 4. Erro-padrão por bootstrap de SEMANAS do calendário, a mesma semana para
//    todos os ativos — respeita a sobreposição dos retornos de 24h e a
//    correlação entre as moedas.
// 5. Holm sobre os 22 testes. Passa na descoberta só com Holm p < 0,05,
//    |t| ≥ 3, mesmo sinal em ≥ 80% dos ativos e meia-diferença entre o quintil
//    de cima e o de baixo ≥ 12 bps (o custo de ida e volta).
// 6. Só quem passou na descoberta é medido na validação (período seguinte,
//    com 7 dias de folga). O período final (holdout) fica lacrado: o dado nem
//    é baixado nesta fase.
import { mulberry32 } from './backtest-correlation-check.mjs';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Segunda-feira 1970-01-05 00:00 UTC — semanas do calendário começam na segunda.
const WEEK_ORIGIN_MS = Date.UTC(1970, 0, 5);

export const FEATURE_LABELS = {
  F1_flow4h: 'Fluxo agressor (4h)',
  F2_flow24h: 'Fluxo agressor (24h)',
  F3_funding: 'Funding',
  F4_basis: 'Prêmio dos futuros',
  F5_oiChange4h: 'Contratos em aberto: variação 4h',
  F6_oiChange24h: 'Contratos em aberto: variação 24h',
  F7_topTraderPosition: 'Grandes traders: comprados/vendidos',
  F8_topVsCrowd: 'Grandes traders × multidão',
  F9_oiPriceDivergence: 'Divergência contratos × preço',
  F10_reversal24h: 'Controle: retorno das últimas 24h',
  F11_trend20d: 'Controle: tendência de 20 dias',
};

// ---------- estatística básica ----------

// Postos com empate pela média (definição usual do Spearman).
export function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

function pearsonFromSums({ n, sx, sy, sxx, syy, sxy }) {
  if (n < 3) return null;
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (!(vx > 0) || !(vy > 0)) return null;
  return cov / Math.sqrt(vx * vy);
}

export function spearman(xs, ys) {
  const rx = ranks(xs);
  const ry = ranks(ys);
  const s = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
  for (let i = 0; i < rx.length; i += 1) addPair(s, rx[i], ry[i], 1);
  return pearsonFromSums(s);
}

function addPair(s, x, y, w) {
  s.n += w; s.sx += w * x; s.sy += w * y; s.sxx += w * x * x; s.syy += w * y * y; s.sxy += w * x * y;
}

// CDF normal padrão (Abramowitz-Stegun 7.1.26, erro < 1,5e-7).
export function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Holm–Bonferroni: p ajustado na ordem original; null fica null.
export function holmAdjust(pValues) {
  const items = pValues.map((p, i) => ({ p, i })).filter((x) => Number.isFinite(x.p)).sort((a, b) => a.p - b.p);
  const m = items.length;
  const out = pValues.map(() => null);
  let running = 0;
  items.forEach((x, k) => {
    running = Math.max(running, Math.min(1, (m - k) * x.p));
    out[x.i] = running;
  });
  return out;
}

// ---------- sinais (todos causais) ----------

// Percentil do valor atual entre os valores não nulos da janela [i−window+1, i].
export function causalPercentile(values, window, minCount) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i += 1) {
    const x = values[i];
    if (x == null || !Number.isFinite(x)) continue;
    let n = 0;
    let below = 0;
    let equal = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j += 1) {
      const v = values[j];
      if (v == null || !Number.isFinite(v)) continue;
      n += 1;
      if (v < x) below += 1;
      else if (v === x) equal += 1;
    }
    if (n >= minCount) out[i] = (below + equal / 2) / n;
  }
  return out;
}

// `k` velas atrás, só se a série for contínua (sem vela faltando no meio).
function back(bars, i, k, barMs) {
  const j = i - k;
  if (j < 0 || bars[i].t - bars[j].t !== k * barMs) return null;
  return bars[j];
}
const ln = (a, b) => (a > 0 && b > 0 ? Math.log(a / b) : null);

/**
 * Valores brutos dos 11 sinais, alinhados às barras. Cada valor da barra i
 * usa só barras ≤ i.
 */
export function computeRawFeatures(bars, barMs) {
  const n = bars.length;
  const f = {};
  for (const key of Object.keys(FEATURE_LABELS)) f[key] = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    if (b.volume > 0 && Number.isFinite(b.takerBuyVolume)) f.F1_flow4h[i] = (2 * b.takerBuyVolume) / b.volume - 1;
    if (back(bars, i, 5, barMs)) {
      let v = 0; let tb = 0;
      for (let j = i - 5; j <= i; j += 1) { v += bars[j].volume; tb += bars[j].takerBuyVolume; }
      if (v > 0 && Number.isFinite(tb)) f.F2_flow24h[i] = (2 * tb) / v - 1;
    }
    f.F3_funding[i] = b.fundingPerHour ?? null;
    f.F4_basis[i] = b.premium ?? null;
    const p1 = back(bars, i, 1, barMs);
    const p6 = back(bars, i, 6, barMs);
    if (p1) f.F5_oiChange4h[i] = ln(b.openInterest, p1.openInterest);
    if (p6) f.F6_oiChange24h[i] = ln(b.openInterest, p6.openInterest);
    if (b.topPositionLS > 0) f.F7_topTraderPosition[i] = Math.log(b.topPositionLS);
    if (b.topPositionLS > 0 && b.globalAccountLS > 0) f.F8_topVsCrowd[i] = Math.log(b.topPositionLS) - Math.log(b.globalAccountLS);
    if (p6) f.F10_reversal24h[i] = ln(b.close, p6.close);
    const p120 = back(bars, i, 120, barMs);
    if (p120) f.F11_trend20d[i] = ln(b.close, p120.close);
  }
  return f;
}

/** Sinais normalizados (percentil causal), inclusive o F9, que depende do percentil do F6. */
export function computeFeatures(bars, { barMs, percentileWindowBars, percentileMinBars }) {
  const raw = computeRawFeatures(bars, barMs);
  const pct = (arr) => causalPercentile(arr, percentileWindowBars, percentileMinBars);
  const out = {};
  for (const key of Object.keys(raw)) if (key !== 'F9_oiPriceDivergence') out[key] = pct(raw[key]);
  // F9: contratos crescendo com o preço caindo (ou o contrário) — divergência.
  const f9 = out.F6_oiChange24h.map((p, i) => {
    const r = raw.F10_reversal24h[i];
    if (p == null || r == null || r === 0) return null;
    return (p - 0.5) * -Math.sign(r);
  });
  out.F9_oiPriceDivergence = pct(f9);
  return out;
}

/**
 * Alvo da barra i: retorno log das próximas h velas, bruto (bps) e dividido
 * pela volatilidade das últimas `volWindowBars` velas (só passado).
 */
export function computeTargets(bars, h, { barMs, volWindowBars }) {
  const n = bars.length;
  const z = new Array(n).fill(null);
  const bps = new Array(n).fill(null);
  const r1 = bars.map((b, i) => (i > 0 && back(bars, i, 1, barMs) ? ln(b.close, bars[i - 1].close) : null));
  for (let i = 0; i < n; i += 1) {
    if (i + h >= n || bars[i + h].t - bars[i].t !== h * barMs) continue;
    const fwd = ln(bars[i + h].close, bars[i].close);
    if (fwd == null) continue;
    let cnt = 0; let s = 0; let ss = 0;
    for (let j = Math.max(0, i - volWindowBars + 1); j <= i; j += 1) {
      if (r1[j] == null) continue;
      cnt += 1; s += r1[j]; ss += r1[j] * r1[j];
    }
    if (cnt < volWindowBars / 2) continue;
    const sd = Math.sqrt(Math.max(0, (ss - (s * s) / cnt) / (cnt - 1)));
    if (!(sd > 0)) continue;
    z[i] = fwd / sd;
    bps[i] = fwd * 10000;
  }
  return { z, bps };
}

// Linhas do período: fechamento em [from, to) e o alvo (t + h velas) ≤ to —
// o retorno nunca atravessa o fim do período.
export function splitIndices(bars, h, { fromMs, toMs, barMs }) {
  const idx = [];
  for (let i = 0; i < bars.length; i += 1) {
    const t = bars[i].t;
    if (t >= fromMs && t < toMs && t + h * barMs <= toMs) idx.push(i);
  }
  return idx;
}

const weekOf = (t) => Math.floor((t - WEEK_ORIGIN_MS) / WEEK_MS);

// ---------- um teste (sinal × horizonte × período) ----------

/**
 * @param {{ symbol: string, t: number[], x: (number|null)[], z: (number|null)[], bps: (number|null)[], idx: number[] }[]} perSymbol
 */
export function evaluateTest(perSymbol, { minRowsPerSymbol, bootstrapReps, seed }) {
  const symbols = [];
  for (const s of perSymbol) {
    const rows = s.idx.filter((i) => s.x[i] != null && s.z[i] != null);
    if (rows.length < minRowsPerSymbol) continue;
    const rx = ranks(rows.map((i) => s.x[i]));
    const ry = ranks(rows.map((i) => s.z[i]));
    const byWeek = new Map();
    rows.forEach((i, k) => {
      const w = weekOf(s.t[i]);
      if (!byWeek.has(w)) byWeek.set(w, { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 });
      addPair(byWeek.get(w), rx[k], ry[k], 1);
    });
    const total = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
    for (const ws of byWeek.values()) for (const key of Object.keys(total)) total[key] += ws[key];
    const ic = pearsonFromSums(total);
    if (ic == null) continue;
    // Quintis do sinal → retorno bruto médio (bps) em cada um.
    const order = rows.map((i, k) => ({ x: rx[k], bps: s.bps[i] })).sort((a, b) => a.x - b.x);
    const quint = [0, 1, 2, 3, 4].map((q) => {
      const part = order.slice(Math.floor((q * order.length) / 5), Math.floor(((q + 1) * order.length) / 5));
      return part.reduce((a, r) => a + r.bps, 0) / part.length;
    });
    symbols.push({ symbol: s.symbol, n: rows.length, ic, byWeek, quint });
  }
  if (!symbols.length) return { eligibleSymbols: 0, n: 0, ic: null };

  const ic = symbols.reduce((a, s) => a + s.ic, 0) / symbols.length;
  const weeks = [...new Set(symbols.flatMap((s) => [...s.byWeek.keys()]))].sort((a, b) => a - b);
  const rand = mulberry32(seed);
  const reps = [];
  for (let r = 0; r < bootstrapReps; r += 1) {
    const mult = new Map();
    for (let k = 0; k < weeks.length; k += 1) {
      const w = weeks[Math.floor(rand() * weeks.length)];
      mult.set(w, (mult.get(w) || 0) + 1);
    }
    let sum = 0; let cnt = 0;
    for (const s of symbols) {
      const acc = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
      for (const [w, m] of mult) {
        const ws = s.byWeek.get(w);
        if (ws) for (const key of Object.keys(acc)) acc[key] += m * ws[key];
      }
      const v = pearsonFromSums(acc);
      if (v != null) { sum += v; cnt += 1; }
    }
    if (cnt) reps.push(sum / cnt);
  }
  const mean = reps.reduce((a, b) => a + b, 0) / reps.length;
  const se = Math.sqrt(reps.reduce((a, b) => a + (b - mean) ** 2, 0) / (reps.length - 1));
  const t = se > 0 ? ic / se : null;
  const p = t == null ? null : 2 * (1 - normalCdf(Math.abs(t)));
  const sameSignShare = symbols.filter((s) => Math.sign(s.ic) === Math.sign(ic)).length / symbols.length;
  const quintileBps = [0, 1, 2, 3, 4].map((q) => symbols.reduce((a, s) => a + s.quint[q], 0) / symbols.length);
  return {
    eligibleSymbols: symbols.length,
    n: symbols.reduce((a, s) => a + s.n, 0),
    ic,
    se,
    t,
    p,
    sameSignShare,
    perSymbolIc: Object.fromEntries(symbols.map((s) => [s.symbol, s.ic])),
    quintileBps,
    halfSpreadBps: (quintileBps[4] - quintileBps[0]) / 2,
  };
}

// ---------- laboratório inteiro ----------

const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

/**
 * @param {{ symbol: string, bars: object[] }[]} datasets saída de fetch-pattern-lab-data.mjs
 * @param {object} prereg docs/experiments/pattern-lab-prereg.json
 */
export function runPatternLab(datasets, prereg) {
  const barMs = prereg.barMinutes * 60 * 1000;
  const S = prereg.stats;
  if (!Number.isInteger(S.minEligibleSymbols) || S.minEligibleSymbols < 1) {
    throw new Error('pré-registro sem stats.minEligibleSymbols (inteiro ≥ 1) — sem ele um sinal sem dado passaria como "testado"');
  }
  const split = (name) => ({ fromMs: dayMs(prereg.splits[name].from), toMs: dayMs(prereg.splits[name].to), barMs });
  const prepared = datasets.map((d) => ({
    symbol: d.symbol,
    bars: d.bars,
    t: d.bars.map((b) => b.t),
    features: computeFeatures(d.bars, { barMs, ...prereg.normalization }),
    targets: Object.fromEntries(prereg.horizonsBars.map((h) => [h, computeTargets(d.bars, h, { barMs, ...prereg.target })])),
  }));

  const build = (feature, h, splitName) => prepared.map((d) => ({
    symbol: d.symbol,
    t: d.t,
    x: d.features[feature],
    z: d.targets[h].z,
    bps: d.targets[h].bps,
    idx: splitIndices(d.bars, h, split(splitName)),
  }));
  const opts = { minRowsPerSymbol: S.minRowsPerSymbol, bootstrapReps: S.bootstrapReps, seed: S.seed };

  const tests = [];
  for (const feature of prereg.features) {
    for (const h of prereg.horizonsBars) {
      tests.push({ feature, label: FEATURE_LABELS[feature], horizonBars: h, discovery: evaluateTest(build(feature, h, 'discovery'), opts) });
    }
  }
  const holm = holmAdjust(tests.map((x) => x.discovery.p));
  const D = S.discovery;
  tests.forEach((x, k) => {
    const d = x.discovery;
    d.holmP = holm[k];
    const reasons = [];
    if (d.ic == null) reasons.push('sem ativos com dado suficiente');
    else if (d.eligibleSymbols < S.minEligibleSymbols) reasons.push(`só ${d.eligibleSymbols} ativo(s) com dado suficiente (mínimo ${S.minEligibleSymbols})`);
    else {
      if (!(d.holmP < D.holmAlpha)) reasons.push(`Holm p ${d.holmP?.toFixed(3)} ≥ ${D.holmAlpha}`);
      if (!(Math.abs(d.t) >= D.minAbsT)) reasons.push(`|t| ${Math.abs(d.t ?? 0).toFixed(2)} < ${D.minAbsT}`);
      if (!(d.sameSignShare >= D.minSameSignShare)) reasons.push(`mesmo sinal em ${(d.sameSignShare * 100).toFixed(0)}% dos ativos`);
      const econOk = Math.abs(d.halfSpreadBps) >= D.minHalfSpreadBps && Math.sign(d.halfSpreadBps) === Math.sign(d.ic);
      if (!econOk) reasons.push(`meia-diferença ${d.halfSpreadBps.toFixed(1)} bps (precisa ≥ ${D.minHalfSpreadBps}, mesmo sentido do IC)`);
    }
    d.pass = reasons.length === 0;
    d.reasons = reasons;
    x.validation = null;
  });

  // Validação só para quem passou na descoberta.
  const V = S.validation;
  for (const x of tests.filter((y) => y.discovery.pass)) {
    const v = evaluateTest(build(x.feature, x.horizonBars, 'validation'), opts);
    const dir = Math.sign(x.discovery.ic);
    const reasons = [];
    if (v.ic == null) reasons.push('sem ativos com dado suficiente');
    else if (v.eligibleSymbols < S.minEligibleSymbols) reasons.push(`só ${v.eligibleSymbols} ativo(s) com dado suficiente (mínimo ${S.minEligibleSymbols})`);
    else {
      if (Math.sign(v.ic) !== dir) reasons.push('sinal invertido');
      if (!(Math.abs(v.ic) >= V.minIcRatio * Math.abs(x.discovery.ic))) reasons.push('IC caiu para menos da metade');
      if (!((v.t ?? 0) * dir >= V.minOneSidedT)) reasons.push(`t unicaudal ${((v.t ?? 0) * dir).toFixed(2)} < ${V.minOneSidedT}`);
      const share = Object.values(v.perSymbolIc).filter((ic) => Math.sign(ic) === dir).length / v.eligibleSymbols;
      v.sameSignShareVsDiscovery = share;
      if (!(share >= V.minSameSignShare)) reasons.push(`mesmo sentido em ${(share * 100).toFixed(0)}% dos ativos`);
    }
    v.pass = reasons.length === 0;
    v.reasons = reasons;
    x.validation = v;
  }

  const discoverySurvivors = tests.filter((x) => x.discovery.pass);
  const validated = discoverySurvivors.filter((x) => x.validation?.pass);
  // Teste pré-registrado sem cobertura mínima NÃO foi testado — não pode
  // virar "não achei padrão" (o downloader trata 404 como ausência, então
  // um dataset inteiro pode faltar sem erro). Isso invalida a rodada
  // inteira, inclusive um VALIDATED: com testes a menos, a correção de Holm
  // também fica mais frouxa do que a pré-registrada.
  const lacks = (r) => r.ic == null || r.eligibleSymbols < S.minEligibleSymbols;
  const untested = [
    ...tests.filter((x) => lacks(x.discovery)).map((x) => ({ test: `${x.feature}@${x.horizonBars}`, phase: 'discovery', eligibleSymbols: x.discovery.eligibleSymbols })),
    ...tests.filter((x) => x.validation && lacks(x.validation)).map((x) => ({ test: `${x.feature}@${x.horizonBars}`, phase: 'validation', eligibleSymbols: x.validation.eligibleSymbols })),
  ];
  let verdict = 'NO_SURVIVOR';
  if (untested.length) verdict = 'INCOMPLETE';
  else if (validated.length) verdict = 'VALIDATED';
  else if (discoverySurvivors.length) verdict = 'FAILED_VALIDATION';

  return {
    verdict,
    untested,
    minEligibleSymbols: S.minEligibleSymbols,
    validated: validated.map((x) => `${x.feature}@${x.horizonBars}`),
    discoverySurvivors: discoverySurvivors.map((x) => `${x.feature}@${x.horizonBars}`),
    testsSpent: tests.length,
    coverage: prepared.map((d) => {
      const disc = split('discovery');
      const val = split('validation');
      const inSplit = (s) => d.t.filter((t) => t >= s.fromMs && t < s.toMs).length;
      return {
        symbol: d.symbol,
        bars: d.bars.length,
        discoveryBars: inSplit(disc),
        validationBars: inSplit(val),
        withMetrics: d.bars.filter((b) => b.openInterest != null).length,
        withFunding: d.bars.filter((b) => b.fundingPerHour != null).length,
        withPremium: d.bars.filter((b) => b.premium != null).length,
      };
    }),
    tests,
  };
}

// O período final é lacrado na B1: o dado nem é baixado. Este guarda existe
// para a B2 — e até lá, qualquer tentativa de abrir o holdout falha alto.
export const HOLDOUT_UNLOCK_PHRASE = 'YES-I-UNDERSTAND';
export function assertHoldoutSealed({ openHoldout, ruleFileSha256 } = {}) {
  if (openHoldout !== HOLDOUT_UNLOCK_PHRASE || !ruleFileSha256) {
    throw new Error('HOLDOUT_SEALED: o período final só abre na fase B2, com a frase de confirmação E um arquivo de regra única comitado (sha256 do resumo da B1).');
  }
  throw new Error('HOLDOUT_SEALED: a fase B2 ainda não existe — nada a calcular no período final.');
}

// ---------- texto para o resumo do job (português simples) ----------

const VERDICT_TEXT = {
  INCOMPLETE: '**Resultado inválido — faltou dado.** Algum sinal pré-registrado não teve moedas suficientes com dado para ser testado (lista abaixo). Isso NÃO conta como "não achei padrão" e NÃO vale como motivo para parar: a rodada precisa ser refeita depois de entender por que o dado faltou.',
  NO_SURVIVOR: '**Não achei padrão.** Nenhum dos sinais passou na régua da primeira fase. Pela regra combinada, o laboratório termina aqui.',
  FAILED_VALIDATION: '**Não achei padrão que se sustente.** Algum sinal passou na primeira fase, mas sumiu no período seguinte — sinal típico de acaso. Pela regra combinada, o laboratório termina aqui.',
  VALIDATED: '**Achei um candidato.** Pelo menos um sinal passou nas duas fases. Próximo passo (B2, só com sua aprovação): testar UMA regra simples com ele, uma única vez, no período lacrado, com custos e contra entradas aleatórias.',
};

export function formatPatternLabMarkdown(result, { preregSha256 = null, commitSha = null } = {}) {
  const f = (v, d = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const lines = [
    '',
    '## Laboratório de padrões — resultado',
    '',
    VERDICT_TEXT[result.verdict],
    '',
    ...(result.untested?.length
      ? [`Sem dado suficiente (mínimo ${result.minEligibleSymbols ?? '?'} moedas): `
        + result.untested.map((u) => `${u.test} na ${u.phase === 'discovery' ? 'descoberta' : 'validação'} (${u.eligibleSymbols} moeda(s))`).join(' · '), '']
      : []),
    `Testes gastos: ${result.testsSpent} (11 sinais × 2 horizontes).`
      + (commitSha ? ` Commit ${commitSha.slice(0, 7)}.` : '')
      + (preregSha256 ? ` Pré-registro sha256 ${preregSha256.slice(0, 12)}….` : ''),
    '',
    '### Fase 1 — descoberta (2021-12 → 2024-10)',
    '',
    '| Sinal | Horizonte | IC | t | p (Holm) | Mesmo sentido nos ativos | Meia-diferença (bps) | Passou? |',
    '|---|---|---|---|---|---|---|---|',
    ...result.tests.map((x) => {
      const d = x.discovery;
      return `| ${x.label} | ${x.horizonBars === 1 ? '4h' : '24h'} | ${f(d.ic, 4)} | ${f(d.t, 2)} | ${f(d.holmP)} | ${d.sameSignShare == null ? '—' : `${(d.sameSignShare * 100).toFixed(0)}% de ${d.eligibleSymbols}`} | ${f(d.halfSpreadBps, 1)} | ${d.pass ? '**sim**' : 'não'} |`;
    }),
    '',
  ];
  const validated = result.tests.filter((x) => x.validation);
  if (validated.length) {
    lines.push('### Fase 2 — validação (2024-11 → 2025-09), só para quem passou na fase 1', '',
      '| Sinal | Horizonte | IC | t | Passou? | Motivo |', '|---|---|---|---|---|---|',
      ...validated.map((x) => `| ${x.label} | ${x.horizonBars === 1 ? '4h' : '24h'} | ${f(x.validation.ic, 4)} | ${f(x.validation.t, 2)} | ${x.validation.pass ? '**sim**' : 'não'} | ${x.validation.reasons.join('; ') || '—'} |`),
      '');
  }
  lines.push(
    'Como ler: IC é a correlação entre o sinal e o retorno seguinte (0 = nenhuma relação). '
      + 'Para passar, o sinal precisa de t ≥ 3, sobreviver à correção por 22 testes (Holm), apontar para o mesmo lado na maioria das moedas '
      + 'e separar o retorno das velas mais altas e mais baixas do sinal em pelo menos 12 bps (o custo de ida e volta).',
    '',
    'Cobertura por moeda: '
      + result.coverage.map((c) => `${c.symbol} ${c.discoveryBars}/${c.validationBars} velas (descoberta/validação), ${c.withMetrics} com contratos em aberto`).join(' · '),
    '',
  );
  return lines.join('\n');
}
