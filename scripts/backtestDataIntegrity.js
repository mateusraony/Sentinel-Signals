// Integridade das séries de candles do backtest histórico (docs/known-risks.md
// item 260). Funções PURAS — sem fs, sem relógio — chamadas por
// scripts/backtestMarketDataProvider.js (estrutura de cada série, uma vez por
// símbolo/timeframe) e por scripts/run-backtest.mjs (cobertura da janela
// pedida, antes do replay).
//
// Por que existe: até aqui um arquivo de candles ausente virava série vazia
// com um console.warn, um JSON corrompido virava erro engolido por timeframe,
// e nada checava ordem/duplicata/buraco — o relatório saía com exit 0 e
// aparência normal. sliceClosedAsOf (backtestEngine.js) faz busca binária e
// DEPENDE de a série estar ordenada sem repetição; essa pré-condição nunca
// era verificada.
//
// Política (pesquisa de comunidade registrada no item 260 — RustyBT, guias
// de qualidade OHLC para backtest): ordem, duplicata, desalinhamento e barra
// inválida são ERRO (dado corrompido, invalida o run). Buraco é AVISO quando
// curto — cripto opera 24/7, mas manutenção/parada real da exchange produz
// janela sem candle que o scan ao vivo também veria — e ERRO a partir de
// MAX_TOLERATED_GAP_MS, onde "parada da exchange" deixa de ser explicação
// plausível e o mais provável é download incompleto. O limite é INCLUSIVO de
// propósito: fetch-backtest-data-futures.mjs pula em silêncio um arquivo
// diário que não existe, e isso deixa um buraco de EXATAMENTE 24h.

export const MAX_TOLERATED_GAP_MS = 24 * 60 * 60 * 1000;

// Folga de fim de série que o backtest.yml concede a dado de FUTURES recém-
// baixado (--max-end-shortfall-hours 48): o arquivo DIÁRIO da Binance
// Futures do último dia só é publicado no dia seguinte, e o `to` padrão do
// workflow é "hoje 00:00" — rodado logo depois da meia-noite UTC, toda série
// termina ~24h antes. Só o chamador sabe a origem do dado, por isso a folga é
// OPT-IN e o padrão continua estrito (review do Codex, PR #476).
export const FUTURES_ARCHIVE_LAG_MS = 48 * 60 * 60 * 1000;

// Quantas ocorrências de cada tipo de problema vão para o relatório como
// amostra — a contagem total vai sempre inteira, a lista não (um arquivo
// inteiro fora de ordem geraria milhares de entradas idênticas).
const MAX_SAMPLES = 5;

const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };

// '15m' → 900000. Formato de intervalo da Binance (mesmo usado nos nomes de
// arquivo `${symbol}_${timeframe}.json`). '1M' (mês) não tem duração fixa:
// devolve null e as checagens que dependem do intervalo são puladas.
export function timeframeToMs(timeframe) {
  const match = /^(\d+)([mhdw])$/.exec(String(timeframe));
  if (!match) return null;
  return Number(match[1]) * UNIT_MS[match[2]];
}

// Início do download de um timeframe com N velas de aquecimento antes do
// --from (fetch-backtest-data*.mjs --warmup-candles, item 260). Por timeframe
// porque N velas de 1d são N dias e N velas de 5m são N×5 min. Intervalo sem
// duração fixa (ex.: '1M') não ganha aquecimento — fica no --from.
export function warmupStartMs(fromMs, timeframe, warmupCandles) {
  const intervalMs = timeframeToMs(timeframe);
  return intervalMs ? fromMs - warmupCandles * intervalMs : fromMs;
}

// null quando não há instante válido (elemento que não é candle, arquivo
// ausente) — describeIssue então omite a "1ª ocorrência" em vez de imprimir
// "undefined".
function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isValidBar(c) {
  if (!c || typeof c !== 'object') return false;
  const fields = [c.openTime, c.closeTime, c.open, c.high, c.low, c.close, c.volume];
  if (!fields.every(Number.isFinite)) return false;
  if (c.closeTime <= c.openTime) return false;
  if (c.low <= 0 || c.volume < 0) return false;
  return c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
}

function makeCollector(symbol, timeframe) {
  const byType = new Map();
  return {
    add(severity, type, at, detail) {
      if (!byType.has(type)) byType.set(type, { severity, type, symbol, timeframe, count: 0, samples: [] });
      const entry = byType.get(type);
      entry.count += 1;
      if (entry.samples.length < MAX_SAMPLES) entry.samples.push({ at: iso(at), ...detail });
    },
    issues() {
      return [...byType.values()];
    },
  };
}

