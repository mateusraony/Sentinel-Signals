// Pure, dependency-free validation for the numeric fields AssetConfigPanel.jsx
// lets the user edit per asset. Extracted (rather than inlined in the
// component) so it's testable the same way as opTransition.js/opExitRules.js
// — this repo's test suite lives entirely under src/lib/**, not
// src/components/**.
//
// Why this exists: every numeric input in AssetConfigPanel.jsx used raw
// Number(e.target.value) with no NaN/min/max/relational guard, and
// handleSave wrote the whole config to Firestore unconditionally. scanner.js
// only individually guards rsi_period/ema_short/ema_long/emaFast-vs-emaSlow
// (via firstPositive/resolveIndicatorParams) — this is the save-time gate
// that stops bad values from ever reaching Firestore in the first place.
// Community consensus for number-input UX (see PR discussion) is to let the
// user type freely and validate on submit/blur, not fight every keystroke —
// so this runs once, at Save, not on every onChange.

function isPositiveNumber(x) {
  return Number.isFinite(x) && x > 0;
}

// Codex review (PR #61): period/bar-count fields aren't just "any positive
// number" — calculateRSI (src/lib/indicators/rsi.js) and calculateATR use
// `period` directly as an array index/loop bound (`avgGain[period]`,
// `for (let i = period; i < n; i++)`). A fractional period like 14.5 never
// touches an INTEGER index at or past that point, so the whole series stays
// at its `.fill()` default (RSI silently reads 50/'neutral' forever) —
// wrong output, not a thrown error. MACD/EMA/RangeFilter use period only as
// an exponential-smoothing constant (harmless if fractional), but a
// fractional bar-count is meaningless for any of them either way, so all
// period fields require an integer here for consistency.
function isPositiveInteger(x) {
  return Number.isInteger(x) && x > 0;
}

export function validateAssetConfig(config) {
  const errors = [];

  if (!isPositiveInteger(config.rf_period)) errors.push('Range Filter: período deve ser um número inteiro positivo');
  if (!isPositiveNumber(config.rf_multiplier)) errors.push('Range Filter: multiplicador deve ser um número positivo');

  if (!isPositiveInteger(config.rsi_period)) errors.push('RSI: período deve ser um número inteiro positivo');
  if (!isPositiveNumber(config.rsi_overbought) || !isPositiveNumber(config.rsi_oversold)) {
    errors.push('RSI: overbought e oversold devem ser números positivos');
  } else {
    if (config.rsi_overbought >= 100) errors.push('RSI: overbought deve ser menor que 100');
    if (config.rsi_oversold >= 100) errors.push('RSI: oversold deve ser menor que 100');
    if (config.rsi_overbought <= config.rsi_oversold) errors.push('RSI: overbought deve ser maior que oversold');
  }

  if (!isPositiveInteger(config.macd_fast)) errors.push('MACD: período fast deve ser um número inteiro positivo');
  if (!isPositiveInteger(config.macd_slow)) errors.push('MACD: período slow deve ser um número inteiro positivo');
  if (!isPositiveInteger(config.macd_signal)) errors.push('MACD: período signal deve ser um número inteiro positivo');
  if (isPositiveInteger(config.macd_fast) && isPositiveInteger(config.macd_slow) && config.macd_fast >= config.macd_slow) {
    errors.push('MACD: período fast deve ser menor que slow');
  }

  if (!isPositiveInteger(config.ema_short)) errors.push('EMA: período curto deve ser um número inteiro positivo');
  if (!isPositiveInteger(config.ema_long)) errors.push('EMA: período longo deve ser um número inteiro positivo');
  if (isPositiveInteger(config.ema_short) && isPositiveInteger(config.ema_long) && config.ema_short >= config.ema_long) {
    errors.push('EMA: período curto deve ser menor que o longo');
  }

  if (!Number.isFinite(config.alert_cooldown_minutes) || config.alert_cooldown_minutes < 0) {
    errors.push('Cooldown de alertas: deve ser um número maior ou igual a zero');
  }

  return errors;
}
