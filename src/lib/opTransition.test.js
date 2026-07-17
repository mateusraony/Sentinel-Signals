import { describe, it, expect } from 'vitest';
import { canApplyTransition, isTerminalStatus, planTradeOpCreation, TERMINAL_STATUSES } from './opTransition.js';

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
    // against the current (fresh) doc, then apply the patch atomically.
    return {
      get: () => ({ ...store }),
      transition(fromStatus, patch) {
        if (!canApplyTransition(store, fromStatus)) return { applied: false };
        Object.assign(store, patch);
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
});