/**
 * Checagem ESTRUTURAL de uma série (independe da janela do run): ordem,
 * duplicata, alinhamento ao intervalo, barras válidas e buracos.
 * @returns {Array<{severity: 'error'|'warning', type: string, symbol: string, timeframe: string, count: number, samples: Array<object>}>}
 */
export function validateCandleSeries(series, { symbol, timeframe }) {
  const out = makeCollector(symbol, timeframe);
  if (!Array.isArray(series)) {
    out.add('error', 'not_an_array', null, { detail: 'o arquivo não contém uma lista de candles' });
    return out.issues();
  }
  if (series.length === 0) {
    out.add('error', 'empty_series', null, {});
    return out.issues();
  }
  const intervalMs = timeframeToMs(timeframe);
  for (let i = 0; i < series.length; i++) {
    const c = series[i];
    if (!isValidBar(c)) out.add('error', 'invalid_bar', c?.openTime, { index: i });
    // Codex review (PR #475, P1): sliceClosedAsOf faz a busca binária por
    // closeTime, não por openTime — validar só a ordem do openTime deixava
    // passar um closeTime corrompido ou de outro intervalo. A duração da vela
    // tem de ser a do intervalo: `intervalo − 1` (convenção da API klines) ou
    // `intervalo` exato (CSV de Futures em microssegundos, arredondado para ms
    // em binanceArchive.js normalizeTimestamp). Revisão do pacote 1: o LIMITE
    // INFERIOR é o que importa para look-ahead — um closeTime CEDO demais
    // (ex.: o de uma vela de 15m num arquivo de 1h) faz sliceClosedAsOf expor
    // o candle inteiro, com high/low/close finais, antes de ele fechar.
    else if (intervalMs && (c.closeTime - c.openTime < intervalMs - 1 || c.closeTime - c.openTime > intervalMs)) {
      out.add('error', 'close_time_mismatch', c.openTime, { closeTime: iso(c.closeTime) });
    }
    if (i === 0) continue;
    const prev = series[i - 1];
    const diff = c?.openTime - prev?.openTime;
    if (!Number.isFinite(diff)) continue; // já contado como invalid_bar
    // Só quando o openTime já está em ordem — fora de ordem/duplicata já é
    // reportado abaixo e não precisa aparecer duas vezes.
    if (diff > 0 && c.closeTime <= prev.closeTime) {
      out.add('error', 'close_time_not_sorted', c.openTime, { closeTime: iso(c.closeTime), previousCloseTime: iso(prev.closeTime) });
    }
    if (diff < 0) out.add('error', 'not_sorted', c.openTime, { previous: iso(prev.openTime) });
    else if (diff === 0) out.add('error', 'duplicate', c.openTime, {});
    else if (intervalMs && diff % intervalMs !== 0) out.add('error', 'misaligned', c.openTime, { previous: iso(prev.openTime) });
    else if (intervalMs && diff > intervalMs) {
      const missingCandles = diff / intervalMs - 1;
      const gapMs = diff - intervalMs;
      if (gapMs >= MAX_TOLERATED_GAP_MS) out.add('error', 'gap_too_large', prev.openTime, { missingCandles, resumesAt: iso(c.openTime) });
      else out.add('warning', 'gap', prev.openTime, { missingCandles, resumesAt: iso(c.openTime) });
    }
  }
  return out.issues();
}

// Quanto o closeTime de duas velas encurtadas (timeframes diferentes da
// mesma moeda) pode diferir para contar como o MESMO instante de parada.
export const HALT_CORROBORATION_TOLERANCE_MS = 60 * 1000;

/**
 * Candidatas a vela fechada CEDO por parada da exchange: closeTime antes do
 * fim normal, as DUAS vizinhas presentes e com duração normal, e a seguinte
 * começando só depois do fim desta. Arquivo inteiro com closeTime curto (de
 * outro intervalo) nunca tem vizinha normal, então não entra.
 * @returns {number[]} índices na série
 */
