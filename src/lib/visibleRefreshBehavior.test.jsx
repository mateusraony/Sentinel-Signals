/**
 * @vitest-environment jsdom
 *
 * Comportamento das telas que leem o banco (docs/known-risks.md item 301), com o React Query DE VERDADE e as opções do `query-client.js` real:
 *  - aba visível: atualiza a cada 30 min (14:00 → 14:30);
 *  - aba escondida: NENHUMA atualização, por mais que o tempo passe;
 *  - ao voltar: refaz na hora o que tem mais de 1 min (STALE_TIME_MS), sem esperar o próximo intervalo.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery, focusManager } from '@tanstack/react-query';
import { queryClientInstance } from './query-client';
import { POLL_OPERATIONAL_MS, POLL_DIAGNOSTIC_MS, VISIBLE_REFRESH_MS, STALE_TIME_MS } from './pollingIntervals';

const MIN = 60_000;
const set = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  window.dispatchEvent(new Event('visibilitychange'));
};

function montar(intervalo = POLL_OPERATIONAL_MS) {
  const client = new QueryClient({ defaultOptions: queryClientInstance.getDefaultOptions() }); // as MESMAS opções do app
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const buscar = vi.fn().mockResolvedValue('ok');
  renderHook(() => useQuery({ queryKey: ['dado'], queryFn: buscar, refetchInterval: intervalo }), { wrapper });
  return { buscar };
}

describe('telas que leem o banco: 30 min com a aba visível, nada com a aba escondida', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focusManager.setFocused(undefined);
    set('visible');
  });
  afterEach(() => {
    cleanup();
    delete document.visibilityState;
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('as constantes: as duas cadências de tela valem 30 min; o dado vale 1 min para quem volta/navega', () => {
    expect(VISIBLE_REFRESH_MS).toBe(30 * MIN);
    expect(POLL_OPERATIONAL_MS).toBe(VISIBLE_REFRESH_MS);
    expect(POLL_DIAGNOSTIC_MS).toBe(VISIBLE_REFRESH_MS);
    expect(STALE_TIME_MS).toBe(MIN);
    expect(queryClientInstance.getDefaultOptions().queries.staleTime).toBe(STALE_TIME_MS);
  });

  it('visível: carrega ao montar e atualiza a cada 30 min, não antes', async () => {
    const { buscar } = montar();
    await vi.advanceTimersByTimeAsync(10);
    expect(buscar).toHaveBeenCalledTimes(1); // 14:00
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(buscar).toHaveBeenCalledTimes(1); // 14:29: ainda nada
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(buscar).toHaveBeenCalledTimes(2); // 14:30
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(buscar).toHaveBeenCalledTimes(3); // 15:00
  });

  it('escondida: NENHUMA atualização em 3 horas', async () => {
    const { buscar } = montar();
    await vi.advanceTimersByTimeAsync(10);
    expect(buscar).toHaveBeenCalledTimes(1);
    set('hidden');
    await vi.advanceTimersByTimeAsync(180 * MIN);
    expect(buscar).toHaveBeenCalledTimes(1);
  });

  it('ao voltar para a aba, refaz NA HORA (o dado tem mais de 1 min), sem esperar os 30 min', async () => {
    const { buscar } = montar();
    await vi.advanceTimersByTimeAsync(10);
    set('hidden');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    set('visible');
    await vi.advanceTimersByTimeAsync(50);
    expect(buscar).toHaveBeenCalledTimes(2);
  });

  it('trocar de aba e voltar em menos de 1 min NÃO refaz (não vira rajada de consultas)', async () => {
    const { buscar } = montar();
    await vi.advanceTimersByTimeAsync(10);
    set('hidden');
    await vi.advanceTimersByTimeAsync(20 * 1000);
    set('visible');
    await vi.advanceTimersByTimeAsync(50);
    expect(buscar).toHaveBeenCalledTimes(1);
  });
});
