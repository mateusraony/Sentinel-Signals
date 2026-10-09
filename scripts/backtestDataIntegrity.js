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

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms);
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
    if (i === 0) continue;
    const prev = series[i - 1];
    const diff = c?.openTime - prev?.openTime;
    if (!Number.isFinite(diff)) continue; // já contado como invalid_bar
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
 * de dado. Mesmo princípio da checagem de cobertura do funding real
 * (run-backtest.mjs, item 131): a janela precisa estar COBERTA, não só densa.
 */
export function checkWindowCoverage(series, { symbol, timeframe, fromMs, toMs }) {
  const out = makeCollector(symbol, timeframe);
  const intervalMs = timeframeToMs(timeframe);
  if (!Array.isArray(series) || series.length === 0 || !intervalMs) return out.issues();
  const first = series[0];
  const last = series[series.length - 1];
  if (first.openTime - fromMs > intervalMs) {
    out.add('error', 'starts_after_window', first.openTime, { windowFrom: iso(fromMs) });
  }
  if (toMs - last.closeTime > intervalMs) {
    out.add('error', 'ends_before_window', last.closeTime, { windowTo: iso(toMs) });
  }
  return out.issues();
}

// Timeframes que o replay SEMPRE lê para um símbolo (run-backtest.mjs): os 3
// de scanAsset (makeAsset liga 1h/4h/1d), o 15m da confirmação RF (salvo com
// a confirmação 15m desligada no pineConfig) e o 5m da cascata SMC quando o
// símbolo a tem. Qualquer outro que o replay venha a ler também é checado
// (getSeriesIntegrityIssues depois do run) — esta lista só decide o que é
// verificado ANTES, para falhar em segundos e não depois de ~28 min de replay.
export function requiredTimeframes(symbol, { smcSymbols, pineConfig }) {
  return [
    '1h', '4h', '1d',
    ...(pineConfig?.skip15mConfirmationEnabled ? [] : ['15m']),
    ...(smcSymbols?.has(symbol) ? ['5m'] : []),
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
    duplicate: 'candle duplicado',
    misaligned: 'candle desalinhado do intervalo',
    gap_too_large: `buraco de ${MAX_TOLERATED_GAP_MS / 3600000}h ou mais`,
    gap: 'buraco curto (possível parada da exchange)',
    starts_after_window: 'série começa depois do início da janela',
    ends_before_window: 'série termina antes do fim da janela',
  };
  const first = issue.samples?.[0];
  const where = first?.at && first.at !== 'null' ? ` — 1ª ocorrência em ${first.at}` : '';
  return `${issue.symbol} ${issue.timeframe}: ${labels[issue.type] || issue.type} (${issue.count}x)${where}`;
}
