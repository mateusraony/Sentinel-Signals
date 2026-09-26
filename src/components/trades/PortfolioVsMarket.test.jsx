// @vitest-environment jsdom
//
// Achado M-9 do Raio-X de UI/UX (docs/known-risks.md item 222/223/226): o
// gráfico comparando carteira vs benchmark não tinha role="img"/aria-label.
// Como o nº de trades não tem teto, o fix usa a técnica validada em
// Backtest.jsx (item 226): aria-label como resumo curto + tabela `sr-only`
// linkada via aria-describedby carregando o dado ponto a ponto.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import PortfolioVsMarket from './PortfolioVsMarket.jsx';

// BENCHMARK_OPTIONS/fetchCurve real chama a Binance/BCB direto do browser —
// mockado pra devolver uma curva controlável e determinística no teste,
// mesmo padrão de isolamento já usado nas outras suítes desta rodada.
vi.mock('@/lib/marketBenchmarks', () => ({
  BENCHMARK_OPTIONS: [
    {
      key: 'BTC', label: 'BTC',
      fetchCurve: vi.fn().mockResolvedValue([
        { timestamp: new Date('2026-01-01T00:00:00.000Z').getTime(), market: 2 },
        { timestamp: new Date('2026-01-05T00:00:00.000Z').getTime(), market: 5 },
      ]),
    },
  ],
}));

afterEach(cleanup);

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const CLOSED_OPS = [
  {
    id: 'op1', symbol: 'BTCUSDT', side: 'BUY', status: 'TP2_HIT',
    entry_price: 60000, initial_stop: 59000, current_stop: 59000, exit_price: 61000,
    created_date: '2026-01-01T00:00:00.000Z', closed_at: '2026-01-03T00:00:00.000Z',
  },
  {
    id: 'op2', symbol: 'ETHUSDT', side: 'SELL', status: 'STOP_HIT',
    entry_price: 3000, initial_stop: 3100, current_stop: 3100, exit_price: 3100,
    created_date: '2026-01-04T00:00:00.000Z', closed_at: '2026-01-05T00:00:00.000Z',
  },
];

function renderChart(trades) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <PortfolioVsMarket trades={trades} />
    </QueryClientProvider>,
  );
}

describe('PortfolioVsMarket — gráfico tem role="img"/aria-label com resumo e tabela sr-only (achado M-9)', () => {
  it('REGRESSÃO: role=img com resumo (trades, carteira, benchmark) e tabela sr-only com cada ponto', async () => {
    const { container } = renderChart(CLOSED_OPS);
    await screen.findByText(/Carteira vs Mercado/i);

    const img = await waitFor(() => {
      const el = container.querySelector('[role="img"]');
      expect(el).not.toBeNull();
      return el;
    });

    const label = img.getAttribute('aria-label');
    expect(label).toMatch(/2 trades fechados/);
    expect(label).toMatch(/carteira/i);

    const tableId = img.getAttribute('aria-describedby');
    expect(tableId).toBeTruthy();
    const table = document.getElementById(tableId);
    expect(table).toBeTruthy();
    expect(table.className).toMatch(/sr-only/);
    expect(table.textContent).toMatch(/BTC\/USDT/);
    expect(table.textContent).toMatch(/ETH\/USDT/);
    expect(table.querySelectorAll('tbody tr').length).toBe(2);
  });

  it('não renderiza role=img com menos de 2 trades fechados (mensagem de "dados insuficientes")', () => {
    const { container } = renderChart([CLOSED_OPS[0]]);
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(screen.getByText(/Dados insuficientes/i)).toBeTruthy();
  });
});
