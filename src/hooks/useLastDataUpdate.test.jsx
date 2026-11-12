/**
 * @vitest-environment jsdom
 *
 * "Quando a tela atualizou pela última vez" (docs/known-risks.md item 301): o maior `dataUpdatedAt` do cache do React Query.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLastDataUpdate } from './useLastDataUpdate';

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useLastDataUpdate(), { wrapper });
  return { client, hook };
}

describe('useLastDataUpdate', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-12T16:00:00Z')); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('sem nenhuma consulta carregada: 0', () => {
    expect(montar().hook.result.current).toBe(0);
  });

  it('devolve o instante da atualização mais recente entre TODAS as consultas', async () => {
    const { client, hook } = montar();
    await act(async () => { await client.fetchQuery({ queryKey: ['a'], queryFn: async () => 1 }); });
    const primeiro = Date.now();
    expect(hook.result.current).toBe(primeiro);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    await act(async () => { await client.fetchQuery({ queryKey: ['b'], queryFn: async () => 2 }); });
    expect(hook.result.current).toBe(primeiro + 5 * 60_000);
  });

  it('uma atualização de uma consulta já existente também avança o horário', async () => {
    const { client, hook } = montar();
    await act(async () => { await client.fetchQuery({ queryKey: ['a'], queryFn: async () => 1 }); });
    const antes = hook.result.current;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => { await client.refetchQueries({ queryKey: ['a'] }); });
    expect(hook.result.current).toBe(antes + 60_000);
  });

  it('consulta que FALHOU não avança o horário (o dado não atualizou)', async () => {
    const { client, hook } = montar();
    await act(async () => { await client.fetchQuery({ queryKey: ['a'], queryFn: async () => 1 }); });
    const antes = hook.result.current;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => { await client.fetchQuery({ queryKey: ['erro'], queryFn: async () => { throw new Error('falhou'); } }).catch(() => {}); });
    expect(hook.result.current).toBe(antes);
  });
});
