// @vitest-environment jsdom
//
// Achado M-9 do Raio-X de UI/UX (Média Prioridade): o gráfico de área
// "Evolução do Saldo Acumulado" não tinha role="img"/aria-label —
// invisível pra leitor de tela. Componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import PerformanceOverview from './PerformanceOverview.jsx';

const listMock = vi.fn(async () => []);
vi.mock('@/api/entities', () => ({
  backend: { entities: { TradeOperation: { list: (...args) => listMock(...args) } } },
}));

// Recharts' ResponsiveContainer exige ResizeObserver em runtime — jsdom
// não implementa, mesmo polyfill já usado em Dashboard.test.jsx.
beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  listMock.mockReset();
});

afterEach(cleanup);

const CLOSED_OPS = [
  {
    id: 'op1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h', side: 'BUY',
    status: 'TP2_HIT', entry_price: 100, initial_stop: 90, current_stop: 105,
    tp1: 110, tp2: 120, exit_price: 120, closed_at: new Date().toISOString(),
    partial_percent: 50, created_date: new Date().toISOString(),
  },
  {
    id: 'op2', asset_id: 'a2', symbol: 'ETHUSDT', timeframe: '4h', side: 'SELL',
    status: 'STOP_HIT', entry_price: 3000, initial_stop: 3100, current_stop: 3100,
    tp1: 2900, tp2: 2800, exit_price: 3100, closed_at: new Date().toISOString(),
    partial_percent: 50, created_date: new Date().toISOString(),
  },
];

function renderOverview() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <PerformanceOverview />
    </QueryClientProvider>,
  );
}

describe('PerformanceOverview — gráfico "Evolução do Saldo Acumulado" tem role="img"/aria-label (achado M-9)', () => {
  it('REGRESSÃO: o wrapper do AreaChart tem role="img" e aria-label com o PnL total', async () => {
    listMock.mockResolvedValue(CLOSED_OPS);
    const { container } = renderOverview();
    await screen.findByText('Performance Consolidada');
    const chart = container.querySelector('[role="img"]');
    expect(chart).not.toBeNull();
    expect(chart.getAttribute('aria-label')).toMatch(/Gráfico de área da evolução do saldo acumulado/);
  });
});

// Achado da varredura pós-Raio-X (2026-09-27): eixo X escondido
// (`<XAxis dataKey="label" hide />`) tirava qualquer referência temporal do
// gráfico — mesmo defeito que A-13 já corrigiu em RFHistoryChart.jsx. Mesmo
// mock de dimensão de RFHistoryChart.test.jsx/CorrelationWidget.test.jsx —
// jsdom não faz layout real, o ResponsiveContainer do recharts não
// desenha o eixo sem uma dimensão explícita via getBoundingClientRect.
describe('PerformanceOverview — eixo X do gráfico não está mais escondido (achado pós-Raio-X)', () => {
  it('REGRESSÃO: o eixo X renderiza (não usa mais hide)', async () => {
    listMock.mockResolvedValue(CLOSED_OPS);
    const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    // eslint-disable-next-line func-names -- precisa de `this` (o elemento) pra decidir a dimensão
    Element.prototype.getBoundingClientRect = function () {
      return { width: 400, height: 140, top: 0, left: 0, bottom: 140, right: 400, x: 0, y: 0, toJSON() {} };
    };
    try {
      const { container } = renderOverview();
      await screen.findByText('Performance Consolidada');
      await vi.waitFor(() => {
        expect(container.querySelector('.recharts-xAxis')).not.toBeNull();
      });
    } finally {
      Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
    }
  });
});
