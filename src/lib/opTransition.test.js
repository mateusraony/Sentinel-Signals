import { describe, it, expect } from 'vitest';
import { canApplyTransition, clampMonotonicStop, groupActiveOpsByAsset, isTerminalStatus, planTradeOpCreation, TERMINAL_STATUSES } from './opTransition.js';

describe('isTerminalStatus', () => {
  it('recognises every terminal status', () => {
    for (const s of ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED']) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });
  it('treats live statuses as non-terminal', () => {
    expect(isTerminalStatus('SIGNAL_CONFIRMED')).toBe(false);
    expect(isTerminalStatus('RUNNER_ACTIVE')).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});

describe('canApplyTransition', () => {
  it('rejects a missing document (op deleted mid-flight)', () => {
    expect(canApplyTransition(null, 'SIGNAL_CONFIRMED')).toBe(false);
  });

  it('applies when the current status still matches fromStatus', () => {
    expect(canApplyTransition({ status: 'SIGNAL_CONFIRMED' }, 'SIGNAL_CONFIRMED')).toBe(true);
    expect(canApplyTransition({ status: 'RUNNER_ACTIVE' }, 'RUNNER_ACTIVE')).toBe(true);
  });

  it('rejects when another worker already moved the status', () => {
    // A concurrent worker advanced SIGNAL_CONFIRMED -> RUNNER_ACTIVE; our
    // stale-based write must not apply on top of it.
    expect(canApplyTransition({ status: 'RUNNER_ACTIVE' }, 'SIGNAL_CONFIRMED')).toBe(false);
  });

  it('never re-transitions a terminal op, even if fromStatus were terminal', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(canApplyTransition({ status: s }, s)).toBe(false);
      expect(canApplyTransition({ status: s }, 'RUNNER_ACTIVE')).toBe(false);
    }
  });
});

describe('clampMonotonicStop', () => {
  it('BUY: rejects a candidate worse (lower) than the existing stop', () => {
    expect(clampMonotonicStop({ side: 'BUY', existingStop: 105, candidateStop: 102 })).toBe(105);
  });
  it('BUY: accepts a candidate better (higher) than the existing stop', () => {
    expect(clampMonotonicStop({ side: 'BUY', existingStop: 100, candidateStop: 105 })).toBe(105);
  });
  it('SELL: rejects a candidate worse (higher) than the existing stop', () => {
    expect(clampMonotonicStop({ side: 'SELL', existingStop: 95, candidateStop: 98 })).toBe(95);
  });
  it('SELL: accepts a candidate better (lower) than the existing stop', () => {
    expect(clampMonotonicStop({ side: 'SELL', existingStop: 100, candidateStop: 95 })).toBe(95);
  });
  it('passes the candidate through unchanged for an unknown/legacy side (never strands old ops)', () => {
    expect(clampMonotonicStop({ side: undefined, existingStop: 105, candidateStop: 102 })).toBe(102);
  });
  it('passes the candidate through when there is nothing to compare against (first write, or no-op patch)', () => {
    expect(clampMonotonicStop({ side: 'BUY', existingStop: null, candidateStop: 105 })).toBe(105);
    expect(clampMonotonicStop({ side: 'BUY', existingStop: 100, candidateStop: null })).toBe(null);
  });
});

describe('planTradeOpCreation', () => {
  it('blocks while the pointed op is genuinely live', () => {
    const plan = planTradeOpCreation({
      pointerOpId: 'op_a',
      pointerOp: { status: 'RUNNER_ACTIVE' },
      existingOp: null,
    });
    expect(plan).toEqual({ action: 'blocked', pointer: 'keep' });
  });

  it('never re-points at a terminal op reused by the retry loop (asset would lock forever)', () => {
    for (const s of TERMINAL_STATUSES) {
      const plan = planTradeOpCreation({
        pointerOpId: null,
        pointerOp: null,
        existingOp: { status: s },
      });
      expect(plan).toEqual({ action: 'reuse', pointer: 'keep' });
    }
  });

  it('treats a pointer to a terminal op as vacant and repairs it', () => {
    // Orphan pointer + terminal deterministic op: clear, don't resurrect.
    expect(planTradeOpCreation({
      pointerOpId: 'op_a',
      pointerOp: { status: 'STOP_HIT' },
      existingOp: { status: 'STOP_HIT' },
    })).toEqual({ action: 'reuse', pointer: 'clear' });
    // Orphan pointer + no deterministic op: create overwrites the pointer.
    expect(planTradeOpCreation({
      pointerOpId: 'op_a',
      pointerOp: { status: 'TP2_HIT' },
      existingOp: null,
    })).toEqual({ action: 'create', pointer: 'set' });
  });

  it('treats a pointer to a missing op as vacant', () => {
    expect(planTradeOpCreation({
      pointerOpId: 'op_ghost',
      pointerOp: null,
      existingOp: null,
    })).toEqual({ action: 'create', pointer: 'set' });
  });

  it('restores the pointer for a live op (crash window between op write and pointer write)', () => {
    expect(planTradeOpCreation({
      pointerOpId: null,
      pointerOp: null,
      existingOp: { status: 'SIGNAL_CONFIRMED' },
    })).toEqual({ action: 'reuse', pointer: 'set' });
  });

  it('creates op + pointer on a clean slate', () => {
    expect(planTradeOpCreation({
      pointerOpId: null,
      pointerOp: null,
      existingOp: null,
    })).toEqual({ action: 'create', pointer: 'set' });
  });
});

// Simulates two workers (browser scan + cron) racing the SAME operation with a
// transaction-serialised store, proving the core invariant: exactly ONE
// transition applies, no terminal regression, no double "apply" (which is what
// gates the single Telegram notification in the scanner).
describe('concurrent transition (in-memory CAS simulation)', () => {
  function makeStore(initial) {
    const store = { ...initial };
    // Mirrors adapter transitionTradeOp: gate the write on canApplyTransition
    // against the current (fresh) doc, clamp current_stop monotonically
    // against the same fresh doc, then apply the patch atomically.
    return {
      get: () => ({ ...store }),
      transition(fromStatus, patch) {
        if (!canApplyTransition(store, fromStatus)) return { applied: false };
        const safePatch = patch.current_stop != null
          ? { ...patch, current_stop: clampMonotonicStop({ side: store.side, existingStop: store.current_stop, candidateStop: patch.current_stop }) }
          : patch;
        Object.assign(store, safePatch);
        return { applied: true };
      },
    };
  }

  it('lets only the first writer win when both read the same fromStatus', () => {
    const s = makeStore({ id: 'op1', status: 'SIGNAL_CONFIRMED' });
    // Both workers read SIGNAL_CONFIRMED, then try different transitions.
    const stopHit = s.transition('SIGNAL_CONFIRMED', { status: 'STOP_HIT', exit_price: 100 });
    const tp1 = s.transition('SIGNAL_CONFIRMED', { status: 'RUNNER_ACTIVE', current_stop: 105 });

    expect(stopHit.applied).toBe(true);
    expect(tp1.applied).toBe(false); // loses the race — no clobber
    expect(s.get().status).toBe('STOP_HIT');
    expect(s.get().current_stop).toBeUndefined(); // the losing patch never wrote
  });

  it('allows same-status writes so the runner trailing stop keeps advancing', () => {
    const s = makeStore({ id: 'op1', status: 'RUNNER_ACTIVE', current_stop: 100 });
    const trail = s.transition('RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 110 });
    expect(trail.applied).toBe(true);
    expect(s.get().current_stop).toBe(110);
  });

  it('rejects a second transition once the op is terminal', () => {
    const s = makeStore({ id: 'op1', status: 'RUNNER_ACTIVE' });
    expect(s.transition('RUNNER_ACTIVE', { status: 'TP2_HIT' }).applied).toBe(true);
    // A late worker still holding the stale RUNNER_ACTIVE view cannot resurrect it.
    expect(s.transition('RUNNER_ACTIVE', { status: 'STOP_HIT' }).applied).toBe(false);
    expect(s.get().status).toBe('TP2_HIT');
  });

  // Item 20 of the 2026-07 hardening proposal: canApplyTransition only CASes
  // `status`, so two same-status trailing-stop advances (browser + cron, each
  // computing current_stop from its OWN pre-transaction read) both pass the
  // CAS — the second writer's patch used to win outright (Object.assign),
  // even when it carried a WORSE stop computed before the first writer's
  // better stop had committed. Reproduces the exact scenario from the plan:
  // worker A commits 100->105 (BUY) first, worker B's stale patch (still
  // based on the pre-105 read) arrives after with only 102.
  it('BUY: a same-status write with a worse current_stop never regresses one already committed', () => {
    const s = makeStore({ id: 'op1', status: 'RUNNER_ACTIVE', side: 'BUY', current_stop: 100 });
    const workerA = s.transition('RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 105 });
    const workerB = s.transition('RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 102 }); // stale, computed from stop=100
    expect(workerA.applied).toBe(true);
    expect(workerB.applied).toBe(true); // CAS still applies (status unchanged) — but the stop must not regress
    expect(s.get().current_stop).toBe(105);
  });

  it('SELL: a same-status write with a worse current_stop never regresses one already committed', () => {
    const s = makeStore({ id: 'op1', status: 'RUNNER_ACTIVE', side: 'SELL', current_stop: 100 });
    const workerA = s.transition('RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 95 });
    const workerB = s.transition('RUNNER_ACTIVE', { status: 'RUNNER_ACTIVE', current_stop: 98 }); // stale, computed from stop=100
    expect(workerA.applied).toBe(true);
    expect(workerB.applied).toBe(true);
    expect(s.get().current_stop).toBe(95);
  });
});

// Shared duplicate-active-op detector — src/lib/opTransition.js, used by both
// TradeOperation mutator loops (persistScanResults and
// priceCheckActiveOpsInner, docs/known-risks.md item 39.1). Pure/no I/O:
// these tests cover the grouping rule itself; scannerStateMachine.test.js
// covers each loop's own reaction (logging, suspension) to the result.
describe('groupActiveOpsByAsset', () => {
  it('puts a single active op for an asset in validGroups, with no duplicates', () => {
    const op = { id: 'op_a', asset_id: 'asset_1', status: 'SIGNAL_CONFIRMED' };
    const { validGroups, duplicateGroups } = groupActiveOpsByAsset([op]);
    expect(validGroups.get('asset_1')).toBe(op);
    expect(duplicateGroups.size).toBe(0);
  });

  it('flags two active ops of the same asset as a duplicate group instead of picking one', () => {
    const opA = { id: 'op_a', asset_id: 'asset_1', status: 'SIGNAL_CONFIRMED' };
    const opB = { id: 'op_b', asset_id: 'asset_1', status: 'RUNNER_ACTIVE' };
    const { validGroups, duplicateGroups } = groupActiveOpsByAsset([opA, opB]);
    expect(validGroups.has('asset_1')).toBe(false);
    expect(duplicateGroups.get('asset_1')).toEqual([opA, opB]);
  });

  it('never mixes different assets into the same group', () => {
    const opA = { id: 'op_a', asset_id: 'asset_1', status: 'SIGNAL_CONFIRMED' };
    const opB = { id: 'op_b', asset_id: 'asset_2', status: 'SIGNAL_CONFIRMED' };
    const { validGroups, duplicateGroups } = groupActiveOpsByAsset([opA, opB]);
    expect(validGroups.get('asset_1')).toBe(opA);
    expect(validGroups.get('asset_2')).toBe(opB);
    expect(duplicateGroups.size).toBe(0);
  });

  it('produces the same grouping regardless of input order', () => {
    const opA = { id: 'op_a', asset_id: 'asset_1', status: 'SIGNAL_CONFIRMED' };
    const opB = { id: 'op_b', asset_id: 'asset_1', status: 'RUNNER_ACTIVE' };
    const opC = { id: 'op_c', asset_id: 'asset_2', status: 'SIGNAL_CONFIRMED' };
    const forward = groupActiveOpsByAsset([opA, opB, opC]);
    const reversed = groupActiveOpsByAsset([opC, opB, opA]);
    expect([...forward.duplicateGroups.get('asset_1')].map(o => o.id).sort())
      .toEqual([...reversed.duplicateGroups.get('asset_1')].map(o => o.id).sort());
    expect(forward.validGroups.get('asset_2')).toEqual(reversed.validGroups.get('asset_2'));
  });

  it('excludes terminal ops from the active count (a terminal op never counts toward a duplicate)', () => {
    const live = { id: 'op_a', asset_id: 'asset_1', status: 'SIGNAL_CONFIRMED' };
    const terminal = { id: 'op_b', asset_id: 'asset_1', status: 'STOP_HIT' };
    const { validGroups, duplicateGroups } = groupActiveOpsByAsset([live, terminal]);
    expect(validGroups.get('asset_1')).toBe(live);
    expect(duplicateGroups.size).toBe(0);
  });

  it('groups legacy ops missing asset_id safely, by symbol, instead of skipping the check', () => {
    const opA = { id: 'op_a', symbol: 'BTCUSDT', status: 'SIGNAL_CONFIRMED' };
    const opB = { id: 'op_b', symbol: 'BTCUSDT', status: 'RUNNER_ACTIVE' };
    const { duplicateGroups } = groupActiveOpsByAsset([opA, opB]);
    expect(duplicateGroups.get('symbol:BTCUSDT')).toEqual([opA, opB]);
  });
});
