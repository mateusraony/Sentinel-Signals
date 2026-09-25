// @vitest-environment jsdom
//
// Achado M-14 do Raio-X de UI/UX (Média Prioridade): o botão de remover
// símbolo da comparação era um ícone puro (X do lucide-react) sem
// aria-label — nenhum nome acessível pra leitor de tela.
//
// Achado M-9 (Média Prioridade): o gráfico de linha (variação % por
// símbolo) não tinha role="img"/aria-label — invisível pra leitor de
// tela, mesma lacuna em todos os gráficos Recharts do projeto.
//
// Componente não tinha teste dedicado antes do achado M-14.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import CorrelationWidget from './CorrelationWidget.jsx';

const fetchCandlesMock = vi.fn(async () => []);
vi.mock('@/api/entities', () => ({
  backend: { entities: { MonitoredAsset: { list: vi.fn(async () => []) } } },
}));
vi.mock('@/lib/marketDataProvider', () => ({
  fetchCandles: (...args) => fetchCandlesMock(...args),
}));

// Recharts' ResponsiveContainer exige ResizeObserver em runtime — jsdom
// não implementa, mesmo polyfill já usado em Dashboard.test.jsx.
beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  fetchCandlesMock.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

// 3 candles fechados por símbolo, valores distintos — suficiente pra
// `analysis` (CorrelationWidget.jsx) ficar não-nulo e o gráfico renderizar.
function closedCandles(closes) {
  return closes.map((close, i) => ({ close, isClosed: true, time: i }));
}

function renderWidget() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CorrelationWidget />
    </QueryClientProvider>,
  );
}

describe('CorrelationWidget — botão de remover símbolo tem aria-label (achado M-14)', () => {
  it('REGRESSÃO: botão de remover de cada símbolo padrão tem nome acessível', async () => {
    renderWidget();
    const removeBtn = await screen.findByRole('button', { name: 'Remover BTC da comparação' });
    expect(removeBtn).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remover ETH da comparação' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remover SOL da comparação' })).toBeTruthy();
  });
});

describe('CorrelationWidget — gráfico de correlação tem role="img"/aria-label (achado M-9)', () => {
  it('REGRESSÃO: o wrapper do LineChart tem role="img" e aria-label citando os símbolos', async () => {
    fetchCandlesMock.mockResolvedValue(closedCandles([100, 101, 102]));
    const { container } = renderWidget();
    const chart = await waitFor(() => {
      const el = container.querySelector('[role="img"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(chart.getAttribute('aria-label')).toMatch(/Gráfico de linha.*BTC.*ETH.*SOL/);
  });
});
