// Aba "Ajuste Fino (What-If)" — lógica PURA (sem React, sem rede, sem banco): histórico dos testes, comparação com o padrão e margem de ruído, conferência dos
// candles, análise de sensibilidade e os dados dos gráficos. O motor da simulação continua em quickBacktest.js; nada aqui toca scanner, banco ou ordens.
// O histórico guarda só PARÂMETROS e RESUMOS (números) no navegador do usuário — não grava no Postgres (conveniência pessoal, não dado de negócio).
import { calcRealizedR, classifyOutcome } from './tradeMetrics';
import { calculateAtrPctSmooth, classifyTier } from './indicators/tier';

// regime e timeStop são interruptores (0/1) guardados junto dos números: entram na identidade, no histórico e na comparação como qualquer parâmetro.
// trail (0/1) liga o trailing do stop antes do TP1; trailStart/trailDist (em × ATR) só valem com ele ligado.
// runnerTrail (0/1) liga o trailing do stop do runner depois do TP1 (runnerTrailDist em × ATR); runnerRf (0/1) liga a saída do runner pelo Range Filter; minRR é o piso de risco/retorno do TP1.
export const PARAM_KEYS = ['atrMult', 'tp1R', 'rfPeriod', 'rfMult', 'minScore', 'minRR', 'regime', 'timeStop', 'trail', 'trailStart', 'trailDist', 'runnerTrail', 'runnerTrailDist', 'runnerRf'];
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- identidade de um teste ----------
// Dois níveis de identidade (achado do Codex, PR #617): o PEDIDO (ativo + timeframe + nº de candles) e a JANELA REAL de dados (o pedido + o fechamento da última
// vela). Quando uma vela nova fecha, o pedido é o mesmo mas a janela é outra: os resultados NÃO são comparáveis e não se ranqueiam juntos.
// O TESTE, porém, é identificado só pelo pedido + os valores (pedido do usuário, 23/11: "o mesmo valor não pode duplicar, só valores únicos"): repetir os
// mesmos valores numa janela mais nova ATUALIZA o registro (resultado e janela novos) em vez de criar um segundo igual. O ranking continua só dentro da janela atual.
export const requestKey = (d) => `${d.assetId}|${d.timeframe}|${d.candleCount}`;
export const datasetKey = (d) => `${requestKey(d)}|${d.windowEnd ?? 'x'}`;
// Valores que não fazem diferença não contam como "outro teste": com o trailing desligado, começo e distância dele não existem (viram 0 na comparação).
const effective = (p, k) => (((k === 'trailStart' || k === 'trailDist') && !p?.trail) || (k === 'runnerTrailDist' && !p?.runnerTrail) ? 0 : r2(p?.[k]));
export const runKey = (d, params) => `${requestKey(d)}|${PARAM_KEYS.map((k) => effective(params, k)).join('|')}`;
export const sameParams = (a, b) => PARAM_KEYS.every((k) => effective(a, k) === effective(b, k));
// Ligar/desligar o trailing é UMA mudança: quando o interruptor difere do padrão, começo e distância não contam à parte.
export const changedKeys = (params, defaults) => {
  let keys = PARAM_KEYS.filter((k) => effective(params, k) !== effective(defaults, k));
  if (keys.includes('trail')) keys = keys.filter((k) => k !== 'trailStart' && k !== 'trailDist');
  if (keys.includes('runnerTrail')) keys = keys.filter((k) => k !== 'runnerTrailDist');
  return keys;
};

/** Resumo numérico de um conjunto de operações já agregado por summarizeOps (só o que o histórico e a comparação usam). */
export function summarizeRun(overall) {
  const o = overall ?? {};
  return {
    expectancyR: finite(o.expectancyR) ? o.expectancyR : null,
    grossExpectancyR: finite(o.grossExpectancyR) ? o.grossExpectancyR : null,
    winRate: finite(o.winRate) ? o.winRate : null,
    profitFactor: finite(o.profitFactor) ? o.profitFactor : null,
    maxDrawdownPct: finite(o.maxDrawdownPct) ? o.maxDrawdownPct : null,
    counted: finite(o.counted) ? o.counted : 0,
    wins: o.wins ?? 0, losses: o.losses ?? 0, be: o.be ?? 0,
    ciHalfWidth: finite(o.expectancyRCI95HalfWidth) ? o.expectancyRCI95HalfWidth : null,
    conclusive: Boolean(o.conclusive),
  };
}

