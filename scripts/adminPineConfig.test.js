// Espelha src/lib/pineParser.test.js para o lado cron — cobre
// getPineConfigStatus() e a visibilidade do fallback (antes era
// console.warn, invisível na tela Logs quando quem falha é o cron).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logWarnMock = vi.fn();
vi.mock('../src/lib/logger.js', () => ({ logWarn: logWarnMock }));

const getMock = vi.fn();
vi.mock('./adminEntities.js', () => ({
  backend: { entities: { StrategyConfig: { get: (...args) => getMock(...args) } } },
}));

describe('adminPineConfig — getPineConfig/getPineConfigStatus', () => {
  beforeEach(() => {
    vi.resetModules();
    getMock.mockReset();
    logWarnMock.mockReset();
  });

  it('leitura OK: status "postgres", degraded false', async () => {
    getMock.mockResolvedValue({ minScore: 82, configVersion: 12, configHash: 'xyz' });
    const { getPineConfig, getPineConfigStatus } = await import('./adminPineConfig.js');

    const config = await getPineConfig();

    expect(config.minScore).toBe(82);
    expect(getPineConfigStatus()).toEqual({ source: 'postgres', version: 12, hash: 'xyz', degraded: false });
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it('Postgres falha: cai pra DEFAULTS, status "defaults"/degraded true, e GRAVA no SystemLog (logWarn, não console.warn)', async () => {
    getMock.mockRejectedValue(new Error('Failed to fetch'));
    const { getPineConfig, getPineConfigStatus } = await import('./adminPineConfig.js');

    const config = await getPineConfig();

    expect(config.minScore).toBe(75); // DEFAULTS.minScore (não exportado deste módulo)
    expect(getPineConfigStatus()).toEqual({ source: 'defaults', version: null, hash: null, degraded: true });
    expect(logWarnMock).toHaveBeenCalledWith(
      'pineParser',
      'Falha ao ler strategyConfig do Postgres/Neon, usando localStorage/defaults',
      expect.objectContaining({ executor: 'cron' })
    );
  });

  it('memoiza por processo — só 1 leitura real mesmo com chamadas concorrentes', async () => {
    getMock.mockResolvedValue({ minScore: 82, configVersion: 1 });
    const { getPineConfig } = await import('./adminPineConfig.js');

    await Promise.all([getPineConfig(), getPineConfig(), getPineConfig()]);

    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
