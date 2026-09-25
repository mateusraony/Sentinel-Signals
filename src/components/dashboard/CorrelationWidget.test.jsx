// @vitest-environment jsdom
//
// Achado M-14 do Raio-X de UI/UX (Média Prioridade): o botão de remover
// símbolo da comparação era um ícone puro (X do lucide-react) sem
// aria-label — nenhum nome acessível pra leitor de tela. Componente não
// tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import CorrelationWidget from './CorrelationWidget.jsx';

vi.mock('@/api/entities', () => ({
  backend: { entities: { MonitoredAsset: { list: vi.fn(async () => []) } } },
}));
vi.mock('@/lib/marketDataProvider', () => ({
  fetchCandles: vi.fn(async () => []),
}));

afterEach(cleanup);

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
