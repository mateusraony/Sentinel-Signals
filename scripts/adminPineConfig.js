// Node/GitHub Actions counterpart to src/lib/pineParser.js's getPineConfig().
// The real Pine Script config only lives in the browser's localStorage
// (edited on the Pine Script page) — there's no server-side copy of it. This
// scheduled job always uses the same defaults the strategy ships with. If
// you customize minScore/tp1R/tp1QtyPercent/trailAtrMult in the app, update
// the matching values below too, or the 24/7 scan and the in-browser scan
// will disagree on those four parameters (rf_period/rf_multiplier don't have
// this problem — those are synced per-asset to Firestore already).
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

export function getPineConfig() {
  return { ...DEFAULTS };
}
