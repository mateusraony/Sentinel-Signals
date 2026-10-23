import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getDbStatus, subscribeDbStatus, reportDbQuotaExhausted, reportDbReachable, resetDbStatusForTests,
} from './dbStatus.js';

beforeEach(() => resetDbStatusForTests());

describe('dbStatus', () => {
  it('começa sem alarme', () => {
    expect(getDbStatus()).toMatchObject({ quotaExhausted: false, since: null, lastOkAt: null });
  });

  it('cota esgotada liga o alarme, guarda desde quando e a última resposta boa', () => {
    reportDbReachable(1000);
    reportDbQuotaExhausted(2000);
    expect(getDbStatus()).toMatchObject({ quotaExhausted: true, since: 2000, lastOkAt: 1000 });
  });

  it('repetir o aviso não reemite nem muda o "desde quando"', () => {
    const fn = vi.fn();
    subscribeDbStatus(fn);
    reportDbQuotaExhausted(2000);
    reportDbQuotaExhausted(3000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getDbStatus().since).toBe(2000);
  });

  it('a primeira resposta boa desliga o alarme', () => {
    reportDbQuotaExhausted(2000);
    reportDbReachable(5000);
    expect(getDbStatus()).toMatchObject({ quotaExhausted: false, since: null, lastOkAt: 5000 });
  });

  it('respostas boas repetidas não reemitem (sem re-render a cada poll)', () => {
    const fn = vi.fn();
    subscribeDbStatus(fn);
    reportDbReachable(1);
    reportDbReachable(2);
    expect(fn).not.toHaveBeenCalled();
  });
});
