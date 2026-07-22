// Pure, dependency-free cross-cascade arbitration rules — same "pure decision,
// I/O lives in the caller" pattern as src/lib/opTransition.js.
//
// Decides what to do when a NEW candidate signal (from either the 4h_15m RF
// cascade or the 1h_5m SMC cascade) arrives while the asset already has an
// active TradeOperation. Because assetActiveOps enforces exactly one active
// op per asset SHARED across both cascades (src/api/entities.js
// createTradeOpIfNoneActive), the active op is necessarily from either the
// SAME cascade as the candidate or the OTHER one — this module never opens a
// second operation, it only decides how the existing one should react.
//
// Replaces the old behavior (docs/known-risks.md item 23): a candidate
// arriving while an op was active was unconditionally blocked and logged
// with no comparison between the two signals. scanner.js's
// handleActiveOpArbitration is the only caller — it turns these pure
// decisions into transitionTradeOp patches (same-status writes only; a
// second TradeOperation/assetActiveOps pointer is never created here).
//
// Promotion is the CONSERVATIVE variant the user explicitly confirmed: it
// only updates the existing operation's management (time stop, targets,
// metadata) — never opens a second operation, never auto-increases position
// size/risk. This is a materially smaller change than the "simultaneous
// operations per timeframe" proposal in docs/known-risks.md item 37, which
// remains NOT implemented and is not reopened by this module.

export const CASCADE_RANK = { '1h_5m': 1, '4h_15m': 2 };

/**
 * @param {'1h_5m'|'4h_15m'} candidateCascade
 * @param {'BUY'|'SELL'} candidateSide
 * @param {{cascade?: string, side?: string}|null} activeOp
 * @returns {{direction: 'same'|'opposite', tfRelation: 'larger'|'smaller'|'same'}}
 */
export function classifyCascadeRelation(candidateCascade, candidateSide, activeOp) {
  const candidateRank = CASCADE_RANK[candidateCascade];
  const activeRank = CASCADE_RANK[activeOp?.cascade];
  const direction = candidateSide === activeOp?.side ? 'same' : 'opposite';
  let tfRelation = 'same';
  if (candidateRank != null && activeRank != null) {
    if (candidateRank > activeRank) tfRelation = 'larger';
    else if (candidateRank < activeRank) tfRelation = 'smaller';
  }
  return { direction, tfRelation };
}

/**
 * @param {Object} params
 * @param {'1h_5m'|'4h_15m'} params.candidateCascade
 * @param {'BUY'|'SELL'} params.candidateSide
 * @param {number} params.candidateScore - 0-100, from confluence.js/smcConfluence.js
 * @param {Object|null} params.activeOp - the currently active TradeOperation
 * @param {Object} [params.pineConfig] - strategyConfig values (arbEnabled, arbPromoteMinScore, ...)
 * @returns {{outcome:string, action:string, reason:string, logLevel:'info'|'warn', scorePenalty:number}}
 */
export function planSignalArbitration({ candidateCascade, candidateSide, candidateScore, activeOp, pineConfig = {} }) {
  const noOp = (outcome, reason, logLevel = 'info') => ({ outcome, action: 'none', reason, logLevel, scorePenalty: 0 });

  // Kill switch — falls back to the old pure-block behavior handled by the
  // caller (scanner.js just logs 'active_op_exists' and skips, same as
  // before this module existed). Also the safe default for a missing/absent
  // active op, which should never reach this function in practice (the
  // caller only invokes it when hasActiveOp is true) but is guarded anyway.
  if (pineConfig.arbEnabled === false) return noOp('no_change', 'arb_disabled');
  if (!activeOp) return noOp('no_change', 'no_active_op');

  const { direction, tfRelation } = classifyCascadeRelation(candidateCascade, candidateSide, activeOp);
  const promoteMin = pineConfig.arbPromoteMinScore ?? 75;
  const reinforceMin = pineConfig.arbReinforceMinScore ?? 50;
  const scorePenalty = pineConfig.arbOppositeScorePenalty ?? 15;
  const invalidateOnOpposite = pineConfig.arbInvalidateOnOppositeMajor === true;
  const score = candidateScore ?? 0;

  if (direction === 'same' && tfRelation === 'larger') {
    // Active op is the smaller-timeframe cascade (1h_5m); candidate is the
    // larger one (4h_15m), same direction — conservative promotion candidate.
    if (activeOp.arbitration_outcome === 'promoted') {
      // Already promoted from this active op — don't re-promote every scan
      // pass a repeated/retried candidate arrives.
      return noOp('no_change', 'already_promoted');
    }
    if (score >= promoteMin) {
      return { outcome: 'promoted', action: 'promote', reason: 'candidate_score_meets_promotion_threshold', logLevel: 'info', scorePenalty: 0 };
    }
    if (score >= reinforceMin) {
      return noOp('reinforcement_accepted', 'candidate_score_meets_reinforcement_threshold');
    }
    return noOp('reinforcement_rejected', 'candidate_score_below_reinforcement_threshold');
  }

  if (direction === 'same' && tfRelation === 'smaller') {
    // Active op is the larger-timeframe cascade (4h_15m); candidate is
    // smaller (1h_5m), same direction — confirms continuation. Never opens
    // an op, never loosens the stop (transitionTradeOp's clampMonotonicStop
    // in src/api/entities.js already enforces that structurally regardless
    // of what patch the caller builds here).
    return noOp('continuation_confirmation', 'smaller_timeframe_confirms_continuation');
  }

  if (direction === 'same' && tfRelation === 'same') {
    return noOp('reinforcement_accepted', 'same_cascade_same_direction');
  }

  if (direction === 'opposite' && tfRelation === 'smaller') {
    // Active op is the larger-timeframe cascade; candidate opposes it from
    // the smaller timeframe — possible correction, not a reversal. Reduce
    // confidence, never auto-close on a single opposing signal.
    return { outcome: 'correction_warning', action: 'reduce_confidence', reason: 'smaller_timeframe_opposes_active_op', logLevel: 'warn', scorePenalty };
  }

  if (direction === 'opposite' && tfRelation === 'larger') {
    // Active op is the smaller-timeframe cascade; candidate opposes it from
    // the LARGER timeframe — critical risk. Never promote. Invalidation is
    // opt-in (arbInvalidateOnOppositeMajor, default false — log-only until
    // real occurrence data justifies auto-closing); always alert either way.
    return {
      outcome: 'critical_opposite',
      action: invalidateOnOpposite ? 'invalidate' : 'none',
      reason: invalidateOnOpposite ? 'larger_timeframe_opposes_active_op_invalidate' : 'larger_timeframe_opposes_active_op_alert_only',
      logLevel: 'warn',
      scorePenalty: 0,
    };
  }

  // direction === 'opposite' && tfRelation === 'same'
  return { outcome: 'correction_warning', action: 'reduce_confidence', reason: 'same_cascade_opposite_direction', logLevel: 'warn', scorePenalty };
}
