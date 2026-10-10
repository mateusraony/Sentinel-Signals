// Parsers e URLs do laboratório de padrões — docs/known-risks.md item 266.
// Funções puras (sem rede), testáveis; o download fica em
// scripts/fetch-pattern-lab-data.mjs.
//
// Por que um arquivo novo em vez de mexer em scripts/binanceArchive.js: o
// parser de klines de lá (`parseKlineCsv`) devolve só OHLCV porque é o formato
// que o motor de backtest consome — mudar a saída dele mexeria em algo que
// funciona. Aqui precisamos das colunas que ele descarta (volume agressor de
// compra) e de dois datasets que ele não conhece (premiumIndexKlines e
// metrics). Os helpers de URL/mês/funding de lá são REUSADOS, não copiados.

const ARCHIVE_BASE = 'https://data.binance.vision/data/futures/um';
const pad2 = (n) => String(n).padStart(2, '0');

export function buildMonthlyPremiumUrl(symbol, interval, year, month) {
  return `${ARCHIVE_BASE}/monthly/premiumIndexKlines/${symbol}/${interval}/${symbol}-${interval}-${year}-${pad2(month)}.zip`;
}

export function buildDailyPremiumUrl(symbol, interval, year, month, day) {
  return `${ARCHIVE_BASE}/daily/premiumIndexKlines/${symbol}/${interval}/${symbol}-${interval}-${year}-${pad2(month)}-${pad2(day)}.zip`;
}

// metrics só existe em arquivo DIÁRIO (com linhas de 5 em 5 minutos dentro).
export function buildDailyMetricsUrl(symbol, year, month, day) {
  return `${ARCHIVE_BASE}/daily/metrics/${symbol}/${symbol}-metrics-${year}-${pad2(month)}-${pad2(day)}.zip`;
}

// Mesma regra de scripts/binanceArchive.js (lá não é exportada): o arquivo da
// Binance passou a usar MICROssegundos a partir de 2025; detecta pela
// magnitude. Duplicada aqui de propósito para não tocar aquele arquivo.
const MICROSECOND_THRESHOLD = 1e14;
export function normalizeTimestamp(raw) {
  const n = Number(raw);
  return n >= MICROSECOND_THRESHOLD ? Math.round(n / 1000) : n;
}

/**
 * Klines com as colunas de fluxo. Ordem (Spot e Futures UM): open_time, open,
 * high, low, close, volume, close_time, quote_volume, count,
 * taker_buy_volume, taker_buy_quote_volume, ignore. Cabeçalho opcional.
 * @param {string} csvText
 * @returns {{ openTime: number, close: number, volume: number, takerBuyVolume: number, trades: number }[]}
 */
export function parseFlowKlineCsv(csvText) {
  const out = [];
  for (const raw of csvText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 10) continue;
    if (!Number.isFinite(Number(cols[0]))) continue; // cabeçalho
    out.push({
      openTime: normalizeTimestamp(cols[0]),
      close: parseFloat(cols[4]),
      volume: parseFloat(cols[5]),
      trades: Number(cols[8]),
      takerBuyVolume: parseFloat(cols[9]),
    });
  }
  return out;
}

