// Teste pré-registrado de tendência diária EMA 10/21 + Supertrend(10,3) —
// docs/known-risks.md item 271. Parte pura (sem rede, sem Date.now); a CLI é
// scripts/daily-ema-supertrend.mjs.
//
// Regra (uma só, pré-registrada): no fechamento da vela diária t (UTC), fica
// comprado durante o dia t+1 se EMA10(close) > EMA21(close) E a
// Supertrend(10, 3) está de alta; senão fica de fora. Retorno do dia t+1 =
// fechamento t → fechamento t+1 (posição mantida sem interrupção; em mercado
// 24/7 a abertura de t+1 ≈ fechamento de t — review do Codex, PR #493). Custo
// por lado a cada troca. Sem add-back, sem parciais, sem alvo fixo.
//
// Hipótese nula e régua: as mesmas do item 268 (scripts/weeklyTrend.mjs) —
// deslocamento circular COMUM das posições contra os retornos, p exato, Holm
// entre carteira e BTC —, com alphaFamily pela metade porque é a 2ª tentativa
// da família de tendência nos mesmos dados.
import { ema } from '../src/lib/indicators/movingAverages.js';
import { calculateATRSeries } from '../src/lib/indicators/atr.js';
import { evaluateTiming, holmThresholds } from './weeklyTrend.mjs';

const DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365;

/**
 * Velas diárias fechadas até endMs, ordenadas e sem repetição de openTime.
 * @param {{ openTime: number, closeTime: number, open: number, high: number, low: number, close: number }[]} daily
 */
export function buildDays(daily, { endMs }) {
  const byOpen = new Map();
  for (const c of daily || []) {
    if (Number.isFinite(c?.openTime) && Number.isFinite(c?.closeTime) && c.closeTime <= endMs
      && [c.open, c.high, c.low, c.close].every(Number.isFinite)) byOpen.set(c.openTime, c);
  }
  return [...byOpen.keys()].sort((a, b) => a - b).map((t) => byOpen.get(t));
}

/**
 * Supertrend no padrão do `ta.supertrend` do Pine: hl2 ± fator·ATR (Wilder,
 * `calculateATRSeries`), bandas com "catraca" pelo close anterior e direção
 * decidida pela banda que a Supertrend ocupava na vela anterior. Na 1ª vela
 * com ATR a direção começa de baixa, como no Pine (`na(atr[1])`).
 * Causal: o valor da vela i só usa velas 0..i.
 * @returns {{ up: (boolean|null)[], line: (number|null)[] }} up = true quando de alta
 */
export function supertrend(candles, { atrPeriod, factor }) {
  const n = candles.length;
  const up = new Array(n).fill(null);
  const line = new Array(n).fill(null);
  const atr = calculateATRSeries(candles, atrPeriod);
  if (!atr.length) return { up, line };
  let upper = null;
  let lower = null;
  let prevLine = null;
  for (let i = atrPeriod - 1; i < n; i += 1) {
    const c = candles[i];
    const src = (c.high + c.low) / 2;
    const rawUpper = src + factor * atr[i];
    const rawLower = src - factor * atr[i];
    let isUp;
    if (upper === null) {
      upper = rawUpper;
      lower = rawLower;
      isUp = false;
    } else {
      const prevClose = candles[i - 1].close;
      const prevUpper = upper;
      const prevLower = lower;
      lower = rawLower > prevLower || prevClose < prevLower ? rawLower : prevLower;
      upper = rawUpper < prevUpper || prevClose > prevUpper ? rawUpper : prevUpper;
      isUp = prevLine === prevUpper ? c.close > upper : !(c.close < lower);
    }
    line[i] = isUp ? lower : upper;
    up[i] = isUp;
    prevLine = line[i];
  }
  return { up, line };
}

/**
 * Sinal no fechamento de cada vela: 1 = comprado no dia seguinte, 0 = fora,
 * null = indicadores ainda sem dado.
 */
export function dailySignals(days, { emaFast, emaSlow, stAtrPeriod, stFactor }) {
  const closes = days.map((d) => d.close);
  const fast = ema(closes, emaFast);
  const slow = ema(closes, emaSlow);
  const st = supertrend(days, { atrPeriod: stAtrPeriod, factor: stFactor });
  return days.map((_, i) => (st.up[i] === null ? null : (fast[i] > slow[i] && st.up[i] ? 1 : 0)));
}

