// @vitest-environment jsdom
// Monitor de anomalias do logger (docs/known-risks.md item 301): consultava o banco a cada 5 min (o Neon grátis só dorme depois de 5 min parado, então
// com uma aba aberta o banco nunca dormia). Agora: a cada 30 min com a aba visível, nada com a aba escondida. Arquivo à parte do logger.test.js porque o
// `initLogger()` só roda uma vez por módulo e cada teste aqui precisa do relógio falso desde o início.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const { filterAssets } = vi.hoisted(() => ({ filterAssets: vi.fn() }));

vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      SystemLog: { bulkCreate: vi.fn().mockResolvedValue([]) },
      MonitoredAsset: { filter: filterAssets },
      TradeOperation: { filter: vi.fn().mockResolvedValue([]) },
    },
  },
}));

import { initLogger } from './logger';

const MIN = 60_000;
const setVisibility = (state) => Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });

describe('logger — monitor de anomalias: 30 min com a aba visível, nada com a aba escondida (item 301)', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    initLogger();
  });
  afterAll(() => vi.useRealTimers());
  beforeEach(() => {
    setVisibility('visible');
    filterAssets.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    delete document.visibilityState;
  });

  it('visível: NÃO consulta aos 5 min (o ritmo antigo, que mantinha o banco acordado)', async () => {
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(filterAssets).not.toHaveBeenCalled();
  });

  it('visível: consulta a cada 30 min', async () => {
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(filterAssets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(filterAssets).toHaveBeenCalledTimes(2);
  });

  it('escondida: NÃO consulta o banco, por mais que o tempo passe', async () => {
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(180 * MIN);
    expect(filterAssets).not.toHaveBeenCalled();
  });

  it('ao voltar a ficar visível, volta a consultar no próximo ciclo', async () => {
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(65 * MIN);
    expect(filterAssets).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(filterAssets).toHaveBeenCalledTimes(1);
  });
});
