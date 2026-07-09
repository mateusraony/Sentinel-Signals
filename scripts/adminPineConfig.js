// Node/GitHub Actions counterpart to src/lib/pineParser.js's getPineConfig().
// The 4 strategy-business parameters (minScore/tp1R/tp1QtyPercent/
// trailAtrMult) are read from strategyConfig/current in Firestore — the
// same document the in-browser Pine Script page writes to via
// syncPineToAssets() — so the 24/7 scan and the in-browser scan never
// disagree on those four. rf_period/rf_multiplier don't need this: those
// are synced per-asset to Firestore already (MonitoredAsset.rf_period/
// rf_multiplier), read directly by scanner.js from the asset record.
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
  strategyTitle: 'NEW ERA - Range Filter Strategy v12',
};

const SYNCED_STRATEGY_KEYS = ['minScore', 'tp1R', 'tp1QtyPercent', 'trailAtrMult'];

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
