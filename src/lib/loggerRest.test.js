// @vitest-environment jsdom
// Repouso do painel (docs/known-risks.md item 301): o monitor de anomalias do logger (a cada 5 min) consulta o banco, e o Neon grátis só dorme depois de
// 5 min parado. Em repouso ele não pode consultar; ao acordar, volta no ritmo normal. Arquivo à parte do logger.test.js porque o `initLogger()` só roda
// uma vez por módulo e cada teste aqui precisa do relógio falso desde o início.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { filterAssets, estado } = vi.hoisted(() => ({ filterAssets: vi.fn(), estado: { resting: false } }));

vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      SystemLog: { bulkCreate: vi.fn().mockResolvedValue([]) },
      MonitoredAsset: { filter: filterAssets },
      TradeOperation: { filter: vi.fn().mockResolvedValue([]) },
    },
  },
}));
vi.mock('@/lib/idleRest', () => ({ isResting: () => estado.resting }));

import { initLogger } from './logger';

const MIN = 60_000;

describe('logger — monitor de anomalias respeita o repouso do painel', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    initLogger();
  });
  afterAll(() => vi.useRealTimers());
  beforeEach(() => {
    estado.resting = false;
    filterAssets.mockReset().mockResolvedValue([]);
  });

  it('ativo: consulta o banco a cada 5 min (comportamento de sempre)', async () => {
    await vi.advanceTimersByTimeAsync(5 * MIN + 100);
    expect(filterAssets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(filterAssets).toHaveBeenCalledTimes(2);
  });

  it('em repouso: NÃO consulta o banco, por mais que o tempo passe', async () => {
    estado.resting = true;
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(filterAssets).not.toHaveBeenCalled();
  });

  it('ao acordar, volta a consultar no próximo ciclo', async () => {
    estado.resting = true;
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(filterAssets).not.toHaveBeenCalled();
    estado.resting = false;
    await vi.advanceTimersByTimeAsync(5 * MIN + 100);
    expect(filterAssets).toHaveBeenCalledTimes(1);
  });
});