// ---------- histórico ----------
export const HISTORY_KEY = 'sentinel_whatif_history_v1';
export const HISTORY_CAP = 60;

// Testes gravados ANTES dos interruptores de regime/time stop não tinham esses filtros: valem como regime=0, timeStop=0 (e a chave é recalculada).
// (mesma regra para o trailing do stop antes do TP1, que também não existia: trail=0, com começo/distância de produção só para ter valor.)
// minRR=0: o piso não existia (nenhuma entrada era barrada por ele); runnerTrail/runnerRf=0: o runner só saía no TP2 ou no breakeven.
const LEGACY_FLAGS = { regime: 0, timeStop: 0, trail: 0, trailStart: 1, trailDist: 2, runnerTrail: 0, runnerTrailDist: 2, runnerRf: 0, minRR: 0 };
function normalizeRun(r) {
  const params = { ...LEGACY_FLAGS, ...r.params };
  return { ...r, params, key: runKey(r.dataset, params), starred: Boolean(r.starred) };
}

function validLegacyOrNew(r) {
  const keys = PARAM_KEYS.filter((k) => !(k in LEGACY_FLAGS));
  return r && typeof r.at === 'string' && r.dataset && typeof r.dataset.assetId === 'string' && typeof r.dataset.timeframe === 'string' && finite(r.dataset.candleCount)
    && r.params && keys.every((k) => finite(r.params[k])) && Object.keys(LEGACY_FLAGS).every((k) => r.params[k] === undefined || finite(r.params[k]))
    && r.summary && typeof r.summary === 'object';
}

export function loadHistory(storage) {
  try {
    const raw = storage?.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.runs)) return [];
    // chaves repetidas (duas versões do mesmo teste depois da normalização) ficam com a mais recente
    const byKey = new Map();
    for (const r of parsed.runs.filter(validLegacyOrNew).map(normalizeRun)) {
      const prev = byKey.get(r.key);
      if (!prev || r.at > prev.at) byKey.set(r.key, { ...r, starred: r.starred || Boolean(prev?.starred) });
    }
    return [...byKey.values()];
  } catch {
    return [];
  }
}

/** @returns {boolean} true se gravou (localStorage pode estar indisponível/cheio — a tela segue funcionando sem persistir). */
export function saveHistory(storage, history) {
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify({ v: 1, runs: history }));
    return true;
  } catch {
    return false;
  }
}

/** Acrescenta (ou atualiza, se a chave já existe) um teste. Favoritos nunca saem pelo teto; o resto fica com os mais recentes. */
export function addRun(history, record, cap = HISTORY_CAP) {
  const existing = history.find((r) => r.key === record.key);
  const next = [{ ...record, starred: existing?.starred ?? Boolean(record.starred) }, ...history.filter((r) => r.key !== record.key)];
  const starred = next.filter((r) => r.starred);
  const rest = next.filter((r) => !r.starred).sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.max(0, cap - starred.length));
  return [...starred, ...rest].sort((a, b) => b.at.localeCompare(a.at));
}
export const toggleStar = (history, key) => history.map((r) => (r.key === key ? { ...r, starred: !r.starred } : r));
export const removeRun = (history, key) => history.filter((r) => r.key !== key);

/** Testes da MESMA janela de dados (ativo + timeframe + candles + última vela) vêm ordenados do melhor ao pior; os de outras janelas vêm à parte (não comparáveis). */
export function rankRuns(history, dataset, by = 'expectancy') {
  const dk = datasetKey(dataset);
  const same = history.filter((r) => datasetKey(r.dataset) === dk);
  const others = history.filter((r) => datasetKey(r.dataset) !== dk).sort((a, b) => b.at.localeCompare(a.at));
  const cmp = by === 'recent'
    ? (a, b) => b.at.localeCompare(a.at)
    : (a, b) => (finite(b.summary.expectancyR) ? b.summary.expectancyR : -Infinity) - (finite(a.summary.expectancyR) ? a.summary.expectancyR : -Infinity)
      || (b.summary.counted ?? 0) - (a.summary.counted ?? 0);
  return { same: [...same].sort(cmp), others };
}

