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
  // Runner do TP1 (known-risks item 46). LIGADO por padrão = comportamento de
  // sempre. Com `false`, o TP1 fecha 100% e vira saída terminal — medido em
  // -0,040 R por operação, mas num regime só. Espelha src/lib/pineParser.js.
  runnerEnabled: true,
  // Retest confirmation gate (Fase 2 rodada 1, src/lib/indicators/retest.js)
  // — master flag OFF by default, see docs/known-risks.md item 40.
  retestEnabled: false,
  retestToleranceAtrMult: 0.3,
  retestTouchMode: 'close',
  // Displacement candle gate (Fase 2 rodada 2, SMC 1h→5m only) — master flag
  // OFF by default, see docs/known-risks.md item 41.
  displacementEnabled: false,
  displacementBodyAtrMult: 1.5,
  displacementMinVolumeRatio: null,
  // SMC tier/regime gate (Fase 3, src/lib/indicators/tier.js) — master flag
  // OFF by default, see docs/known-risks.md item 42.
  smcTierEnabled: false,
  // Order Block / FVG (Fase 4) — informational score inputs, never a gate.
  // Numeric params mirror the real Pine; score weights start at 0 on purpose.
  // Master flag OFF by default, see docs/known-risks.md item 43.
  smcObFvgEnabled: false,
  obFvgAtrLen: 50,
  obMinAtrMult: 0.5,
  obMaxAtrMult: 2.5,
  fvgMinAtrMult: 0.5,
  fvgFillTargetRatio: 0.6,
  smcScoreObWeight: 0,
  smcScoreFvgWeight: 0,
  // Proteção de stop pré-TP1 (known-risks.md item 53/54) — master flag OFF
  // por padrão. Espelha src/lib/pineParser.js.
  preTp1StopProtectionEnabled: false,
  preTp1StopProtectionAtrMult: 1.0,
  // Gate de padrão de vela (engolfo) na cascata RF — master flag OFF por
  // padrão. Espelha src/lib/pineParser.js.
  candlePatternEnabled: false,
  // Bypassa check15mConfirmation na cascata RF nativa 4h→15m (known-risks.md
  // item 67) — master flag OFF por padrão. Espelha src/lib/pineParser.js.
  skip15mConfirmationEnabled: false,
  // NOTA (não é omissão): `rf1hCondEnabled` (Fase 1, docs/known-risks.md
  // item 56 "Fase 1") existe SÓ em scripts/backtestPineConfig.js —
  // deliberadamente NÃO espelhado aqui, ao contrário da convenção padrão
  // acima ("mantenha espelhado à mão"). Esta chave sincronizaria com
  // strategyConfig/current no Firestore, gravável por qualquer sessão
  // anônima (sem tela de login, CLAUDE.md decisão item 1) — mirroring
  // criaria um toggle de produção sem gate de revisão. O experimento deve
  // ficar restrito ao motor de backtest. Tripwire test em
  // scannerStateMachine.test.js falha se essa chave aparecer aqui.
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
  'runnerEnabled',
  'retestEnabled', 'retestToleranceAtrMult', 'retestTouchMode',
  'displacementEnabled', 'displacementBodyAtrMult', 'displacementMinVolumeRatio',
  'smcTierEnabled',
  'smcObFvgEnabled', 'obFvgAtrLen', 'obMinAtrMult', 'obMaxAtrMult',
  'fvgMinAtrMult', 'fvgFillTargetRatio', 'smcScoreObWeight', 'smcScoreFvgWeight',
  'preTp1StopProtectionEnabled', 'preTp1StopProtectionAtrMult',
  'candlePatternEnabled',
  'skip15mConfirmationEnabled',
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
