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

// Structural initial stop for the SMC 1h→5m cascade (known-risks item 11's
// pending design point, community-validated: stop goes BEYOND the sweep
// wick / protective swing with a buffer — never exactly at the level, which
// gets tagged routinely on inducement spikes). The three ATR(1h) bounds:
//   buffer  — small offset past the structural level (default 0.1×ATR)
//   floor   — minimum stop distance so 5m noise can't produce a stop the
//             next wick clips (default 0.5×ATR, the community's lower bound)
//   cap     — maximum distance = the old fixed SMC stop (2.0×ATR), so the
//             worst case never exceeds today's behaviour
// When the structural level is missing or on the wrong side of the entry,
// falls back to the plain cap-distance ATR stop (the pre-migration model).
export function computeStructuralStop({
  isBuy, entry, structuralLevel, atrValue,
  bufferAtrMult = 0.1, minAtrMult = 0.5, maxAtrMult = 2.0,
}) {
  const fallbackStop = isBuy ? entry - atrValue * maxAtrMult : entry + atrValue * maxAtrMult;
  if (!Number.isFinite(structuralLevel) || !Number.isFinite(entry) || !Number.isFinite(atrValue) || atrValue <= 0) {
    return { stop: fallbackStop, basis: 'atr_fallback' };
  }
  const buffered = isBuy
    ? structuralLevel - atrValue * bufferAtrMult
    : structuralLevel + atrValue * bufferAtrMult;
  const distance = isBuy ? entry - buffered : buffered - entry;
  if (distance <= 0) {
    // Structural level at/beyond the entry on the wrong side — thesis level
    // unusable as a stop; keep the ATR model.
    return { stop: fallbackStop, basis: 'atr_fallback' };
  }
  const minDistance = atrValue * minAtrMult;
  const maxDistance = atrValue * maxAtrMult;
  if (distance < minDistance) {
    return { stop: isBuy ? entry - minDistance : entry + minDistance, basis: 'structural_floored' };
  }
  if (distance > maxDistance) {
    return { stop: fallbackStop, basis: 'structural_capped' };
  }
  return { stop: isBuy ? entry - distance : entry + distance, basis: 'structural' };
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