export function bestRun(sameRuns) {
  const withR = sameRuns.filter((r) => finite(r.summary.expectancyR) && (r.summary.counted ?? 0) > 0);
  return withR.length ? withR.reduce((b, r) => (r.summary.expectancyR > b.summary.expectancyR ? r : b)) : null;
}

/** Aviso de "melhor entre muitas tentativas" (múltiplas comparações): só a partir de 8 combinações na mesma janela. */
export function overfitNote(count) {
  if (count < 8) return null;
  return `Aviso (não bloqueia nada, pode continuar testando): você já testou ${count} combinações nesta mesma janela. Quanto mais combinações, maior a chance de o "melhor resultado" ser sorte: confirme num período ou ativo diferente antes de confiar.`;
}

// ---------- comparação com o padrão ----------
/**
 * Atual × padrão (mesmos candles). `withinNoise`: a diferença de expectância cabe na margem de erro (maior meia-largura do IC95 dos dois); com amostra pequena
 * demais para medir o ruído, `noiseR` é null e a tela diz isso em vez de afirmar. Leitura NÃO pareada (as operações divergem), por isso a banda é conservadora.
 */
export function compareSummaries(cur, base) {
  const noises = [cur?.ciHalfWidth, base?.ciHalfWidth].filter(finite);
  const noiseR = noises.length ? Math.max(...noises) : null;
  const metric = (k) => ({ cur: cur?.[k] ?? null, base: base?.[k] ?? null, delta: finite(cur?.[k]) && finite(base?.[k]) ? cur[k] - base[k] : null });
  const expectancyR = metric('expectancyR');
  return {
    noiseR,
    expectancyR: { ...expectancyR, withinNoise: expectancyR.delta !== null && noiseR !== null && Math.abs(expectancyR.delta) <= noiseR },
    winRate: metric('winRate'), profitFactor: metric('profitFactor'), maxDrawdownPct: metric('maxDrawdownPct'), counted: metric('counted'),
  };
}

// ---------- conferência dos candles ----------
const TF_MS = { '1h': 3600e3, '4h': 4 * 3600e3, '1d': 24 * 3600e3 };
export const timeframeMs = (tf) => TF_MS[tf] ?? null;

/**
 * Confere os candles ANTES de confiar no resultado. Cada item: { id, label, status: 'ok'|'info'|'attention'|'problem', detail }.
 * `raw` = o que a Binance devolveu; `closed` = só as velas fechadas (o que a simulação usa).
 */
