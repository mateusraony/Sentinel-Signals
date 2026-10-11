// Teste pré-registrado de tendência semanal — docs/known-risks.md item 268.
// Parte pura (sem rede, sem Date.now); a CLI é scripts/weekly-trend.mjs.
//
// Regra (uma só, pré-registrada): na segunda 00:00 UTC, se a semana anterior
// subiu (fechamento de domingo ÷ fechamento do domingo anterior > 1), fica
// comprado a semana inteira, da abertura de segunda ao fechamento de domingo;
// se não, fica de fora. Custo por lado a cada troca.
//
// Hipótese nula: deslocamento circular COMUM k das posições em relação aos
// retornos — o MESMO k para todas as moedas do teste (review do Codex, PR
// #488), por isso k vai de mín a (n da série mais curta − mín). Todo k nesse
// intervalo é enumerado: p exato, sem seed. O custo é contado de forma
// circular (a 1ª semana compara com a última), o que deixa o número de trocas
// — e o custo — idêntico em toda rotação; só o momento muda.
import { distribution } from './randomBaselineSummary.mjs';

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

const firstMondayAtOrAfter = (ms) => {
  const dayStart = Math.floor(ms / DAY) * DAY;
  const dow = new Date(dayStart).getUTCDay();
  return dayStart + ((1 - dow + 7) % 7) * DAY;
};

/**
 * Semanas cheias (segunda→domingo) a partir de velas diárias. Só conta a
 * semana com as 7 velas presentes (indexadas por openTime) e fechadas até endMs.
 * @param {{ openTime: number, closeTime: number, open: number, close: number }[]} daily
 */
export function buildWeeks(daily, { endMs }) {
  const byOpen = new Map();
  for (const c of daily || []) {
    if (Number.isFinite(c?.openTime) && Number.isFinite(c?.closeTime) && c.closeTime <= endMs
      && Number.isFinite(c.open) && Number.isFinite(c.close)) byOpen.set(c.openTime, c);
  }
  const opens = [...byOpen.keys()].sort((a, b) => a - b);
  if (!opens.length) return [];
  const weeks = [];
  const lastOpen = opens[opens.length - 1];
  for (let monday = firstMondayAtOrAfter(opens[0]); monday + 6 * DAY <= lastOpen; monday += WEEK) {
    const days = [];
    for (let d = 0; d < 7; d += 1) {
      const c = byOpen.get(monday + d * DAY);
      if (!c) break;
      days.push(c);
    }
    if (days.length === 7) weeks.push({ weekStart: monday, open: days[0].open, close: days[6].close });
  }
  return weeks;
}

/**
 * Posição e retorno de cada semana elegível de uma moeda.
 * Elegível: semana cheia dentro de [startMs, endMs], depois das primeiras
 * `excludeWeeks` semanas cheias desde a listagem, com as semanas t−1 e
 * t−1−lookback também cheias (o sinal só usa o que já fechou).
 */
export function symbolSeries(weeks, { startMs, endMs, lookbackWeeks, excludeWeeks }) {
  if (!weeks.length) return [];
  const byStart = new Map(weeks.map((w) => [w.weekStart, w]));
  const firstEligible = weeks[0].weekStart + excludeWeeks * WEEK;
  const out = [];
  for (const w of weeks) {
    if (w.weekStart < startMs || w.weekStart + WEEK - 1 > endMs || w.weekStart < firstEligible) continue;
    const prev = byStart.get(w.weekStart - WEEK);
    const base = byStart.get(w.weekStart - (1 + lookbackWeeks) * WEEK);
    if (!prev || !base) continue;
    out.push({ weekStart: w.weekStart, pos: prev.close / base.close - 1 > 0 ? 1 : 0, ret: w.close / w.open - 1 });
  }
  return out;
}

// Retorno líquido semanal de uma moeda; `posOf(j)` dá a posição usada na semana j.
// Custo circular: a semana 0 compara com a última (n−1). Assim toda rotação
// das posições paga exatamente o mesmo custo (review do Codex, PR #488); na
// série real a diferença é no máximo uma troca em ~400 semanas.
function netSeries(entries, posOf, costPerSide) {
  let prev = entries.length ? posOf(entries.length - 1) : 0;
  return entries.map((e, j) => {
    const pos = posOf(j);
    const net = pos * e.ret - costPerSide * Math.abs(pos - prev);
    prev = pos;
    return { weekStart: e.weekStart, net, pos };
  });
}

