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

// Quanto a série pode terminar antes do `--to` e ainda ser só AVISO (revisão do
// pacote 1, 2026-10-09): o arquivo DIÁRIO da Binance Futures do último dia só
// é publicado no dia seguinte, e o `to` padrão do backtest.yml é "hoje 00:00".
// Rodado logo depois da meia-noite UTC, toda série termina ~24h antes — antes
// deste módulo o run seguia com um dia a menos; recusá-lo por isso tornaria o
// default dependente da hora. Acima disso já é download incompleto: ERRO.
export const MAX_TOLERATED_END_SHORTFALL_MS = 48 * 60 * 60 * 1000;

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

/**
 * A série cobre a janela [fromMs, toMs] do run? Tolerância de UM intervalo em
 * cada ponta: o download começa no primeiro candle alinhado a partir de
 * `--from` e descarta o candle ainda em formação no fim (fetch-backtest-data*
 * .mjs), então até um intervalo de folga é o comportamento normal, não falta
 * de dado.
 *
 * Severidade (revisão do pacote 1, 2026-10-09):
 * - Começar DEPOIS do `--from` é AVISO: os dois downloads paginam a partir do
 *   início pedido, então série que começa tarde é, na prática, símbolo listado
 *   no meio da janela — a estratégia simplesmente não podia operá-lo antes, e
 *   recusar o run inteiro barraria todo backtest longo de carteira.
 * - Terminar antes do `--to` é AVISO até MAX_TOLERATED_END_SHORTFALL_MS
 *   (arquivo diário de Futures ainda não publicado) e ERRO acima.
 */
export function checkWindowCoverage(series, { symbol, timeframe, fromMs, toMs }) {
  const out = makeCollector(symbol, timeframe);
  const intervalMs = timeframeToMs(timeframe);
  if (!Array.isArray(series) || series.length === 0 || !intervalMs) return out.issues();
  const first = series[0];
  const last = series[series.length - 1];
  // Elemento que não é candle (ex.: `null`) já sai como invalid_bar em
  // validateCandleSeries; aqui só não pode derrubar o preflight com TypeError.
  if (Number.isFinite(first?.openTime) && first.openTime - fromMs > intervalMs) {
    out.add('warning', 'starts_after_window', first.openTime, { windowFrom: iso(fromMs) });
  }
  if (Number.isFinite(last?.closeTime) && toMs - last.closeTime > intervalMs) {
    const shortfallMs = toMs - last.closeTime;
    if (shortfallMs > MAX_TOLERATED_END_SHORTFALL_MS) {
      out.add('error', 'ends_before_window', last.closeTime, { windowTo: iso(toMs) });
    } else {
      out.add('warning', 'ends_slightly_before_window', last.closeTime, { windowTo: iso(toMs) });
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
    ...(pineConfig?.skip15mConfirmationEnabled ? [] : ['15m']),
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
    starts_after_window: 'série começa depois do início da janela (símbolo listado no meio dela?) — sem dado nesse trecho',
    ends_before_window: `série termina mais de ${MAX_TOLERATED_END_SHORTFALL_MS / 3600000}h antes do fim da janela`,
    ends_slightly_before_window: 'série termina pouco antes do fim da janela (último arquivo diário ainda não publicado?)',
  };
  const first = issue.samples?.[0];
  const where = first?.at ? ` — 1ª ocorrência em ${first.at}` : '';
  return `${issue.symbol} ${issue.timeframe}: ${labels[issue.type] || issue.type} (${issue.count}x)${where}`;
}
