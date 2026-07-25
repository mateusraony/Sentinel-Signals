// Pure, dependency-free retest detector — Fase 2 rodada 1 (docs/known-risks.md
// item 40). Original a este projeto: não porta nenhuma lógica do Pine real do
// usuário (o script de referência não usa esse conceito), então fica isento
// da obrigação de paridade Pine×JS descrita em .claude/rules/pine-parity.md.
//
// Scans a series of CLOSED candles for the first one that comes back to touch
// a previously broken `level` and closes (or wicks, depending on `touchMode`)
// back in the breakout direction. The signal candle itself never counts as
// its own retest — only candles that closed strictly after it are considered.
//
// No I/O, no Date.now() — every temporal reference is a caller-supplied
// timestamp (accepts either an ISO string or an epoch-ms number, same
// leniency as opExitRules.js's isCandleUsableForExits/getEntryReferenceTime).

export function detectRetest(candles, { direction, level, signalCandleTime, tolerancePrice, touchMode = 'close' }) {
  const notRetested = { retested: false, retestCandleTime: null, retestPrice: null, barsToConfirm: null, reason: null };

  if (level == null || tolerancePrice == null || tolerancePrice < 0) {
    return { ...notRetested, reason: 'invalid_params' };
  }
  if (direction !== 'BUY' && direction !== 'SELL') {
    return { ...notRetested, reason: 'invalid_params' };
  }
  if (!Array.isArray(candles) || candles.length === 0) {
    return { ...notRetested, reason: 'no_candles' };
  }

  const signalMs = signalCandleTime != null ? new Date(signalCandleTime).getTime() : null;
  const lowerBound = level - tolerancePrice;
  const upperBound = level + tolerancePrice;

  let barsSeen = 0;
  for (const candle of candles) {
    const candleMs = new Date(candle.closeTime).getTime();
    if (signalMs != null && candleMs <= signalMs) continue;
    barsSeen += 1;

    // touchMode 'wick': a touch is any overlap between the candle's full
    // [low, high] range and the tolerance band — NOT just whether a single
    // extreme (low for BUY, high for SELL) lands inside it. A candle whose
    // wick blows straight through the whole band (e.g. low well below
    // lowerBound, high well above upperBound) still physically crossed the
    // level; picking only one extreme missed that case entirely (external
    // audit of PR #81/#82, confirmed against this code before fixing —
    // dormant in production since touchMode defaults to 'close', which
    // never used this branch).
    const touchedLevel = touchMode === 'wick'
      ? (candle.high >= lowerBound && candle.low <= upperBound)
      : (candle.close >= lowerBound && candle.close <= upperBound);
    // Resumption in the breakout direction is judged on the CLOSE regardless
    // of touchMode — a wick that dips into the retest band but closes back
    // away from the level isn't a confirmed retest, just a longer wick.
    const resumedDirection = direction === 'BUY' ? candle.close >= lowerBound : candle.close <= upperBound;

    if (touchedLevel && resumedDirection) {
      return {
        retested: true,
        retestCandleTime: candle.closeTime,
        retestPrice: candle.close,
        barsToConfirm: barsSeen,
        reason: null,
      };
    }
  }

  return { ...notRetested, reason: 'not_yet' };
}
