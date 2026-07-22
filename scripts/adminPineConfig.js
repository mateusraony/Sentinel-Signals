// Node/GitHub Actions counterpart to src/lib/pineParser.js's getPineConfig().
// The strategy-business parameters below are read from strategyConfig/current
// in Firestore — the same document the in-browser Pine Script page writes to
// via syncPineToAssets() — so the 24/7 scan and the in-browser scan never
// disagree. rf_period/rf_multiplier don't need this: those are synced
// per-asset to Firestore already (MonitoredAsset.rf_period/rf_multiplier),
// read directly by scanner.js from the asset record.
//
// Keep this DEFAULTS/SYNCED_STRATEGY_KEYS pair mirrored by hand with
// src/lib/pineParser.js — there's no shared module between the two (the
// browser file uses browser-only APIs like localStorage), so any new synced
// parameter added there must be added here too.
import { getFirestore } from 'firebase-admin/firestore';

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

const SYNCED_STRATEGY_KEYS = [
  'minScore', 'tp1R', 'tp1QtyPercent', 'trailAtrMult',
  'tier2Threshold', 'tier3Threshold',
  'useADX', 'adxLen', 'adxSmooth', 'useChop', 'chopLen',
  'useTimeStop', 'timeStopT1', 'timeStopT2', 'timeStopT3',
  'useChopExit', 'useInvalidation', 'invalidRFBars', 'invalidScoreMin',
  'confirmBars', 'onlyClosedCandles',
  'emaFastLen', 'emaSlowLen', 'rsiLen', 'volLen', 'atrLen',
  'arbEnabled', 'arbPromoteMinScore', 'arbReinforceMinScore',
  'arbInvalidateOnOppositeMajor', 'arbOppositeScorePenalty', 'minRR',
  'smcScoreStructureWeight', 'smcScoreChochBonus', 'smcScoreEmaWeight',
  'smcScoreRfWeight', 'smcScoreVolumeWeight', 'smcScoreAlignmentWeight',
  'smcScoreSweepWeight',
];

export async function getPineConfig() {
  const config = { ...DEFAULTS };
  try {
    const db = getFirestore();
    const snap = await db.collection('strategyConfig').doc('current').get();
    if (snap.exists) {
      const data = snap.data();
      for (const key of SYNCED_STRATEGY_KEYS) {
        if (data[key] !== undefined) config[key] = data[key];
      }
    }
  } catch (e) {
    console.warn('[adminPineConfig] Falha ao ler strategyConfig, usando defaults:', e.message);
  }
  return config;
}