export function findTruncatedCandles(series, timeframe) {
  const intervalMs = timeframeToMs(timeframe);
  if (!Array.isArray(series) || !intervalMs) return [];
  const duration = (c) => (c && Number.isFinite(c.openTime) && Number.isFinite(c.closeTime) ? c.closeTime - c.openTime : NaN);
  const isNormal = (c) => duration(c) >= intervalMs - 1 && duration(c) <= intervalMs;
  const found = [];
  for (let i = 1; i < series.length - 1; i++) {
    const c = series[i];
    const d = duration(c);
    if (!(d > 0 && d < intervalMs - 1)) continue;
    if (!isNormal(series[i - 1]) || !isNormal(series[i + 1])) continue;
    if (!(series[i + 1].openTime >= c.openTime + intervalMs)) continue;
    found.push(i);
  }
  return found;
}

const PRICE_REL_TOLERANCE = 1e-9;
const VOLUME_REL_TOLERANCE = 1e-6;
const nearRel = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);

function aggregateBars(bars) {
  return {
    n: bars.length,
    open: bars[0].open,
    close: bars[bars.length - 1].close,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    volume: bars.reduce((sum, b) => sum + b.volume, 0),
  };
}

const fmt = (v) => (Number.isFinite(v) ? String(Number(v.toPrecision(10))) : String(v));
const describeOhlcv = (o) => `open ${fmt(o.open)} high ${fmt(o.high)} low ${fmt(o.low)} close ${fmt(o.close)} vol ${fmt(o.volume)}`;

/**
 * Prova por CONTEÚDO (item 281, 2ª execução do targets-test.yml): o OHLCV da
 * vela encurtada bate com o agregado das velas de um timeframe MENOR da mesma
 * moeda? Cobre a parada da exchange em que o timeframe menor não tem vela
 * encurtada (29/09/2021: o 4h foi cortado às 07:00 e o 1h/15m só têm buraco).
 *
 * Dois recortes das velas menores, qualquer um serve:
 * - inteiro: as que ABREM em `[open, open + intervalo)` (a parada deixa de
 *   fora as velas que não existem);
 * - declarado: as que FECHAM até o closeTime que a própria vela declara.
 * Preço: tolerância relativa 1e-9; volume: 1e-6 (soma de floats).
 * Sem nenhuma vela menor no recorte, não há o que comparar e não verifica.
 * @param {{ openTime: number, closeTime: number, open: number, high: number, low: number, close: number, volume: number }} candle
 * @param {Array<object>} subBars velas do timeframe menor, em ordem
 * @param {number} intervalMs duração do timeframe da vela
 * @returns {{ ok: boolean, span?: 'inteiro'|'declarado', subBars: number, detail: string }}
 */
export function candleMatchesSubBars(candle, subBars, intervalMs) {
  if (!Array.isArray(subBars) || !candle) return { ok: false, subBars: 0, detail: 'sem velas menores' };
  const spans = [
    ['inteiro', (b) => b.openTime >= candle.openTime && b.openTime < candle.openTime + intervalMs],
    ['declarado', (b) => b.openTime >= candle.openTime && b.closeTime <= candle.closeTime],
  ];
  const tried = [];
  for (const [span, inSpan] of spans) {
    const bars = subBars.filter((b) => b && Number.isFinite(b.openTime) && Number.isFinite(b.closeTime) && inSpan(b));
    if (bars.length === 0) continue;
    const agg = aggregateBars(bars);
    const ok = nearRel(agg.open, candle.open, PRICE_REL_TOLERANCE)
      && nearRel(agg.high, candle.high, PRICE_REL_TOLERANCE)
      && nearRel(agg.low, candle.low, PRICE_REL_TOLERANCE)
      && nearRel(agg.close, candle.close, PRICE_REL_TOLERANCE)
      && nearRel(agg.volume, candle.volume, VOLUME_REL_TOLERANCE);
    if (ok) return { ok: true, span, subBars: agg.n, detail: `bate com ${agg.n} vela(s) menor(es), recorte ${span}` };
    tried.push(`recorte ${span} (${agg.n} vela(s)): ${describeOhlcv(agg)}`);
  }
  if (tried.length === 0) return { ok: false, subBars: 0, detail: 'nenhuma vela menor no recorte' };
  return { ok: false, subBars: 0, detail: `vela: ${describeOhlcv(candle)} · agregado ${tried.join(' · ')}` };
}