// Média semanal de peso igual entre as moedas com semana válida.
function portfolioWeekly(netsBySymbol) {
  const byWeek = new Map();
  for (const nets of netsBySymbol) {
    for (const x of nets) {
      const acc = byWeek.get(x.weekStart) || { sum: 0, count: 0, exposure: 0 };
      acc.sum += x.net; acc.count += 1; acc.exposure += Math.abs(x.pos);
      byWeek.set(x.weekStart, acc);
    }
  }
  return [...byWeek.entries()].sort(([a], [b]) => a - b)
    .map(([weekStart, a]) => ({ weekStart, ret: a.sum / a.count, exposure: a.exposure / a.count }));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function sharpe(weekly) {
  const xs = weekly.map((w) => w.ret);
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(52) : null;
}

function maxDrawdown(weekly) {
  let equity = 1; let peak = 1; let dd = 0;
  for (const w of weekly) {
    equity *= 1 + w.ret;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, (peak - equity) / peak);
  }
  return dd;
}

/**
 * Estatística observada × nula de deslocamento circular comum.
 * @param {{ symbol: string, entries: { weekStart: number, pos: number, ret: number }[] }[]} series
 */
export function evaluateTiming(series, { minShift, costPerSide, transform = (p) => p }) {
  const usable = series.filter((s) => s.entries.length >= 2 * minShift + 2);
  const dropped = series.filter((s) => s.entries.length < 2 * minShift + 2).map((s) => s.symbol);
  if (!usable.length) return { usable: [], dropped, observed: null };
  const statFor = (k) => {
    const nets = usable.map((s) => {
      const n = s.entries.length;
      return netSeries(s.entries, (j) => transform(s.entries[(j + k) % n].pos), costPerSide);
    });
    return portfolioWeekly(nets);
  };
  const observedWeekly = statFor(0);
  const observed = mean(observedWeekly.map((w) => w.ret));
  // Mesmo k para todas: limitado pela série mais curta, para nenhuma precisar
  // "dar a volta" num deslocamento diferente.
  const nMin = Math.min(...usable.map((s) => s.entries.length));
  const nullStats = [];
  for (let k = minShift; k <= nMin - minShift; k += 1) nullStats.push(mean(statFor(k).map((w) => w.ret)));
  const atLeast = nullStats.filter((v) => v >= observed).length;
  const nullDist = distribution(nullStats);
  return {
    usable: usable.map((s) => s.symbol),
    dropped,
    weeks: observedWeekly.length,
    observed,
    nullMedian: nullDist.p50,
    nullDistribution: nullDist,
    shifts: nullStats.length,
    p: (1 + atLeast) / (1 + nullStats.length),
    excessAnnual: (observed - nullDist.p50) * 52,
    observedWeekly,
  };
}

const inRange = (entries, from, to) => entries.filter((e) => e.weekStart >= from && e.weekStart + WEEK - 1 <= to);

// Holm para uma família pequena: devolve o limiar de cada p (na ordem dada).
export function holmThresholds(ps, alpha) {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array(ps.length);
  let stillRejecting = true;
  order.forEach(({ p, i }, rank) => {
    const threshold = alpha / (ps.length - rank);
    const pass = stillRejecting && p <= threshold;
    if (!pass) stillRejecting = false;
    out[i] = { threshold, pass };
  });
  return out;
}

/**
 * @param {Record<string, object[]>} dailyBySymbol velas diárias por símbolo
 * @param {object} prereg docs/experiments/weekly-trend-prereg.json
 */
