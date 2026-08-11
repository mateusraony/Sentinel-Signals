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
// op. `current_stop` gets its own protection below (clampMonotonicStop); the
// remaining fields (tp1_hit/tp2_hit/rf_reverse_bars_count/...) are
// last-write-wins because they're already idempotent by construction (one-way
// flags, per-candle dedup) — a stale write of those can't regress anything.
export function canApplyTransition(currentDoc, fromStatus) {
  if (!currentDoc) return false;
  if (isTerminalStatus(currentDoc.status)) return false;
  return currentDoc.status === fromStatus;
}

// Guard `current_stop` against a stale caller overwriting a better stop that
// another worker already committed. The browser and cron each compute
// `newCurrentStop` from their OWN candle/price read, BEFORE opening the
// Firestore transaction — so canApplyTransition's status-only CAS lets a
// same-status write through (e.g. two concurrent trailing-stop advances on a
// RUNNER_ACTIVE op) even when the doc's `current_stop` moved between the
// caller's read and its write. Revised from an earlier "last-write-wins by
// design, self-corrects on the next pass" assumption: advanceTrailingStop
// (opExitRules.js) maxes/mins the new trail against the STORED stop, so a
// regression here only heals once price moves favorably enough again — not
// immediately — leaving a real (if narrow) window where a worse stop could
// govern a stop-out. Call with the value read INSIDE the same transaction as
// `existingStop`, never a value read before the transaction opened.
export function clampMonotonicStop({ side, existingStop, candidateStop }) {
  if (candidateStop == null || existingStop == null) return candidateStop;
  if (side === 'BUY') return Math.max(existingStop, candidateStop);
  if (side === 'SELL') return Math.min(existingStop, candidateStop);
  return candidateStop; // unknown/legacy side — pass through, don't strand old ops
}