/**
 * Regra espelhada de VENDA (item 274): −1 = vendido no dia seguinte quando
 * EMA10 < EMA21 E a Supertrend está de baixa; 0 = fora; null = sem dado.
 * Não é o "fora" da regra de compra: fora inclui os dias em que só uma das
 * duas condições virou (item 274 explica por que isso importa).
 */
export function dailyShortSignals(days, { emaFast, emaSlow, stAtrPeriod, stFactor }) {
  const closes = days.map((d) => d.close);
  const fast = ema(closes, emaFast);
  const slow = ema(closes, emaSlow);
  const st = supertrend(days, { atrPeriod: stAtrPeriod, factor: stFactor });
  return days.map((_, i) => (st.up[i] === null ? null : (fast[i] < slow[i] && !st.up[i] ? -1 : 0)));
}

/**
 * Posição e retorno de cada dia elegível de uma moeda. O dia j usa o sinal do
 * fechamento do dia anterior (j−1, que tem de existir e ser o dia de
 * calendário anterior) e o retorno fechamento de j−1 → fechamento de j.
 * Fechamento a fechamento, e não abertura → fechamento (review do Codex, PR
 * #493): com a posição mantida vários dias, só abertura → fechamento perderia
 * o trecho entre o fechamento e a abertura seguinte sem cobrar saída e
 * reentrada — uma estratégia híbrida impossível.
 * `weekStart` é a chave do período esperada por evaluateTiming (aqui, o
 * início do dia).
 */
export function symbolDailySeries(days, signals, { startMs, endMs, warmupDays }) {
  const out = [];
  for (let j = Math.max(1, warmupDays); j < days.length; j += 1) {
    const d = days[j];
    const prev = days[j - 1];
    if (d.openTime < startMs || d.closeTime > endMs) continue;
    if (prev.openTime !== d.openTime - DAY || signals[j - 1] === null) continue;
    out.push({ weekStart: d.openTime, pos: signals[j - 1], ret: d.close / prev.close - 1 });
  }
  return out;
}

const inRange = (entries, from, to) => entries.filter((e) => e.weekStart >= from && e.weekStart + DAY - 1 <= to);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function sharpe(daily) {
  const xs = daily.map((d) => d.ret);
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(DAYS_PER_YEAR) : null;
}

// Retorno composto ao ano da carteira de peso igual rebalanceada todo dia.
function cagr(daily) {
  if (!daily.length) return null;
  const equity = daily.reduce((acc, d) => acc * (1 + d.ret), 1);
  return equity > 0 ? equity ** (DAYS_PER_YEAR / daily.length) - 1 : -1;
}

// Trocas de posição (entrada ou saída) dentro da série da moeda.
function switchesOf(entries) {
  let n = 0;
  for (let j = 1; j < entries.length; j += 1) n += Math.abs(entries[j].pos - entries[j - 1].pos);
  return n;
}

function maxDrawdown(daily) {
  let equity = 1; let peak = 1; let dd = 0;
  for (const d of daily) {
    equity *= 1 + d.ret;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, (peak - equity) / peak);
  }
  return dd;
}

/**
 * @param {Record<string, object[]>} dailyBySymbol velas diárias por símbolo
 * @param {object} prereg docs/experiments/daily-ema-supertrend-prereg.json (item 271) ou
 *   daily-ema-supertrend-replication-prereg.json (item 272, sem co-primário)
 * @param {{ descriptive?: boolean }} [options] descriptive:false pula a parte
 *   descritiva (só a calibração sintética usa, para rodar mais rápido)
 */
