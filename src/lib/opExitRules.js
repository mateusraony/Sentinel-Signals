// Pure, dependency-free exit-evaluation rules for active TradeOperations.
// Extracted from persistScanResults (scanner.js) so the temporal guard, the
// trailing-stop ordering and the per-candle RF counter are testable with plain
// fixtures — no Firestore, no mocks. The scanner wires these in; the rules
// themselves never touch I/O.

// P0-c — temporal guard. A candle's high/low may only trigger stop/TP when the
// candle closed STRICTLY AFTER the operation's signal candle: the signal
// candle itself (and anything older, e.g. on replay) contains price movement
// from BEFORE the entry existed, so "hitting" TP/stop on it is retroactive.
// Legacy fallback: ops created before candle_close_time existed (or a feed
// that doesn't report lastCandleTime) keep today's behaviour — evaluate —
// so old open operations are never stranded by the new guard.
export function isCandleUsableForExits(candleCloseIso, entryCandleCloseIso) {
  if (!candleCloseIso || !entryCandleCloseIso) return true;
  return new Date(candleCloseIso).getTime() > new Date(entryCandleCloseIso).getTime();
}

// P0-d — ATR trailing advance, monotonic (a runner stop never retreats).
// The caller must evaluate the CURRENT candle's stop-hit against the STORED
// stop BEFORE calling this: a stop derived from this candle's close only
// protects from the next candle on — testing it against the same candle's
// low/high is look-ahead.
export function advanceTrailingStop({ isBuy, currentStop, closePrice, atrValue, trailMult }) {
  const atrTrailStop = isBuy
    ? closePrice - atrValue * trailMult
    : closePrice + atrValue * trailMult;
  return isBuy ? Math.max(currentStop, atrTrailStop) : Math.min(currentStop, atrTrailStop);
}

// P0-e — RF-reversal counter that counts CANDLES, not scanner passes. The
// cron runs every 5 minutes over a 4h/1h signal timeframe, so a naive "+1 per
// pass while reversed" overcounts the same candle many times. Dedup by the
// candle's close time: same candle → count unchanged; new candle → +1; RF back
// in favour → reset. Legacy fallback (no candleTime from the feed) keeps the
// old per-pass behaviour rather than silently freezing the counter.
export function nextRfReverseCount({ rfReversedAgainst, prevCount, prevCandleTime, candleTime }) {
  if (!rfReversedAgainst) return { count: 0, lastCandle: null };
  if (!candleTime) return { count: prevCount + 1, lastCandle: null };
  if (prevCandleTime === candleTime) return { count: prevCount, lastCandle: candleTime };
  return { count: prevCount + 1, lastCandle: candleTime };
}
