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
// only updates the existing operation's management (time stop, mode,
// metadata) — never opens a second operation, never auto-increases position
// size/risk. This is a materially smaller change than the "simultaneous
// operations per timeframe" proposal in docs/known-risks.md item 37, which
// remains NOT implemented and is not reopened by this module.
//
// Two-stage promotion (post-PR #78 review, external audit): a qualifying 4h
// candidate does NOT immediately "promote" the op — that conflated "the 4h
// context looks good" with "the 4h→15m cascade's own entry confirmation
// actually happened", which this module never checks (it deliberately never
// fetches candles, see scanner.js's handleActiveOpArbitration doc comment).
// Instead it starts a PENDING_15M stage; scanner.js's own promotion-
// confirmation retry step later resolves it to CONFIRMED (via the SAME
// check15mConfirmation the native 4h_15m cascade uses) or EXPIRED — see
// scanner.js and docs/known-risks.md for the specific item this closes.

export const CASCADE_RANK = { '1h_5m': 1, '4h_15m': 2 };

// Bumped whenever the decision matrix's shape changes (new outcome/action
// values, changed thresholds semantics) — stamped onto SystemLog entries and
// TradeOperation patches so a later analysis can tell which rules produced a
// given historical decision without guessing from timestamps.
export const ARBITRATION_VERSION = 1;

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
 * @returns {{outcome:string, action:string, reason:string, logLevel:'info'|'warn', scorePenalty:number, direction:string|null, tfRelation:string|null}}
 */
export function planSignalArbitration({ candidateCascade, candidateSide, candidateScore, activeOp, pineConfig = {} }) {
  const relation = activeOp
    ? classifyCascadeRelation(candidateCascade, candidateSide, activeOp)
    : { direction: null, tfRelation: null };
  const build = (outcome, action, reason, logLevel = 'info', scorePenalty = 0) =>
    ({ outcome, action, reason, logLevel, scorePenalty, direction: relation.direction, tfRelation: relation.tfRelation });
  const noOp = (outcome, reason, logLevel = 'info') => build(outcome, 'none', reason, logLevel);

  // Kill switch — falls back to the old pure-block behavior handled by the
  // caller (scanner.js just logs 'active_op_exists' and skips, same as
  // before this module existed). Also the safe default for a missing/absent
  // active op, which should never reach this function in practice (the
  // caller only invokes it when hasActiveOp is true) but is guarded anyway.
  if (pineConfig.arbEnabled === false) return noOp('no_change', 'arb_disabled');
  if (!activeOp) return noOp('no_change', 'no_active_op');

  const { direction, tfRelation } = relation;
  const promoteMin = pineConfig.arbPromoteMinScore ?? 75;
  // Floor for ANY candidate to be allowed to influence an already-active op's
  // management (continuation confirmation, confidence reduction) — not just
  // the promotion-adjacent quadrant. A weak candidate is still persisted as
  // its own SignalEvent upstream (unaffected by this gate); it just can't
  // move the active op. critical_opposite is deliberately EXEMPT (always
  // observable, see that branch below) — a large-timeframe reversal is worth
  // knowing about even from a middling candidate.
  const reinforceMin = pineConfig.arbReinforceMinScore ?? 50;
  const scorePenalty = pineConfig.arbOppositeScorePenalty ?? 15;
  const invalidateOnOpposite = pineConfig.arbInvalidateOnOppositeMajor === true;
  const score = candidateScore ?? 0;
  const belowThreshold = () => noOp('candidate_below_arbitration_threshold', 'candidate_score_below_management_threshold');

  if (direction === 'same' && tfRelation === 'larger') {
    // Active op is the smaller-timeframe cascade (1h_5m); candidate is the
    // larger one (4h_15m), same direction — conservative promotion candidate.
    if (activeOp.promotion_status === 'CONFIRMED') return noOp('no_change', 'already_promoted');
    if (activeOp.promotion_status === 'PENDING_15M') return noOp('no_change', 'already_pending');
    if (score >= promoteMin) {
      // Stage A only — the 4h context qualifies, but this module never
      // fetches the 15m candle itself. scanner.js's promotion-confirmation
      // retry resolves this to CONFIRMED/EXPIRED using the real cascade's
      // own check15mConfirmation.
      return build('promotion_pending', 'start_promotion_pending', 'candidate_score_meets_promotion_threshold');
    }
    if (score >= reinforceMin) return noOp('reinforcement_accepted', 'candidate_score_meets_reinforcement_threshold');
    return noOp('reinforcement_rejected', 'candidate_score_below_reinforcement_threshold');
  }

  if (direction === 'same' && tfRelation === 'smaller') {
    // Active op is the larger-timeframe cascade (4h_15m); candidate is
    // smaller (1h_5m), same direction — confirms continuation. Never opens
    // an op, never loosens the stop (transitionTradeOp's clampMonotonicStop
    // in src/api/entities.js already enforces that structurally regardless
    // of what patch the caller builds here).
    if (score < reinforceMin) return belowThreshold();
    return noOp('continuation_confirmation', 'smaller_timeframe_confirms_continuation');
  }

  if (direction === 'same' && tfRelation === 'same') {
    return noOp('reinforcement_accepted', 'same_cascade_same_direction');
  }

  if (direction === 'opposite' && tfRelation === 'smaller') {
    // Active op is the larger-timeframe cascade; candidate opposes it from
    // the smaller timeframe — possible correction, not a reversal. Reduce
    // confidence, never auto-close on a single opposing signal.
    if (score < reinforceMin) return belowThreshold();
    return build('correction_warning', 'reduce_confidence', 'smaller_timeframe_opposes_active_op', 'warn', scorePenalty);
  }

  if (direction === 'opposite' && tfRelation === 'larger') {
    // Active op is the smaller-timeframe cascade; candidate opposes it from
    // the LARGER timeframe — critical risk. Never promote (and cancel a
    // pending promotion, if any — the larger context that would have
    // confirmed it just reversed). Invalidation is opt-in
    // (arbInvalidateOnOppositeMajor, default false — log-only until real
    // occurrence data justifies auto-closing). Deliberately NOT gated by
    // reinforceMin — a major-timeframe reversal is always worth alerting on,
    // even from a middling-score candidate; it just never auto-invalidates
    // below the opt-in toggle either way.
    const hadPending = activeOp.promotion_status === 'PENDING_15M';
    const action = invalidateOnOpposite ? 'invalidate' : (hadPending ? 'reject_pending_promotion' : 'none');
    const reason = invalidateOnOpposite
      ? 'larger_timeframe_opposes_active_op_invalidate'
      : (hadPending ? 'larger_timeframe_opposes_active_op_rejects_pending_promotion' : 'larger_timeframe_opposes_active_op_alert_only');
    return build('critical_opposite', action, reason, 'warn');
  }

  // direction === 'opposite' && tfRelation === 'same'
  if (score < reinforceMin) return belowThreshold();
  return build('correction_warning', 'reduce_confidence', 'same_cascade_opposite_direction', 'warn', scorePenalty);
}