export function runDailyTrend(dailyBySymbol, prereg, { descriptive = true } = {}) {
  // `side: 'short'` (item 274) troca só a regra de posição; sem o campo, é a
  // regra de compra dos itens 271/272, byte a byte.
  const short = prereg.side === 'short';
  const signalsOf = short ? dailyShortSignals : dailySignals;
  const startMs = Date.parse(prereg.start);
  const endMs = Date.parse(prereg.end);
  const costPerSide = prereg.costBpsPerSide / 10000;
  const opts = { minShift: prereg.minShiftDays, costPerSide, periodsPerYear: DAYS_PER_YEAR };
  const baseParams = { emaFast: prereg.emaFast, emaSlow: prereg.emaSlow, stAtrPeriod: prereg.stAtrPeriod, stFactor: prereg.stFactor };
  const daysCache = new Map();
  const daysOf = (symbol) => {
    if (!daysCache.has(symbol)) daysCache.set(symbol, buildDays(dailyBySymbol[symbol], { endMs }));
    return daysCache.get(symbol);
  };
  const entriesCache = new Map();
  const entriesOf = (symbol, params) => {
    const key = `${symbol}|${JSON.stringify(params)}`;
    if (!entriesCache.has(key)) {
      const days = daysOf(symbol);
      entriesCache.set(key, symbolDailySeries(days, signalsOf(days, params), { startMs, endMs, warmupDays: prereg.warmupDaysAfterListing }));
    }
    return entriesCache.get(key);
  };
  const has = (s) => dailyBySymbol[s]?.length > 0;
  const seriesOf = (symbol, params = baseParams, range = { from: startMs, to: endMs }) => ({
    symbol, entries: inRange(entriesOf(symbol, params), range.from, range.to),
  });

  // Dado faltando ou cortado invalida a rodada (não vira "não achei"), como no 268.
  const expectedLastDay = endMs + 1 - DAY;
  const coverage = {};
  const untested = [];
  // Item 274 (tempo novo, 2 anos): moeda que para de ser negociada antes do
  // fim sai da carteira inteira (não só do pedaço depois da deslistagem), até
  // `maxDelisted` moedas. Sem o campo, terminar antes do fim invalida a rodada,
  // como nos itens 271/272.
  const delistRule = Number.isInteger(prereg.maxDelisted);
  const delisted = [];
  for (const symbol of prereg.primarySymbols) {
    if (!has(symbol)) { untested.push(`${symbol}: sem dado`); continue; }
    const entries = seriesOf(symbol).entries;
    const first = entries[0]?.weekStart ?? null;
    const last = entries.at(-1)?.weekStart ?? null;
    const present = new Set(daysOf(symbol).map((d) => d.openTime));
    let missingDays = 0;
    if (first != null) for (let t = first; t <= last; t += DAY) if (!present.has(t)) missingDays += 1;
    coverage[symbol] = { days: entries.length, first: first && new Date(first).toISOString(), last: last && new Date(last).toISOString(), missingDays };
    if (delistRule && last != null && last < expectedLastDay) delisted.push(symbol);
    else if (entries.length < 2 * prereg.minShiftDays + 2) untested.push(`${symbol}: só ${entries.length} dias utilizáveis`);
    else if (last !== expectedLastDay) untested.push(`${symbol}: termina em ${new Date(last).toISOString().slice(0, 10)}, antes do fim pré-registrado`);
    else if (missingDays > prereg.maxMissingDays) untested.push(`${symbol}: ${missingDays} dias faltando no meio (máximo ${prereg.maxMissingDays})`);
  }
  if (delisted.length > (prereg.maxDelisted ?? 0)) {
    untested.push(`${delisted.length} moedas terminam antes do fim pré-registrado (máximo ${prereg.maxDelisted}): ${delisted.join(', ')}`);
  }
  const active = (s) => has(s) && !delisted.includes(s);
  const startIso = new Date(startMs).toISOString();
  if (prereg.coPrimarySymbol) {
    const btc = coverage[prereg.coPrimarySymbol];
    if (btc && btc.days < prereg.minCoPrimaryDays) untested.push(`${prereg.coPrimarySymbol}: ${btc.days} dias (mínimo ${prereg.minCoPrimaryDays})`);
    if (btc && btc.first !== startIso) untested.push(`${prereg.coPrimarySymbol}: começa em ${btc.first?.slice(0, 10)}, depois do início pré-registrado`);
  } else {
    // Sem co-primário (replicação, item 272): a moeda mais antiga da carteira
    // tem de cobrir o início — senão o dado baixado está cortado no começo.
    const firsts = Object.values(coverage).map((c) => c.first).filter(Boolean).sort();
    if (firsts.length && firsts[0] !== startIso) untested.push(`carteira: a moeda mais antiga começa em ${firsts[0].slice(0, 10)}, depois do início pré-registrado`);
  }

  const halves = prereg.halves.map((h) => ({ from: Date.parse(h.from), to: Date.parse(h.to) }));
  const coPrimaries = [
    { name: 'carteira', symbols: prereg.primarySymbols },
    ...(prereg.coPrimarySymbol ? [{ name: prereg.coPrimarySymbol, symbols: [prereg.coPrimarySymbol] }] : []),
  ];
  const tests = coPrimaries.map((cp) => {
    const symbols = cp.symbols.filter(active);
    const full = evaluateTiming(symbols.map((s) => seriesOf(s)), opts);
    const byHalf = halves.map((h) => {
      const r = evaluateTiming(symbols.map((s) => seriesOf(s, baseParams, h)), opts);
      return { from: new Date(h.from).toISOString(), to: new Date(h.to).toISOString(), observed: r.observed, nullMedian: r.nullMedian ?? null, p: r.p ?? null, days: r.weeks ?? 0, beatsNullMedian: r.observed != null && r.observed > r.nullMedian };
    });
    return { ...cp, full, byHalf };
  });
  const holm = holmThresholds(tests.map((t) => t.full.p ?? 1), prereg.alphaFamily);
  for (const [i, t] of tests.entries()) {
    t.holm = holm[i];
    t.halvesPass = t.byHalf.every((h) => h.beatsNullMedian);
    t.effectPass = Number.isFinite(t.full.excessAnnual) && t.full.excessAnnual >= prereg.minAnnualExcess;
    // Item 274 (venda): ganhar de vender em dias sorteados não basta — num
    // mercado que sobe, a venda pode bater o sorteio e ainda perder dinheiro.
    if (prereg.requirePositiveNet) t.netPass = Number.isFinite(t.full.observed) && t.full.observed > 0;
    t.pass = t.holm.pass && t.halvesPass && t.effectPass && t.netPass !== false;
  }

  let verdict = 'NO_TREND_EDGE';
  if (untested.length) verdict = 'INCOMPLETE';
  else if (tests.some((t) => t.pass)) verdict = 'TREND_FOUND';

  const strip = ({ observedWeekly, weeks, ...rest }) => ({ ...rest, days: weeks });
  const result = {
    title: prereg.title ?? null,
    ...(short ? { side: 'short' } : {}),
    ...(delistRule ? { delisted } : {}),
    verdict,
    untested,
    coverage,
    tests: tests.map((t) => ({ name: t.name, symbols: t.symbols, full: strip(t.full), byHalf: t.byHalf, holm: t.holm, halvesPass: t.halvesPass, effectPass: t.effectPass, ...(t.netPass !== undefined ? { netPass: t.netPass } : {}), pass: t.pass })),
  };
  if (!descriptive) return result;

  // Descritivo (não decide nada).
  const portfolioSymbols = prereg.primarySymbols.filter(active);
  const portfolioSeries = portfolioSymbols.map((s) => seriesOf(s));
  const strategyDaily = tests[0].full.observedWeekly || [];
  const buyHoldDaily = evaluateTiming(portfolioSeries, { ...opts, transform: () => 1 }).observedWeekly || [];
  // Comprado/vendido só faz sentido para a regra de compra (0/1 → −1/+1).
  const longShort = short ? null : evaluateTiming(portfolioSeries, { ...opts, transform: (p) => 2 * p - 1 });
  const shortHoldDaily = short ? evaluateTiming(portfolioSeries, { ...opts, transform: () => -1 }).observedWeekly || [] : null;
  // Custo maior que o pré-registrado (a taxa de taker do Spot é ~10 bps por lado).
  // Recalcula também o excesso e o p: por moeda, toda rotação paga o mesmo
  // número de trocas (custo circular de evaluateTiming), mas na carteira as
  // moedas entram em datas diferentes e o peso de cada dia muda (1/moedas
  // ativas) — deslocar as trocas entre dias de peso diferente muda o custo da
  // nula (review do Codex, PR #495). Não decide nada.
  const costSensitivity = (prereg.costSensitivityBps || []).map((bps) => {
    const r = evaluateTiming(portfolioSeries, { ...opts, costPerSide: bps / 10000 });
    return { bpsPerSide: bps, meanDaily: r.observed, cagr: cagr(r.observedWeekly || []), nullMedian: r.nullMedian ?? null, excessAnnual: r.excessAnnual ?? null, p: r.p ?? null };
  });
  const years = (endMs + 1 - startMs) / (DAYS_PER_YEAR * DAY);
  const robustness = (prereg.robustness || []).map((v) => {
    const { label, ...overrides } = v;
    const params = { ...baseParams, ...overrides };
    const r = evaluateTiming(portfolioSymbols.map((s) => seriesOf(s, params)), opts);
    return { label, params, observed: r.observed, nullMedian: r.nullMedian ?? null, excessAnnual: r.excessAnnual ?? null, p: r.p ?? null };
  });
  const perSymbol = [...prereg.primarySymbols, ...prereg.descriptiveSymbols].filter(active).map((symbol) => {
    const s = seriesOf(symbol);
    const r = evaluateTiming([s], opts);
    return {
      symbol,
      days: s.entries.length,
      exposure: s.entries.length ? mean(s.entries.map((e) => Math.abs(e.pos))) : null,
      switches: switchesOf(s.entries),
      observed: r.observed,
      nullMedian: r.nullMedian ?? null,
      p: r.p ?? null,
      buyHoldMean: s.entries.length ? mean(s.entries.map((e) => e.ret)) : null,
      descriptiveOnly: prereg.descriptiveSymbols.includes(symbol),
    };
  });
  const perSymbolPrimary = perSymbol.filter((x) => !x.descriptiveOnly);
  const switchesPerYear = perSymbolPrimary.length
    ? mean(perSymbolPrimary.map((x) => (x.days ? x.switches / (x.days / DAYS_PER_YEAR) : 0)))
    : null;
  result.descriptive = {
    switchesPerSymbolYear: switchesPerYear,
    years,
    strategy: { sharpe: sharpe(strategyDaily), maxDrawdown: maxDrawdown(strategyDaily), meanDaily: mean(strategyDaily.map((d) => d.ret)), exposure: mean(strategyDaily.map((d) => d.exposure)), cagr: cagr(strategyDaily) },
    buyAndHold: { sharpe: sharpe(buyHoldDaily), maxDrawdown: maxDrawdown(buyHoldDaily), meanDaily: mean(buyHoldDaily.map((d) => d.ret)), cagr: cagr(buyHoldDaily) },
    longShort: longShort ? { observed: longShort.observed, p: longShort.p ?? null } : null,
    ...(short ? { shortAndHold: { sharpe: sharpe(shortHoldDaily), maxDrawdown: maxDrawdown(shortHoldDaily), meanDaily: mean(shortHoldDaily.map((d) => d.ret)), cagr: cagr(shortHoldDaily) } } : {}),
    costSensitivity,
    robustness,
    perSymbol,
  };
  return result;
}

