// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { useMarketContext } from './useMarketContext.js';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/marketContextSource', () => ({ fetchMarketContext: fetchMock }));

function wrapper({ children }) {
  return <QueryClientProvider client={makeTestQueryClient()}>{children}</QueryClientProvider>;
}

describe('useMarketContext', () => {
  // mockClear + implementação padrão (em vez de mockReset): com mockReset este teste falhava com a rejeição simulada
  // aparecendo como erro não tratado (medido; causa não investigada a fundo). O padrão é uma promessa pendente, para um
  // teste esquecido nunca bater na rede.
  beforeEach(() => { fetchMock.mockClear(); fetchMock.mockImplementation(async () => new Promise(() => {})); });

  it('devolve os eventos e a hora da checagem em caso de sucesso', async () => {
    fetchMock.mockResolvedValue({ events: [{ id: 'a' }], checkedAtMs: 123 });
    const { result } = renderHook(() => useMarketContext(), { wrapper });
    await waitFor(() => expect(result.current.events).toEqual([{ id: 'a' }]));
    expect(result.current.checkedAtMs).toBe(123);
  });

  it('falha em silêncio: erro de rede → events = null, sem lançar', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('HTTP 404'); });
    const { result } = renderHook(() => useMarketContext(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(result.current.events).toBeNull();
    expect(result.current.checkedAtMs).toBeNull();
  });

  it('desligado: não faz nenhuma requisição', async () => {
    const { result } = renderHook(() => useMarketContext({ enabled: false }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.events).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});
