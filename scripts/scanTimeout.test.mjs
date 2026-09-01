// docs/known-risks.md item 142 — a scan hanging on a Firestore call stuck
// retrying RESOURCE_EXHAUSTED (community-confirmed: no way to opt the admin
// client out of that retry per error code) used to keep run-scan.mjs alive
// for minutes, colliding with the next ~5min external trigger and cascading
// into hours of cancelled/failed runs. withTimeout is what makes a stuck
// call fail fast instead.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout, forceExit } from './scanTimeout.mjs';

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the real value when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'test')).resolves.toBe('ok');
  });

  it('rejects with the real error when the promise rejects before the deadline', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'test')).rejects.toThrow('boom');
  });

  it('rejects with a timeout error naming the label when the promise never settles in time', async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise(() => {});
    const result = withTimeout(neverSettles, 90_000, 'scanAllAssets');
    const assertion = expect(result).rejects.toThrow(/Timeout: scanAllAssets.*90000ms.*RESOURCE_EXHAUSTED/s);
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it('does not fire the timeout once the real promise already won the race (no dangling rejection)', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    await withTimeout(Promise.resolve('fast'), 90_000, 'test');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('forceExit', () => {
  it('sets exitCode and calls process.exit with the same code', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    try {
      forceExit(1);
      expect(process.exitCode).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });
});