const VERDICT_TEXT = {
  TREND_FOUND: '**Achei tendência diária (EMA 10/21 + Supertrend) que sobrevive à régua pré-registrada.** O próximo passo é decisão do usuário, registrada no item do pré-registro em docs/known-risks.md.',
  NO_TREND_EDGE: '**Não achei vantagem na tendência diária EMA 10/21 + Supertrend.** A regra não ganhou do mesmo tempo comprado em dias embaralhados, com folga e nas duas metades.',
  INCOMPLETE: '**Resultado inválido — faltou dado.** Não conta como resposta; a rodada precisa ser refeita.',
};

const VERDICT_TEXT_SHORT = {
  TREND_FOUND: '**A venda espelhada passou na régua pré-registrada:** vender nos dias de tendência de baixa ganhou de vender em dias sorteados, com folga e nas duas metades, e deu retorno líquido positivo. Ressalva: sem o custo de funding de Futuros. O próximo passo é decisão do usuário.',
  NO_TREND_EDGE: '**A venda espelhada não passou.** Vender nos dias de tendência de baixa não ganhou de vender em dias sorteados com folga e nas duas metades, ou não deu retorno líquido positivo.',
  INCOMPLETE: VERDICT_TEXT.INCOMPLETE,
};

export function formatDailyTrendMarkdown(r) {
  const pct = (v, d = 3) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
  const f = (v, d = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const short = r.side === 'short';
  const heading = short ? 'Venda espelhada diária (EMA10 < EMA21 e Supertrend de baixa)' : 'Tendência diária EMA 10/21 + Supertrend (10,3)';
  const lines = ['', `## ${heading}${r.title ? ` — ${r.title}` : ''} — resultado`, '', (short ? VERDICT_TEXT_SHORT : VERDICT_TEXT)[r.verdict], ''];
  if (r.untested.length) lines.push(`Faltou: ${r.untested.join(' · ')}`, '');
  if (r.delisted?.length) lines.push(`Deslistadas antes do fim (fora da carteira inteira, regra pré-registrada): ${r.delisted.join(', ')}.`, '');
  lines.push(
    '| Teste | Dias | Retorno líquido médio/dia | Mediana embaralhada | Excesso ao ano | p | Limiar (Holm) | Metades | Passou? |',
    '|---|---|---|---|---|---|---|---|---|',
    ...r.tests.map((t) => `| ${t.name} | ${t.full.days ?? '—'} | ${pct(t.full.observed, 4)} | ${pct(t.full.nullMedian, 4)} | ${pct(t.full.excessAnnual, 1)} | ${f(t.full.p, 4)} | ${f(t.holm.threshold, 4)} | ${t.byHalf.map((h) => (h.beatsNullMedian ? 'sim' : 'não')).join(' / ')} | ${t.pass ? '**sim**' : 'não'} |`),
    '',
  );
  if (r.tests.some((t) => t.netPass !== undefined)) lines.push(`Retorno líquido positivo (exigido para a venda): ${r.tests.map((t) => `${t.name} ${t.netPass ? 'sim' : 'não'}`).join(' · ')}.`, '');
  if (r.descriptive) {
    const d = r.descriptive;
    const ref = short ? d.shortAndHold : d.buyAndHold;
    lines.push(
      `Carteira (descritivo): Sharpe da regra ${f(d.strategy.sharpe, 2)} × ${short ? 'vender e segurar' : 'comprar e segurar'} ${f(ref.sharpe, 2)}; `
        + `queda máxima ${pct(d.strategy.maxDrawdown, 1)} × ${pct(ref.maxDrawdown, 1)}; tempo ${short ? 'vendido' : 'comprado'} ${pct(d.strategy.exposure, 0)}; `
        + `retorno composto ao ano ${pct(d.strategy.cagr, 1)} × ${pct(ref.cagr, 1)}.`
        + (short ? ` Comprar e segurar no mesmo período: composto ${pct(d.buyAndHold.cagr, 1)}/ano.` : ''),
      `Trocas de posição: ${f(d.switchesPerSymbolYear, 1)} por moeda por ano.`
        + (d.costSensitivity.length ? ' Com custo maior (descritivo, não decide): ' + d.costSensitivity.map((c) => `${c.bpsPerSide} bps/lado → líquido ${pct(c.meanDaily, 4)}/dia, composto ${pct(c.cagr, 1)}/ano, excesso ${pct(c.excessAnnual, 1)}/ano (p ${f(c.p, 4)})`).join(' · ') : ''),
      ...(d.longShort ? [`Comprado/vendido (descritivo): p ${f(d.longShort.p, 4)}.`] : []),
      '',
      'Vizinhos de robustez (descritivo, não decidem nada): ' + d.robustness.map((v) => `${v.label}: excesso ${pct(v.excessAnnual, 1)}/ano (p ${f(v.p, 3)})`).join(' · '),
      '',
      'Por moeda: ' + d.perSymbol.map((s) => `${s.symbol}${s.descriptiveOnly ? ' (só descritivo)' : ''} ${pct(s.observed, 4)} × ${pct(s.nullMedian, 4)} (p ${f(s.p, 3)}, ${s.days} dias, ${s.switches} trocas)`).join(' · '),
      '',
    );
  }
  return lines.join('\n');
}
