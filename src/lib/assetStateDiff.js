// Pure, dependency-free comparison used to decide whether an AssetState
// write is actually needed. Extracted so it's testable without Firestore,
// mirroring the pattern established for opTransition.js/opExitRules.js/
// assetHealthcheck.js. Consumed by src/lib/scanner.js's persistScanResults,
// which otherwise calls AssetState.update() once per timeframe on EVERY
// scan pass (every 5 min via the cron), even when the underlying candle
// hasn't closed yet and every field is byte-identical to what's already
// stored (see docs/known-risks.md item 17).
//
// `processed_at` is intentionally excluded from the comparison — it's a
// volatile "computed at" timestamp, not part of the state itself, so
// including it would make every call report a change and defeat the guard.
const COMPARABLE_FIELDS = [
  'last_close', 'last_candle_time',
  'rf_filter_value', 'rf_direction', 'rf_high_band', 'rf_low_band', 'rf_signal', 'rf_cond_ini',
  'rsi_value', 'rsi_zone',
  'macd_line', 'macd_signal_line', 'macd_histogram', 'macd_cross',
  'ema_short_value', 'ema_long_value', 'ema_cross', 'trend_ema',
];

export function hasAssetStateChanged(existing, next) {
  if (!existing) return true;
  return COMPARABLE_FIELDS.some((field) => existing[field] !== next[field]);
}
