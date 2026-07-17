// Pure, dependency-free compare-and-set guard for TradeOperation status
// transitions. Lives in ONE place so the client adapter (src/api/entities.js)
// and the admin adapter (scripts/adminEntities.js) share the exact same rule
// instead of each hardcoding the terminal list — the same manual-mirror drift
// that already bit adminPineConfig.js. Only the transaction wrapper differs
// per SDK; the decision below is identical in both.
//
// Why this exists: the browser auto-scan and the GitHub Actions cron mutate
// TradeOperations under SEPARATE locks (see .claude/rules/trading-engine.md),
// so a plain read-modify-write could clobber a newer state, resurrect a
// terminal op, or fire a duplicate Telegram notification. The adapters call
// canApplyTransition INSIDE a Firestore transaction, against the freshly-read
// document, so only the first writer of a given transition wins.

export const TERMINAL_STATUSES = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

// Decide whether a status write may apply, given the CURRENT document (as read
// inside the transaction) and the status the caller believed it was
// transitioning from. Rejects when:
//   - the doc no longer exists,
//   - the doc is already terminal (terminal is final — never re-transition),
//   - another worker already moved the status away from `fromStatus`.
// Compares ONLY `status` (not tp1_hit/current_stop/etc.) on purpose: a stricter
// predicate would silently drop legitimate same-status writes (e.g. the runner
// trailing stop advancing while status stays RUNNER_ACTIVE) and could strand an
// op. Fields other than status are last-write-wins by design — the trailing
// stop is monotonic and self-corrects on the next pass.
export function canApplyTransition(currentDoc, fromStatus) {
  if (!currentDoc) return false;
  if (isTerminalStatus(currentDoc.status)) return false;
  return currentDoc.status === fromStatus;
}

// Decide what createTradeOpIfNoneActive should do, given what it read inside
// the transaction: the assetActiveOps pointer, the op that pointer references
// (null when missing), and the op at the deterministic doc ID (null when
// missing). A pointer whose op is gone or terminal does NOT count as active —
// nothing else ever clears such a pointer (transitionTradeOp's CAS rejects
// terminal ops, so its in-transaction clear can never run again), so treating
// it as live would block the asset's entries forever. The signal-retry loop
// reuses deterministic IDs, which is how a terminal op can be re-encountered
// here; it must never be re-pointed as active.
// Returns { action: 'blocked'|'reuse'|'create', pointer: 'set'|'clear'|'keep' }.
export function planTradeOpCreation({ pointerOpId, pointerOp, existingOp }) {
  if (pointerOpId && pointerOp && !isTerminalStatus(pointerOp.status)) {
    return { action: 'blocked', pointer: 'keep' };
  }
  if (existingOp) {
    if (isTerminalStatus(existingOp.status)) {
      // Finished op: don't resurrect it; repair the orphan pointer if present.
      return { action: 'reuse', pointer: pointerOpId ? 'clear' : 'keep' };
    }
    // Live op without a (valid) pointer — crash window between the op write
    // and the pointer write; restore the pointer.
    return { action: 'reuse', pointer: 'set' };
  }
  return { action: 'create', pointer: 'set' };
}