/**
 * Vela fechada CEDO por parada da exchange (item 281, 1ª execução do
 * targets-test.yml): quando a Binance para, a vela em andamento sai com o
 * closeTime no instante da parada, antes do fim normal (padrão público,
 * binance-public-data issue #77). Em 2021-08-13 isso aconteceu na mesma hora
 * em todas as moedas, em 15m/1h/4h, e o validador recusava a janela inteira.
 *
 * Só conserta com PROVA independente (review do Codex, PR #509): isolamento
 * sozinho não distingue uma parada de uma vela parcial inserida por engano.
 * `isCorroborated(candle)` diz se há prova: OUTRO timeframe da mesma moeda
 * encurtado no mesmo instante, ou o conteúdo batendo com o agregado de um
 * timeframe menor (candleMatchesSubBars) — sem ela, nada é consertado e a
 * vela continua ERRO em validateCandleSeries.
 *
 * Conserto CONSERVADOR: o closeTime volta para o fim normal da vela
 * (`openTime + intervalo − 1`), então o replay só a enxerga quando enxergaria
 * uma vela normal — nunca antes, sem olhar o futuro. Vela mais LONGA que o
 * intervalo nunca é tocada. Série sem nada a consertar volta como a MESMA
 * referência.
 * @param {unknown} series
 * @param {{ symbol: string, timeframe: string, isCorroborated?: (candle: any) => boolean | { ok: boolean, via?: string, detail?: string } }} meta
 * @returns {{ series: unknown, issues: Array<object> }}
 */
export function repairTruncatedCloseTimes(series, { symbol, timeframe, isCorroborated = () => false }) {
  const out = makeCollector(symbol, timeframe);
  const intervalMs = timeframeToMs(timeframe);
  let repaired = null;
  for (const i of findTruncatedCandles(series, timeframe)) {
    const c = series[i];
    // A prova devolve boolean ou { ok, via, detail } (via/detail só explicam).
    const proof = isCorroborated(c);
    const ok = typeof proof === 'object' && proof !== null ? Boolean(proof.ok) : Boolean(proof);
    const via = typeof proof === 'object' && proof !== null ? proof.via : undefined;
    const detail = typeof proof === 'object' && proof !== null ? proof.detail : undefined;
    if (!ok) {
      // Continua ERRO em validateCandleSeries; o aviso só diz POR QUE a prova falhou.
      if (detail) out.add('warning', 'close_time_truncated_unverified', c.openTime, { closeTime: iso(c.closeTime), detail });
      continue;
    }
    if (!repaired) repaired = series.slice();
    repaired[i] = { ...c, closeTime: c.openTime + intervalMs - 1 };
    out.add('warning', 'close_time_truncated_repaired', c.openTime, { closeTime: iso(c.closeTime), repairedTo: iso(repaired[i].closeTime), ...(via ? { via } : {}) });
  }
  return { series: repaired || series, issues: out.issues() };
}

/**
 * A série cobre a janela [fromMs, toMs] do run? Tolerância de UM intervalo em
 * cada ponta: o download começa no primeiro candle alinhado a partir de
 * `--from` e descarta o candle ainda em formação no fim (fetch-backtest-data*
 * .mjs), então até um intervalo de folga é o comportamento normal, não falta
 * de dado.
 *
 * Severidade — ERRO por padrão nas duas pontas; as folgas são OPT-IN porque
 * só quem baixou o dado sabe de onde ele veio (review do Codex, PR #476: um
 * diretório reaproveitado de um período mais curto, ou um arquivo truncado,
 * é indistinguível de um símbolo recém-listado olhando só a série):
 * - `allowLateStart`: começar DEPOIS do `--from` vira AVISO. Seguro quando o
 *   dado acabou de ser baixado para esta janela (os dois downloads paginam a
 *   partir do início pedido, então começo tardio = símbolo listado no meio da
 *   janela) — é o que o backtest.yml declara.
 * - `maxEndShortfallMs`: terminar antes do `--to` até esse tanto vira AVISO
 *   (backtest.yml: FUTURES_ARCHIVE_LAG_MS, só com dado de Futures).
 */
export function checkWindowCoverage(series, {
  symbol, timeframe, fromMs, toMs, allowLateStart = false, maxEndShortfallMs = 0,
}) {
  const out = makeCollector(symbol, timeframe);
  const intervalMs = timeframeToMs(timeframe);
  if (!Array.isArray(series) || series.length === 0 || !intervalMs) return out.issues();
  const first = series[0];
  const last = series[series.length - 1];
  // Elemento que não é candle (ex.: `null`) já sai como invalid_bar em
  // validateCandleSeries; aqui só não pode derrubar o preflight com TypeError.
  if (Number.isFinite(first?.openTime) && first.openTime - fromMs > intervalMs) {
    out.add(allowLateStart ? 'warning' : 'error', 'starts_after_window', first.openTime, { windowFrom: iso(fromMs) });
  }
  if (Number.isFinite(last?.closeTime) && toMs - last.closeTime > intervalMs) {
    const shortfallMs = toMs - last.closeTime;
    if (shortfallMs <= maxEndShortfallMs) {
      out.add('warning', 'ends_slightly_before_window', last.closeTime, { windowTo: iso(toMs) });
    } else {
      out.add('error', 'ends_before_window', last.closeTime, { windowTo: iso(toMs) });
    }
  }
  return out.issues();
}

