// Node adapter for the historical backtest — the './pineParser' redirect
// target for scanner.js during a backtest run. Deliberately does NOT reuse
// adminPineConfig.js: that file reads strategyConfig/current from Firestore
// at call time (firebase-admin), which needs a live service account and
// network access — neither available (nor desired) for an offline replay.
// Instead this is a static config: the SAME DEFAULTS as pineParser.js/
// adminPineConfig.js, overridable via setPineConfigOverrides() (called once
// by run-backtest.mjs from --pine-config CLI JSON, if given).
//
// Keep DEFAULTS mirrored by hand with src/lib/pineParser.js and
// scripts/adminPineConfig.js — see those files' own comments on why there's
// no shared module (browser-only APIs on one side, firebase-admin on the
// other). Extracting a shared source is a separate, lower-risk cleanup
// (tracked, not part of this change — see the PR description's "fora de
// escopo" section).
const DEFAULTS = {
  rng_per: 20,
  rng_qty: 3.5,
  minScore: 75,
  atrLen: 14,
  tp1R: 1.5,
  tp1QtyPercent: 50,
  trailAtrMult: 2.0,
  emaFastLen: 20,
  emaSlowLen: 50,
  rsiLen: 14,
  volLen: 20,
  pineVersion: 6,
  strategyTitle: 'NEW ERA - Range Filter Strategy v13.2',
  tier2Threshold: 0.8,
  tier3Threshold: 1.5,
  useADX: true,
  adxLen: 14,
  adxSmooth: 14,
  useChop: true,
  chopLen: 14,
  useTimeStop: true,
  timeStopT1: 48,
  timeStopT2: 64,
  timeStopT3: 96,
  useChopExit: false,
  useInvalidation: false,
  invalidRFBars: 2,
  invalidScoreMin: 75,
  confirmBars: 1,
  onlyClosedCandles: true,
  // Cross-cascade arbitration + R:R gate + SMC score weights (Phase 1 —
  // see src/lib/signalArbitration.js/opExitRules.js/indicators/smcConfluence.js)
  arbEnabled: true,
  arbPromoteMinScore: 75,
  arbReinforceMinScore: 50,
  arbInvalidateOnOppositeMajor: false,
  arbOppositeScorePenalty: 15,
  minRR: 1.2,
  smcScoreStructureWeight: 15,
  smcScoreChochBonus: 10,
  smcScoreEmaWeight: 20,
  smcScoreRfWeight: 15,
  smcScoreVolumeWeight: 15,
  smcScoreAlignmentWeight: 15,
  smcScoreSweepWeight: 10,
};

let overrides = {};

// Called once by run-backtest.mjs before the replay starts, from a
// user-supplied --pine-config JSON file (if any) — lets a backtest run
// compare parameter sets (fase 2 of the user's request) without editing this
// file. Never mutates DEFAULTS itself.
export function setPineConfigOverrides(next = {}) {
  overrides = { ...next };
}

export async function getPineConfig() {
  return { ...DEFAULTS, ...overrides };
}
