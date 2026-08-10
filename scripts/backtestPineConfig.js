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
  // Runner do TP1 (known-risks item 46). LIGADO por padrão = comportamento de
  // sempre. Com `false`, o TP1 fecha 100% e vira saída terminal. Override via
  // --pine-config para comparar relatórios com/sem.
  runnerEnabled: true,
  // Retest confirmation gate (Fase 2 rodada 1, src/lib/indicators/retest.js)
  // — master flag OFF by default, see docs/known-risks.md item 40. Override
  // via --pine-config to compare backtest reports with/without it.
  retestEnabled: false,
  retestToleranceAtrMult: 0.3,
  retestTouchMode: 'close',
  // Displacement candle gate (Fase 2 rodada 2, SMC 1h→5m only) — master flag
  // OFF by default, see docs/known-risks.md item 41. Override via
  // --pine-config to compare backtest reports with/without it.
  displacementEnabled: false,
  displacementBodyAtrMult: 1.5,
  displacementMinVolumeRatio: null,
  // SMC tier/regime gate (Fase 3, src/lib/indicators/tier.js) — master flag
  // OFF by default, see docs/known-risks.md item 42.
  smcTierEnabled: false,
  // Order Block / FVG (Fase 4) — informational score inputs, never a gate.
  // Master flag OFF by default; weights start at 0. Use --pine-config to
  // compare backtest reports with/without. See docs/known-risks.md item 43.
  smcObFvgEnabled: false,
  obFvgAtrLen: 50,
  obMinAtrMult: 0.5,
  obMaxAtrMult: 2.5,
  fvgMinAtrMult: 0.5,
  fvgFillTargetRatio: 0.6,
  smcScoreObWeight: 0,
  smcScoreFvgWeight: 0,
  // Bypassa check15mConfirmation na cascata RF nativa 4h→15m (known-risks.md
  // item 67) — master flag OFF by default. Override via --pine-config to
  // compare backtest reports with/without it. Espelha src/lib/pineParser.js/
  // scripts/adminPineConfig.js.
  skip15mConfirmationEnabled: false,
  // RF 1h condicionado ao 4h (Fase 1, docs/known-risks.md item 56 "Fase 1")
  // — master flag OFF by default. INTENTIONALLY NOT mirrored to
  // src/lib/pineParser.js / scripts/adminPineConfig.js (breaks the usual
  // "add to all 3" convention on purpose): those two feed
  // strategyConfig/current in Firestore, writable by any anonymous session
  // (no login screen, CLAUDE.md decision item 1) — a key there is a live
  // production toggle with zero code-review gate. This experiment must stay
  // backtest-only, so it can only ever be set via --pine-config here. See
  // src/lib/pineParser.js/scripts/adminPineConfig.js DEFAULTS comments (same
  // note, mirrored) and the tripwire test in scannerStateMachine.test.js
  // that fails if this key ever appears in either of those two files.
  rf1hCondEnabled: false,
  // RF 1h TOTALMENTE independente do 4h (docs/known-risks.md item 68) —
  // mesma mecânica do rf1hCondEnabled acima (mesmo tf4hData pra ATR/tier/
  // regime, mesma check15mConfirmation), SEM o gate de concordância
  // direcional com o 4h. Isola exatamente essa variável em relação ao
  // condicionado, pra comparação A/B direta. Master flag OFF by default.
  // INTENTIONALLY NOT mirrored to src/lib/pineParser.js /
  // scripts/adminPineConfig.js — mesmo motivo do rf1hCondEnabled (chave
  // viva em strategyConfig/current seria toggle de produção sem
  // code-review). Backtest-only, só via --pine-config aqui. Ver o tripwire
  // test em src/lib/rf1hUncondTripwire.test.js. Nunca ligar junto com
  // rf1hCondEnabled no mesmo run — convenção, não validado em runtime.
  rf1hUncondEnabled: false,
  // Filtro de lado na cascata RF nativa (docs/known-risks.md item 71) —
  // 'SELL', 'BUY' ou ausente/null (default, os dois lados, comportamento de
  // sempre). Motivado por achado real: nas operações reais já medidas
  // (20 símbolos/12 meses), BUY teve expectância -0,324R (CONCLUSIVA, IC95
  // não cruza zero) e SELL +0,271R (também CONCLUSIVA) — o padrão mais forte
  // já medido neste projeto. Um parâmetro só (não 2 flags booleanas) evita
  // precisar validar mutex e permite testar SELL-only e BUY-only pela MESMA
  // mecânica, pro contraste que a comparação pede. INTENTIONALLY NOT
  // mirrored to src/lib/pineParser.js/scripts/adminPineConfig.js — mesmo
  // motivo dos outros flags backtest-only acima (chave viva em
  // strategyConfig/current seria toggle de produção sem code-review, e uma
  // mudança de ESTRATÉGIA dessa magnitude exige A/B real antes de cogitar
  // produção). Backtest-only, só via --pine-config. Ver o tripwire test em
  // src/lib/allowedSideTripwire.test.js.
  allowedSide: null,
};

let overrides = {};

// Called once by run-backtest.mjs before the replay starts, from a
// user-supplied --pine-config JSON file (if any) — lets a backtest run
// compare parameter sets (fase 2 of the user's request) without editing this
// file. Never mutates DEFAULTS itself.
export function setPineConfigOverrides(next = {}) {
  // Codex review (PR #156): um valor inválido (typo, caixa errada, ou não
  // string truthy como `true`) passaria incólume até scanner.js, onde a
  // comparação `signal_type !== allowedSide` rejeitaria os DOIS lados sem
  // erro nenhum — um backtest caro terminaria com zero operações da
  // cascata nativa, parecendo um resultado real em vez de config quebrada.
  // Falha CEDO e alto, antes do replay começar, em vez de silenciosamente.
  if (next.allowedSide != null && next.allowedSide !== 'BUY' && next.allowedSide !== 'SELL') {
    throw new Error(`setPineConfigOverrides: allowedSide inválido (${JSON.stringify(next.allowedSide)}) — só aceita 'BUY', 'SELL' ou ausente/null`);
  }
  overrides = { ...next };
}

export async function getPineConfig() {
  return { ...DEFAULTS, ...overrides };
}