export function assessCandles({ raw, closed, requested, timeframe, startIndex = 0, now = Date.now() }) {
  const tfMs = timeframeMs(timeframe);
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });

  add('received', 'Candles recebidos', raw.length >= requested ? 'ok' : 'attention',
    raw.length >= requested ? `${raw.length} de ${requested} pedidos.` : `Só ${raw.length} de ${requested} pedidos — a Binance devolveu menos.`);

  const dropped = raw.length - closed.length;
  add('closed', 'Vela em formação descartada', dropped <= 1 ? 'ok' : 'problem',
    dropped === 0 ? 'Nenhuma vela aberta na série.' : dropped === 1 ? 'A vela em formação foi descartada (a simulação só usa velas fechadas).' : `${dropped} velas descartadas por estarem abertas — não era esperado.`);

  let outOfOrder = 0; let gaps = 0; let firstGap = null;
  for (let i = 1; i < closed.length; i++) {
    const d = closed[i].openTime - closed[i - 1].openTime;
    if (d <= 0) outOfOrder += 1;
    else if (tfMs && d > tfMs) { gaps += Math.round(d / tfMs) - 1; if (firstGap === null) firstGap = closed[i].openTime; }
  }
  add('order', 'Ordem e duplicatas', outOfOrder === 0 ? 'ok' : 'problem', outOfOrder === 0 ? 'Velas em ordem crescente, sem repetição.' : `${outOfOrder} vela(s) fora de ordem ou repetida(s).`);
  add('gaps', 'Buracos na série', gaps === 0 ? 'ok' : 'attention',
    gaps === 0 ? 'Nenhuma vela faltando entre a primeira e a última.' : `${gaps} vela(s) faltando (primeiro buraco em ${new Date(firstGap).toISOString().slice(0, 10)}). Indicadores atravessam o buraco como se não existisse.`);

  const bad = closed.filter((c) => !(finite(c.open) && finite(c.high) && finite(c.low) && finite(c.close) && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0
    && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))).length;
  add('values', 'Preços coerentes', bad === 0 ? 'ok' : 'problem', bad === 0 ? 'Abertura, máxima, mínima e fechamento coerentes em todas as velas.' : `${bad} vela(s) com preço inválido (máxima menor que a abertura/fechamento, zero ou texto).`);

  const zeroVol = closed.filter((c) => !(c.volume > 0)).length;
  const zeroShare = closed.length ? zeroVol / closed.length : 0;
  add('volume', 'Volume', zeroShare <= 0.05 ? 'ok' : 'attention', zeroShare <= 0.05 ? 'Volume presente (entra no score: +10 pontos).' : `${zeroVol} vela(s) sem volume (${(zeroShare * 100).toFixed(0)}%): o ponto do volume no score fica injusto.`);

  const last = closed[closed.length - 1];
  if (last && tfMs) {
    const age = now - last.closeTime;
    add('fresh', 'Atualidade', age <= 2 * tfMs ? 'ok' : 'attention',
      age <= 2 * tfMs ? 'A última vela fechada é recente.' : `A última vela fechada tem ${Math.round(age / 3600e3)} h — dados possivelmente desatualizados.`);
  }

  if (closed.length > 1 && tfMs) {
    const days = (closed[closed.length - 1].closeTime - closed[0].openTime) / 86400e3;
    const warm = startIndex;
    add('span', 'Período e aquecimento', 'info',
      `${closed.length} velas ≈ ${Math.round(days)} dias. As primeiras ${warm} servem só para aquecer os indicadores; as operações começam depois delas (${closed.length - warm} velas operáveis).`);
  }

  const level = checks.some((c) => c.status === 'problem') ? 'problem' : checks.some((c) => c.status === 'attention') ? 'attention' : 'ok';
  return { level, checks };
}

// ---------- tier / padrões vindos da produção ----------
/** Tier do ativo pelo ATR% suavizado (mesma regra do scanner: tier.js) — define o stop padrão (2× / 2,5× / 3× ATR). */
export function detectTier(closed, pineConfig = {}) {
  const atrLen = Number.isFinite(pineConfig.atrLen) ? pineConfig.atrLen : 14;
  if (!closed || closed.length < atrLen + 20) return null;
  return classifyTier(calculateAtrPctSmooth(closed, atrLen, 20), { tier2: pineConfig.tier2Threshold ?? 0.8, tier3: pineConfig.tier3Threshold ?? 1.5 });
}

