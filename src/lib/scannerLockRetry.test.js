// Cobre o retry curto + fail-open + alerta Telegram de tryAcquireScanLock/
// tryReleaseScanLock (src/lib/scanner.js), exercitados via priceCheckActiveOps
// (entry point exportado mais barato de montar — com zero TradeOperation
// ativa, priceCheckActiveOpsInner retorna assim que lê a lista vazia, sem
// precisar mockar fetchCandles/fetchCurrentPrice).
//
// vi.resetModules() + import dinâmico por teste (mesmo padrão de
// apiBackend.test.js): o cooldown do alerta (lastLockAlertAt) é module-level
// em scanner.js — sem reset, o estado vazaria entre testes do mesmo arquivo
// e o teste de cooldown dependeria da ordem de execução dos outros.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeBackend } from './__fixtures__/fakeBackend.js';

vi.mock('@/api/entities', () => ({ backend: {} }));
vi.mock('./telegram', () => ({
  isTelegramConfigured: vi.fn(() => false),
  notifyLockDegraded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('./marketDataProvider', () => ({
  fetchCandles: vi.fn(),
  fetchCurrentPrice: vi.fn(),
  MARKET_SOURCE: 'futures',
  DATA_EXCHANGE: 'binance',
  EXECUTOR: 'browser',
}));

let backend, notifyLockDegraded, logError, logWarn, priceCheckActiveOps;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));

  const entitiesModule = await import('@/api/entities');
  backend = createFakeBackend();
  entitiesModule.backend.entities = backend.entities;
  entitiesModule.backend.locks = backend.locks;
  entitiesModule.backend.tradeOps = backend.tradeOps;
  ({ notifyLockDegraded } = await import('./telegram'));
  ({ logError, logWarn } = await import('./logger'));
  ({ priceCheckActiveOps } = await import('./scanner.js'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tryAcquireScanLock — retry curto antes do fail-open', () => {
  it('sobrevive a 1 falha transitória (dentro do orçamento de retry) — nunca chega no fail-open', async () => {
    let calls = 0;
    backend.locks.acquireScanLock = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return true;
    });

    const promise = priceCheckActiveOps();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toEqual({ errors: [] }); // não "skipped" — lock foi adquirido de verdade
    expect(calls).toBe(2);
    expect(logError).not.toHaveBeenCalled();
    expect(notifyLockDegraded).not.toHaveBeenCalled();
  });

  it('esgota o retry curto e cai no fail-open — loga ERROR e alerta no Telegram', async () => {
    backend.locks.acquireScanLock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const promise = priceCheckActiveOps();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    // Fail-open: prossegue como se tivesse adquirido (não derruba o price-check).
    expect(result).toEqual({ errors: [] });
    expect(backend.locks.acquireScanLock).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(logError).toHaveBeenCalledWith(
      'scanner',
      expect.stringContaining('Falha ao adquirir lock "price-check"'),
      expect.objectContaining({
        executor: 'browser',
        error_class: 'NETWORK',
        scan_id: expect.stringMatching(/^price-check_/), // holder, único por execução
      })
    );
    expect(notifyLockDegraded).toHaveBeenCalledTimes(1);
    expect(notifyLockDegraded).toHaveBeenCalledWith('price-check', 'browser', 'Failed to fetch');
  });

  it('não alerta 2x dentro do cooldown, mas alerta de novo depois que o cooldown passa', async () => {
    backend.locks.acquireScanLock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    // 1ª ocorrência — alerta.
    let promise = priceCheckActiveOps();
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    expect(notifyLockDegraded).toHaveBeenCalledTimes(1);

    // 2ª ocorrência minutos depois, ainda dentro do cooldown de 30min — sem alerta novo.
    vi.setSystemTime(new Date('2026-07-16T12:10:00.000Z'));
    promise = priceCheckActiveOps();
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    expect(notifyLockDegraded).toHaveBeenCalledTimes(1); // continua 1, não 2

    // 3ª ocorrência depois do cooldown (30min) — alerta de novo.
    vi.setSystemTime(new Date('2026-07-16T12:41:00.000Z'));
    promise = priceCheckActiveOps();
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    expect(notifyLockDegraded).toHaveBeenCalledTimes(2);
  });
});

describe('tryReleaseScanLock — retry curto, sem alerta', () => {
  it('esgota o retry e loga WARN (não ERROR), sem notificar Telegram', async () => {
    backend.locks.releaseScanLock = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    const promise = priceCheckActiveOps();
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(backend.locks.releaseScanLock).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(logWarn).toHaveBeenCalledWith(
      'scanner',
      expect.stringContaining('Falha ao liberar lock "price-check"'),
      expect.objectContaining({ executor: 'browser' })
    );
    expect(notifyLockDegraded).not.toHaveBeenCalled();
  });
});
