// Pure, dependency-free exit-evaluation rules for active TradeOperations.
// Extracted from persistScanResults (scanner.js) so the temporal guard, the
// trailing-stop ordering and the per-candle RF counter are testable with plain
// fixtures — no Firestore, no mocks. The scanner wires these in; the rules
// themselves never touch I/O.

// P0-c/P0-g — temporal guard. A candle's high/low may only trigger stop/TP
// when the candle itself STARTED at or after the moment the position
// actually existed.
//
// P0-c (original): compared the candidate candle's CLOSE against the SIGNAL
// candle's close. That blocks the signal candle itself, but NOT the very
// next candle when confirmation is late (a retry): a 4h signal closing at
// 08:00, confirmed by a 15m candle only at 11:45 (op created then), still
// let the 08:00–12:00 candle evaluate stop/TP — its close (12:00) is
// "after" the signal close (08:00) — even though that candle's own price
// action from 08:00 to 11:45 happened BEFORE the entry existed.
//
// P0-g (this fix): compare the candidate candle's OPEN (not close) against
// the REAL entry reference — the confirming 15m/5m candle's close
// (entry_candle_time_15m/5m via getEntryReferenceTime below), not the
// signal candle's close. Only a candle that STARTS at or after the entry is
// guaranteed free of pre-entry price action. In the common fast-confirm
// path (no retry delay) this is equivalent to P0-c, since the confirming
// candle closes at essentially the same instant as the signal candle; the
// fix only changes behaviour for delayed/retried confirmations, where it
// additionally excludes the one candle that used to leak pre-entry action.
// Live price coverage for the deferred window continues via
// priceCheckActiveOps meanwhile (real-time price, not historical high/low).
//
// Legacy fallback: ops missing every reference field (pre-dating these
// fields, or a feed that doesn't report candle times) keep today's
// behaviour — evaluate — so old open operations are never stranded.
export function isCandleUsableForExits(candleOpenIso, entryTimeIso) {
  if (!candleOpenIso || !entryTimeIso) return true;
  return new Date(candleOpenIso).getTime() >= new Date(entryTimeIso).getTime();
}

// Best reference for "when did this operation actually start existing" —
// prefers the real confirming candle (15m for the RF cascade, 5m for the
// SMC cascade; mutually exclusive per op) over the signal candle's close,
// which is what isCandleUsableForExits needs to correctly exclude pre-entry
// price action (see above). Falls back to candle_close_time for paths where
// no confirmation candle time was recorded (legacy ops, manual/webhook
// entries) — the same fallback the guard already tolerated before P0-g.
export function getEntryReferenceTime(op) {
  return op.entry_candle_time_15m || op.entry_candle_time_5m || op.candle_close_time || null;
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

// Same-candle stop/target ambiguity (known-risks.md — formalizes what
// scanner.js already did inline, "stop has priority over TP on same candle
// for safety"). A closed candle's high AND low can both cross the stop and
// a target level; OHLC alone can't establish which happened first intrabar.
// Community convention (backtesting.py, QuantConnect, NinjaTrader — see
// PR that introduced this) is exactly this: assume the pessimistic case,
// stop first. stopWins never differs from stopTouched — this function
// exists to name the policy and to compute `ambiguous` in one place, so
// callers can flag it on the record instead of the ambiguity vanishing
// into an indistinguishable "clean" stop.
export function resolveCandleExit({ stopTouched, targetTouched }) {
  return { stopWins: stopTouched, ambiguous: Boolean(stopTouched && targetTouched) };
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

// Risk:Reward entry gate — rejects a candidate entry whose reward (distance
// to the chosen target) doesn't clear `minRR` times its risk (distance to
// the initial stop). Evaluated once, before createTradeOpIfNoneActive, on
// both cascades' already-computed entry/stop/tp1/tp2 (never recomputes them).
//
// Honesty note (see docs/known-risks.md): under BOTH cascades' current TP
// model, tp1/tp2 are derived AS `entry ± riskDistance * tp1R/tp2R` — i.e. as
// a multiple of the very risk distance this function divides by. That makes
// rr1 mathematically equal to pineConfig.tp1R (and rr2 to tp2R) for every
// real entry today: this gate cannot reject a real candidate unless tp1R
// itself is misconfigured below minRR, or a future structural (non-risk-
// derived) target replaces the current model. It still guards that
// misconfiguration and gives future structural TPs a real gate to plug into
// — kept honest rather than pretending it's an active filter today.
export function passesRiskReward({ entry, stop, tp1, tp2, minRR = 1.2, target = 'tp1' }) {
  if (![entry, stop, tp1].every(Number.isFinite)) {
    return { pass: false, rr1: null, rr2: null, reason: 'missing_fields' };
  }
  const riskDistance = Math.abs(entry - stop);
  if (riskDistance <= 0) {
    return { pass: false, rr1: null, rr2: null, reason: 'invalid_stop_distance' };
  }
  const rr1 = Math.abs(tp1 - entry) / riskDistance;
  const rr2 = Number.isFinite(tp2) ? Math.abs(tp2 - entry) / riskDistance : null;
  const chosen = target === 'tp2' ? rr2 : rr1;
  if (chosen == null) {
    return { pass: false, rr1, rr2, reason: 'missing_target' };
  }
  const pass = chosen >= minRR;
  return { pass, rr1, rr2, reason: pass ? null : 'rr_below_min' };
}