/** @param {{ pineConfig?: any, asset?: any, tier?: any }} args */
export function buildDefaults({ pineConfig = {}, asset = null, tier = null }) {
  return {
    // Interruptores: o padrão é o que a PRODUÇÃO tem ligado (useADX/useChop/useTimeStop do Pine salvo; ligados quando ausentes).
    regime: pineConfig.useADX !== false || pineConfig.useChop !== false ? 1 : 0,
    timeStop: pineConfig.useTimeStop !== false ? 1 : 0,
    // Trailing pré-TP1: na produção vale quando a proteção pré-TP1 (mestre) E o modo trailing estão ligados; começo/distância vêm do Pine salvo (1,0× / 2,0× ATR).
    trail: pineConfig.preTp1StopProtectionEnabled !== false && pineConfig.preTp1TrailEnabled !== false ? 1 : 0,
    trailStart: pineConfig.preTp1TrailStartAtrMult ?? 1,
    trailDist: pineConfig.preTp1TrailAtrMult ?? 2,
    // Runner depois do TP1: o exit_mode de toda operação nova é HYBRID_RF_ATR (trailing por ATR + invalidação pelo Range Filter) — por isso os dois ficam ligados no padrão.
    runnerTrail: 1,
    runnerTrailDist: pineConfig.trailAtrMult ?? 2,
    runnerRf: 1,
    minRR: pineConfig.minRR ?? 1.2,
    atrMult: tier?.atrStopMult ?? 2,
    tp1R: pineConfig.tp1R ?? 1.5,
    rfPeriod: asset?.rf_period ?? pineConfig.rng_per ?? 20,
    rfMult: asset?.rf_multiplier ?? pineConfig.rng_qty ?? 3.5,
    minScore: pineConfig.minScore ?? 75,
  };
}

// ---------- fidelidade: o que o simulador faz e não faz ----------
export function fidelityRows(pc = {}, ema = { emaFast: 20, emaSlow: 50 }, flags = { regime: 0, timeStop: 0, trail: 0, runnerTrail: 0, runnerRf: 0 }) {
  const state = (on) => (on ? 'ligado neste teste' : 'desligado neste teste');
  const prod = (on) => (on ? 'ligado na produção' : 'desligado na produção');
  const included = [
    'Sinal do Range Filter (período e multiplicador que você escolher)',
    'Score de 0 a 100 (Range Filter + MACD + EMA + RSI + volume), com o mínimo escolhido',
    `Médias EMA ${ema.emaFast}/${ema.emaSlow} no score (as mesmas do scanner)`,
    `Filtro de regime ADX/Choppiness por tier — ${state(flags.regime)} (produção: ${pc.useADX !== false || pc.useChop !== false ? 'ligado' : 'desligado'}); só barra entradas, como o scanner`,
    `Time stop por tier (48 / 64 / 96 candles) — ${state(flags.timeStop)} (produção: ${pc.useTimeStop !== false ? 'ligado' : 'desligado'}); só antes do TP1, no fechamento da vela`,
    'Stop a N× ATR e alvos TP1/TP2 em múltiplos de R (TP2 = 2× o TP1)',
    `Trailing do stop ANTES do TP1 — ${state(flags.trail)} (produção: ${pc.preTp1StopProtectionEnabled !== false && pc.preTp1TrailEnabled !== false ? 'ligado' : 'desligado'}); o stop segue o melhor preço a uma distância em ATR, só sobe, nunca passa do fechamento e só protege a vela seguinte`,
    'Stop sobe para a entrada (breakeven) depois do TP1 (e nunca piora um stop que o trailing já subiu)',
    `Trailing do stop do RUNNER depois do TP1 — ${state(flags.runnerTrail)} (produção: ligado, ${pc.trailAtrMult ?? 2}× ATR); o stop sobe para fechamento − N× ATR, só sobe e só protege a vela seguinte`,
    `Saída do runner pelo Range Filter — ${state(flags.runnerRf)} (produção: ligada): fecha no fechamento da vela quando o filtro virou contra a posição e o preço cruzou o filtro`,
    `Piso de risco/retorno do TP1 (minRR ${pc.minRR ?? 1.2}R na produção): entrada só abre se o TP1 rende pelo menos o piso — com o TP1 abaixo do piso nenhuma entrada passa`,
    'Se a mesma vela toca o stop e um alvo, o stop vence (regra do motor real)',
    'Taxa, slippage e funding descontados (padrão do projeto)',
    'Uma operação por vez',
  ];
  const notIncluded = [
    { label: 'Filtro de tendência do 4h e confirmação de 15 min', production: 'ligado na produção', why: 'O simulador olha um timeframe só.' },
    { label: 'Chop Exit e invalidação do Range Filter ANTES do TP1', production: 'desligados por padrão na produção', why: 'O scanner tem os dois, mas vêm desligados (useChopExit / useInvalidation); o simulador também não os faz.' },
  ];
  return { included, notIncluded };
}

