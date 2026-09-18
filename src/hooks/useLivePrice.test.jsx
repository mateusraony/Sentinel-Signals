// @vitest-environment jsdom
//
// Achado real (2026-09-18, screenshot do usuário em produção): duas operações
// abertas (ETHFI/USDT, FET/USDT) mostravam "Sem cotação" no painel real, sem
// deixar NENHUM rastro auditável — nem console, nem SystemLog. A investigação
// (agente Explore) confirmou zero logging em todo o caminho TradeCard →
// useLivePrice → fetchCurrentPrice, tornando a causa HTTP exata (rate limit?
// CORS? timeout?) impossível de diagnosticar remotamente depois do fato. Este
// teste prova que a falha agora vira um logWarn — sem mudar isError/isStale.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { useLivePrice } from './useLivePrice.js';

const { fetchCurrentPriceMock, logWarnMock } = vi.hoisted(() => ({
  fetchCurrentPriceMock: vi.fn(),
  logWarnMock: vi.fn(),
}));

vi.mock('@/lib/marketDataProvider', () => ({
  fetchCurrentPrice: fetchCurrentPriceMock,
}));

vi.mock('@/lib/logger', () => ({
  logWarn: logWarnMock,
}));

function wrapper({ children }) {
  const client = makeTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useLivePrice — instrumentação de "Sem cotação"', () => {
  beforeEach(() => {
    fetchCurrentPriceMock.mockReset();
    logWarnMock.mockReset();
  });

  it('REGRESSÃO: falha sem nenhuma leitura anterior vira logWarn com o símbolo e a mensagem real', async () => {
    fetchCurrentPriceMock.mockRejectedValue(new Error('Erro ao buscar preço de ETHFIUSDT (HTTP 429)'));

    const { result } = renderHook(() => useLivePrice('ETHFIUSDT'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() => expect(logWarnMock).toHaveBeenCalledTimes(1));

    expect(logWarnMock).toHaveBeenCalledWith(
      'useLivePrice',
      'Sem cotação ao vivo para ETHFIUSDT',
      { message: 'Erro ao buscar preço de ETHFIUSDT (HTTP 429)' },
    );
    // Comportamento existente (isError/price) não muda — só a instrumentação é nova.
    expect(result.current.price).toBeNull();
  });

  it('não loga de novo a cada re-render enquanto o mesmo erro persistir (dedupado por símbolo+mensagem)', async () => {
    fetchCurrentPriceMock.mockRejectedValue(new Error('falha de rede'));

    const { result, rerender } = renderHook(() => useLivePrice('FETUSDT'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() => expect(logWarnMock).toHaveBeenCalledTimes(1));

    rerender();
    rerender();
    expect(logWarnMock).toHaveBeenCalledTimes(1);
  });

  it('sucesso nunca loga nada', async () => {
    fetchCurrentPriceMock.mockResolvedValue(0.68773);

    const { result } = renderHook(() => useLivePrice('ETHFIUSDT'), { wrapper });

    await waitFor(() => expect(result.current.price).toBe(0.68773));
    expect(logWarnMock).not.toHaveBeenCalled();
  });
});
