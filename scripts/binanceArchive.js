// Pure helpers for scripts/fetch-backtest-data-futures.mjs — building
// data.binance.vision archive URLs and parsing the CSV kline format inside
// each ZIP. Split out from the fetch script so the parsing/URL logic (the
// part that can silently corrupt data if wrong) is unit-testable without
// hitting the network, same separation-of-pure-logic-from-I/O pattern used
// throughout src/lib/ (opTransition.js, opExitRules.js, etc.).
//
// docs/known-risks.md item 86/122: data.binance.vision (batch archive CDN)
// is NOT subject to the 451-by-datacenter-IP block that hits fapi.binance.com
// (item 4) — this is what makes downloading real Futures (USDⓈ-M perpetual)
// history possible from a GitHub Actions runner, closing the Spot-vs-Futures
// data mismatch for BACKTEST measurements (the live 24/7 cron still reads
// Spot; that part is unchanged and has no free fix, see item 4).

const ARCHIVE_BASE = 'https://data.binance.vision/data/futures/um';

export function buildMonthlyUrl(symbol, interval, year, month) {
  const mm = String(month).padStart(2, '0');
  return `${ARCHIVE_BASE}/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${year}-${mm}.zip`;
}

export function buildDailyUrl(symbol, interval, year, month, day) {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${ARCHIVE_BASE}/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${year}-${mm}-${dd}.zip`;
}

/**
 * Every calendar month touched by [fromMs, toMs), inclusive of partial
 * months at either edge — a monthly archive is tried first for each one
 * (fetchFuturesArchive falls back to daily files when the monthly ZIP 404s,
 * e.g. the current/most recent month, not yet published as a monthly roll-up).
 * @returns {{ year: number, month: number }[]} month is 1-12, chronological order.
 */
export function monthsInRange(fromMs, toMs) {
  const months = [];
  const cursor = new Date(Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), 1));
  const end = new Date(toMs);
  while (cursor.getTime() < end.getTime() || (cursor.getUTCFullYear() === end.getUTCFullYear() && cursor.getUTCMonth() === end.getUTCMonth())) {
    months.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    if (months.length > 600) break; // 50 years — sanity guard against a bad date input looping forever
  }
  return months;
}

/**
 * Days of a given UTC month clipped to [fromMs, toMs) — used for the
 * daily-file fallback when a month's monthly archive isn't published yet.
 * @returns {number[]} day-of-month values (1-31) actually inside the requested range.
 */
export function daysInMonthRange(year, month, fromMs, toMs) {
  const days = [];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const dayStart = Date.UTC(year, month - 1, day);
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    if (dayEnd <= fromMs || dayStart >= toMs) continue;
    days.push(day);
  }
  return days;
}

// Binance's historical archive switched open_time/close_time to
// MICROSECONDS for data from 2025-01-01 onward (confirmed for Spot in the
// official binance-public-data README; Futures archives are not confirmed
// either way in public docs as of this writing, and old files predating the
// change are still milliseconds). Rather than hardcode a cutover date this
// detects the unit per-value by magnitude: a millisecond epoch timestamp for
// any date in this project's lifetime (2020-2030) is 13 digits; a
// microsecond one is 16. 1e14 sits well between the two with wide margin in
// both directions, so this is robust regardless of the exact/undocumented
// cutover and works uniformly across old (ms) and new (µs) files without
// needing to know which is which ahead of time.
const MICROSECOND_THRESHOLD = 1e14;

function normalizeTimestamp(raw) {
  const n = Number(raw);
  return n >= MICROSECOND_THRESHOLD ? Math.round(n / 1000) : n;
}

/**
 * Parses one archive CSV's raw text (the file inside the ZIP) into the same
 * candle shape scripts/fetch-backtest-data.mjs already produces from the
 * Spot REST API, so scripts/backtestMarketDataProvider.js needs no changes.
 * Handles two format variations transparently, both confirmed to exist
 * across different archive vintages:
 *  - an optional header row (skipped by checking whether the first cell of
 *    the first row parses as a number — a real open_time never doesn't);
 *  - millisecond vs. microsecond timestamps (see normalizeTimestamp above).
 * Column order (both Spot and Futures UM klines): open_time,open,high,low,
 * close,volume,close_time,quote_volume,count,taker_buy_volume,
 * taker_buy_quote_volume,ignore.
 * @param {string} csvText
 * @returns {{ openTime: number, open: number, high: number, low: number, close: number, volume: number, closeTime: number }[]}
 */
export function parseKlineCsv(csvText) {
  const lines = csvText.split('\n').map((l) => l.trim()).filter(Boolean);
  const candles = [];
  for (const line of lines) {
    const cols = line.split(',');
    if (cols.length < 7) continue;
    const openTimeRaw = Number(cols[0]);
    if (!Number.isFinite(openTimeRaw)) continue; // header row (e.g. "open_time")
    candles.push({
      openTime: normalizeTimestamp(cols[0]),
      open: parseFloat(cols[1]),
      high: parseFloat(cols[2]),
      low: parseFloat(cols[3]),
      close: parseFloat(cols[4]),
      volume: parseFloat(cols[5]),
      closeTime: normalizeTimestamp(cols[6]),
    });
  }
  return candles;
}

/**
 * Sorts by openTime, drops duplicates (monthly + daily fallback can overlap
 * at a month boundary), and clips to [fromMs, toMs) plus the "only truly
 * closed candles" rule already used by scripts/fetch-backtest-data.mjs — a
 * still-forming bar at fetch time must not be baked into the fixture as a
 * closed one.
 * @param {ReturnType<typeof parseKlineCsv>} candles
 */
export function dedupeAndFilterCandles(candles, fromMs, toMs, nowMs) {
  const byOpenTime = new Map();
  for (const c of candles) {
    if (c.closeTime > nowMs) continue;
    if (c.openTime < fromMs || c.openTime >= toMs) continue;
    byOpenTime.set(c.openTime, c); // later source (daily fallback, read after monthly) wins on exact collision
  }
  return [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);
}