// ---------- reavaliar o histórico na janela atual ----------
/**
 * Testes cujo resultado guardado é de OUTRA janela de dados (uma vela nova fechou desde então) no mesmo pedido (ativo + timeframe + candles). Devolve os parâmetros
 * a rodar de novo nos dados de agora (cada execução leva ~2 ms). O resultado novo SUBSTITUI o antigo (mesma chave: o teste é um só, com o resultado mais novo).
 */
export function reevaluationTargets(history, dataset) {
  if (!dataset || dataset.windowEnd == null) return [];
  const req = requestKey(dataset);
  const out = [];
  for (const r of history) {
    if (requestKey(r.dataset) !== req || datasetKey(r.dataset) === datasetKey(dataset)) continue;
    out.push({ params: r.params, starred: r.starred });
  }
  return out;
}

// ---------- sensibilidade ----------
export function sensitivityValues({ min, max, step }, points = 9) {
  const decimals = (String(step).split('.')[1] ?? '').length;
  const out = [];
  for (let i = 0; i < points; i++) {
    const raw = min + ((max - min) * i) / (points - 1);
    const snapped = Math.round(raw / step) * step;
    out.push(Number(snapped.toFixed(decimals)));
  }
  return [...new Set(out)];
}

/** Os 9 pontos da varredura MAIS o valor atual (achado do Codex, PR #617): o veredito é sobre o valor que está na tela, nunca sobre um ponto vizinho. */
export function sweepValues(def, current, points = 9) {
  const decimals = (String(def.step).split('.')[1] ?? '').length;
  const withCurrent = [...sensitivityValues(def, points), Number(Number(current).toFixed(decimals))].filter(finite);
  return [...new Set(withCurrent)].sort((a, b) => a - b);
}

export function sweepParam({ runSummary, params, key, values }) {
  return values.map((value) => ({ value, summary: runSummary({ ...params, [key]: value }) }));
}

/**
 * O valor atual está num platô (vizinhos parecidos) ou numa ponta (vizinhos bem piores)? Texto hesitante de propósito: é evidência, não prova.
 * Só avalia o ponto EXATO do valor atual (`points` precisa conter o valor); sem ele ou sem operações nele, devolve "unknown".
 */
export function judgeSensitivity(points, currentValue) {
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const usable = (p) => finite(p.summary?.expectancyR) && (p.summary.counted ?? 0) > 0;
  const cur = sorted.find((p) => Math.abs(p.value - currentValue) < 1e-9);
  if (sorted.filter(usable).length < 3) return { verdict: 'unknown', text: 'Poucos pontos com operações para avaliar a estabilidade.' };
  if (!cur || !usable(cur)) return { verdict: 'unknown', text: 'O valor atual não teve operações nesta simulação: não dá para avaliar a estabilidade dele.' };
  const idx = sorted.indexOf(cur);
  const left = sorted.slice(0, idx).reverse().find(usable);
  const right = sorted.slice(idx + 1).find(usable);
  const neighbors = [left, right].filter(Boolean);
  if (!neighbors.length) return { verdict: 'unknown', text: 'Sem vizinhos com operações para comparar.' };
  const meanN = neighbors.reduce((s, p) => s + p.summary.expectancyR, 0) / neighbors.length;
  const noise = Math.max(cur.summary.ciHalfWidth ?? 0, ...neighbors.map((p) => p.summary.ciHalfWidth ?? 0));
  const drop = cur.summary.expectancyR - meanN;
  if ((cur.summary.counted ?? 0) < 10) return { verdict: 'unknown', text: 'Amostra pequena demais neste ponto para dizer se é estável.' };
  if (drop > Math.max(noise, 0.05)) return { verdict: 'peak', text: 'O valor atual é bem melhor que os vizinhos: sinal de ajuste sob medida (frágil). Desconfie.' };
  if (neighbors.every((p) => p.summary.expectancyR > 0) && cur.summary.expectancyR > 0) return { verdict: 'plateau', text: 'Os vizinhos têm resultado parecido e também positivo: região mais estável.' };
  return { verdict: 'mixed', text: 'Sem padrão claro: os vizinhos oscilam em torno do valor atual.' };
}

