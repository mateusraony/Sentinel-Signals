// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { useFundingRate } from './useFundingRate.js';

const { fetchMarkPriceMock, logWarnMock } = vi.hoisted(() => ({
  fetchMarkPriceMock: vi.fn(),
  logWarnMock: vi.fn(),
}));

vi.mock('@/lib/marketDataProvider', () => ({
  fetchMarkPrice: fetchMarkPriceMock,
}));

vi.mock('@/lib/logger', () => ({
  logWarn: logWarnMock,
}));

function wrapper({ children }) {
  const client = makeTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useFundingRate', () => {
  beforeEach(() => {
    fetchMarkPriceMock.mockReset();
    logWarnMock.mockReset();
  });

  it('devolve o funding rate e o horário do próximo funding em caso de sucesso', async () => {
    fetchMarkPriceMock.mockResolvedValue({ markPrice: 50000, lastFundingRate: 0.0001, nextFundingTime: 1735689600000 });

    const { result } = renderHook(() => useFundingRate('BTCUSDT'), { wrapper });

    await waitFor(() => expect(result.current.fundingRate).toBe(0.0001));
    expect(result.current.nextFundingTime).toBe(1735689600000);
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it('sem símbolo, não dispara a query', async () => {
    const { result } = renderHook(() => useFundingRate(undefined), { wrapper });

    expect(result.current.fundingRate).toBeNull();
    expect(fetchMarkPriceMock).not.toHaveBeenCalled();
  });

  it('falha na busca vira logWarn dedupado por símbolo+mensagem, sem repetir a cada re-render', async () => {
    fetchMarkPriceMock.mockRejectedValue(new Error('Erro ao buscar mark price de BTCUSDT'));

    const { result, rerender } = renderHook(() => useFundingRate('BTCUSDT'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() => expect(logWarnMock).toHaveBeenCalledTimes(1));

    expect(logWarnMock).toHaveBeenCalledWith(
      'useFundingRate',
      'Sem funding rate para BTCUSDT',
      { message: 'Erro ao buscar mark price de BTCUSDT' },
    );
    expect(result.current.fundingRate).toBeNull();

    rerender();
    rerender();
    expect(logWarnMock).toHaveBeenCalledTimes(1);
  });
});