// docs/known-risks.md item 59 addendum (external review, PR #116): a
// "candle time" marker paired with a stop advance (e.g.
// runner_stop_advanced_candle_time) exists so a repeat pass over the SAME
// still-latest candle doesn't re-test it against a stop that candle's own
// close just advanced — see the guard next to detectRetest's caller in
// scanner.js. That marker is only correct if it names the candle whose
// close produced the stop value actually STORED. Without this check, a
// stale worker (racing across a candle boundary — e.g. cron still
// evaluating candle T1 after the browser already committed a fresher
// stop from candle T2) has its worse candidate clamped away by
// clampMonotonicStop, but would otherwise still overwrite the marker with
// T1 — leaving `current_stop` correctly at the T2-derived value while the
// marker falsely claims T1 caused it, un-defeating the exact same-candle
// look-ahead guard the marker exists for. Call with the value read INSIDE
// the same transaction as clampMonotonicStop, on its result.
export function stopAdvanceCandidateWon({ clampedStop, candidateStop }) {
  return clampedStop === candidateStop;
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

// docs/known-risks.md item 37 (Bloco 4 Fase 1) — the doc-anchor ID for
// `assetActiveOps`. Cascades that never opt into hierarchical coexistence
// (the default, and every cascade until Fase 1 wires it in) keep the
// original scalar-per-asset doc (`assetId`, unchanged since P0-a) — only a
// caller that explicitly passes `cascade` gets a doc scoped to that one
// cascade (`assetId__cascade`), letting two cascades hold independent
// anchors for the SAME asset without touching the shared doc at all. Pure
// string formatting shared by all 3 backends (entities.js/adminEntities.js/
// fakeBackend.js) so they can never disagree on the doc ID.
export function buildActiveOpsAnchorId(assetId, cascade) {
  return cascade ? `${assetId}__${cascade}` : assetId;
}

// Group a list of TradeOperations by asset, defensively excluding anything
// already terminal (a caller that queried by a broad status list — or a
// stale in-memory snapshot — must not have a finished op counted toward the
// "more than one active op" invariant). Structurally, `assetActiveOps`'s CAS
// should make more than one active op per asset impossible, but historical
// corruption or a manual Firestore edit can still produce it — this is the
// shared detector both mutator loops (persistScanResults,
// priceCheckActiveOpsInner, .claude/rules/trading-engine.md) use to find it.
// Pure/no I/O on purpose: callers decide how to log and how to interrupt
// their own flow. Order-independent — grouped by key, not by first-seen, so
// the order Firestore hands back docs in never changes the outcome. Legacy
// ops missing `asset_id` fall back to a symbol-keyed group so they still
// group safely instead of silently skipping the check.
//
// `coexistingCascades` (docs/known-risks.md item 37, Bloco 4 Fase 1):
// optional iterable of cascade names allowed to have simultaneous active ops
// on the SAME asset — defaults to none, so every existing caller (both
// mutator loops today) keeps the original "2+ ops on one asset is always
// corruption" behavior unchanged. Grouping happens in two passes so a
// hierarchical op can NEVER weaken the duplicate check for a cascade that
// never opted in: pass 1 buckets by bare asset (exactly as before, cascade
// ignored); pass 2 only splits an asset's bucket by `(asset, cascade)` when
// EVERY live op in that bucket has a cascade in the allowlist — one
// non-allowlisted op sharing the asset (e.g. a backtest-only variant like
// `rf1h_cond4h_15m` combined with this flag, a combination Fase 1 never
// intended to run together) falls back to the original single-group
// duplicate check for the WHOLE asset, same as if the allowlist were absent.
// Returns { validGroups: Map<key, op>, duplicateGroups: Map<key, op[]> }.
export function groupActiveOpsByAsset(ops, coexistingCascades) {
  const coexisting = coexistingCascades ? new Set(coexistingCascades) : null;
  const byAsset = new Map();
  for (const op of ops) {
    if (!op || isTerminalStatus(op.status)) continue;
    const assetKey = op.asset_id ?? `symbol:${op.symbol}`;
    if (!byAsset.has(assetKey)) byAsset.set(assetKey, []);
    byAsset.get(assetKey).push(op);
  }

  // Merge a symbol-fallback group (legacy op missing asset_id) into any
  // asset-id-keyed group for the SAME symbol. Without this, a legacy op and
  // a current-schema op for the same underlying asset land under two
  // different keys (`symbol:BTCUSDT` vs `asset1`) and both read as lone,
  // "valid" groups — exactly the mixed legacy/current duplicate the symbol
  // fallback exists to catch (Codex review, PR #80).
  for (const [key, group] of [...byAsset]) {
    if (!key.startsWith('symbol:')) continue;
    const symbol = group[0]?.symbol;
    const assetKey = [...byAsset.keys()].find(
      (k) => k !== key && !k.startsWith('symbol:') && byAsset.get(k).some((o) => o.symbol === symbol)
    );
    if (assetKey) {
      byAsset.set(assetKey, [...byAsset.get(assetKey), ...group]);
      byAsset.delete(key);
    }
  }

  const validGroups = new Map();
  const duplicateGroups = new Map();
  for (const [assetKey, group] of byAsset) {
    const allAllowlisted = coexisting && group.every((op) => coexisting.has(op.cascade));
    if (!allAllowlisted) {
      if (group.length > 1) duplicateGroups.set(assetKey, group);
      else validGroups.set(assetKey, group[0]);
      continue;
    }
    // Every op in this asset's bucket opted into coexistence — safe to
    // split by cascade, but a 2nd op of the SAME cascade is still a real
    // duplicate (the anchor-per-cascade doc should have prevented it).
    const byCascade = new Map();
    for (const op of group) {
      const cascadeKey = `${assetKey}::${op.cascade}`;
      if (!byCascade.has(cascadeKey)) byCascade.set(cascadeKey, []);
      byCascade.get(cascadeKey).push(op);
    }
    for (const [cascadeKey, cGroup] of byCascade) {
      if (cGroup.length > 1) duplicateGroups.set(cascadeKey, cGroup);
      else validGroups.set(cascadeKey, cGroup[0]);
    }
  }
  return { validGroups, duplicateGroups };
}
