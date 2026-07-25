// Pure, dependency-free displacement-candle classifier — Fase 2 rodada 2
// (docs/known-risks.md item 41). Original to this project: no canonical
// numeric definition of "displacement" exists in ICT community material, and
// the project's own reference Pine (docs/reference-pine/smc-a-unified-v2.3.pine)
// doesn't use the term either — it has an unrelated body/ATR(200) filter for
// Order Block confirmation (is_bac) and a separate body/ATR(3)+wick-asymmetry
// momentum filter for BOS/CHoCH (filter_insignificant_internal_breaks).
// Deliberately simpler than either of those: ONE configurable body/ATR ratio,
// plus an OPTIONAL volume-ratio requirement (off unless a minVolumeRatio is
// given — canonical ICT never required volume, it originated in forex where
// no real trade volume exists; crypto has real volume, so this project makes
// it an available, not mandatory, extra filter). Isn't a paridade-Pine
// function — no golden-test obligation (.claude/rules/pine-parity.md).
//
// Evaluates a SINGLE candle (the entry trigger candle a confirmation gate
// already identified), not a window — displacement is a property of one
// bar, unlike a retest which is a multi-bar search (src/lib/indicators/retest.js).

export function detectDisplacement(candle, { direction, atrValue, bodyAtrMult, minVolumeRatio = null, volumeMa = null }) {
  const invalid = { isDisplacement: false, bodyRatio: null, volumeRatio: null, reason: 'invalid_params' };
  if (!candle || (direction !== 'BUY' && direction !== 'SELL') ||
    atrValue == null || atrValue <= 0 || bodyAtrMult == null || bodyAtrMult <= 0) {
    return invalid;
  }

  // A structure-break entry (BOS/CHoCH) only requires the CLOSE to cross a
  // prior pivot — it doesn't require the candle itself to be net bullish/
  // bearish by open×close. A candle that gaps up, sells off intrabar, but
  // still closes above the pivot would pass the structure gate as a valid
  // BUY signal while its own body is net bearish. Checked here, before the
  // body/ATR ratio, so a doji (open === close) fails on both sides too.
  const alignedWithDirection = direction === 'BUY' ? candle.close > candle.open : candle.close < candle.open;
  if (!alignedWithDirection) {
    return { isDisplacement: false, bodyRatio: null, volumeRatio: null, reason: 'wrong_direction' };
  }

  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / atrValue;
  const bodyOk = bodyRatio >= bodyAtrMult;

  let volumeRatio = null;
  if (minVolumeRatio != null) {
    if (volumeMa == null || volumeMa <= 0) {
      return { isDisplacement: false, bodyRatio, volumeRatio: null, reason: 'insufficient_volume_data' };
    }
    volumeRatio = (candle.volume ?? 0) / volumeMa;
  }

  if (!bodyOk) return { isDisplacement: false, bodyRatio, volumeRatio, reason: 'body_too_small' };
  if (minVolumeRatio != null && volumeRatio < minVolumeRatio) {
    return { isDisplacement: false, bodyRatio, volumeRatio, reason: 'volume_too_low' };
  }
  return { isDisplacement: true, bodyRatio, volumeRatio, reason: null };
}