export function runWeeklyTrend(dailyBySymbol, prereg) {
  const startMs = Date.parse(prereg.start);
  const endMs = Date.parse(prereg.end);
  const costPerSide = prereg.costBpsPerSide / 10000;
  const opts = { minShift: prereg.minShiftWeeks, costPerSide };
  const seriesOf = (symbol, lookbackWeeks, range = { from: startMs, to: endMs }) => ({
    symbol,
    entries: inRange(symbolSeries(buildWeeks(dailyBySymbol[symbol], { endMs }), {
      startMs, endMs, lookbackWeeks, excludeWeeks: prereg.excludeWeeksAfterListing,
    }), range.from, range.to),
  });

  // Dado faltando ou cortado invalida a rodada (não vira "não achei") —
  // review do Codex, PR #488: arquivo não vazio mas truncado também conta.
  const expectedLastWeek = Math.floor((endMs + 1 - WEEK - startMs) / WEEK) * WEEK + startMs;
  const coverage = {};
  const untested = [];
  for (const symbol of prereg.primarySymbols) {
    if (!dailyBySymbol[symbol]?.length) { untested.push(`${symbol}: sem dado`); continue; }
    const entries = seriesOf(symbol, prereg.lookbackWeeks).entries;
    const first = entries[0]?.weekStart ?? null;
    const last = entries.at(-1)?.weekStart ?? null;
    // Semanas de calendário incompletas (falta alguma vela diária) entre a
    // primeira e a última semana usada. Um dia faltando conta 1 aqui, embora
    // tire até 3 semanas da série (a própria e as duas que a usam como sinal).
    const present = new Set(buildWeeks(dailyBySymbol[symbol], { endMs }).map((w) => w.weekStart));
    let missingWeeks = 0;
    if (first != null) for (let w = first; w <= last; w += WEEK) if (!present.has(w)) missingWeeks += 1;
    coverage[symbol] = { weeks: entries.length, first: first && new Date(first).toISOString(), last: last && new Date(last).toISOString(), missingWeeks };
    if (entries.length < 2 * prereg.minShiftWeeks + 2) untested.push(`${symbol}: só ${entries.length} semanas utilizáveis`);
    else if (last !== expectedLastWeek) untested.push(`${symbol}: termina em ${new Date(last).toISOString().slice(0, 10)}, antes do fim pré-registrado`);
    else if (missingWeeks > prereg.maxMissingWeeks) untested.push(`${symbol}: ${missingWeeks} semanas faltando no meio (máximo ${prereg.maxMissingWeeks})`);
  }
  const btc = coverage[prereg.coPrimarySymbol];
  if (btc && btc.weeks < prereg.minCoPrimaryWeeks) untested.push(`${prereg.coPrimarySymbol}: ${btc.weeks} semanas (mínimo ${prereg.minCoPrimaryWeeks})`);
  if (btc && btc.first !== new Date(startMs).toISOString()) untested.push(`${prereg.coPrimarySymbol}: começa em ${btc.first?.slice(0, 10)}, depois do início pré-registrado`);

  const halves = prereg.halves.map((h) => ({ from: Date.parse(h.from), to: Date.parse(h.to) }));
  const coPrimaries = [
    { name: 'carteira', symbols: prereg.primarySymbols },
    { name: prereg.coPrimarySymbol, symbols: [prereg.coPrimarySymbol] },
  ];
  const tests = coPrimaries.map((cp) => {
    const full = evaluateTiming(cp.symbols.filter((s) => dailyBySymbol[s]?.length).map((s) => seriesOf(s, prereg.lookbackWeeks)), opts);
    const byHalf = halves.map((h) => {
      const r = evaluateTiming(cp.symbols.filter((s) => dailyBySymbol[s]?.length).map((s) => seriesOf(s, prereg.lookbackWeeks, h)), opts);
      return { from: new Date(h.from).toISOString(), to: new Date(h.to).toISOString(), observed: r.observed, nullMedian: r.nullMedian, p: r.p ?? null, weeks: r.weeks ?? 0, beatsNullMedian: r.observed != null && r.observed > r.nullMedian };
    });
    return { ...cp, full, byHalf };
  });
  const holm = holmThresholds(tests.map((t) => t.full.p ?? 1), prereg.alphaFamily);
  for (const [i, t] of tests.entries()) {
    t.holm = holm[i];
    t.halvesPass = t.byHalf.every((h) => h.beatsNullMedian);
    t.effectPass = Number.isFinite(t.full.excessAnnual) && t.full.excessAnnual >= prereg.minAnnualExcess;
    t.pass = t.holm.pass && t.halvesPass && t.effectPass;
  }

  // Descritivo (não decide nada).
  const portfolioSeries = prereg.primarySymbols.filter((s) => dailyBySymbol[s]?.length).map((s) => seriesOf(s, prereg.lookbackWeeks));
  const strategyWeekly = tests[0].full.observedWeekly || [];
  const buyHoldWeekly = portfolioWeekly(portfolioSeries.map((s) => netSeries(s.entries, () => 1, costPerSide)));
  const longShort = evaluateTiming(portfolioSeries, { ...opts, transform: (p) => 2 * p - 1 });
  const lookback4 = evaluateTiming(prereg.primarySymbols.filter((s) => dailyBySymbol[s]?.length).map((s) => seriesOf(s, prereg.secondaryLookbackWeeks)), opts);
  const perSymbol = [...prereg.primarySymbols, ...prereg.descriptiveSymbols].filter((s) => dailyBySymbol[s]?.length).map((symbol) => {
    const r = evaluateTiming([seriesOf(symbol, prereg.lookbackWeeks)], opts);
    const entries = seriesOf(symbol, prereg.lookbackWeeks).entries;
    return {
      symbol,
      weeks: entries.length,
      exposure: entries.length ? mean(entries.map((e) => e.pos)) : null,
      observed: r.observed,
      nullMedian: r.nullMedian ?? null,
      p: r.p ?? null,
      buyHoldMean: entries.length ? mean(entries.map((e) => e.ret)) : null,
      descriptiveOnly: prereg.descriptiveSymbols.includes(symbol),
    };
  });

  let verdict = 'NO_TREND_EDGE';
  if (untested.length) verdict = 'INCOMPLETE';
  else if (tests.some((t) => t.pass)) verdict = 'TREND_FOUND';

  const strip = ({ observedWeekly, ...rest }) => rest;
  return {
    verdict,
    untested,
    coverage,
    tests: tests.map((t) => ({ name: t.name, symbols: t.symbols, full: strip(t.full), byHalf: t.byHalf, holm: t.holm, halvesPass: t.halvesPass, effectPass: t.effectPass, pass: t.pass })),
    descriptive: {
      strategy: { sharpe: sharpe(strategyWeekly), maxDrawdown: maxDrawdown(strategyWeekly), meanWeekly: mean(strategyWeekly.map((w) => w.ret)), exposure: mean(strategyWeekly.map((w) => w.exposure)) },
      buyAndHold: { sharpe: sharpe(buyHoldWeekly), maxDrawdown: maxDrawdown(buyHoldWeekly), meanWeekly: mean(buyHoldWeekly.map((w) => w.ret)) },
      longShort: { observed: longShort.observed, p: longShort.p ?? null },
      lookback4: { observed: lookback4.observed, nullMedian: lookback4.nullMedian ?? null, p: lookback4.p ?? null },
      perSymbol,
    },
  };
}

