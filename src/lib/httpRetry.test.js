import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from './httpRetry.js';

function mockResponse({ ok, status, retryAfter } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => (name === 'retry-after' ? retryAfter ?? null : null) },
    text: async () => `body ${status}`,
    json: async () => ({}),
  };
}

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves on the first try when the response is ok — no retry, no delay', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('https://example.test');

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 500 (no Retry-After) with exponential backoff and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 500 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.test', { context: 'test' });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries on a persistently retryable status and returns the last (non-ok) response, without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.test', { maxRetries: 2 });
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await promise;

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 tentativa inicial + 2 retries
  });

  it('does NOT retry a non-retryable 4xx (404) — fails on the first try', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('https://example.test');

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a thrown network error ("Failed to fetch") and succeeds on the 2nd attempt', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.test');
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on a persistent network error and re-throws the last error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.test', { maxRetries: 1 });
    const assertion = expect(promise).rejects.toThrow('Failed to fetch');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 tentativa inicial + 1 retry
  });

  it('honors Retry-After in seconds over the exponential backoff', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 429, retryAfter: '2' }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.test');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // ainda dentro dos 2s do Retry-After
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After as an HTTP date', async () => {
    const retryAt = new Date(Date.now() + 1500).toUTCString();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503, retryAfter: retryAt }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.test');
    await vi.advanceTimersByTimeAsync(1500);
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
