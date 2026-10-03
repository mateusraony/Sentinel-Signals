// @vitest-environment jsdom
//
// Cobre o cache versionado + status degradado de getPineConfig() (docs/
// known-risks.md) — adicionado em resposta a uma análise de logs externa
// que apontou um risco real: antes desta mudança, uma falha de leitura do
// Postgres fazia getPineConfig() cair silenciosamente para
// localStorage[PINE_CONFIG_KEY] (o rascunho Pine desta aba específica, que
// pode estar dias desatualizado) ou DEFAULTS, sem nenhum jeito de o chamador
// saber que o config usado não é o oficial confirmado.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({ logWarn: vi.fn() }));

const getMock = vi.fn();
const setMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      StrategyConfig: { get: (...args) => getMock(...args), set: (...args) => setMock(...args) },
      MonitoredAsset: { filter: vi.fn().mockResolvedValue([]) },
    },
  },
}));

import { getPineConfig, getPineConfigStatus, hashSyncedConfig, syncPineToAssets, DEFAULTS } from './pineParser.js';

beforeEach(() => {
  localStorage.clear();
  getMock.mockReset();
  setMock.mockClear();
});

describe('hashSyncedConfig', () => {
  it('é determinístico e independe da ordem das chaves', () => {
    const a = hashSyncedConfig({ minScore: 75, tp1R: 1.5 });
    const b = hashSyncedConfig({ tp1R: 1.5, minScore: 75 });
    expect(a).toBe(b);
  });

  it('muda quando um valor muda', () => {
    const a = hashSyncedConfig({ minScore: 75 });
    const b = hashSyncedConfig({ minScore: 80 });
    expect(a).not.toBe(b);
  });
});

describe('getPineConfig / getPineConfigStatus', () => {
  it('leitura OK do Postgres: status "postgres", degraded false, grava cache versionado', async () => {
    getMock.mockResolvedValue({ minScore: 82, configVersion: 37, configHash: 'abc123' });

    const config = await getPineConfig();

    expect(config.minScore).toBe(82);
    expect(getPineConfigStatus()).toEqual({ source: 'postgres', version: 37, hash: 'abc123', degraded: false });
    expect(JSON.parse(localStorage.getItem('cryptoradar_pine_synced_cache')).version).toBe(37);
  });

  it('Postgres falha, mas existe cache de uma leitura anterior: usa o cache, status "cache", degraded false', async () => {
    getMock.mockResolvedValueOnce({ minScore: 82, configVersion: 37, configHash: 'abc123' });
    await getPineConfig(); // popula o cache

    getMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    const config = await getPineConfig();

    expect(config.minScore).toBe(82); // veio do cache, não dos DEFAULTS
    expect(getPineConfigStatus()).toEqual({ source: 'cache', version: 37, hash: 'abc123', degraded: false });
  });

  it('Postgres falha e NUNCA houve cache: usa DEFAULTS, status "defaults", degraded TRUE', async () => {
    getMock.mockRejectedValue(new Error('Failed to fetch'));

    const config = await getPineConfig();

    expect(config.minScore).toBe(DEFAULTS.minScore);
    expect(getPineConfigStatus()).toEqual({ source: 'defaults', version: null, hash: null, degraded: true });
  });

  it('cache corrompido no localStorage é tratado como ausente (cai pra defaults/degraded), sem lançar', async () => {
    localStorage.setItem('cryptoradar_pine_synced_cache', '{not json');
    getMock.mockRejectedValue(new Error('Failed to fetch'));

    const config = await getPineConfig();

    expect(config.minScore).toBe(DEFAULTS.minScore);
    expect(getPineConfigStatus().degraded).toBe(true);
  });
});

describe('syncPineToAssets — versionamento', () => {
  it('incrementa configVersion a partir do valor anterior e grava um configHash', async () => {
    getMock.mockResolvedValue({ minScore: 75, configVersion: 36 });

    await syncPineToAssets();

    expect(setMock).toHaveBeenCalledTimes(1);
    const [, payload] = setMock.mock.calls[0];
    expect(payload.configVersion).toBe(37);
    expect(typeof payload.configHash).toBe('string');
    expect(payload.configHash.length).toBeGreaterThan(0);
  });

  it('sem StrategyConfig anterior (1a vez), começa em configVersion 1', async () => {
    getMock.mockResolvedValue(null);

    await syncPineToAssets();

    const [, payload] = setMock.mock.calls[0];
    expect(payload.configVersion).toBe(1);
  });
});