const VERDICT_TEXT = {
  TREND_FOUND: '**Achei tendência semanal que sobrevive à régua pré-registrada.** Próximo passo (só com sua aprovação): decidir como mostrar isso no painel.',
  NO_TREND_EDGE: '**Não achei vantagem na tendência semanal.** A regra não ganhou do mesmo tempo comprado em semanas embaralhadas, com folga e nas duas metades.',
  INCOMPLETE: '**Resultado inválido — faltou dado.** Não conta como resposta; a rodada precisa ser refeita.',
};

export function formatWeeklyTrendMarkdown(r) {
  const pct = (v, d = 3) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
  const f = (v, d = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const lines = ['', '## Tendência semanal — resultado', '', VERDICT_TEXT[r.verdict], ''];
  if (r.untested.length) lines.push(`Faltou: ${r.untested.join(' · ')}`, '');
  lines.push(
    '| Teste | Semanas | Retorno líquido médio/semana | Mediana embaralhada | Excesso ao ano | p | Limiar (Holm) | Metades | Passou? |',
    '|---|---|---|---|---|---|---|---|---|',
    ...r.tests.map((t) => `| ${t.name} | ${t.full.weeks ?? '—'} | ${pct(t.full.observed)} | ${pct(t.full.nullMedian)} | ${pct(t.full.excessAnnual, 1)} | ${f(t.full.p, 4)} | ${f(t.holm.threshold, 4)} | ${t.byHalf.map((h) => (h.beatsNullMedian ? 'sim' : 'não')).join(' / ')} | ${t.pass ? '**sim**' : 'não'} |`),
    '',
    `Carteira (descritivo): Sharpe da regra ${f(r.descriptive.strategy.sharpe, 2)} × comprar e segurar ${f(r.descriptive.buyAndHold.sharpe, 2)}; `
      + `queda máxima ${pct(r.descriptive.strategy.maxDrawdown, 1)} × ${pct(r.descriptive.buyAndHold.maxDrawdown, 1)}; tempo comprado ${pct(r.descriptive.strategy.exposure, 0)}.`,
    `Olhando 4 semanas (descritivo): p ${f(r.descriptive.lookback4.p, 4)}. Comprado/vendido (descritivo): p ${f(r.descriptive.longShort.p, 4)}.`,
    '',
    'Por moeda: ' + r.descriptive.perSymbol.map((s) => `${s.symbol}${s.descriptiveOnly ? ' (só descritivo)' : ''} ${pct(s.observed)} × ${pct(s.nullMedian)} (p ${f(s.p, 3)}, ${s.weeks} semanas)`).join(' · '),
    '',
  );
  return lines.join('\n');
}