// ---------- dados dos gráficos ----------
export function buildTradeChart(candles, ops, startIndex = 0) {
  const from = Math.max(0, startIndex - 5);
  const idxByClose = new Map(candles.map((c, i) => [c.closeTime, i]));
  const points = candles.slice(from).map((c, k) => ({ i: from + k, t: c.closeTime, close: c.close }));
  const trades = ops.map((op) => ({
    entryI: idxByClose.get(op.created_date), exitI: idxByClose.get(op.closed_at), side: op.side, entry: op.entry_price, exit: op.exit_price,
    r: calcRealizedR(op), outcome: classifyOutcome(op),
  })).filter((t) => t.entryI !== undefined && t.exitI !== undefined);
  return { points, trades };
}

const EDGES = [-1, -0.5, 0, 0.5, 1, 1.5, 2, 3];
const fmtEdge = (n) => String(n).replace('.', ',');
export function rHistogram(ops) {
  const rs = ops.map((op) => calcRealizedR(op)).filter(finite);
  const bins = [{ label: `≤ ${fmtEdge(EDGES[0])}`, lo: -Infinity, hi: EDGES[0], mid: EDGES[0] - 0.25 }];
  for (let i = 1; i < EDGES.length; i++) bins.push({ label: `${fmtEdge(EDGES[i - 1])} a ${fmtEdge(EDGES[i])}`, lo: EDGES[i - 1], hi: EDGES[i], mid: (EDGES[i - 1] + EDGES[i]) / 2 });
  bins.push({ label: `> ${fmtEdge(EDGES[EDGES.length - 1])}`, lo: EDGES[EDGES.length - 1], hi: Infinity, mid: EDGES[EDGES.length - 1] + 0.5 });
  return bins.map((b) => ({ ...b, count: rs.filter((r) => r > b.lo && r <= b.hi).length, positive: b.mid > 0 }));
}

export function exitBreakdown(ops) {
  const groups = {
    tp2: { key: 'tp2', label: 'Alvo final (TP2)', ops: [] },
    tp1_be: { key: 'tp1_be', label: 'TP1 e depois stop do runner (breakeven ou trailing)', ops: [] },
    rf_exit: { key: 'rf_exit', label: 'TP1 e depois saída pelo Range Filter', ops: [] },
    stop_trail: { key: 'stop_trail', label: 'Stop do trailing (antes do TP1)', ops: [] },
    stop: { key: 'stop', label: 'Stop cheio (perda)', ops: [] },
    time_stop: { key: 'time_stop', label: 'Time stop (fechada por tempo)', ops: [] },
  };
  for (const op of ops) {
    if (op.closed_reason === 'TIME_STOP') groups.time_stop.ops.push(op);
    else if (op.status === 'TP2_HIT') groups.tp2.ops.push(op);
    else if (op.status === 'INVALIDATED' && op.tp1_hit) groups.rf_exit.ops.push(op);
    else if (op.status === 'STOP_HIT' && op.tp1_hit) groups.tp1_be.ops.push(op);
    else if (op.status === 'STOP_HIT' && op.pre_tp1_trailed) groups.stop_trail.ops.push(op);
    else if (op.status === 'STOP_HIT') groups.stop.ops.push(op);
  }
  const total = ops.length || 1;
  return Object.values(groups).map((g) => {
    const rs = g.ops.map((op) => calcRealizedR(op)).filter(finite);
    return { key: g.key, label: g.label, count: g.ops.length, share: g.ops.length / total, avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, sumR: rs.reduce((a, b) => a + b, 0) };
  });
}

export function sideBreakdown(ops) {
  return ['BUY', 'SELL'].map((side) => {
    const g = ops.filter((op) => op.side === side);
    const rs = g.map((op) => calcRealizedR(op)).filter(finite);
    return { side, count: g.length, wins: g.filter((op) => classifyOutcome(op) === 'WIN').length, avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, sumR: rs.reduce((a, b) => a + b, 0) };
  });
}