// scanAsset (scanner.js) usa TIMEFRAMES = 1h/4h/1d quando o ativo não traz
// `timeframes_enabled` — só o fallback desse caso; o normal é ler do ativo.
const SCAN_ASSET_DEFAULT_TIMEFRAMES = ['1h', '4h', '1d'];

// Timeframes que o replay SEMPRE lê para um ativo (run-backtest.mjs):
// os ligados em `asset.timeframes_enabled` (mesma regra do scanAsset:
// `!== false` liga — derivado do ativo, não copiado, para não divergir de
// makeAsset), o 15m da confirmação RF (salvo com a confirmação 15m desligada
// no pineConfig) e o 5m da cascata SMC quando o ativo a tem. Esta lista só
// decide o que é verificado ANTES do replay, para falhar em segundos; toda
// série que o replay vier a ler a mais também é checada depois
// (run-backtest.mjs, getLoadedSeries).
export function requiredTimeframes(asset, { pineConfig } = {}) {
  const enabled = asset?.timeframes_enabled;
  const scanTimeframes = enabled
    ? Object.keys(enabled).filter((tf) => enabled[tf] !== false)
    : SCAN_ASSET_DEFAULT_TIMEFRAMES;
  return [
    ...scanTimeframes,
    // fibEntryEnabled (item 267) precisa do 15m mesmo com a confirmação
    // pulada: a entrada e a gestão da operação vivem nele.
    // O alvo de Fibonacci do item 281 também mede a perna no 15m.
    ...(pineConfig?.fibEntryEnabled || pineConfig?.targetMode === 'fib_ext_15m' || !pineConfig?.skip15mConfirmationEnabled ? ['15m'] : []),
    ...(asset?.smc_enabled ? ['5m'] : []),
  ];
}

// Uma linha legível por problema, para o console e o Job Summary.
export function describeIssue(issue) {
  const labels = {
    missing_file: 'arquivo de candles ausente',
    invalid_json: 'arquivo de candles não é JSON válido',
    not_an_array: 'arquivo não contém uma lista de candles',
    empty_series: 'série vazia',
    invalid_bar: 'candle com valor inválido (NaN, preço ≤ 0, high/low incoerente)',
    not_sorted: 'candles fora de ordem',
    close_time_mismatch: 'closeTime fora da própria vela (corrompido ou de outro intervalo)',
    close_time_not_sorted: 'closeTime fora de ordem',
    duplicate: 'candle duplicado',
    misaligned: 'candle desalinhado do intervalo',
    gap_too_large: `buraco de ${MAX_TOLERATED_GAP_MS / 3600000}h ou mais`,
    gap: 'buraco curto (possível parada da exchange)',
    close_time_truncated_repaired: 'vela fechada cedo (parada da exchange) — closeTime levado ao fim normal da vela, sem olhar o futuro',
    close_time_truncated_unverified: 'vela curta SEM prova de parada (nenhum timeframe confirma) — continua erro',
    starts_after_window: 'série começa depois do início da janela — sem dado nesse trecho',
    ends_before_window: 'série termina antes do fim da janela',
    ends_slightly_before_window: 'série termina pouco antes do fim da janela, dentro da folga pedida (último arquivo diário ainda não publicado?)',
  };
  const first = issue.samples?.[0];
  const where = first?.at ? ` — 1ª ocorrência em ${first.at}` : '';
  // O closeTime real vai junto: sem ele, uma falha no runner do GitHub não
  // diz que tipo de vela é (a rede das sessões não alcança a Binance).
  const close = first?.closeTime ? ` (closeTime ${first.closeTime})` : '';
  const why = issue.type === 'close_time_truncated_unverified' && first?.detail ? ` — ${first.detail}` : '';
  return `${issue.symbol} ${issue.timeframe}: ${labels[issue.type] || issue.type} (${issue.count}x)${where}${close}${why}`;
}