// "2023-01-01 00:05:00" (UTC) → epoch ms. Aceita também epoch numérico.
export function parseUtcDateTime(text) {
  const s = String(text).trim();
  if (/^\d+$/.test(s)) return normalizeTimestamp(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// Colunas do metrics, resolvidas PELO NOME do cabeçalho (nunca por posição —
// uma coluna trocada aqui seria indistinguível de dado real).
const METRICS_COLUMNS = {
  createTime: ['create_time'],
  openInterest: ['sum_open_interest'],
  topPositionLS: ['sum_toptrader_long_short_ratio'],
  globalAccountLS: ['count_long_short_ratio'],
};

/**
 * @param {string} csvText
 * @returns {{ time: number, openInterest: number, topPositionLS: number, globalAccountLS: number }[]}
 */
export function parseMetricsCsv(csvText) {
  const lines = csvText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map((c) => c.trim().toLowerCase());
  const idx = {};
  for (const [key, names] of Object.entries(METRICS_COLUMNS)) {
    idx[key] = header.findIndex((h) => names.includes(h));
    if (idx[key] === -1) {
      throw new Error(`metrics CSV sem a coluna ${names[0]} (cabeçalho: ${header.join('|')}) — abortado em vez de adivinhar posição`);
    }
  }
  const num = (v) => {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : null;
  };
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    const time = parseUtcDateTime(cols[idx.createTime]);
    if (!Number.isFinite(time)) continue;
    rows.push({
      time,
      openInterest: num(cols[idx.openInterest]),
      topPositionLS: num(cols[idx.topPositionLS]),
      globalAccountLS: num(cols[idx.globalAccountLS]),
    });
  }
  return rows;
}

/**
 * Último valor conhecido NO FECHAMENTO de cada barra, sem olhar o futuro.
 * Uma linha de metrics só vale para a barra que fecha em C se
 * `time ≤ C − maxRowLagMs` (não sabemos se o carimbo é início ou fim da janela
 * de 5 min — o atraso de uma linha cobre os dois casos). Se a última linha
 * válida for mais velha que `maxStaleMs`, o valor fica null (buraco no dado,
 * nunca valor velho fingindo ser atual).
 * @param {number[]} barCloses fechamentos das barras (ms), em ordem
 * @param {{ time: number }[]} rows ordenadas por time
 */
export function alignRowsToBars(barCloses, rows, { maxRowLagMs, maxStaleMs }) {
  const out = new Array(barCloses.length).fill(null);
  let j = -1;
  for (let i = 0; i < barCloses.length; i += 1) {
    const cutoff = barCloses[i] - maxRowLagMs;
    while (j + 1 < rows.length && rows[j + 1].time <= cutoff) j += 1;
    if (j >= 0 && barCloses[i] - rows[j].time <= maxStaleMs) out[i] = rows[j];
  }
  return out;
}

// A liquidação mais espaçada da Binance é de 8h; mais de 24h sem nenhuma é
// buraco no dado — vira null em vez de repetir uma taxa velha.
export const FUNDING_MAX_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Funding por hora vigente no fechamento C: a última liquidação com
 * `calcTime ≤ C`, dividida pelas horas do intervalo (algumas moedas mudaram de
 * 8h para 4h; sem normalizar, a mudança de intervalo viraria "sinal").
 * Intervalo ausente no arquivo antigo = 8h (o padrão histórico da Binance).
 * @param {number[]} barCloses
 * @param {{ calcTime: number, intervalHours: number|null, rate: number }[]} fundingRows ordenadas
 */
export function alignFundingToBars(barCloses, fundingRows) {
  const out = new Array(barCloses.length).fill(null);
  let j = -1;
  for (let i = 0; i < barCloses.length; i += 1) {
    while (j + 1 < fundingRows.length && fundingRows[j + 1].calcTime <= barCloses[i]) j += 1;
    if (j >= 0 && barCloses[i] - fundingRows[j].calcTime <= FUNDING_MAX_STALE_MS) {
      out[i] = fundingRows[j].rate / (fundingRows[j].intervalHours || 8);
    }
  }
  return out;
}

/**
 * Junta os quatro datasets numa barra de 4h por linha, só com o que já era
 * conhecido no fechamento C de cada barra. Barra fora de [dataStart, dataEnd]
 * (pelo fechamento) é descartada — o laboratório nunca guarda dado depois do
 * fim pré-registrado.
 * @returns {{ t: number, close: number, volume: number, takerBuyVolume: number,
 *   premium: number|null, fundingPerHour: number|null, openInterest: number|null,
 *   topPositionLS: number|null, globalAccountLS: number|null }[]}
 */
export function buildLabBars({ klines, premium = [], funding = [], metricsRows = [], barMs, dataStartMs, dataEndMs, maxRowLagMs, maxStaleMs }) {
  const byOpen = new Map();
  for (const k of klines) {
    const close = k.openTime + barMs;
    if (k.openTime < dataStartMs || close > dataEndMs) continue;
    if (!(k.volume > 0) || !Number.isFinite(k.close)) continue;
    byOpen.set(k.openTime, k);
  }
  const bars = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
  const closes = bars.map((k) => k.openTime + barMs);
  const premiumByOpen = new Map(premium.map((p) => [p.openTime, p.close]));
  const fundingAt = alignFundingToBars(closes, [...funding].sort((a, b) => a.calcTime - b.calcTime));
  const metricsAt = alignRowsToBars(closes, [...metricsRows].sort((a, b) => a.time - b.time), { maxRowLagMs, maxStaleMs });
  return bars.map((k, i) => ({
    t: closes[i],
    close: k.close,
    volume: k.volume,
    takerBuyVolume: k.takerBuyVolume,
    premium: Number.isFinite(premiumByOpen.get(k.openTime)) ? premiumByOpen.get(k.openTime) : null,
    fundingPerHour: fundingAt[i],
    openInterest: metricsAt[i]?.openInterest ?? null,
    topPositionLS: metricsAt[i]?.topPositionLS ?? null,
    globalAccountLS: metricsAt[i]?.globalAccountLS ?? null,
  }));
}
